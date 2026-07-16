import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunCliAdapter, RunCliCapabilities, RunCliResult } from "./cli-adapter.ts";
import type { WorkflowBridge } from "./bridge.ts";
import { activeWorkflowRun, type WorkflowRun, type WorkflowSnapshot } from "./types.ts";

export interface WorkflowSnapshotProvider {
  refresh(): Promise<WorkflowSnapshot>;
  getSnapshot(): WorkflowSnapshot | undefined;
}

export interface WorkflowRunAdapter {
  capabilities(refresh?: boolean): Promise<RunCliCapabilities>;
  prepare(step: string): Promise<RunCliResult>;
  brief(runId: string, sessionId?: string): Promise<RunCliResult>;
  create(
    command: string,
    args?: readonly string[],
    options?: { sessionId?: string; intent?: string; parentRunId?: string },
  ): Promise<RunCliResult>;
  complete(runId: string, sessionId?: string): Promise<RunCliResult>;
  cancel(runId: string, sessionId?: string): Promise<RunCliResult>;
}

export interface WorkflowLease {
  sessionId: string;
  hostSessionId: string;
  epoch: number;
  heartbeatAt: string;
  token: string;
}

export interface WorkflowAttachResult {
  snapshot: WorkflowSnapshot;
  brief?: RunCliResult;
  lease: WorkflowLease;
}

export interface WorkflowTransitionResult {
  command: RunCliResult;
  snapshot: WorkflowSnapshot;
}

export class WorkflowLeaseBusyError extends Error {
  constructor(readonly owner: WorkflowLease) {
    super(`Workflow Session ${owner.sessionId} is leased by host ${owner.hostSessionId}`);
    this.name = "WorkflowLeaseBusyError";
  }
}

export interface WorkflowLeaseStoreHooks {
  beforeHeartbeatPublish?(lease: WorkflowLease): Promise<void>;
}

