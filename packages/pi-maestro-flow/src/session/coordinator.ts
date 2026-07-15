import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
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

export class WorkflowLeaseStore {
  private held?: WorkflowLease;

  constructor(
    private readonly workflowRoot: string,
    private readonly staleAfterMs = 30_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acquire(sessionId: string, hostSessionId: string): Promise<WorkflowLease> {
    if (this.held?.sessionId === sessionId && this.held.hostSessionId === hostSessionId) {
      return this.heartbeat();
    }
    const directory = join(this.workflowRoot, ".workflow", "tmp", "hook");
    await mkdir(directory, { recursive: true });
    const sessionOwner = await this.findSessionOwner(directory, sessionId, hostSessionId);
    if (sessionOwner && !this.isStale(sessionOwner)) throw new WorkflowLeaseBusyError(sessionOwner);
    const path = this.pathFor(hostSessionId);
    let previousEpoch = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease: WorkflowLease = {
        sessionId,
        hostSessionId,
        epoch: Math.max(previousEpoch + 1, this.now().getTime()),
        heartbeatAt: this.now().toISOString(),
        token: randomUUID(),
      };
      try {
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        this.held = lease;
        return { ...lease };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = await this.read(path);
      if (!owner) {
        await rm(path, { force: true });
        continue;
      }
      previousEpoch = owner.epoch;
      if (!this.isStale(owner)) throw new WorkflowLeaseBusyError(owner);
      const quarantine = `${path}.stale-${owner.token}`;
      try {
        await rename(path, quarantine);
        await rm(quarantine, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Could not acquire workflow lease for ${sessionId}`);
  }

  async heartbeat(): Promise<WorkflowLease> {
    const lease = this.requireHeld();
    const path = this.pathFor(lease.hostSessionId);
    await this.assertOwner(path, lease);
    const next = { ...lease, heartbeatAt: this.now().toISOString() };
    await this.replaceOwned(path, next);
    this.held = next;
    return { ...next };
  }

  async fence(): Promise<WorkflowLease> {
    const lease = this.requireHeld();
    const path = this.pathFor(lease.hostSessionId);
    await this.assertOwner(path, lease);
    const next = {
      ...lease,
      epoch: lease.epoch + 1,
      heartbeatAt: this.now().toISOString(),
      token: randomUUID(),
    };
    await this.replaceOwned(path, next);
    this.held = next;
    return { ...next };
  }

  current(): WorkflowLease | undefined {
    return this.held ? { ...this.held } : undefined;
  }

  async release(): Promise<void> {
    const lease = this.held;
    if (!lease) return;
    const path = this.pathFor(lease.hostSessionId);
    const owner = await this.read(path);
    if (owner?.token === lease.token) await rm(path, { force: true });
    this.held = undefined;
  }

  private pathFor(hostSessionId: string): string {
    return join(this.workflowRoot, ".workflow", "tmp", "hook", `${encodeURIComponent(hostSessionId)}.json`);
  }

  private async findSessionOwner(
    directory: string,
    sessionId: string,
    hostSessionId: string,
  ): Promise<WorkflowLease | undefined> {
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json") || file === `${encodeURIComponent(hostSessionId)}.json`) continue;
      const path = join(directory, file);
      const owner = await this.read(path);
      if (owner?.sessionId !== sessionId) continue;
      if (this.isStale(owner)) {
        await rm(path, { force: true });
        continue;
      }
      return owner;
    }
    return undefined;
  }

  private async assertOwner(path: string, expected: WorkflowLease): Promise<void> {
    const owner = await this.read(path);
    if (!owner || owner.token !== expected.token || owner.epoch !== expected.epoch) {
      throw new WorkflowLeaseBusyError(owner ?? { ...expected, hostSessionId: "unknown", token: "unknown" });
    }
  }

  private async replaceOwned(path: string, lease: WorkflowLease): Promise<void> {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async read(path: string): Promise<WorkflowLease | undefined> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<WorkflowLease>;
      if (
        typeof value.sessionId !== "string"
        || typeof value.hostSessionId !== "string"
        || typeof value.epoch !== "number"
        || typeof value.heartbeatAt !== "string"
        || typeof value.token !== "string"
      ) return undefined;
      return value as WorkflowLease;
    } catch {
      return undefined;
    }
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

const MARKER_PREFIX = "maestro-workflow-continuation:";

interface ContinuationMarker {
  sessionId: string;
  runId: string;
  iteration: number;
  epoch: number;
  nonce: string;
}

export class WorkflowCoordinator {
  constructor(
    private readonly bridge: WorkflowSnapshotProvider,
    private readonly adapter: WorkflowRunAdapter,
    private readonly leases: WorkflowLeaseStore,
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
    const lease = await this.leases.acquire(session.sessionId, hostSessionId);
    const run = activeWorkflowRun(snapshot);
    const brief = run ? await this.adapter.brief(run.runId, session.sessionId) : undefined;
    return { snapshot, ...(brief ? { brief } : {}), lease };
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
    const result = await this.adapter.create(command, args, { sessionId: session.sessionId });
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async complete(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    requireRun(session.runs, runId);
    const result = await this.adapter.complete(runId, session.sessionId);
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async retry(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const failed = requireRun(session.runs, runId);
    if (failed.status !== "failed") throw new Error(`Run ${runId} is ${failed.status}; only failed Runs can be retried`);
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.retryViaParentRun) throw new Error("Installed Maestro CLI cannot preserve retry parent_run_id");
    await this.leases.fence();
    const result = await this.adapter.create(failed.command, failed.args, {
      sessionId: session.sessionId,
      parentRunId: failed.runId,
    });
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async cancel(runId: string): Promise<WorkflowTransitionResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    requireRun(session.runs, runId);
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.cancel) throw new Error("Installed Maestro CLI does not expose canonical run cancel");
    await this.leases.fence();
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
    return `${MARKER_PREFIX}${Buffer.from(JSON.stringify(marker)).toString("base64url")}`;
  }

  acceptsContinuation(markerText: string): boolean {
    const marker = parseMarker(markerText);
    const lease = this.leases.current();
    const snapshot = this.bridge.getSnapshot();
    const run = snapshot ? activeWorkflowRun(snapshot) : undefined;
    return Boolean(
      marker
      && lease
      && snapshot?.session
      && run
      && marker.sessionId === lease.sessionId
      && marker.sessionId === snapshot.session.sessionId
      && marker.runId === run.runId
      && marker.epoch === lease.epoch,
    );
  }

  async fenceContinuation(): Promise<void> {
    await this.leases.fence();
  }

  async release(): Promise<void> {
    await this.leases.release();
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
      || typeof value.iteration !== "number"
      || typeof value.epoch !== "number"
      || typeof value.nonce !== "string"
    ) return undefined;
    return value as ContinuationMarker;
  } catch {
    return undefined;
  }
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
  return gates.some((gate) => gate.blocking && gate.status === "failed");
}