interface CurrentLease {
  lease: WorkflowLease;
  released: boolean;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class WorkflowLeaseStore {
  private held?: WorkflowLease;

  constructor(
    private readonly workflowRoot: string,
    private readonly staleAfterMs = 30_000,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: WorkflowLeaseStoreHooks = {},
  ) {}

  async acquire(sessionId: string, hostSessionId: string): Promise<WorkflowLease> {
    if (this.held?.sessionId === sessionId && this.held.hostSessionId === hostSessionId) {
      return this.heartbeat();
    }
    if (this.held) throw new Error("Release the current Workflow lease before acquiring another Session");
    const directory = this.directoryFor(sessionId);
    await ensurePrivateDirectory(directory);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.readCurrent(directory, sessionId);
      if (current && !current.released && !this.isStale(current.lease)) {
        throw new WorkflowLeaseBusyError(current.lease);
      }
      const lease: WorkflowLease = {
        sessionId,
        hostSessionId,
        epoch: (current?.lease.epoch ?? 0) + 1,
        heartbeatAt: this.now().toISOString(),
        token: randomUUID(),
      };
      const claimPath = this.claimPath(directory, lease.epoch);
      const pendingPath = `${claimPath}.${lease.token}.pending`;
      try {
        await writeFile(pendingPath, `${JSON.stringify(lease)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
        await link(pendingPath, claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        continue;
      } finally {
        await rm(pendingPath, { force: true }).catch(() => {});
      }
      const owner = await this.readCurrent(directory, sessionId);
      if (!owner || owner.released || !sameLease(owner.lease, lease)) {
        if (owner && !owner.released) throw new WorkflowLeaseBusyError(owner.lease);
        continue;
      }
      this.held = lease;
      return { ...lease };
    }
    throw new Error(`Could not acquire workflow lease for ${sessionId}`);
  }

  async heartbeat(expectedToken?: string): Promise<WorkflowLease> {
    const lease = this.requireHeld();
    if (expectedToken && lease.token !== expectedToken) throw new WorkflowLeaseBusyError(lease);
    try {
      const directory = this.directoryFor(lease.sessionId);
      await this.assertOwner(directory, lease);
      const next = { ...lease, heartbeatAt: this.now().toISOString() };
      await this.hooks.beforeHeartbeatPublish?.({ ...next });
      await this.replaceState(directory, next);
      await this.assertOwner(directory, next);
      if (!this.held || !sameLease(this.held, lease)) throw this.busyError(lease);
      this.held = next;
      return { ...next };
    } catch (error) {
      this.lose(lease);
      throw error;
    }
  }

  async fence(): Promise<WorkflowLease> {
    const lease = this.requireHeld();
    const directory = this.directoryFor(lease.sessionId);
    try {
      await this.assertOwner(directory, lease);
      const next: WorkflowLease = {
        ...lease,
        epoch: lease.epoch + 1,
        heartbeatAt: this.now().toISOString(),
        token: randomUUID(),
      };
      const claimPath = this.claimPath(directory, next.epoch);
      const pendingPath = `${claimPath}.${next.token}.pending`;
      try {
        await writeFile(pendingPath, `${JSON.stringify(next)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
        await link(pendingPath, claimPath);
      } finally {
        await rm(pendingPath, { force: true }).catch(() => {});
      }
      await this.assertOwner(directory, next);
      this.held = next;
      return { ...next };
    } catch (error) {
      this.lose(lease);
      throw error;
    }
  }

  current(): WorkflowLease | undefined {
    return this.held ? { ...this.held } : undefined;
  }

  async release(): Promise<void> {
    const lease = this.held;
    if (!lease) return;
    this.held = undefined;
    const directory = this.directoryFor(lease.sessionId);
    const owner = await this.readCurrent(directory, lease.sessionId);
    if (!owner || owner.released || !sameLease(owner.lease, lease)) return;
    await writeFile(this.releasePath(directory, lease), "", { flag: "wx", mode: PRIVATE_FILE_MODE }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }

  private directoryFor(sessionId: string): string {
    return join(this.workflowRoot, ".workflow", "tmp", "hook", `${encodeURIComponent(sessionId)}.lease`);
  }

  private claimPath(directory: string, epoch: number): string {
    return join(directory, `${epoch}.claim.json`);
  }

  private statePath(directory: string, lease: WorkflowLease): string {
    return join(directory, `${lease.epoch}.${lease.token}.state.json`);
  }

  private releasePath(directory: string, lease: WorkflowLease): string {
    return join(directory, `${lease.epoch}.${lease.token}.released`);
  }

  private async assertOwner(directory: string, expected: WorkflowLease): Promise<void> {
    const owner = await this.readCurrent(directory, expected.sessionId);
    if (!owner || owner.released || !sameLease(owner.lease, expected)) {
      throw this.busyError(expected, owner?.lease);
    }
  }

  private async replaceState(directory: string, lease: WorkflowLease): Promise<void> {
    const path = this.statePath(directory, lease);
    const pendingPath = `${path}.${randomUUID()}.pending`;
    try {
      await writeFile(pendingPath, `${JSON.stringify(lease)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await rename(pendingPath, path);
    } finally {
      await rm(pendingPath, { force: true }).catch(() => {});
    }
  }

  private async readCurrent(directory: string, sessionId: string): Promise<CurrentLease | undefined> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const claims = entries.flatMap((entry) => {
      const match = /^(\d+)\.claim\.json$/.exec(entry);
      if (!match) return [];
      const epoch = Number(match[1]);
      return Number.isSafeInteger(epoch) ? [{ entry, epoch }] : [];
    }).sort((left, right) => right.epoch - left.epoch);
    if (claims.length === 0) return this.readLegacy(sessionId);
    const claim = await this.readLease(join(directory, claims[0]!.entry));
    if (!claim) throw new Error(`Workflow Session ${sessionId} has an unreadable lease claim`);
    const released = await this.exists(this.releasePath(directory, claim));
    const state = await this.readLease(this.statePath(directory, claim));
    if (state && !sameLease(state, claim)) {
      throw new Error(`Workflow Session ${sessionId} has a mismatched lease state`);
    }
    return { lease: state ?? claim, released };
  }

  private async readLegacy(sessionId: string): Promise<CurrentLease | undefined> {
    const path = join(
      this.workflowRoot,
      ".workflow",
      "tmp",
      "hook",
      `${encodeURIComponent(sessionId)}.lease.json`,
    );
    const lease = await this.readLease(path);
    return lease ? { lease, released: false } : undefined;
  }

  private async readLease(path: string): Promise<WorkflowLease | undefined> {
    let raw: string;
    try {
      await secureExistingPrivateFile(path);
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: Partial<WorkflowLease>;
    try {
      value = JSON.parse(raw) as Partial<WorkflowLease>;
    } catch {
      return undefined;
    }
    if (
      typeof value.sessionId !== "string"
      || typeof value.hostSessionId !== "string"
      || !Number.isSafeInteger(value.epoch)
      || typeof value.heartbeatAt !== "string"
      || typeof value.token !== "string"
    ) return undefined;
    return value as WorkflowLease;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await secureExistingPrivateFile(path);
      await readFile(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private busyError(expected: WorkflowLease, owner?: WorkflowLease): WorkflowLeaseBusyError {
    return new WorkflowLeaseBusyError(owner ?? { ...expected, hostSessionId: "unknown", token: "unknown" });
  }

  private lose(lease: WorkflowLease): void {
    if (this.held && sameLease(this.held, lease)) this.held = undefined;
  }

  private isStale(lease: WorkflowLease): boolean {
    const heartbeat = Date.parse(lease.heartbeatAt);
    return !Number.isFinite(heartbeat) || this.now().getTime() - heartbeat > this.staleAfterMs;
  }

  private requireHeld(): WorkflowLease {
    if (!this.held) throw new Error("Workflow lease is not held");
    return this.held;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Workflow lease directory must be a real directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function secureExistingPrivateFile(path: string): Promise<void> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Workflow lease path must be a regular file: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
}

const MARKER_PREFIX = "maestro-workflow-continuation:";

interface ContinuationMarker {
  sessionId: string;
  runId: string;
  iteration: number;
  epoch: number;
  nonce: string;
}

export class WorkflowCoordinator {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatWork = Promise.resolve();
  private heartbeatGeneration = 0;
  private pendingContinuation?: ContinuationMarker;

  constructor(
    private readonly bridge: WorkflowSnapshotProvider,
    private readonly adapter: WorkflowRunAdapter,
    private readonly leases: WorkflowLeaseStore,
    private readonly heartbeatEveryMs = 10_000,
  ) {}

  static create(bridge: WorkflowBridge, adapter: RunCliAdapter, workflowRoot: string): WorkflowCoordinator {
    return new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(workflowRoot));
  }

  async attach(hostSessionId: string, explicitSessionId?: string): Promise<WorkflowAttachResult> {
    const snapshot = await this.bridge.refresh();
    const session = snapshot.session;
    if (!session) throw new Error("No active canonical Workflow Session");
    if (explicitSessionId && explicitSessionId !== session.sessionId) {
      throw new Error(`Active Workflow Session is ${session.sessionId}, not ${explicitSessionId}`);
    }
    await this.stopHeartbeat();
    this.pendingContinuation = undefined;
    const current = this.leases.current();
    if (current && (current.sessionId !== session.sessionId || current.hostSessionId !== hostSessionId)) {
      await this.leases.release();
    }
    const lease = await this.leases.acquire(session.sessionId, hostSessionId);
    this.startHeartbeat(lease);
    try {
      const run = activeWorkflowRun(snapshot);
      const brief = run ? await this.adapter.brief(run.runId, session.sessionId) : undefined;
      return { snapshot, ...(brief ? { brief } : {}), lease };
    } catch (error) {
      await this.stopHeartbeat();
      await this.leases.release();
      throw error;
    }
  }

  status(): WorkflowSnapshot | undefined {
    return this.bridge.getSnapshot();
  }

  async prepare(step: string): Promise<RunCliResult> {
    return this.adapter.prepare(step);
  }

  async brief(runId?: string): Promise<RunCliResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const target = runId ?? session.activeRunId;
    if (!target) throw new Error("Workflow Session has no active Run");
    return this.adapter.brief(target, session.sessionId);
  }

  async advance(command: string, args: readonly string[] = []): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const active = activeWorkflowRun(snapshot);
    if (active && ["created", "running", "blocked"].includes(active.status)) {
      return { command: await this.adapter.brief(active.runId, session.sessionId), snapshot };
    }
    await this.fenceLease(session.sessionId);
    const result = await this.adapter.create(command, args, { sessionId: session.sessionId });
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async complete(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    requireRun(session.runs, runId);
    await this.fenceLease(session.sessionId);
    const result = await this.adapter.complete(runId, session.sessionId);
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async retry(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const failed = requireRun(session.runs, runId);
    if (failed.status !== "failed") throw new Error(`Run ${runId} is ${failed.status}; only failed Runs can be retried`);
    this.requireMutationLease(session.sessionId);
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.retryViaParentRun) throw new Error("Installed Maestro CLI cannot preserve retry parent_run_id");
    const retryBaseline = {
      sessionId: session.sessionId,
      runIds: new Set(session.runs.map((run) => run.runId)),
      failedAttempt: lineageAttempt(session.runs, failed),
    };
    await this.fenceLease(session.sessionId);
    const result = await this.adapter.create(failed.command, failed.args, {
      sessionId: session.sessionId,
      parentRunId: failed.runId,
    });
    const refreshed = await this.bridge.refresh();
    validateRetrySnapshot(refreshed, failed.runId, retryBaseline);
    return { command: result, snapshot: refreshed };
  }

  async cancel(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    requireRun(session.runs, runId);
    this.requireMutationLease(session.sessionId);
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.cancel) throw new Error("Installed Maestro CLI does not expose canonical run cancel");
    await this.fenceLease(session.sessionId);
    const result = await this.adapter.cancel(runId, session.sessionId);
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  continuationMarker(iteration: number): string {
    const snapshot = this.bridge.getSnapshot();
    if (!snapshot) throw new Error("Coordinator is not attached");
    const session = requireSession(snapshot);
    const run = activeWorkflowRun(snapshot);
    if (!run || run.status !== "running") throw new Error("No running Run owns continuation");
    if (hasBlockingFailure(session.gates) || hasBlockingFailure(run.gates)) {
      throw new Error("Blocking gate failure prevents continuation");
    }
    const lease = this.leases.current();
    if (!lease || lease.sessionId !== session.sessionId) throw new Error("Workflow continuation lease is not held");
    const marker: ContinuationMarker = {
      sessionId: session.sessionId,
      runId: run.runId,
      iteration,
      epoch: lease.epoch,
      nonce: randomUUID(),
    };
    this.pendingContinuation = marker;
    return `${MARKER_PREFIX}${Buffer.from(JSON.stringify(marker)).toString("base64url")}`;
  }

  acceptsContinuation(markerText: string): boolean {
    const marker = parseMarker(markerText);
    const expected = this.pendingContinuation;
    const lease = this.leases.current();
    const snapshot = this.bridge.getSnapshot();
    const run = snapshot ? activeWorkflowRun(snapshot) : undefined;
    const accepted = Boolean(
      marker
      && expected
      && lease
      && snapshot?.session
      && run
      && run.status === "running"
      && !hasBlockingFailure(snapshot.session.gates)
      && !hasBlockingFailure(run.gates)
      && sameMarker(marker, expected)
      && marker.sessionId === lease.sessionId
      && marker.sessionId === snapshot.session.sessionId
      && marker.runId === run.runId
      && marker.epoch === lease.epoch,
    );
    if (accepted) this.pendingContinuation = undefined;
    return accepted;
  }

  async fenceContinuation(): Promise<void> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    await this.fenceLease(session.sessionId);
  }

  async release(): Promise<void> {
    this.pendingContinuation = undefined;
    await this.stopHeartbeat();
    await this.leases.release();
  }

  private async fenceLease(sessionId: string): Promise<void> {
    this.requireMutationLease(sessionId);
    this.pendingContinuation = undefined;
    await this.stopHeartbeat();
    const lease = await this.leases.fence();
    this.startHeartbeat(lease);
  }

  private requireMutationLease(sessionId: string): WorkflowLease {
    const lease = this.leases.current();
    if (!lease) throw new Error("Workflow mutation lease is not held");
    if (lease.sessionId !== sessionId) {
      throw new Error(
        `Workflow mutation lease belongs to ${lease.sessionId}, but the active canonical Session is ${sessionId}`,
      );
    }
    return lease;
  }

  private startHeartbeat(lease: WorkflowLease): void {
    const generation = ++this.heartbeatGeneration;
    const timer = setInterval(() => {
      this.heartbeatWork = this.heartbeatWork.then(async () => {
        if (this.heartbeatGeneration !== generation || this.leases.current()?.token !== lease.token) return;
        await this.leases.heartbeat(lease.token);
      }).catch(() => {
        if (this.heartbeatGeneration === generation) {
          this.pendingContinuation = undefined;
          clearInterval(timer);
          if (this.heartbeatTimer === timer) this.heartbeatTimer = undefined;
        }
      });
    }, this.heartbeatEveryMs);
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  private async stopHeartbeat(): Promise<void> {
    this.heartbeatGeneration += 1;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.heartbeatWork.catch(() => {});
  }
}

function parseMarker(text: string): ContinuationMarker | undefined {
  const encoded = text.includes(MARKER_PREFIX) ? text.slice(text.indexOf(MARKER_PREFIX) + MARKER_PREFIX.length).split(/[\s<]/)[0] : "";
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ContinuationMarker>;
    if (
      typeof value.sessionId !== "string"
      || typeof value.runId !== "string"
      || !Number.isInteger(value.iteration)
      || (value.iteration ?? -1) < 0
      || typeof value.epoch !== "number"
      || typeof value.nonce !== "string"
    ) return undefined;
    return value as ContinuationMarker;
  } catch {
    return undefined;
  }
}

function sameMarker(left: ContinuationMarker, right: ContinuationMarker): boolean {
  return left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.iteration === right.iteration
    && left.epoch === right.epoch
    && left.nonce === right.nonce;
}

function sameLease(left: WorkflowLease, right: WorkflowLease): boolean {
  return left.sessionId === right.sessionId
    && left.hostSessionId === right.hostSessionId
    && left.epoch === right.epoch
    && left.token === right.token;
}

function requireSession(snapshot: WorkflowSnapshot) {
  if (!snapshot.session) throw new Error("No active canonical Workflow Session");
  return snapshot.session;
}

function requireRun(runs: WorkflowRun[], runId: string): WorkflowRun {
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

function hasBlockingFailure(gates: Array<{ blocking: boolean; status: string }>): boolean {
  return gates.some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
}

function validateRetrySnapshot(
  after: WorkflowSnapshot,
  failedRunId: string,
  baseline: { sessionId: string; runIds: ReadonlySet<string>; failedAttempt: number },
): WorkflowRun {
  const afterSession = requireSession(after);
  if (afterSession.sessionId !== baseline.sessionId) {
    throw new Error(`Retry switched canonical Workflow Session from ${baseline.sessionId} to ${afterSession.sessionId}`);
  }
  const retained = requireRun(afterSession.runs, failedRunId);
  if (retained.status !== "failed") throw new Error(`Retry did not retain failed Run ${failedRunId}`);
  const retries = afterSession.runs.filter((run) => !baseline.runIds.has(run.runId) && run.parentRunId === failedRunId);
  if (retries.length !== 1) {
    throw new Error(`Retry must create exactly one new Run with parent_run_id ${failedRunId}; found ${retries.length}`);
  }
  const retry = retries[0]!;
  const retryAttempt = lineageAttempt(afterSession.runs, retry);
  if (retryAttempt !== baseline.failedAttempt + 1) {
    throw new Error(`Retry Run ${retry.runId} has attempt ${retryAttempt}; expected ${baseline.failedAttempt + 1}`);
  }
  return retry;
}

function lineageAttempt(runs: WorkflowRun[], run: WorkflowRun): number {
  const visited = new Set<string>();
  let attempt = 1;
  let current = run;
  while (current.parentRunId) {
    if (visited.has(current.runId)) throw new Error(`Retry lineage contains a cycle at ${current.runId}`);
    visited.add(current.runId);
    current = requireRun(runs, current.parentRunId);
    attempt += 1;
  }
  return attempt;
}
