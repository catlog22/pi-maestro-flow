import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunCliAdapter,
  RunCliCapabilities,
  RunCliResult,
  RunDoneOptions,
  RunEditOptions,
  RunPlanPublishOptions,
} from "./cli-adapter.ts";
import type { WorkflowBridge } from "./bridge.ts";
import {
  RunResponseParseError,
  extractRunResponseLeaseClaim,
  parseRunResponse,
  projectPublicRunResponse,
  type PrivateRunResponseEnvelope,
  type RunLeaseClaim,
  type RunResponseFenceV11,
} from "./run-response.ts";
import { activeWorkflowRun, type WorkflowRun, type WorkflowSession, type WorkflowSnapshot } from "./types.ts";

export interface WorkflowSnapshotProvider {
  refresh(): Promise<WorkflowSnapshot>;
  refreshSession?(sessionId: string): Promise<WorkflowSnapshot>;
  getSnapshot(): WorkflowSnapshot | undefined;
}

export interface WorkflowRunAdapter {
  capabilities?(): Promise<RunCliCapabilities>;
  prepare(step: string): Promise<RunCliResult>;
  brief(runId: string, sessionId?: string): Promise<RunCliResult>;
  check(runId: string, sessionId?: string): Promise<RunCliResult>;
  next(sessionId: string, pick?: string): Promise<RunCliResult>;
  done(runId: string, sessionId: string, options?: RunDoneOptions): Promise<RunCliResult>;
  edit(commands: readonly string[], options: RunEditOptions): Promise<RunCliResult>;
  /** Raw Maestro CLI argv passthrough (run-control shell surface). */
  exec(argv: readonly string[]): Promise<RunCliResult>;
  supportsPlanPublish(): Promise<boolean>;
  publishPlan(options: RunPlanPublishOptions): Promise<RunCliResult>;
}

interface WorkflowLease {
  sessionId: string;
  hostSessionId: string;
  epoch: number;
  heartbeatAt: string;
  token: string;
}

export type WorkflowLeaseMetadata = Omit<WorkflowLease, "token">;

export type WorkflowLeaseOwnershipState = "unowned" | "owned" | "stale";

/** Public lease metadata for attribution. The fencing token is intentionally excluded. */
export interface WorkflowLeaseOwnership {
  sessionId: string;
  currentHostSessionId: string;
  state: WorkflowLeaseOwnershipState;
  ownerHostSessionId?: string;
  epoch?: number;
  heartbeatAt?: string;
  isOwner: boolean;
  isAttached: boolean;
}

export interface WorkflowHostContext {
  hostSessionId: string;
}

/**
 * session/3.0 resume projection (mirror of the core ResumeMapV1 contract in
 * maestro/src/run/protocol-schemas.ts). Defined locally with minimal manual
 * validation so the coordinator never depends on core packages.
 */
export interface ResumeMapV1 {
  sessionId: string;
  sessionStatus: "open" | "completed" | "archived" | "failed";
  orchestrationRevision: number;
  activityRevision: number;
  activeRuns: Array<{
    runId: string;
    stepId: string;
    status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "sealed";
    revision: number;
  }>;
  blockingGates: string[];
  openDecisions: string[];
  pendingPublications: Array<{ publicationId: string; resourceUri?: string }>;
  nextActions: Array<{
    action: string;
    targetId: string;
    expectedRevision: number;
  }>;
  fingerprint: string;
}

export interface WorkflowAttachResult {
  snapshot: WorkflowSnapshot;
  brief?: RunCliResult;
  /** Lease metadata when the authority model holds one; session-v3 has no lease. */
  lease?: WorkflowLeaseMetadata | WorkflowCoreLeaseMetadata;
  /** session/3.0 resume projection consumed at restore; present only when it validates. */
  resumeMap?: ResumeMapV1;
}

export interface WorkflowTransitionResult {
  command: RunCliResult;
  snapshot: WorkflowSnapshot;
}

export type WorkflowCoordinatorMode = "legacy-host" | "core-execution" | "fail-closed" | "session-v3";

export interface WorkflowCoreLeaseMetadata {
  sessionId: string;
  executionId: string;
  generation: number;
  ownerId: string;
  epoch: number;
  executionRevision: number;
}

export interface WorkflowRunControlClassification {
  write: boolean;
  sessionless: boolean;
  mutation?: "read" | "session" | "run" | "execution" | "execution-acquire" | "execution-lease"
    | "compatibility-start" | "plan-publish" | "artifact-republish";
  lease?: "none" | "required" | "acquire" | "command-aware";
}

interface CoreExecutionLocator {
  sessionId: string;
  executionId: string;
  generation: number;
}

interface CoreExecutionAuthority {
  capabilities?: RunCliCapabilities;
  locator?: CoreExecutionLocator;
  claim?: RunLeaseClaim;
  fence?: RunResponseFenceV11;
  lastLeaseEpoch?: number;
  ownerId?: string;
}

interface CoreMutationCandidate {
  locator: CoreExecutionLocator;
  fence: RunResponseFenceV11;
  claim?: RunLeaseClaim;
  ownerId?: string;
  releasesLease: boolean;
}

export class WorkflowLeaseBusyError extends Error {
  readonly owner: WorkflowLeaseMetadata;

  constructor(owner: WorkflowLease) {
    super(
      `Workflow Session ${owner.sessionId} is leased by Pi session ${owner.hostSessionId} `
      + `(epoch ${owner.epoch}, heartbeat ${owner.heartbeatAt})`,
    );
    this.name = "WorkflowLeaseBusyError";
    this.owner = leaseMetadata(owner);
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

  /** Root directory of the workflow workspace (read-only surface). */
  root(): string {
    return this.workflowRoot;
  }

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

  async ownership(sessionId: string, currentHostSessionId: string): Promise<WorkflowLeaseOwnership> {
    const current = await this.readCurrent(this.directoryFor(sessionId), sessionId);
    if (!current || current.released) {
      return {
        sessionId,
        currentHostSessionId,
        state: "unowned",
        isOwner: false,
        isAttached: false,
      };
    }
    const lease = current.lease;
    return {
      sessionId,
      currentHostSessionId,
      state: this.isStale(lease) ? "stale" : "owned",
      ownerHostSessionId: lease.hostSessionId,
      epoch: lease.epoch,
      heartbeatAt: lease.heartbeatAt,
      isOwner: lease.hostSessionId === currentHostSessionId,
      isAttached: Boolean(
        lease.hostSessionId === currentHostSessionId
        && this.held
        && sameLease(this.held, lease),
      ),
    };
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

export interface WorkflowCoordinatorOptions {
  /** Explicit compatibility boundary for the old plugin/runtime only. */
  legacyCompatibility?: boolean;
}

export class WorkflowCoordinator {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatWork = Promise.resolve();
  private heartbeatGeneration = 0;
  private pendingContinuation?: ContinuationMarker;
  // The first authority-sensitive entry point negotiates once, then the
  // selected authority remains sticky for this coordinator instance.
  private selectedMode: WorkflowCoordinatorMode = "fail-closed";
  private authoritySelection?: Promise<WorkflowCoordinatorMode>;
  private authorityDiagnostic?: string;
  private coreHeartbeatTimer?: ReturnType<typeof setInterval>;
  private coreHeartbeatGeneration = 0;
  private coreHeartbeatPending = false;
  private coreMutationWork = Promise.resolve();
  private readonly core: CoreExecutionAuthority = {};
  // session/3.0 resume-map restore authority: the orchestration revision cached
  // from `session resume-view` is the expected-orchestration-revision fallback
  // when the bridge snapshot omits session.orchestrationRevision.
  private v3ResumeRevisionCache: number | null = null;
  private readonly v3ResumeMapDiagnostics: string[] = [];

  constructor(
    private readonly bridge: WorkflowSnapshotProvider,
    private readonly adapter: WorkflowRunAdapter,
    private readonly leases: WorkflowLeaseStore,
    private readonly heartbeatEveryMs = 10_000,
    private readonly options: WorkflowCoordinatorOptions = {},
  ) {}

  static create(bridge: WorkflowBridge, adapter: RunCliAdapter, workflowRoot: string): WorkflowCoordinator {
    return new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(workflowRoot));
  }

  static legacyCompatible(
    bridge: WorkflowSnapshotProvider,
    adapter: WorkflowRunAdapter,
    leases: WorkflowLeaseStore,
    heartbeatEveryMs = 10_000,
  ): WorkflowCoordinator {
    return new WorkflowCoordinator(bridge, adapter, leases, heartbeatEveryMs, { legacyCompatibility: true });
  }

  mode(): WorkflowCoordinatorMode {
    return this.selectedMode;
  }

  /** Validation diagnostics from the last session/3.0 resume-map consumption. */
  resumeMapDiagnostics(): readonly string[] {
    return this.v3ResumeMapDiagnostics;
  }

  /** Negotiate authority once, optionally asserting the selected mode. */
  async selectMode(expectedMode?: WorkflowCoordinatorMode): Promise<WorkflowCoordinatorMode> {
    this.authoritySelection ??= this.initializeAuthority();
    const selected = await this.authoritySelection;
    if (expectedMode && expectedMode !== selected) {
      throw new Error(
        `Workflow coordinator cannot select ${expectedMode}; capability negotiation selected ${selected}`,
      );
    }
    return selected;
  }

  async attach(hostSessionId: string, explicitSessionId?: string): Promise<WorkflowAttachResult> {
    const mode = await this.selectMode();
    if (mode === "fail-closed") throw this.failClosedMutationError("attach");
    if (mode === "core-execution") {
      return this.attachCore(hostSessionId, explicitSessionId);
    }
    if (mode === "session-v3") {
      return this.attachV3(hostSessionId, explicitSessionId);
    }
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
      const brief = run
        ? projectPublicRunCliResult(await this.adapter.brief(run.runId, session.sessionId))
        : undefined;
      return { snapshot, ...(brief ? { brief } : {}), lease: leaseMetadata(lease) };
    } catch (error) {
      await this.stopHeartbeat();
      await this.leases.release();
      throw error;
    }
  }

  status(): WorkflowSnapshot | undefined {
    return this.bridge.getSnapshot();
  }

  /** Reload canonical Workflow authority instead of returning the cached projection. */
  refreshSnapshot(): Promise<WorkflowSnapshot> {
    return this.bridge.refresh();
  }

  async ownership(currentHostSessionId: string): Promise<WorkflowLeaseOwnership | undefined> {
    const mode = await this.selectMode();
    const hostSessionId = requireHostSessionId(currentHostSessionId);
    const snapshot = this.bridge.getSnapshot();
    const session = snapshot?.session;
    if (!session) return undefined;
    if (mode === "session-v3") {
      // session/3.0 has no lease: every host observes an unowned authority.
      return {
        sessionId: session.sessionId,
        currentHostSessionId: hostSessionId,
        state: "unowned",
        isOwner: false,
        isAttached: false,
      };
    }
    if (mode !== "legacy-host") {
      const lease = snapshot?.execution?.lease;
      if (!lease) {
        return {
          sessionId: session.sessionId,
          currentHostSessionId: hostSessionId,
          state: "unowned",
          isOwner: false,
          isAttached: false,
        };
      }
      const isOwner = lease.ownerId === hostSessionId;
      return {
        sessionId: session.sessionId,
        currentHostSessionId: hostSessionId,
        state: "owned",
        ownerHostSessionId: lease.ownerId,
        epoch: lease.epoch,
        heartbeatAt: lease.heartbeatAt,
        isOwner,
        isAttached: Boolean(isOwner && this.core.claim && this.core.ownerId === hostSessionId),
      };
    }
    return this.leases.ownership(session.sessionId, hostSessionId);
  }

  async supportsPlanPublish(): Promise<boolean> {
    return await this.selectMode() !== "fail-closed" && this.adapter.supportsPlanPublish();
  }

  /** New-Session Plan publication is available after authority negotiation; session-v3 allocates the plan chain step instead of a v2 Execution. */
  async supportsNewPlanSession(): Promise<boolean> {
    const mode = await this.selectMode();
    return mode === "core-execution" || mode === "legacy-host" || mode === "session-v3";
  }

  async publishPlan(
    options: RunPlanPublishOptions,
    context: WorkflowHostContext,
  ): Promise<WorkflowTransitionResult> {
    const mode = await this.selectMode();
    if (mode === "fail-closed") throw this.failClosedMutationError("plan publish");
    if (mode === "session-v3") {
      return this.publishPlanV3(options, context);
    }
    if (mode === "core-execution") {
      return this.publishPlanCore(options, context);
    }
    const currentHostSessionId = requireHostSessionId(context.hostSessionId);
    let publishOptions = options;
    if (options.sessionId) {
      const snapshot = await this.bridge.refresh();
      const session = requireSession(snapshot);
      if (session.sessionId !== options.sessionId) {
        throw new Error(
          `Approved Plan targets Workflow Session ${options.sessionId}, but the active canonical Session is ${session.sessionId}`,
        );
      }
      await this.fenceLease(session.sessionId, currentHostSessionId);
      const fenced = requireSession(await this.bridge.refresh());
      if (fenced.sessionId !== session.sessionId) {
        throw new Error(
          `Canonical Workflow Session switched from ${session.sessionId} to ${fenced.sessionId} while fencing Plan publication`,
        );
      }
      publishOptions = {
        ...options,
        expectedIdentityRevision: fenced.revision,
        expectedActivityRevision: fenced.activityRevision ?? fenced.revision,
      };
    } else {
      if (this.leases.current()) {
        throw new Error("Release the current Workflow Session before publishing into a new Session");
      }
      const snapshot = await this.bridge.refresh();
      const session = snapshot.session;
      if (session) {
        if (session.activeRunId) {
          throw new Error(
            `Workflow Session ${session.sessionId} has active Run ${session.activeRunId}; finish it before creating a new Session`,
          );
        }
        const ownership = await this.leases.ownership(session.sessionId, currentHostSessionId);
        if (ownership.state === "owned") {
          throw new Error(
            ownership.ownerHostSessionId === currentHostSessionId
              ? `Workflow Session ${session.sessionId} still has an attached lease; release it before creating a new Session`
              : `Workflow Session ${session.sessionId} is owned by Pi session ${ownership.ownerHostSessionId ?? "another host"}`,
          );
        }
      }
    }
    publishOptions = {
      ...publishOptions,
      requestId: requiredPlanPublishRequestId(publishOptions),
    };
    const privateCommand = await this.adapter.publishPlan(publishOptions);
    validatePlanPublishCommand(privateCommand, publishOptions);
    const command = projectPublicRunCliResult(privateCommand);
    return { command, snapshot: await this.bridge.refresh() };
  }

  async prepare(step: string): Promise<RunCliResult> {
    return projectPublicRunCliResult(await this.adapter.prepare(step));
  }

  async brief(runId?: string): Promise<RunCliResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const target = runId ?? activeWorkflowRun(snapshot)?.runId;
    if (!target) throw new Error("Workflow Session has no active Run");
    return projectPublicRunCliResult(await this.adapter.brief(target, session.sessionId));
  }

  async check(runId?: string): Promise<RunCliResult> {
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    const target = runId ?? activeWorkflowRun(snapshot)?.runId;
    if (!target) throw new Error("Workflow Session has no active Run");
    requireRun(session.runs, target);
    return projectPublicRunCliResult(await this.adapter.check(target, session.sessionId));
  }

  async next(pick?: string, context?: WorkflowHostContext): Promise<WorkflowTransitionResult> {
    const mode = await this.selectMode();
    if (mode === "fail-closed") throw this.failClosedMutationError("next");
    if (mode === "session-v3") {
      // v3 allocates the next chain-bound Run through the CAS envelope; there
      // is no lease and no --pick (the chain defines the candidate).
      return this.execV3(
        ["run", "next", "--json"],
        { write: true, sessionless: false, mutation: "session", lease: "none" },
        context?.hostSessionId,
      );
    }
    if (mode === "core-execution") {
      return this.exec(
        ["run", "next", ...(pick ? ["--pick", pick] : []), "--json"],
        { write: true, sessionless: false, mutation: "execution", lease: "required" },
        context?.hostSessionId,
      );
    }
    const currentHostSessionId = requireHostSessionId(context?.hostSessionId);
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    await this.requireMutationLease(session.sessionId, currentHostSessionId);
    const active = activeWorkflowRun(snapshot);
    if (active && ["created", "running", "blocked"].includes(active.status)) {
      return {
        command: projectPublicRunCliResult(await this.adapter.brief(active.runId, session.sessionId)),
        snapshot,
      };
    }
    await this.fenceLease(session.sessionId, currentHostSessionId);
    const result = projectPublicRunCliResult(await this.adapter.next(session.sessionId, pick));
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async done(
    runId: string,
    options: RunDoneOptions = {},
    context?: WorkflowHostContext,
  ): Promise<WorkflowTransitionResult> {
    const mode = await this.selectMode();
    if (mode === "fail-closed") throw this.failClosedMutationError("complete");
    if (mode === "session-v3") {
      // v3 completes atomically with --advance; needs-retry/blocked are v2
      // verdicts — v3 failed attempts go through run transition + retry.
      if (options.verdict === "needs-retry" || options.verdict === "blocked") {
        throw new Error(
          `verdict ${options.verdict} is retired for session/3.0; use run transition failed + run create --retry-of-run`,
        );
      }
      const argv = ["run", "complete", runId, "--advance",
        "--verdict", options.verdict === "done-with-concerns" ? "done_with_concerns" : "done"];
      if (options.summary) argv.push("--summary", options.summary);
      if (options.reason) argv.push("--reason", options.reason);
      for (const evidence of options.evidence ?? []) argv.push("--evidence", evidence);
      argv.push("--json");
      return this.execV3(
        argv,
        { write: true, sessionless: false, mutation: "run", lease: "none" },
        context?.hostSessionId,
      );
    }
    if (mode === "core-execution") {
      const argv = ["run", "complete", runId, "--verdict", options.verdict ?? "done"];
      if (options.summary) argv.push("--summary", options.summary);
      if (options.reason) argv.push("--reason", options.reason);
      for (const note of options.notes ?? []) argv.push("--note", note);
      for (const decision of options.decisions ?? []) argv.push("--decision", decision);
      for (const evidence of options.evidence ?? []) argv.push("--evidence", evidence);
      for (const artifact of options.artifacts ?? []) argv.push("--artifact", artifact);
      argv.push("--json");
      return this.exec(
        argv,
        { write: true, sessionless: false, mutation: "execution", lease: "required" },
        context?.hostSessionId,
      );
    }
    const currentHostSessionId = requireHostSessionId(context?.hostSessionId);
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    await this.requireMutationLease(session.sessionId, currentHostSessionId);
    requireRun(session.runs, runId);
    await this.fenceLease(session.sessionId, currentHostSessionId);
    const result = projectPublicRunCliResult(await this.adapter.done(runId, session.sessionId, options));
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  async edit(
    commands: readonly string[],
    options: Omit<RunEditOptions, "sessionId"> = {},
    context?: WorkflowHostContext,
  ): Promise<WorkflowTransitionResult> {
    const mode = await this.selectMode();
    if (mode === "fail-closed") throw this.failClosedMutationError("edit");
    if (mode === "session-v3") {
      // run edit is retired for session/3.0: chain editing is the explicit
      // session chain insert|skip|replace command family (core v3). Refuse
      // loudly instead of falling into the v2 lease path.
      throw new Error(
        "run edit is retired for session/3.0 workspaces; use session chain insert|skip|replace",
      );
    }
    if (mode === "core-execution") {
      return this.exec(
        ["run", "edit", ...commands, ...runEditArgv(options), "--json"],
        { write: true, sessionless: false, mutation: "execution", lease: "required" },
        context?.hostSessionId,
      );
    }
    const currentHostSessionId = requireHostSessionId(context?.hostSessionId);
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    await this.fenceLease(session.sessionId, currentHostSessionId);
    const result = projectPublicRunCliResult(
      await this.adapter.edit(commands, { ...options, sessionId: session.sessionId }),
    );
    return { command: result, snapshot: await this.bridge.refresh() };
  }

  /**
   * Raw Maestro CLI argv passthrough (run-control shell surface).
   * Write commands fence the mutation lease; sessionless entry commands
   * (create/start) are allowed without a held lease but refuse to mint a
   * second Session while one is held.
   */
  async exec(
    argv: readonly string[],
    classification: WorkflowRunControlClassification,
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    const mode = await this.selectMode();
    if (classification.write && classification.mutation === "artifact-republish") {
      if (argv[0] !== "artifact" || argv[1] !== "republish") {
        throw new Error(`Unknown Maestro artifact mutation: ${argv.slice(1).join(" ") || "(missing subcommand)"}`);
      }
      return this.execArtifactRepublish(argv, hostSessionId);
    }
    if (mode === "fail-closed" && classification.write) {
      throw this.failClosedMutationError(argv.slice(0, 3).join(" ") || "mutation");
    }
    if (mode === "session-v3") {
      return this.execV3(argv, classification, hostSessionId);
    }
    if (mode === "core-execution") {
      return this.execCore(argv, classification, hostSessionId);
    }
    if (classification.write && classification.mutation === "plan-publish") {
      return this.execLegacyRawPlanPublish(argv, hostSessionId);
    }
    if (classification.write) {
      if (classification.sessionless) {
        this.requireSessionlessWrite(argv);
      } else if (classification.lease !== "none") {
        const snapshot = await this.bridge.refresh();
        const session = requireSession(snapshot);
        await this.fenceLease(session.sessionId, hostSessionId);
      }
    }
    const command = projectPublicRunCliResult(await this.adapter.exec(argv));
    return { command, snapshot: await this.bridge.refresh() };
  }

  /**
   * session/3.0 raw Maestro argv passthrough (run-control shell surface).
   * Reads pass through unchanged; writes get the v3 mutation envelope
   * (participant/actor/request-id/reason/json and expected entity revisions)
   * injected by the coordinator, mirroring addV3MutationOptions in the core.
   * There is no mutation lease in v3: the core relies on participant identity
   * and entity-revision CAS instead.
   */
  private async execV3(
    argv: readonly string[],
    classification: WorkflowRunControlClassification,
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    if (!classification.write) {
      const command = projectPublicRunCliResult(await this.adapter.exec(argv));
      return { command, snapshot: await this.bridge.refresh() };
    }
    const prepared = await this.prepareV3MutationArgv(argv, hostSessionId);
    const privateCommand = await this.adapter.exec(prepared);
    let envelope = parseRunResponse(privateCommand.stdout);
    if (envelope.ok) {
      // Audit #4: bind the response to the dispatched request — operation and
      // request-id must match the injected v3 mutation envelope.
      const expectedOperation = expectedV3Operation(argv);
      const injectedRequestId = flagValue(prepared, "--request-id");
      if (expectedOperation && envelope.operation !== expectedOperation) {
        throw new RunResponseParseError(
          `v3 envelope operation mismatch: expected ${expectedOperation}, got ${envelope.operation}`,
        );
      }
      if (injectedRequestId && envelope.request_id !== injectedRequestId) {
        throw new RunResponseParseError(
          `v3 envelope request_id mismatch: expected ${injectedRequestId}, got ${envelope.request_id}`,
        );
      }
    }
    if (
      !envelope.ok
      && envelope.schema_version === "run-response/1.2"
      && envelope.error
      && isV3RevisionConflictCode(envelope.error.code)
    ) {
      // D3 constraint: a revision conflict is never replayed with a replaced
      // revision. Re-read authority so the hint can report the current CAS
      // revision, then surface the envelope's next_actions for the caller.
      const reReadHint = await this.v3ConflictReReadHint(argv);
      envelope = {
        ...envelope,
        error: { ...envelope.error, message: `${envelope.error.message} ${reReadHint}` },
      };
    }
    const command = projectPublicRunCliResult({
      ...privateCommand,
      stdout: JSON.stringify(projectPublicRunResponse(envelope)),
    });
    return { command, snapshot: await this.bridge.refresh() };
  }

  private async prepareV3MutationArgv(
    argv: readonly string[],
    hostSessionId?: string,
  ): Promise<string[]> {
    const participantId = requireHostSessionId(hostSessionId);
    const prepared = [...argv];
    addFlag(prepared, "--participant", participantId);
    addFlag(prepared, "--actor", participantId);
    // session migrate accepts participant/actor/json only (no request-id/reason).
    if (!isV3MigrateCommand(argv)) {
      addFlagIfMissing(prepared, "--request-id", randomUUID());
      addFlagIfMissing(prepared, "--reason", "Pi run-control v3 mutation");
    }
    addBooleanFlag(prepared, "--json");
    if (isV3OpenCommand(argv) || isV3MigrateCommand(argv)) {
      // Entry/migration commands mint or convert a Session: no CAS expected.
      return prepared;
    }
    const session = await this.requireV3Session(prepared);
    if (isV3OrchestrationTarget(argv)) {
      const revision = session.orchestrationRevision ?? this.v3ResumeRevisionCache;
      if (revision === undefined) {
        throw new Error("cannot determine expected orchestration revision; read session status first");
      }
      addFlag(prepared, "--expected-orchestration-revision", String(revision));
    }
    if (isV3RunTarget(argv)) {
      const runId = v3TargetRunId(argv);
      const run = session.runs.find((candidate) => candidate.runId === runId);
      if (!run || run.revision === undefined) {
        throw new Error("cannot determine expected run revision; read run brief first");
      }
      addFlag(prepared, "--expected-run-revision", String(run.revision));
    }
    return prepared;
  }

  /**
   * Target-aware v3 Session resolution: an explicit `--session` in the prepared
   * argv wins over the state.json-derived active Session. Without it the
   * cached/active snapshot is used (legacy state.json semantics). This fixes
   * mutations targeting a different Session than the stale active one — the
   * CAS revision was previously derived from the wrong Session.
   */
  private async requireV3Session(argv?: readonly string[]): Promise<WorkflowSession> {
    const explicitSessionId = argv ? optionalSingleFlag(argv, "--session") : undefined;
    let snapshot = this.bridge.getSnapshot();
    if (explicitSessionId && explicitSessionId !== snapshot?.session?.sessionId) {
      if (this.bridge.refreshSession) {
        snapshot = await this.bridge.refreshSession(explicitSessionId);
      } else {
        snapshot = await this.bridge.refresh();
      }
    } else if (!snapshot?.session) {
      snapshot = await this.bridge.refresh();
    }
    const session = snapshot.session;
    if (!session) {
      throw new Error("cannot determine expected orchestration revision; read session status first");
    }
    return session;
  }

  /**
   * Re-reads the CAS authority the failed v3 mutation targeted (session status
   * for orchestration targets, run brief for run targets) and returns a hint
   * that reports the current revision and explicitly refuses auto-replay.
   */
  private async v3ConflictReReadHint(argv: readonly string[]): Promise<string> {
    if (isV3RunTarget(argv)) {
      const runId = v3TargetRunId(argv);
      try {
        const command = await this.adapter.exec(["run", "brief", runId, "--json"]);
        const envelope = parseRunResponse(command.stdout);
        const revision = v3ReReadRevision(envelope, true);
        return `Re-read authority via 'maestro run brief ${runId} --json' `
          + `(current Run revision ${revision}); the mutation was not replayed — `
          + "re-read the Run brief and retry with the current --expected-run-revision.";
      } catch {
        return `Re-read authority via 'maestro run brief ${runId} --json'; `
          + "the mutation was not replayed — re-read the Run brief and retry with "
          + "the current --expected-run-revision.";
      }
    }
    try {
      const command = await this.adapter.exec(["session", "status", "--json"]);
      const envelope = parseRunResponse(command.stdout);
      const revision = v3ReReadRevision(envelope, false);
      return `Re-read authority via 'maestro session status --json' `
        + `(current orchestration revision ${revision}); the mutation was not replayed — `
        + "re-read session status and retry with the current --expected-orchestration-revision.";
    } catch {
      return `Re-read authority via 'maestro session status --json'; `
        + "the mutation was not replayed — re-read session status and retry with "
        + "the current --expected-orchestration-revision.";
    }
  }

  private async attachV3(hostSessionId: string, explicitSessionId?: string): Promise<WorkflowAttachResult> {
    requireHostSessionId(hostSessionId);
    const snapshot = await this.bridge.refresh();
    const session = snapshot.session;
    if (!session) throw new Error("No active canonical Workflow Session");
    if (explicitSessionId && explicitSessionId !== session.sessionId) {
      throw new Error(`Active Workflow Session is ${session.sessionId}, not ${explicitSessionId}`);
    }
    const run = activeWorkflowRun(snapshot);
    const brief = run
      ? projectPublicRunCliResult(await this.adapter.brief(run.runId, session.sessionId))
      : undefined;
    // session/3.0 has no lease to acquire or heartbeat: return the projected
    // snapshot (and active Run brief) without lease metadata. The core's
    // ResumeMapV1 (`session resume-view --json`) is the v3 restore entry
    // point; its orchestration revision is cached for CAS fallback. A failed
    // resume-map validation never blocks the attach.
    const resumeMap = await this.v3ResumeMap();
    if (resumeMap) {
      this.v3ResumeRevisionCache = resumeMap.orchestrationRevision;
    }
    return {
      snapshot,
      ...(brief ? { brief } : {}),
      ...(resumeMap ? { resumeMap } : {}),
    };
  }

  /**
   * Consumes the session/3.0 resume projection (`session resume-view --json`).
   * The v3 core returns a run-response/1.2 envelope whose result is the core
   * ResumeMapV1. Validation mirrors the core guards: no forbidden
   * execution/lease/operation field names, fingerprint matches the stable-JSON
   * body hash, and the map fits RESUME_MAP_MAX_UTF8_BYTES. Any failure records
   * a diagnostic and returns null so recovery never blocks on a bad resume map.
   */
  private async v3ResumeMap(): Promise<ResumeMapV1 | null> {
    this.v3ResumeMapDiagnostics.length = 0;
    try {
      const command = await this.adapter.exec(["session", "resume-view", "--json"]);
      const envelope = parseRunResponse(command.stdout);
      if (!envelope.ok || envelope.schema_version !== "run-response/1.2") {
        this.v3ResumeMapDiagnostics.push(
          `session resume-view returned ${envelope.schema_version} ${envelope.ok ? "success" : "error"} envelope`,
        );
        return null;
      }
      const result = recordValue(envelope.result);
      if (!result) {
        this.v3ResumeMapDiagnostics.push("session resume-view result is not a ResumeMapV1 record");
        return null;
      }
      if (resumeMapHasForbiddenFields(result)) {
        this.v3ResumeMapDiagnostics.push("ResumeMapV1 contains forbidden execution/lease/operation field names");
        return null;
      }
      if (!resumeMapFingerprintMatches(result)) {
        this.v3ResumeMapDiagnostics.push("ResumeMapV1 fingerprint does not match the resume body");
        return null;
      }
      if (resumeMapUtf8Bytes(result) > RESUME_MAP_MAX_UTF8_BYTES) {
        this.v3ResumeMapDiagnostics.push(
          `ResumeMapV1 exceeds ${RESUME_MAP_MAX_UTF8_BYTES} UTF-8 bytes`,
        );
        return null;
      }
      if (!resumeMapShapeValid(result)) {
        this.v3ResumeMapDiagnostics.push("ResumeMapV1 is missing required identity fields");
        return null;
      }
      return result as unknown as ResumeMapV1;
    } catch (error) {
      this.v3ResumeMapDiagnostics.push(
        `session resume-view consumption failed: ${publicWorkflowErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async execArtifactRepublish(
    argv: readonly string[],
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    const mutation = this.coreMutationWork.then(
      () => this.performArtifactRepublish(argv, hostSessionId),
    );
    this.coreMutationWork = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async performArtifactRepublish(
    argv: readonly string[],
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    const ownerId = requireHostSessionId(hostSessionId);
    const capabilities = this.core.capabilities;
    if (
      capabilities?.mode !== "structured"
      || capabilities.support["run-response/1.2"] !== true
      || capabilities.support.artifact_compatibility_v1 !== true
    ) {
      throw new Error(
        "Artifact republish refused: structured artifact_compatibility_v1 and run-response/1.2 support are required",
      );
    }

    const artifactId = requiredArtifactId(argv);
    const sessionId = requireSingleFlag(argv, "--session");
    const consumer = requireSingleFlag(argv, "--consumer");
    const alias = requireSingleFlag(argv, "--alias");
    const prepared = [...argv];
    addFlag(prepared, "--participant", ownerId);
    addFlag(prepared, "--actor", ownerId);
    addFlagIfMissing(prepared, "--request-id", randomUUID());
    addFlagIfMissing(prepared, "--reason", "Republish Artifact compatibility through Pi run-control");
    addFlagIfMissing(prepared, "--evidence", `pi-session:${ownerId}`);
    addBooleanFlag(prepared, "--json");

    const inspectedCommand = await this.adapter.exec([
      "artifact", "inspect", artifactId,
      "--session", sessionId,
      "--consumer", consumer,
      "--alias", alias,
      "--json",
    ]);
    const inspected = parseRunResponse(inspectedCommand.stdout);
    const assessment = artifactInspectionAuthority(inspected, artifactId, sessionId);
    assertArtifactWriterMode(capabilities, assessment.sessionSchemaVersion);
    addFlag(prepared, "--assessment-hash", assessment.assessmentHash);
    addFlag(prepared, "--expected-artifact-revision", String(assessment.artifactRevision));
    addFlag(prepared, "--expected-orchestration-revision", String(assessment.sessionRevision));

    const privateCommand = await this.adapter.exec(prepared);
    const envelope = parseRunResponse(privateCommand.stdout);
    validateArtifactRepublishEnvelope(
      envelope,
      artifactId,
      sessionId,
      requireSingleFlag(prepared, "--request-id"),
    );
    const command = projectPublicRunCliResult({
      ...privateCommand,
      stdout: JSON.stringify(projectPublicRunResponse(envelope)),
    });
    return { command, snapshot: await this.bridge.refresh() };
  }

  private async execLegacyRawPlanPublish(
    argv: readonly string[],
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    const ownerId = requireHostSessionId(hostSessionId);
    if (!await this.adapter.supportsPlanPublish()) {
      throw new Error("Legacy-host Plan publication refused: installed Maestro CLI does not support plan publish");
    }
    const before = await this.bridge.refresh();
    const session = requireSession(before);
    await this.fenceLease(session.sessionId, ownerId);
    const fenced = requireSession(await this.bridge.refresh());
    if (fenced.sessionId !== session.sessionId) {
      throw new Error("Legacy-host Plan publication refused: canonical Workflow Session changed while fencing");
    }
    const prepared = [...argv];
    const handoffKey = requireSingleFlag(prepared, "--handoff-key");
    const requestId = optionalSingleFlag(prepared, "--request-id") ?? derivePlanPublishRequestId(handoffKey);
    addFlag(prepared, "--session", fenced.sessionId);
    addFlag(prepared, "--expected-identity-revision", String(fenced.revision));
    addFlag(prepared, "--expected-activity-revision", String(fenced.activityRevision ?? fenced.revision));
    addFlag(prepared, "--request-id", requestId);
    addBooleanFlag(prepared, "--json");

    const privateCommand = await this.adapter.exec(prepared);
    const envelope = parseRunResponse(privateCommand.stdout);
    validatePlanPublishEnvelope(envelope, handoffKey, requestId);
    const refreshed = await this.bridge.refresh();
    validateLegacyRawPlanPublishSnapshot(refreshed, envelope, fenced.sessionId, handoffKey, requestId);
    return {
      command: projectPublicRunCliResult({
        ...privateCommand,
        stdout: JSON.stringify(projectPublicRunResponse(envelope)),
      }),
      snapshot: refreshed,
    };
  }

  continuationMarker(iteration: number): string {
    const snapshot = this.bridge.getSnapshot();
    if (!snapshot) throw new Error("Coordinator is not attached");
    const session = requireSession(snapshot);
    const run = activeWorkflowRun(snapshot);
    if (!run || run.status !== "running") throw new Error("No running Run owns continuation");
    if (hasBlockingFailure(run.gates)) {
      throw new Error("Blocking gate failure prevents continuation");
    }
    const epoch = this.selectedMode === "core-execution"
      ? this.requireCoreContinuationEpoch(session.sessionId)
      : this.selectedMode === "session-v3"
        ? session.orchestrationRevision ?? 0
        : this.requireLegacyContinuationEpoch(session.sessionId);
    const marker: ContinuationMarker = {
      sessionId: session.sessionId,
      runId: run.runId,
      iteration,
      epoch,
      nonce: randomUUID(),
    };
    this.pendingContinuation = marker;
    return `${MARKER_PREFIX}${Buffer.from(JSON.stringify(marker)).toString("base64url")}`;
  }

  acceptsContinuation(markerText: string): boolean {
    const marker = parseMarker(markerText);
    const expected = this.pendingContinuation;
    const currentEpoch = this.selectedMode === "core-execution"
      ? this.core.fence?.lease_epoch ?? undefined
      : this.selectedMode === "session-v3"
        ? this.bridge.getSnapshot()?.session?.orchestrationRevision ?? undefined
        : this.leases.current()?.epoch;
    const snapshot = this.bridge.getSnapshot();
    const run = snapshot ? activeWorkflowRun(snapshot) : undefined;
    const accepted = Boolean(
      marker
      && expected
      && currentEpoch !== undefined
      && snapshot?.session
      && run
      && run.status === "running"
      && !hasBlockingFailure(run.gates)
      && sameMarker(marker, expected)
      && marker.sessionId === snapshot.session.sessionId
      && marker.runId === run.runId
      && marker.epoch === currentEpoch,
    );
    if (accepted) this.pendingContinuation = undefined;
    return accepted;
  }

  async fenceContinuation(): Promise<void> {
    this.pendingContinuation = undefined;
    if (this.selectedMode === "fail-closed") throw this.failClosedMutationError("continuation fence");
    if (this.selectedMode === "core-execution") return;
    // session/3.0 has no lease to fence; continuation acceptance is revision-based.
    if (this.selectedMode === "session-v3") return;
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    await this.fenceLease(session.sessionId);
  }

  async release(): Promise<void> {
    this.pendingContinuation = undefined;
    if (this.selectedMode === "fail-closed") return;
    // session/3.0 holds no local lease to release.
    if (this.selectedMode === "session-v3") return;
    if (this.selectedMode === "core-execution") {
      this.stopCoreHeartbeat();
      try {
        if (this.core.claim && this.core.locator && this.core.fence) {
          await this.execCore(
            ["execution", "lease", "release", "--json"],
            { write: true, sessionless: false, mutation: "execution-lease", lease: "required" },
            this.core.ownerId,
          );
        }
      } finally {
        this.clearCoreAuthority();
      }
      return;
    }
    await this.stopHeartbeat();
    try {
      await this.leases.release();
    } catch (error) {
      throw new Error(publicWorkflowErrorMessage(error));
    }
  }

  private async attachCore(hostSessionId: string, explicitSessionId?: string): Promise<WorkflowAttachResult> {
    const ownerId = requireHostSessionId(hostSessionId);
    this.requireCoreCapabilities();
    const snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    if (explicitSessionId && explicitSessionId !== session.sessionId) {
      throw new Error(`Active Workflow Session is ${session.sessionId}, not ${explicitSessionId}`);
    }
    const locator = requireCoreExecutionLocator(snapshot);
    const transition = await this.execCore(
      ["execution", "attach", "--json"],
      { write: true, sessionless: false, mutation: "execution-acquire", lease: "acquire" },
      ownerId,
    );
    const run = activeWorkflowRun(transition.snapshot);
    const brief = run
      ? projectPublicRunCliResult(await this.adapter.brief(run.runId, session.sessionId))
      : undefined;
    const fence = requireCoreFence(this.core.fence);
    return {
      snapshot: transition.snapshot,
      ...(brief ? { brief } : {}),
      lease: {
        sessionId: locator.sessionId,
        executionId: locator.executionId,
        generation: locator.generation,
        ownerId,
        epoch: requiredRevision(fence.lease_epoch, "lease epoch"),
        executionRevision: requiredRevision(fence.execution_revision, "execution revision"),
      },
    };
  }

  private async publishPlanV3(
    options: RunPlanPublishOptions,
    context: WorkflowHostContext,
  ): Promise<WorkflowTransitionResult> {
    requireHostSessionId(context.hostSessionId);
    const requestId = requiredPlanPublishRequestId(options);
    const sessionId = options.sessionId?.trim()
      || `plan-${createHash("sha256").update(requestId).digest("hex").slice(0, 12)}`;
    // 1. Open the v3 Session with a stable derived request id. Idempotent: the
    //    core replays the original receipt when the same request-id is retried,
    //    and re-opening an existing Session is a no-op receipt.
    const openResult = await this.execV3(
      ["session", "open", options.intent ?? "Execute approved Plan", "--id", sessionId,
        "--request-id", `req_plan_open_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`,
        "--json"],
      { write: true, sessionless: false, mutation: "session", lease: "none" },
      context.hostSessionId,
    );
    const openEnvelope = parseRunResponse(openResult.command.stdout);
    if (!openEnvelope.ok) {
      throw new Error(`v3 Plan Session open failed: ${publicWorkflowErrorMessage(
        new Error(openEnvelope.error?.message ?? "session open rejected"),
      )}`);
    }
    // 2. Persist the approved Plan document under .workflow/plans/ (Pi-side
    //    convention; the core v3 surface has no plan command).
    const planDir = join(this.leases.root(), ".workflow", "plans");
    await mkdir(planDir, { recursive: true });
    const planFile = join(planDir, `${sessionId}-${options.planRevision}.md`);
    const source = await readFile(options.sourcePath, "utf8");
    await writeFile(planFile, source);
    // 3. Insert the plan chain step with an explicit target: the bridge has no
    //    state.json active Session under v3, so the CAS revision must resolve
    //    through the explicit --session (target-aware refreshSession).
    const insertResult = await this.execV3(
      ["session", "chain", "insert", "--session", sessionId,
        "--step-id", `plan-${options.planRevision}`,
        "--command", "plan", "--goal-ref", planFile,
        "--request-id", `req_plan_insert_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`,
        "--json"],
      { write: true, sessionless: false, mutation: "session", lease: "none" },
      context.hostSessionId,
    );
    const insertEnvelope = parseRunResponse(insertResult.command.stdout);
    if (!insertEnvelope.ok) {
      throw new Error(`v3 Plan chain step insert failed: ${publicWorkflowErrorMessage(
        new Error(insertEnvelope.error?.message ?? "chain insert rejected"),
      )}`);
    }
    // 4. Synthetic plan-publish envelope for the Pi plan-workflow consumers
    //    (PublishedPlanIdentity shape) backed by the persisted document.
    const checksum = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    const envelope = {
      schema_version: "run-response/1.2",
      operation: "plan-publish",
      request_id: requestId,
      locator: { session_id: sessionId, run_id: null },
      revision: null,
      replay: null,
      warnings: [],
      ok: true,
      exit_code: 0,
      disposition: "success",
      result: {
        session_id: sessionId,
        run_id: `plan-${sessionId}-${options.planRevision}`,
        artifact_id: `plan:${sessionId}:${options.planRevision}`,
        source_checksum: checksum,
        handoff_key: options.handoffKey,
        request_id: requestId,
      },
      error: null,
      next: null,
      continuation: null,
    };
    return {
      command: {
        argv: ["plan", "publish", "--json"],
        stdout: JSON.stringify(envelope),
        stderr: "",
        exitCode: 0,
      },
      snapshot: await this.bridge.refresh(),
    };
  }

  private async publishPlanCore(
    options: RunPlanPublishOptions,
    context: WorkflowHostContext,
  ): Promise<WorkflowTransitionResult> {
    this.requireCoreCapabilities();
    const hostSessionId = requireHostSessionId(context.hostSessionId);
    if (!options.sessionId) {
      const mutation = this.coreMutationWork.then(
        () => this.performCoreNewPlanPublish(options, hostSessionId),
      );
      this.coreMutationWork = mutation.then(() => undefined, () => undefined);
      return mutation;
    }
    let snapshot = await this.bridge.refresh();
    const session = requireSession(snapshot);
    if (options.sessionId && session.sessionId !== options.sessionId) {
      throw new Error(
        `Approved Plan targets Workflow Session ${options.sessionId}, but the active canonical Session is ${session.sessionId}`,
      );
    }

    if (!optionalCoreExecutionLocator(snapshot)) {
      if (snapshot.execution || snapshot.locator?.executionId) {
        throw new Error("Core Plan publication refused: canonical Execution locator is incomplete");
      }
      await this.execCore(
        [
          "execution", "start",
          "--reason", "Publish approved Pi Plan",
          "--evidence", `pi-plan-request:${requiredPlanPublishRequestId(options)}`,
        ],
        { write: true, sessionless: false, mutation: "execution-acquire", lease: "acquire" },
        hostSessionId,
      );
      snapshot = await this.bridge.refresh();
      requireSession(snapshot);
    }

    const publishOptions = this.corePlanPublishOptions(options, hostSessionId, snapshot);

    const mutation = this.coreMutationWork.then(() => this.performCorePlanPublish(publishOptions, hostSessionId));
    this.coreMutationWork = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async performCoreNewPlanPublish(
    options: RunPlanPublishOptions,
    hostSessionId: string,
  ): Promise<WorkflowTransitionResult> {
    this.requireCoreCapabilities();
    const requestId = options.requestId || derivePlanPublishRequestId(options.handoffKey);
    const sessionId = derivePlanSessionId(options.handoffKey);
    const startRequestId = derivePlanExecutionStartRequestId(options.handoffKey);
    const intent = requiredPlanIntent(options.intent ?? options.topic, options.handoffKey);

    let snapshot = await this.bridge.refresh();
    if (snapshot.session?.sessionId !== sessionId) {
      try {
        const created = await this.adapter.exec([
          "session", "create", intent,
          "--id", sessionId,
          "--intent", intent,
          "--json",
        ]);
        const envelope = parseRunResponse(created.stdout);
        if (created.exitCode === 0) {
          validateCorePlanSessionCreate(envelope, sessionId);
        } else if (!isRecoverablePlanSessionCreate(envelope, sessionId)) {
          throw new Error(
            `${envelope.error?.code ?? "UNKNOWN"}: ${envelope.error?.message ?? "unknown failure"}`,
          );
        }
        snapshot = await this.bridge.refresh();
        validateCorePlanSessionSnapshot(snapshot, sessionId, intent);
      } catch (error) {
        throw new Error(
          `Core Plan identity step for deterministic Session ${sessionId} can be retried with the same approved Plan: `
          + publicWorkflowErrorMessage(error),
        );
      }
    } else {
      validateCorePlanSessionSnapshot(snapshot, sessionId, intent);
    }

    if (!this.hasCorePlanClaim(snapshot, sessionId, hostSessionId)) {
      await this.acquireCorePlanExecution(sessionId, startRequestId, hostSessionId);
      snapshot = await this.bridge.refresh();
    }
    const locator = requireCoreExecutionLocator(snapshot);
    if (locator.sessionId !== sessionId || locator.generation !== 1) {
      throw new Error(
        `Core Plan recovery expected Session ${sessionId} generation 1, but canonical authority is `
        + `${locator.sessionId} generation ${locator.generation}`,
      );
    }

    try {
      const publishOptions = this.corePlanPublishOptions(
        { ...options, sessionId, requestId },
        hostSessionId,
        snapshot,
      );
      return await this.performCorePlanPublish(publishOptions, hostSessionId);
    } catch (error) {
      if (this.core.claim) this.startCoreHeartbeat();
      throw new Error(
        `Core Plan publication for deterministic Session ${sessionId} can be retried with the same approved Plan: `
        + publicWorkflowErrorMessage(error),
      );
    }
  }

  private async acquireCorePlanExecution(
    sessionId: string,
    requestId: string,
    hostSessionId: string,
  ): Promise<void> {
    let commandDispatched = false;
    try {
      commandDispatched = true;
      const privateCommand = await this.adapter.exec([
        "execution", "start",
        "--session", sessionId,
        "--request-id", requestId,
        "--execution-owner", hostSessionId,
        "--owner-kind", "pi",
        "--expected-lease-epoch", "0",
        "--expected-identity-revision", "1",
        "--expected-activity-revision", "0",
        "--actor", hostSessionId,
        "--reason", "Start generation 1 for approved Pi Plan",
        "--evidence", `pi-session:${hostSessionId}`,
        "--json",
      ]);
      const envelope = parseRunResponse(privateCommand.stdout);
      if (privateCommand.exitCode !== 0 || envelope.schema_version !== "run-response/1.1"
        || envelope.operation !== "execution-start") {
        throw new Error(
          `${envelope.error?.code ?? "EXECUTION_START_FAILED"}: `
          + `${envelope.error?.message ?? "generation-1 acquisition failed"}`,
        );
      }
      const candidate = this.stageCoreMutationResponse(
        envelope,
        "execution-acquire",
        "acquire",
        hostSessionId,
        true,
      );
      validateCorePlanExecutionStart(envelope, sessionId, requestId, candidate);
      const refreshed = await this.bridge.refresh();
      this.validateCorePostcondition(refreshed, envelope, candidate);
      this.commitCoreMutation(candidate);
      if (this.core.claim) this.startCoreHeartbeat();
    } catch (error) {
      if (commandDispatched) this.loseCoreClaim();
      throw new Error(
        `Core Plan Execution start for deterministic Session ${sessionId} is recoverable with request_id ${requestId}: `
        + publicWorkflowErrorMessage(error),
      );
    }
  }

  private hasCorePlanClaim(
    snapshot: WorkflowSnapshot,
    sessionId: string,
    hostSessionId: string,
  ): boolean {
    const locator = optionalCoreExecutionLocator(snapshot);
    if (!locator || locator.sessionId !== sessionId || locator.generation !== 1) return false;
    const fence = this.core.fence;
    const lease = snapshot.execution?.lease;
    return Boolean(
      this.core.claim
      && this.core.ownerId === hostSessionId
      && fence
      && lease
      && lease.sessionId === sessionId
      && lease.executionId === locator.executionId
      && lease.ownerId === hostSessionId
      && lease.epoch === fence.lease_epoch,
    );
  }

  private corePlanPublishOptions(
    options: RunPlanPublishOptions,
    hostSessionId: string,
    snapshot: WorkflowSnapshot,
  ): RunPlanPublishOptions {
    const session = requireSession(snapshot);
    const locator = requireCoreExecutionLocator(snapshot);
    if (options.sessionId && locator.sessionId !== options.sessionId) {
      throw new Error("Core Plan publication refused: current Execution belongs to a different Session");
    }
    const claim = this.core.claim;
    const fence = requireCoreFence(this.core.fence ?? coreFenceFromSnapshot(snapshot));
    if (!claim || this.core.ownerId !== hostSessionId) {
      throw new Error("Core Plan publication refused: no valid transient core lease claim is held");
    }
    const lease = snapshot.execution?.lease;
    const leaseEpoch = requiredRevision(fence.lease_epoch, "lease epoch");
    if (!lease
      || lease.sessionId !== locator.sessionId
      || lease.executionId !== locator.executionId
      || lease.ownerId !== hostSessionId
      || lease.epoch !== leaseEpoch) {
      throw new Error("Core Plan publication refused: canonical snapshot does not confirm the held core lease");
    }
    if (snapshot.execution?.status !== "active" || snapshot.execution.activeRunId) {
      throw new Error(
        `Core Plan publication requires an idle active Execution; current Run is ${snapshot.execution?.activeRunId ?? "<none>"}`,
      );
    }
    if (snapshot.execution.chain.length > 0
      && !snapshot.execution.chain.some((step) => step.command === "execute" && step.status === "pending")) {
      throw new Error("Core Plan publication requires an empty chain or a pending execute step in the current Execution");
    }

    return {
      ...options,
      sessionId: locator.sessionId,
      sourcePiSession: options.sourcePiSession || hostSessionId,
      expectedIdentityRevision: session.revision,
      expectedActivityRevision: session.activityRevision ?? session.revision,
      requestId: options.requestId || derivePlanPublishRequestId(options.handoffKey),
      executionId: locator.executionId,
      generation: locator.generation,
      expectedExecutionRevision: requiredRevision(fence.execution_revision, "execution revision"),
      executionOwner: hostSessionId,
      ownerKind: "pi",
      ownerEpoch: leaseEpoch,
      leaseId: claim.lease_id,
      actor: hostSessionId,
      reason: options.reason || "Publish approved Pi Plan into current Execution",
      evidence: options.evidence?.length ? options.evidence : [`pi-session:${hostSessionId}`],
    };
  }

  private async performCorePlanPublish(
    options: RunPlanPublishOptions,
    hostSessionId: string,
  ): Promise<WorkflowTransitionResult> {
    let commandDispatched = false;
    try {
      const snapshot = await this.bridge.refresh();
      const locator = requireCoreExecutionLocator(snapshot);
      this.assertCoreLocatorBinding(locator);
      if (!this.core.claim || this.core.ownerId !== hostSessionId) {
        throw new Error("Core Plan publication refused: no valid transient core lease claim is held");
      }
      commandDispatched = true;
      const privateCommand = await this.adapter.publishPlan(options);
      const envelope = parseRunResponse(privateCommand.stdout);
      validatePlanPublishEnvelope(
        envelope,
        options.handoffKey,
        requiredPlanPublishRequestId(options),
      );
      if (envelope.schema_version !== "run-response/1.1" || envelope.operation !== "plan-publish") {
        throw new Error("Core Plan publication requires a plan-publish run-response/1.1 result");
      }
      const candidate = this.stageCoreMutationResponse(
        envelope,
        "execution",
        "required",
        hostSessionId,
      );
      const command = projectPublicRunCliResult({
        ...privateCommand,
        stdout: JSON.stringify(projectPublicRunResponse(envelope)),
      });
      const refreshed = await this.bridge.refresh();
      this.validateCorePostcondition(refreshed, envelope, candidate);
      this.commitCoreMutation(candidate);
      return { command, snapshot: refreshed };
    } catch (error) {
      if (commandDispatched && !await this.recoverCorePlanClaim(hostSessionId)) this.loseCoreClaim();
      throw new Error(publicWorkflowErrorMessage(error));
    }
  }

  private async recoverCorePlanClaim(hostSessionId: string): Promise<boolean> {
    const claim = this.core.claim;
    const previousLocator = this.core.locator;
    if (!claim || !previousLocator || this.core.ownerId !== hostSessionId) return false;
    try {
      const snapshot = await this.bridge.refresh();
      const locator = requireCoreExecutionLocator(snapshot);
      const lease = snapshot.execution?.lease;
      if (!sameCoreLocator(locator, previousLocator)
        || !lease
        || lease.sessionId !== locator.sessionId
        || lease.executionId !== locator.executionId
        || lease.ownerId !== hostSessionId
        || lease.epoch < 1) return false;
      this.core.locator = locator;
      this.core.fence = coreFenceFromSnapshot(snapshot);
      this.core.lastLeaseEpoch = Math.max(this.core.lastLeaseEpoch ?? 0, lease.epoch);
      this.startCoreHeartbeat();
      return true;
    } catch {
      return false;
    }
  }

  private async execCore(
    argv: readonly string[],
    classification: WorkflowRunControlClassification,
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    if (!classification.write) {
      const command = projectPublicRunCliResult(await this.adapter.exec(argv));
      return { command, snapshot: await this.bridge.refresh() };
    }

    const mutation = this.coreMutationWork.then(
      () => this.performCoreMutation(argv, classification, hostSessionId),
    );
    this.coreMutationWork = mutation.then(() => undefined, () => undefined);
    const transition = await mutation;
    if (["acquire", "command-aware"].includes(classification.lease ?? "") && this.core.claim) {
      this.startCoreHeartbeat();
    }
    if (!this.core.claim) this.stopCoreHeartbeat();
    return transition;
  }

  private async performCoreMutation(
    argv: readonly string[],
    classification: WorkflowRunControlClassification,
    hostSessionId?: string,
  ): Promise<WorkflowTransitionResult> {
    let commandDispatched = false;
    try {
      this.requireCoreCapabilities();
      const snapshot = await this.bridge.refresh();
      const mutation = classification.mutation ?? "execution";
      const leaseMode = resolveCoreLeaseMode(
        argv,
        snapshot,
        mutation,
        classification.lease ?? "required",
      );
      const prepared = this.prepareCoreMutationArgv(
        argv,
        snapshot,
        mutation,
        leaseMode,
        hostSessionId,
      );
      commandDispatched = true;
      let privateCommand: RunCliResult;
      try {
        privateCommand = await this.adapter.exec(prepared);
      } catch (error) {
        if (mutation !== "compatibility-start" || leaseMode !== "acquire") throw error;
        privateCommand = await this.adapter.exec(prepared);
      }
      const envelope = parseRunResponse(privateCommand.stdout);
      if (envelope.schema_version !== "run-response/1.1") {
        throw new Error("Core-execution mutation requires a run-response/1.1 result");
      }
      validateRunResponseRequestId(envelope, prepared);
      if (mutation === "plan-publish") validateRawPlanPublishEnvelope(envelope, prepared);
      const expectedOperation = expectedCoreOperation(argv, leaseMode);
      if (expectedOperation && envelope.operation !== expectedOperation) {
        throw new Error(
          `Core-execution mutation returned operation ${envelope.operation}, expected ${expectedOperation}`,
        );
      }
      const candidate = this.stageCoreMutationResponse(
        envelope,
        mutation,
        leaseMode,
        hostSessionId,
        isCanonicalExecutionStart(argv) || (isCompatibilityStart(argv) && leaseMode === "acquire"),
      );
      const command = projectPublicRunCliResult({
        ...privateCommand,
        stdout: JSON.stringify(projectPublicRunResponse(envelope)),
      });
      const refreshed = await this.refreshCorePostconditionSnapshot(
        snapshot,
        candidate,
        mutation,
        leaseMode,
      );
      this.validateCorePostcondition(refreshed, envelope, candidate);
      this.commitCoreMutation(candidate);
      return { command, snapshot: refreshed };
    } catch (error) {
      // After dispatch, a write may have committed even when transport,
      // parsing, or canonical reload failed. Preflight refusal is known not to
      // have mutated authority, so the current claim remains valid.
      if (commandDispatched) this.loseCoreClaim();
      throw new Error(publicWorkflowErrorMessage(error));
    }
  }

  private async refreshCorePostconditionSnapshot(
    before: WorkflowSnapshot,
    candidate: CoreMutationCandidate | undefined,
    mutation: NonNullable<WorkflowRunControlClassification["mutation"]>,
    leaseMode: "none" | "required" | "acquire",
  ): Promise<WorkflowSnapshot> {
    if (mutation === "compatibility-start" && leaseMode === "acquire" && !before.session && candidate) {
      if (!this.bridge.refreshSession) {
        throw new Error("Canonical Workflow bridge cannot reload the Session returned by a fresh compatibility start");
      }
      return this.bridge.refreshSession(candidate.locator.sessionId);
    }
    return this.bridge.refresh();
  }

  private prepareCoreMutationArgv(
    argv: readonly string[],
    snapshot: WorkflowSnapshot,
    mutation: NonNullable<WorkflowRunControlClassification["mutation"]>,
    leaseMode: "none" | "required" | "acquire",
    hostSessionId?: string,
  ): string[] {
    const prepared = [...argv];
    if (mutation === "session") {
      const command = argv[1] ?? argv[0];
      if (command !== "create") {
        const session = requireSession(snapshot);
        addFlag(prepared, "--session", session.sessionId);
        addFlag(prepared, "--expected-identity-revision", String(session.revision));
        addFlag(prepared, "--expected-activity-revision", String(session.activityRevision ?? session.revision));
      }
      addFlagIfMissing(prepared, "--request-id", randomUUID());
      if (hostSessionId) {
        const actor = requireHostSessionId(hostSessionId);
        addFlag(prepared, "--actor", actor);
        if (command !== "create") {
          addFlagIfMissing(prepared, "--reason", `Pi coordinator session-${command}`);
          addFlagIfMissing(prepared, "--evidence", `pi-session:${actor}`);
        }
      }
      addBooleanFlag(prepared, "--json");
      return prepared;
    }

    if (mutation === "plan-publish") {
      return this.prepareCorePlanPublishArgv(prepared, snapshot, hostSessionId);
    }

    const ownerId = requireHostSessionId(hostSessionId);
    const compatibilityStart = mutation === "compatibility-start" && isCompatibilityStart(argv);
    const starting = (mutation === "execution-acquire" && isCanonicalExecutionStart(argv))
      || (compatibilityStart && leaseMode === "acquire");
    const session = snapshot.session;
    const locator = starting
      ? session ? { sessionId: session.sessionId } : undefined
      : requireCoreExecutionLocator(snapshot);
    if (locator && "executionId" in locator) this.assertCoreLocatorBinding(locator);
    if (locator) addFlag(prepared, "--session", locator.sessionId);
    if (locator && "executionId" in locator) {
      addFlag(prepared, "--execution", locator.executionId);
      if (compatibilityStart) addFlag(prepared, "--generation", String(locator.generation));
    }
    addFlagIfMissing(prepared, "--request-id", randomUUID());

    const snapshotFence = session ? coreFenceFromSnapshot(snapshot) : undefined;
    const observedFence = this.core.fence ?? snapshotFence;
    if (requiresActivityRevision(argv)) {
      addFlag(
        prepared,
        "--expected-activity-revision",
        String(starting && !session
          ? 0
          : requiredRevision(observedFence?.session_activity_revision, "session activity revision")),
      );
    }
    if (leaseMode === "acquire") {
      addFlag(prepared, compatibilityStart ? "--owner-id" : "--execution-owner", ownerId);
      addFlag(prepared, "--owner-kind", "pi");
      addFlag(
        prepared,
        "--expected-lease-epoch",
        String(starting ? 0 : this.core.lastLeaseEpoch ?? observedFence?.lease_epoch ?? 0),
      );
      if (!starting && observedFence?.execution_revision !== null && observedFence?.execution_revision !== undefined) {
        addFlag(prepared, "--expected-execution-revision", String(observedFence.execution_revision));
      }
      if (starting) {
        addFlag(
          prepared,
          "--expected-identity-revision",
          String(session
            ? requiredRevision(observedFence?.session_identity_revision, "session identity revision")
            : 1),
        );
      }
    } else {
      const fence = requireCoreFence(this.core.fence ?? snapshotFence);
      addFlag(
        prepared,
        "--expected-execution-revision",
        String(requiredRevision(fence.execution_revision, "execution revision")),
      );
      if (leaseMode === "required") {
        const claim = this.core.claim;
        if (!claim) throw new Error("Core-execution mutation refused: no transient core lease claim is held");
        if (this.core.ownerId !== ownerId) {
          throw new Error(
            `Core-execution mutation claim belongs to Pi session ${this.core.ownerId ?? "unknown"}, `
            + `but this call came from Pi session ${ownerId}`,
          );
        }
        addFlag(prepared, compatibilityStart ? "--owner-id" : "--execution-owner", ownerId);
        addFlag(prepared, "--owner-kind", "pi");
        addFlag(
          prepared,
          compatibilityStart ? "--lease-epoch" : "--owner-epoch",
          String(requiredRevision(fence.lease_epoch, "lease epoch")),
        );
        addFlag(prepared, "--lease-id", claim.lease_id);
      }
    }
    if (requiresExecutionAudit(argv) || (compatibilityStart && leaseMode === "acquire")) {
      addFlag(prepared, "--actor", ownerId);
      addFlagIfMissing(prepared, "--reason", `Pi coordinator ${expectedCoreOperation(argv, leaseMode) ?? "mutation"}`);
      addFlagIfMissing(prepared, "--evidence", `pi-session:${ownerId}`);
    }
    addBooleanFlag(prepared, "--json");
    return prepared;
  }

  private prepareCorePlanPublishArgv(
    prepared: string[],
    snapshot: WorkflowSnapshot,
    hostSessionId?: string,
  ): string[] {
    const ownerId = requireHostSessionId(hostSessionId);
    const session = requireSession(snapshot);
    const locator = requireCoreExecutionLocator(snapshot);
    this.assertCoreLocatorBinding(locator);
    const fence = requireCoreFence(this.core.fence ?? coreFenceFromSnapshot(snapshot));
    const claim = this.core.claim;
    if (!claim) throw new Error("Core Plan publication refused: no transient core lease claim is held");
    if (this.core.ownerId !== ownerId) {
      throw new Error(
        `Core Plan publication claim belongs to Pi session ${this.core.ownerId ?? "unknown"}, `
        + `but this call came from Pi session ${ownerId}`,
      );
    }
    const handoffKey = requireSingleFlag(prepared, "--handoff-key");
    const requestId = optionalSingleFlag(prepared, "--request-id") ?? derivePlanPublishRequestId(handoffKey);
    addFlag(prepared, "--session", locator.sessionId);
    addFlag(prepared, "--execution", locator.executionId);
    addFlag(prepared, "--generation", String(locator.generation));
    addFlag(prepared, "--request-id", requestId);
    addFlag(prepared, "--expected-identity-revision", String(session.revision));
    addFlag(prepared, "--expected-activity-revision", String(session.activityRevision ?? session.revision));
    addFlag(
      prepared,
      "--expected-execution-revision",
      String(requiredRevision(fence.execution_revision, "execution revision")),
    );
    addFlag(prepared, "--execution-owner", ownerId);
    addFlag(prepared, "--owner-kind", "pi");
    addFlag(prepared, "--owner-epoch", String(requiredRevision(fence.lease_epoch, "lease epoch")));
    addFlag(prepared, "--lease-id", claim.lease_id);
    addFlag(prepared, "--actor", ownerId);
    addFlagIfMissing(prepared, "--reason", "Publish approved Plan through Pi run-control");
    addFlagIfMissing(prepared, "--evidence", `pi-session:${ownerId}`);
    addBooleanFlag(prepared, "--json");
    return prepared;
  }

  private stageCoreMutationResponse(
    envelope: PrivateRunResponseEnvelope,
    mutation: NonNullable<WorkflowRunControlClassification["mutation"]>,
    leaseMode: "none" | "required" | "acquire",
    hostSessionId?: string,
    allowsNewLocator = false,
  ): CoreMutationCandidate | undefined {
    if (envelope.schema_version !== "run-response/1.1") {
      throw new Error("Core-execution mutation requires a run-response/1.1 result");
    }
    if (!envelope.ok) {
      const code = envelope.error?.code ?? "UNKNOWN";
      const message = envelope.error?.message ?? "Core-execution mutation failed";
      throw new Error(`${code}: ${message}`);
    }
    if (mutation === "session") return undefined;
    const locator = runResponseCoreLocator(envelope);
    const fence = requireCoreFence(envelope.fence);
    if (!allowsNewLocator && this.core.locator && !sameCoreLocator(this.core.locator, locator)) {
      throw new Error("Core-execution mutation returned a different Execution locator");
    }
    let claim: RunLeaseClaim | undefined;
    let ownerId: string | undefined;
    if (leaseMode === "acquire") {
      claim = extractRunResponseLeaseClaim(envelope) ?? undefined;
      if (!claim) throw new Error("Core-execution acquisition returned no private lease claim");
      ownerId = requireHostSessionId(hostSessionId);
      validateAcquisitionClaim(claim, ownerId, fence);
    }
    return {
      locator,
      fence,
      ...(claim ? { claim } : {}),
      ...(ownerId ? { ownerId } : {}),
      releasesLease: releasesCoreLease(envelope.operation),
    };
  }

  private commitCoreMutation(candidate: CoreMutationCandidate | undefined): void {
    if (!candidate) return;
    this.core.locator = candidate.locator;
    this.core.fence = candidate.fence;
    if (candidate.fence.lease_epoch !== null) {
      this.core.lastLeaseEpoch = Math.max(this.core.lastLeaseEpoch ?? 0, candidate.fence.lease_epoch);
    }
    if (candidate.claim) {
      this.core.claim = candidate.claim;
      this.core.ownerId = candidate.ownerId;
    }
    if (candidate.releasesLease) {
      this.core.claim = undefined;
      this.core.ownerId = undefined;
    }
  }

  private requireCoreCapabilities(): RunCliCapabilities {
    const capabilities = this.core.capabilities;
    if (!capabilities || !hasCompleteCoreCapabilities(capabilities)) {
      throw new Error(
        "Core-execution mutation refused: structured session_statusless, execution_generation, "
        + "core_execution_lease, and run-response/1.1 support are all required",
      );
    }
    return capabilities;
  }

  private observeCoreSnapshot(snapshot: WorkflowSnapshot): void {
    const locator = optionalCoreExecutionLocator(snapshot);
    if (!locator) {
      if (snapshot.locator?.executionId || snapshot.execution) {
        throw new Error("Canonical Workflow snapshot contains an incomplete core Execution locator");
      }
      return;
    }
    this.assertCoreLocatorBinding(locator);
    this.core.locator = locator;
    if (!this.core.fence) this.core.fence = coreFenceFromSnapshot(snapshot);
    const observedEpoch = snapshot.execution?.lease?.epoch;
    if (observedEpoch !== undefined) {
      this.core.lastLeaseEpoch = Math.max(this.core.lastLeaseEpoch ?? 0, observedEpoch);
    }
  }

  private validateCorePostcondition(
    snapshot: WorkflowSnapshot,
    envelope: PrivateRunResponseEnvelope,
    candidate: CoreMutationCandidate | undefined,
  ): void {
    if (!candidate || envelope.schema_version !== "run-response/1.1") return;
    const operation = envelope.operation;
    if (operation === "execution-seal") {
      const session = requireSession(snapshot);
      if (
        session.sessionId !== candidate.locator.sessionId
        || snapshot.locator?.executionId
        || snapshot.execution
      ) {
        throw new Error("Canonical Workflow snapshot does not prove the sealed Execution was cleared");
      }
      return;
    }

    const locator = requireCoreExecutionLocator(snapshot);
    if (!sameCoreLocator(locator, candidate.locator)) {
      throw new Error("Canonical Workflow Execution locator does not match the core mutation response");
    }
    const execution = snapshot.execution!;
    const responseRevision = requiredRevision(candidate.fence.execution_revision, "execution revision");
    if (execution.revision !== responseRevision) {
      throw new Error("Canonical Workflow Execution revision does not match the core mutation response");
    }
    if (operation === "execution-pause") {
      if (execution.status !== "paused" || execution.lease !== null) {
        throw new Error("Canonical Workflow snapshot does not prove pause released the core lease");
      }
      return;
    }
    if (operation === "execution-lease-release") {
      if (execution.lease !== null) {
        throw new Error("Canonical Workflow snapshot does not prove the core lease was released");
      }
      return;
    }
    if (!candidate.releasesLease) {
      const claimOwner = candidate.ownerId ?? this.core.ownerId;
      const claim = candidate.claim ?? this.core.claim;
      if (claim) {
        const lease = execution.lease;
        const epoch = requiredRevision(candidate.fence.lease_epoch, "lease epoch");
        if (
          !lease
          || lease.sessionId !== locator.sessionId
          || lease.executionId !== locator.executionId
          || lease.ownerId !== claimOwner
          || lease.epoch !== epoch
        ) {
          throw new Error("Canonical Workflow snapshot does not confirm the current core lease owner and epoch");
        }
      }
    }
  }

  private assertCoreLocatorBinding(locator: CoreExecutionLocator): void {
    if (this.core.locator && !sameCoreLocator(this.core.locator, locator)) {
      throw new Error("Canonical Workflow Execution changed while a core lease claim is held");
    }
  }

  private requireCoreContinuationEpoch(sessionId: string): number {
    if (this.core.locator?.sessionId !== sessionId || !this.core.claim) {
      throw new Error("Workflow continuation core lease claim is not held");
    }
    return requiredRevision(this.core.fence?.lease_epoch ?? null, "lease epoch");
  }

  private requireLegacyContinuationEpoch(sessionId: string): number {
    const lease = this.leases.current();
    if (!lease || lease.sessionId !== sessionId) throw new Error("Workflow continuation lease is not held");
    return lease.epoch;
  }

  private clearCoreAuthority(): void {
    this.core.claim = undefined;
    this.core.fence = undefined;
    this.core.locator = undefined;
    this.core.ownerId = undefined;
    this.core.lastLeaseEpoch = undefined;
  }

  private loseCoreClaim(): void {
    this.stopCoreHeartbeat();
    this.pendingContinuation = undefined;
    this.core.claim = undefined;
    this.core.fence = undefined;
    this.core.ownerId = undefined;
  }

  private async initializeAuthority(): Promise<WorkflowCoordinatorMode> {
    this.pendingContinuation = undefined;
    await this.stopHeartbeat();
    try {
      await this.leases.release();
    } catch (error) {
      this.authorityDiagnostic = `legacy authority teardown failed: ${publicWorkflowErrorMessage(error)}`;
      this.selectedMode = "fail-closed";
      return this.selectedMode;
    }
    if (!this.adapter.capabilities) {
      this.authorityDiagnostic = "adapter exposes no structured core authority capabilities";
      this.selectedMode = this.options.legacyCompatibility ? "legacy-host" : "fail-closed";
      return this.selectedMode;
    }
    let capabilities: RunCliCapabilities;
    try {
      capabilities = await this.adapter.capabilities();
    } catch (error) {
      this.authorityDiagnostic = `capability negotiation failed: ${publicWorkflowErrorMessage(error)}`;
      this.selectedMode = "fail-closed";
      return this.selectedMode;
    }
    this.core.capabilities = capabilities;
    this.authorityDiagnostic = capabilities.diagnostic ?? undefined;
    if (capabilities.mode === "legacy") {
      this.authorityDiagnostic ??= "installed CLI exposes legacy read compatibility only";
      this.selectedMode = this.options.legacyCompatibility ? "legacy-host" : "fail-closed";
      return this.selectedMode;
    }
    if (capabilities.protocol === "session-run-v3") {
      // Plan-B v3 core detected. The Pi Session/Run CAS adapter is implemented:
      // session-v3 mode speaks the v3 protocol directly and never touches the
      // retired v2 lease/generation machinery.
      this.selectedMode = "session-v3";
      return this.selectedMode;
    }
    if (!hasCompleteCoreCapabilities(capabilities)) {
      this.authorityDiagnostic ??= "installed CLI does not expose complete core-execution capabilities";
      this.selectedMode = "fail-closed";
      return this.selectedMode;
    }
    try {
      const snapshot = await this.bridge.refresh();
      if (snapshot.execution?.legacyProjection) {
        this.authorityDiagnostic = "canonical Session uses the legacy session/1.x lifecycle";
        this.selectedMode = "legacy-host";
        return this.selectedMode;
      }
      this.observeCoreSnapshot(snapshot);
    } catch (error) {
      this.authorityDiagnostic = `canonical Execution negotiation failed: ${publicWorkflowErrorMessage(error)}`;
      this.selectedMode = "fail-closed";
      return this.selectedMode;
    }
    this.selectedMode = "core-execution";
    return this.selectedMode;
  }

  private failClosedMutationError(operation: string): Error {
    const diagnostic = this.authorityDiagnostic ? ` (${this.authorityDiagnostic})` : "";
    return new Error(
      `Workflow mutation refused for ${operation}: coordinator authority mode is fail-closed${diagnostic}`,
    );
  }

  private startCoreHeartbeat(): void {
    this.stopCoreHeartbeat();
    const generation = ++this.coreHeartbeatGeneration;
    const timer = setInterval(() => {
      if (
        this.coreHeartbeatGeneration !== generation
        || this.coreHeartbeatPending
        || !this.core.claim
        || !this.core.ownerId
      ) return;
      this.coreHeartbeatPending = true;
      void this.execCore(
        ["execution", "lease", "heartbeat", "--json"],
        { write: true, sessionless: false, mutation: "execution-lease", lease: "required" },
        this.core.ownerId,
      ).catch(() => {
        if (this.coreHeartbeatGeneration === generation) this.loseCoreClaim();
      }).finally(() => {
        this.coreHeartbeatPending = false;
      });
    }, this.heartbeatEveryMs);
    timer.unref?.();
    this.coreHeartbeatTimer = timer;
  }

  private stopCoreHeartbeat(): void {
    this.coreHeartbeatGeneration += 1;
    if (this.coreHeartbeatTimer) clearInterval(this.coreHeartbeatTimer);
    this.coreHeartbeatTimer = undefined;
  }

  private async fenceLease(sessionId: string, currentHostSessionId?: string): Promise<void> {
    await this.requireMutationLease(sessionId, currentHostSessionId);
    this.pendingContinuation = undefined;
    await this.stopHeartbeat();
    const lease = await this.leases.fence();
    this.startHeartbeat(lease);
  }

  private async requireMutationLease(
    sessionId: string,
    currentHostSessionId?: string,
  ): Promise<WorkflowLease> {
    const hostSessionId = currentHostSessionId === undefined
      ? undefined
      : requireHostSessionId(currentHostSessionId);
    const lease = this.leases.current();
    if (!lease) {
      if (!hostSessionId) throw new Error("Workflow mutation lease is not held");
      const ownership = await this.leases.ownership(sessionId, hostSessionId);
      if (ownership.ownerHostSessionId) {
        const freshness = ownership.state === "stale" ? "stale" : "active";
        throw new Error(
          `Workflow mutation lease is not held by Pi session ${hostSessionId}; `
          + `Workflow Session ${sessionId} has a ${freshness} lease owned by Pi session `
          + `${ownership.ownerHostSessionId} (epoch ${ownership.epoch}, heartbeat ${ownership.heartbeatAt})`,
        );
      }
      throw new Error(
        `Workflow mutation lease is not held by Pi session ${hostSessionId}; attach Workflow Session ${sessionId} first`,
      );
    }
    if (lease.sessionId !== sessionId) {
      throw new Error(
        `Workflow mutation lease belongs to ${lease.sessionId}, but the active canonical Session is ${sessionId}`,
      );
    }
    if (hostSessionId && lease.hostSessionId !== hostSessionId) {
      throw new Error(
        `Workflow mutation lease belongs to Pi session ${lease.hostSessionId}, `
        + `but this run-control call came from Pi session ${hostSessionId}`,
      );
    }
    return lease;
  }

  /**
   * Entry commands (create/start) may run without a held lease, but must not
   * mint a second Session (or target another Session) while this Pi session
   * holds the active mutation lease.
   */
  private requireSessionlessWrite(argv: readonly string[]): void {
    const lease = this.leases.current();
    if (!lease) return;
    const target = extractSessionId(argv);
    if (!target) {
      throw new Error(
        `Workflow mutation lease is already held for ${lease.sessionId}; `
        + "release it before creating a new Session",
      );
    }
    if (target !== lease.sessionId) {
      throw new Error(
        `Workflow mutation lease belongs to ${lease.sessionId}, but this command targets Session ${target}`,
      );
    }
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

function runEditArgv(options: Omit<RunEditOptions, "sessionId">): string[] {
  return [
    ...(options.after ? ["--after", options.after] : []),
    ...(options.replace ? ["--replace", options.replace] : []),
    ...(options.remove ? ["--remove", options.remove] : []),
    ...(options.args ? ["--args", options.args] : []),
    ...(options.stage ? ["--stage", options.stage] : []),
    ...(options.goalRef ? ["--goal-ref", options.goalRef] : []),
    ...(options.insertedBy ? ["--inserted-by", options.insertedBy] : []),
  ];
}

function optionalCoreExecutionLocator(snapshot: WorkflowSnapshot): CoreExecutionLocator | undefined {
  const locator = snapshot.locator;
  const execution = snapshot.execution;
  if (
    snapshot.source !== "canonical"
    || !locator?.executionId
    || locator.generation === undefined
    || !execution
    || execution.legacyProjection
    || execution.executionId !== locator.executionId
    || execution.sessionId !== locator.sessionId
    || execution.generation !== locator.generation
  ) return undefined;
  return {
    sessionId: locator.sessionId,
    executionId: locator.executionId,
    generation: locator.generation,
  };
}

function requireCoreExecutionLocator(snapshot: WorkflowSnapshot): CoreExecutionLocator {
  const locator = optionalCoreExecutionLocator(snapshot);
  if (!locator) {
    throw new Error(
      "Core-execution mutation refused: a current non-legacy Session/Execution/generation locator is required",
    );
  }
  return locator;
}

function coreFenceFromSnapshot(snapshot: WorkflowSnapshot): RunResponseFenceV11 {
  const session = requireSession(snapshot);
  return {
    session_identity_revision: session.revision,
    session_activity_revision: session.activityRevision ?? session.revision,
    execution_revision: snapshot.revision.executionRevision ?? snapshot.execution?.revision ?? null,
    lease_epoch: snapshot.execution?.lease?.epoch ?? null,
  };
}

function requireCoreFence(fence: RunResponseFenceV11 | null | undefined): RunResponseFenceV11 {
  if (!fence) throw new Error("Core-execution mutation refused: a current core fence is required");
  return fence;
}

function runResponseCoreLocator(envelope: PrivateRunResponseEnvelope): CoreExecutionLocator {
  if (envelope.schema_version !== "run-response/1.1") {
    throw new Error("Core-execution mutation requires a run-response/1.1 locator");
  }
  const locator = envelope.locator;
  if (!locator?.session_id || !locator.execution_id || locator.generation === null) {
    throw new Error("Core-execution mutation returned no complete Session/Execution/generation locator");
  }
  return {
    sessionId: locator.session_id,
    executionId: locator.execution_id,
    generation: locator.generation,
  };
}

function requiredRevision(value: number | null | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new Error(`Core-execution mutation refused: ${name} is required`);
  }
  return value as number;
}

interface ArtifactInspectionAuthority {
  assessmentHash: string;
  artifactRevision: number;
  sessionRevision: number;
  sessionSchemaVersion: string;
}

function artifactInspectionAuthority(
  envelope: PrivateRunResponseEnvelope,
  artifactId: string,
  sessionId: string,
): ArtifactInspectionAuthority {
  if (envelope.schema_version !== "run-response/1.2" || envelope.operation !== "artifact-inspect") {
    throw new Error("Artifact republish preflight requires an artifact-inspect run-response/1.2 result");
  }
  if (!envelope.ok) {
    throw new Error(`${envelope.error?.code ?? "ARTIFACT_INSPECT_FAILED"}: ${envelope.error?.message ?? "Artifact inspection failed"}`);
  }
  if (
    envelope.locator?.session_id !== sessionId
    || envelope.revision?.target_type !== "artifact"
    || envelope.revision.target_id !== artifactId
  ) {
    throw new Error("Artifact inspect response does not match the requested Session and Artifact authority");
  }
  const result = recordValue(envelope.result);
  const source = recordValue(result?.source);
  const assessmentHash = typeof result?.assessment_hash === "string" ? result.assessment_hash : "";
  const artifactRevision = source?.artifact_registry_revision;
  const sessionRevision = source?.session_revision;
  const sessionSchemaVersion = typeof source?.session_schema_version === "string"
    ? source.session_schema_version
    : "";
  if (
    !assessmentHash
    || !Number.isSafeInteger(artifactRevision)
    || (artifactRevision as number) < 0
    || !Number.isSafeInteger(sessionRevision)
    || (sessionRevision as number) < 0
    || !sessionSchemaVersion
    || envelope.revision.revision !== artifactRevision
  ) {
    throw new Error("Artifact inspect response does not contain a complete assessment and CAS authority");
  }
  return {
    assessmentHash,
    artifactRevision: artifactRevision as number,
    sessionRevision: sessionRevision as number,
    sessionSchemaVersion,
  };
}

function assertArtifactWriterMode(capabilities: RunCliCapabilities, sessionSchemaVersion: string): void {
  const v3Writer = sessionSchemaVersion === "session/3.0";
  if (v3Writer && capabilities.protocol !== "session-run-v3") {
    throw new Error("Artifact republish refused: session/3.0 requires negotiated Session/Run v3 writer support");
  }
  if (!v3Writer && capabilities.protocol === "session-run-v3") {
    throw new Error(
      `Artifact republish refused: negotiated Session/Run v3 writer does not match ${sessionSchemaVersion} authority`,
    );
  }
  if (!/^session\/(?:1\.[0-3]|2\.0|3\.0)$/.test(sessionSchemaVersion)) {
    throw new Error(`Artifact republish refused: unsupported Session writer ${sessionSchemaVersion}`);
  }
}

function validateArtifactRepublishEnvelope(
  envelope: PrivateRunResponseEnvelope,
  sourceArtifactId: string,
  sessionId: string,
  requestId: string,
): void {
  if (envelope.schema_version !== "run-response/1.2" || envelope.operation !== "artifact-republish") {
    throw new Error("Artifact republish requires an artifact-republish run-response/1.2 result");
  }
  if (envelope.request_id !== requestId || envelope.locator?.session_id !== sessionId) {
    throw new Error("Artifact republish response does not match the dispatched request and Session authority");
  }
  if (!envelope.ok) return;
  const result = recordValue(envelope.result);
  const receipt = recordValue(result?.receipt);
  if (
    result?.source_artifact_id !== sourceArtifactId
    || receipt?.schema_version !== "artifact-republish/1.0"
    || envelope.revision?.target_type !== "artifact"
    || envelope.replay === null
  ) {
    throw new Error("Artifact republish response does not contain complete applied Artifact authority");
  }
}

function requiredArtifactId(argv: readonly string[]): string {
  const artifactId = argv[2]?.trim();
  if (!artifactId || artifactId.startsWith("-")) {
    throw new Error("Artifact republish requires a positional Artifact ID");
  }
  return artifactId;
}

function sameCoreLocator(left: CoreExecutionLocator, right: CoreExecutionLocator): boolean {
  return left.sessionId === right.sessionId
    && left.executionId === right.executionId
    && left.generation === right.generation;
}

function hasCompleteCoreCapabilities(capabilities: RunCliCapabilities): boolean {
  const structured = capabilities.structured;
  return capabilities.mode === "structured"
    && structured?.schema_version === "maestro-capabilities/1.0"
    && Array.isArray(structured.session_schema_writes)
    && structured.session_schema_writes.includes("session/2.0")
    && Array.isArray(structured.execution_schema_writes)
    && structured.execution_schema_writes.includes("execution/1.0")
    && Array.isArray(structured.run_response_writes)
    && structured.run_response_writes.includes("run-response/1.1")
    && structured.features?.session_statusless === true
    && structured.features.execution_generation === true
    && structured.features.core_execution_lease === true
    && capabilities.support?.execution_generation === true
    && capabilities.support.core_execution_lease === true
    && capabilities.support["run-response/1.1"] === true;
}

function expectedCoreOperation(
  argv: readonly string[],
  leaseMode: "none" | "required" | "acquire" = "required",
): string | undefined {
  if (argv[0] === "plan" && argv[1] === "publish") return "plan-publish";
  if (isCompatibilityStart(argv)) {
    if (leaseMode === "acquire") return "execution-start";
    return compatibilityStartCreatesRun(argv) ? "create" : "next";
  }
  if (argv[0] !== "execution") return undefined;
  if (argv[1] === "lease" || argv[1] === "handoff") {
    return `execution-${argv[1]}-${argv[2] ?? ""}`;
  }
  return `execution-${argv[1] ?? ""}`;
}

function isCanonicalExecutionStart(argv: readonly string[]): boolean {
  return argv[0] === "execution" && argv[1] === "start";
}

function isCompatibilityStart(argv: readonly string[]): boolean {
  return (argv[0] === "session" || argv[0] === "run") && argv[1] === "start";
}

function compatibilityStartCreatesRun(argv: readonly string[]): boolean {
  if (argv[0] === "run") return optionalSingleFlag(argv, "--cmd") !== undefined;
  const chainIndex = argv.findIndex((argument) => argument === "--chain" || argument.startsWith("--chain="));
  if (chainIndex < 0) return false;
  const inline = argv[chainIndex]!.startsWith("--chain=")
    ? argv[chainIndex]!.slice("--chain=".length)
    : argv[chainIndex + 1];
  return Boolean(inline?.trim());
}

/** session/3.0 entry command that mints a new Session with no CAS expected revision. */
function isV3OpenCommand(argv: readonly string[]): boolean {
  return argv[0] === "session" && argv[1] === "open";
}

/** session migrate accepts participant/actor/json but not request-id/reason or CAS. */
function isV3MigrateCommand(argv: readonly string[]): boolean {
  return argv[0] === "session" && argv[1] === "migrate";
}

/** Run-target v3 mutations carry --expected-run-revision (run complete also needs orchestration). */
function isV3RunTarget(argv: readonly string[]): boolean {
  return argv[0] === "run" && ["complete", "transition", "cancel", "seal"].includes(argv[1] ?? "");
}

/**
 * Orchestration-target v3 mutations carry --expected-orchestration-revision:
 * session chain insert/skip/replace, run next/create/decide, session
 * complete/archive, and run complete (which advances the chain).
 * session open is handled before this check (no CAS for a brand-new Session).
 */
function isV3OrchestrationTarget(argv: readonly string[]): boolean {
  if (argv[0] === "run") {
    return ["next", "create", "decide", "complete"].includes(argv[1] ?? "");
  }
  if (argv[0] !== "session") return false;
  const command = argv[1] ?? "";
  if (["complete", "archive", "unarchive"].includes(command)) return true;
  return command === "chain" && ["insert", "skip", "replace"].includes(argv[2] ?? "");
}

function v3TargetRunId(argv: readonly string[]): string {
  const flagged = optionalSingleFlag(argv, "--run");
  if (flagged) return flagged;
  const runId = argv[2]?.trim();
  if (!runId || runId.startsWith("-")) {
    throw new Error("cannot determine expected run revision; read run brief first");
  }
  return runId;
}

function isV3RevisionConflictCode(code: string): boolean {
  return code === "ORCHESTRATION_REVISION_CONFLICT" || code === "RUN_REVISION_CONFLICT";
}

/** Extracts the current CAS revision from a re-read 1.2 envelope result. */
function v3ReReadRevision(envelope: PrivateRunResponseEnvelope, runTarget: boolean): string {
  if (envelope.schema_version !== "run-response/1.2") return "unknown";
  const result = recordValue(envelope.result);
  if (envelope.revision?.revision !== undefined) return String(envelope.revision.revision);
  if (result && runTarget && typeof result.revision === "number") return String(result.revision);
  if (result && !runTarget && typeof result.orchestration_revision === "number") {
    return String(result.orchestration_revision);
  }
  return "unknown";
}

function resolveCoreLeaseMode(
  argv: readonly string[],
  snapshot: WorkflowSnapshot,
  mutation: NonNullable<WorkflowRunControlClassification["mutation"]>,
  requested: NonNullable<WorkflowRunControlClassification["lease"]>,
): "none" | "required" | "acquire" {
  if (requested !== "command-aware") return requested;
  if (mutation !== "compatibility-start" || !isCompatibilityStart(argv)) {
    throw new Error("Core-execution mutation has an invalid command-aware lease classification");
  }
  return optionalCoreExecutionLocator(snapshot) ? "required" : "acquire";
}

function requiresActivityRevision(argv: readonly string[]): boolean {
  return isCanonicalExecutionStart(argv)
    || isCompatibilityStart(argv)
    || (argv[0] === "execution" || argv[0] === "session")
      && (argv[1] === "resume" || argv[1] === "seal");
}

function requiresExecutionAudit(argv: readonly string[]): boolean {
  if (argv[0] !== "execution") return false;
  if (["start", "pause", "resolve", "resume", "seal"].includes(argv[1] ?? "")) return true;
  if (argv[1] === "handoff") return ["prepare", "accept", "cancel"].includes(argv[2] ?? "");
  return argv[1] === "lease" && argv[2] === "recover";
}

function releasesCoreLease(operation: string): boolean {
  return ["execution-pause", "execution-seal", "execution-lease-release"].includes(operation);
}

function addFlag(argv: string[], flag: string, value: string): void {
  const matches: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === flag) {
      matches.push(argv[index + 1] ?? "");
    } else if (argument.startsWith(`${flag}=`)) {
      matches.push(argument.slice(flag.length + 1));
    }
  }
  if (matches.length === 0) {
    argv.push(flag, value);
    return;
  }
  if (matches.length !== 1 || matches[0] !== value) {
    throw new Error(`Core-execution mutation refused: ${flag} conflicts with coordinator authority`);
  }
}

function addFlagIfMissing(argv: string[], flag: string, value: string): void {
  if (argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`))) return;
  argv.push(flag, value);
}

function addBooleanFlag(argv: string[], flag: string): void {
  if (!argv.includes(flag)) argv.push(flag);
}

function requireSingleFlag(argv: readonly string[], flag: string): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === flag) values.push(argv[index + 1] ?? "");
    else if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
  }
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`Core-execution mutation requires exactly one non-empty ${flag}`);
  }
  return values[0];
}

function optionalSingleFlag(argv: readonly string[], flag: string): string | undefined {
  const matches: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === flag) matches.push(argv[index + 1] ?? "");
    else if (argument.startsWith(`${flag}=`)) matches.push(argument.slice(flag.length + 1));
  }
  if (matches.length > 1 || (matches.length === 1 && !matches[0]?.trim())) {
    throw new Error(`Core-execution mutation requires at most one non-empty ${flag}`);
  }
  return matches[0];
}

function validateRunResponseRequestId(
  envelope: PrivateRunResponseEnvelope,
  argv: readonly string[],
): void {
  const requestId = optionalSingleFlag(argv, "--request-id");
  if (requestId && envelope.ok && envelope.request_id !== requestId) {
    throw new Error("Core-execution mutation response request_id does not match the dispatched request");
  }
}

function validateAcquisitionClaim(
  claim: RunLeaseClaim,
  ownerId: string,
  fence: RunResponseFenceV11,
): void {
  const record = claim as Record<string, unknown>;
  if (record.owner_id !== ownerId
    || record.owner_kind !== "pi"
    || record.epoch !== requiredRevision(fence.lease_epoch, "lease epoch")) {
    throw new Error("Core-execution acquisition returned a lease claim for different authority");
  }
}

function validateRawPlanPublishEnvelope(
  envelope: PrivateRunResponseEnvelope,
  argv: readonly string[],
): void {
  const handoffKey = requireSingleFlag(argv, "--handoff-key");
  const requestId = requireSingleFlag(argv, "--request-id");
  validatePlanPublishEnvelope(envelope, handoffKey, requestId);
}

function requiredPlanPublishRequestId(options: RunPlanPublishOptions): string {
  if (options.requestId !== undefined) {
    const explicit = options.requestId.trim();
    if (!explicit) throw new Error("Plan publication request ID must be non-empty");
    return explicit;
  }
  return derivePlanPublishRequestId(options.handoffKey);
}

function validatePlanPublishCommand(
  command: RunCliResult,
  options: RunPlanPublishOptions,
): void {
  const envelope = parseRunResponse(command.stdout);
  validatePlanPublishEnvelope(
    envelope,
    options.handoffKey,
    requiredPlanPublishRequestId(options),
  );
}

function validatePlanPublishEnvelope(
  envelope: PrivateRunResponseEnvelope,
  expectedHandoffKey: string,
  expectedRequestId: string,
): void {
  if (!envelope.ok || envelope.operation !== "plan-publish" || envelope.request_id !== expectedRequestId) {
    throw new Error("Plan publication returned an invalid operation or request binding");
  }
  const result = recordValue(envelope.result);
  if (result?.request_id !== expectedRequestId || result.handoff_key !== expectedHandoffKey) {
    throw new Error("Plan publication response does not match the approved handoff and request identity");
  }
}

function validateLegacyRawPlanPublishSnapshot(
  snapshot: WorkflowSnapshot,
  envelope: PrivateRunResponseEnvelope,
  expectedSessionId: string,
  expectedHandoffKey: string,
  expectedRequestId: string,
): void {
  const result = recordValue(envelope.result);
  const session = snapshot.session;
  const sessionId = typeof result?.session_id === "string" ? result.session_id : undefined;
  const runId = typeof result?.run_id === "string" ? result.run_id : undefined;
  const artifactId = typeof result?.artifact_id === "string" ? result.artifact_id : undefined;
  if (!session || session.sessionId !== expectedSessionId || sessionId !== expectedSessionId
    || !runId || !artifactId || snapshot.canonicalClaim?.status === "invalid") {
    throw new Error("Legacy-host Plan publication canonical result does not match the fenced Session");
  }
  const artifact = session.artifacts.find((candidate) => candidate.artifactId === artifactId);
  const producer = session.runs.find((candidate) => candidate.runId === runId);
  const handoff = producer?.handoff;
  const artifactRefs = Array.isArray(handoff?.artifact_refs) ? handoff.artifact_refs : [];
  const expectedHandoffHash = `sha256:${createHash("sha256").update(expectedHandoffKey, "utf8").digest("hex")}`;
  if (!artifact || artifact.status !== "sealed" || artifact.runId !== runId
    || session.aliases["current-plan"] !== artifactId
    || !producer || producer.command !== "plan-publish" || producer.status !== "sealed"
    || producer.primaryArtifactId !== artifactId
    || handoff?.producer_run_id !== runId || handoff.command !== "plan-publish"
    || !["ready", "ready_with_concerns"].includes(String(handoff.verdict))
    || !artifactRefs.includes(artifactId)
    || producer.planPublication?.requestId !== expectedRequestId
    || producer.planPublication.handoffKeyHash !== expectedHandoffHash) {
    throw new Error("Legacy-host Plan publication did not become the canonical current-plan authority");
  }
}

/** Public projection for coordinator and run-control result surfaces. */
export function projectPublicRunCliResult(result: RunCliResult): RunCliResult {
  let stdout: string;
  try {
    stdout = JSON.stringify(redactPublicSecrets(projectPublicRunResponse(parseRunResponse(result.stdout))));
  } catch {
    try {
      stdout = JSON.stringify(redactPublicSecrets(JSON.parse(result.stdout) as unknown));
    } catch {
      stdout = redactSensitiveText(result.stdout);
    }
  }
  const secrets = privateArgvValues(result.argv);
  return {
    ...result,
    argv: redactLeaseArgv(result.argv),
    stdout: redactPrivateValues(stdout, secrets),
    stderr: redactPrivateValues(redactSensitiveText(result.stderr), secrets),
  };
}

function redactLeaseArgv(argv: readonly string[]): string[] {
  let redactNext = false;
  const positionalHandoffToken = argv[0] === "execution" && argv[1] === "handoff" && argv[2] === "accept";
  return argv.map((argument, index) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (positionalHandoffToken && index === 3 && !argument.startsWith("-")) return "<redacted>";
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
    if (isSecretFlag(flag)) {
      if (equalsAt >= 0) return `${flag}=<redacted>`;
      redactNext = true;
      return argument;
    }
    return redactSensitiveText(argument);
  });
}

function isSecretFlag(flag: string): boolean {
  return flag === "--lease-id"
    || flag === "--handoff-key"
    || /^--[a-z0-9-]*token[a-z0-9-]*$/i.test(flag);
}

function privateArgvValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  const positionalHandoffToken = argv[0] === "execution" && argv[1] === "handoff" && argv[2] === "accept";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (positionalHandoffToken && index === 3 && !argument.startsWith("-")) values.push(argument);
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
    if (!isSecretFlag(flag)) continue;
    const value = equalsAt >= 0 ? argument.slice(equalsAt + 1) : argv[index + 1];
    if (value) values.push(value);
  }
  return values;
}

function redactPrivateValues(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("<redacted>");
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    if (jsonEscaped !== secret) redacted = redacted.split(jsonEscaped).join("<redacted>");
  }
  return redacted;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\blease_claim\s*[:=]\s*\{[^\r\n}]*\}/gi, "lease_claim=<redacted>")
    .replace(/("(?:lease_id|[^"\\]*(?:token|handoff[_-]?key)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi, "$1\"<redacted>\"")
    .replace(/\b(lease_id|[a-z0-9_-]*(?:token|handoff[_-]?key)[a-z0-9_-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1=<redacted>")
    .replace(/(--(?:lease-id|handoff-key|[a-z0-9-]*token[a-z0-9-]*)(?:=|\s+))\S+/gi, "$1<redacted>");
}

function redactPublicSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPublicSecrets);
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "lease_claim" || key === "lease_id" || /token|handoff[_-]?key/i.test(key)) continue;
    projected[key] = redactPublicSecrets(nested);
  }
  return projected;
}

/** Extract --session/--id (or = form) from a Maestro argv list, if present. */
function extractSessionId(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if ((argument === "--session" || argument === "--id") && index + 1 < argv.length) {
      return argv[index + 1];
    }
    for (const flag of ["--session=", "--id="]) {
      if (argument.startsWith(flag)) return argument.slice(flag.length);
    }
  }
  return undefined;
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

const LEASE_PATH_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function publicWorkflowErrorMessage(error: unknown): string {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return message.includes(".workflow") && message.includes(".lease")
    ? message.replace(LEASE_PATH_UUID_PATTERN, "<redacted>")
    : message;
}

function leaseMetadata(lease: WorkflowLease): WorkflowLeaseMetadata {
  return {
    sessionId: lease.sessionId,
    hostSessionId: lease.hostSessionId,
    epoch: lease.epoch,
    heartbeatAt: lease.heartbeatAt,
  };
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

function derivePlanPublishRequestId(handoffKey: string): string {
  const normalized = handoffKey.trim();
  if (!normalized) throw new Error("Plan handoff key must be non-empty");
  return `req_plan_publish_${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

function derivePlanSessionId(handoffKey: string): string {
  const normalized = handoffKey.trim();
  if (!normalized) throw new Error("Plan handoff key must be non-empty");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
  // Maestro preserves explicit IDs with a timestamp-shaped suffix. The fixed
  // suffix makes identity allocation stable across transport failures/restarts.
  return `pi-plan-${digest}-00000000-000000`;
}

function derivePlanExecutionStartRequestId(handoffKey: string): string {
  const normalized = handoffKey.trim();
  if (!normalized) throw new Error("Plan handoff key must be non-empty");
  const digest = createHash("sha256").update(`execution-start\0${normalized}`, "utf8").digest("hex").slice(0, 32);
  return `req_plan_execution_start_${digest}`;
}

function requiredPlanIntent(value: string | undefined, handoffKey: string): string {
  const normalized = value?.trim();
  return (normalized || `Approved Plan request ${derivePlanPublishRequestId(handoffKey)}`).slice(0, 240);
}

function validateCorePlanSessionCreate(
  envelope: PrivateRunResponseEnvelope,
  sessionId: string,
): void {
  if (envelope.schema_version !== "run-response/1.1"
    || envelope.operation !== "session-create"
    || !envelope.ok
    || envelope.exit_code !== 0
    || envelope.request_id !== null
    || envelope.replay !== null) {
    throw new Error("Core Plan Session creation requires a successful non-replay run-response/1.1 result");
  }
  const locator = envelope.locator;
  if (!locator
    || locator.session_id !== sessionId
    || locator.execution_id !== null
    || locator.generation !== null
    || locator.run_id !== null) {
    throw new Error("Core Plan Session creation returned an invalid Session-only locator");
  }
  const fence = requireCoreFence(envelope.fence);
  if (fence.session_identity_revision !== 1
    || fence.session_activity_revision !== 0
    || fence.execution_revision !== null
    || fence.lease_epoch !== null) {
    throw new Error("Core Plan Session creation returned an invalid initial identity fence");
  }
  const result = recordValue(envelope.result);
  if (result?.session_id !== sessionId
    || result.schema_version !== "session/2.0"
    || result.current_execution_id !== null
    || result.latest_execution_id !== null) {
    throw new Error("Core Plan Session creation did not return the expected session/2.0 identity");
  }
}

function isRecoverablePlanSessionCreate(
  envelope: PrivateRunResponseEnvelope,
  sessionId: string,
): boolean {
  return envelope.schema_version === "run-response/1.1"
    && envelope.operation === "session-create"
    && !envelope.ok
    && envelope.locator?.session_id === sessionId
    && /Session already exists/i.test(envelope.error?.message ?? "");
}

function validateCorePlanSessionSnapshot(
  snapshot: WorkflowSnapshot,
  sessionId: string,
  intent: string,
): void {
  const session = requireSession(snapshot);
  if (snapshot.source !== "canonical"
    || snapshot.canonicalClaim?.status !== "valid"
    || snapshot.canonicalClaim.activeSessionId !== sessionId
    || session.sessionId !== sessionId
    || session.schemaVersion !== "session/2.0"
    || session.lifecycleAuthority !== "execution-derived"
    || session.intent !== intent
    || session.archivedAt !== null) {
    throw new Error(`Canonical recovery did not confirm deterministic session/2.0 identity ${sessionId}`);
  }
  if (!snapshot.execution) {
    if (session.activityRevision !== 0 || session.currentExecutionId !== null || session.latestExecutionId !== null) {
      throw new Error(`Deterministic Session ${sessionId} is not an unused identity shell`);
    }
    return;
  }
  const locator = requireCoreExecutionLocator(snapshot);
  if (locator.sessionId !== sessionId || locator.generation !== 1) {
    throw new Error(`Deterministic Session ${sessionId} contains unrelated Execution authority`);
  }
}

function validateCorePlanExecutionStart(
  envelope: PrivateRunResponseEnvelope,
  sessionId: string,
  requestId: string,
  candidate: CoreMutationCandidate | undefined,
): void {
  if (envelope.schema_version !== "run-response/1.1"
    || envelope.operation !== "execution-start"
    || !envelope.ok
    || envelope.exit_code !== 0
    || envelope.request_id !== requestId
    || !candidate
    || candidate.locator.sessionId !== sessionId
    || candidate.locator.generation !== 1
    || envelope.locator?.run_id !== null) {
    throw new Error("Core Plan generation-1 acquisition returned an invalid locator or request binding");
  }
  if (candidate.fence.session_identity_revision !== 1
    || candidate.fence.session_activity_revision !== 1
    || candidate.fence.execution_revision !== 1
    || candidate.fence.lease_epoch !== 1) {
    throw new Error("Core Plan generation-1 acquisition returned an invalid initial authority fence");
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const RESUME_MAP_MAX_UTF8_BYTES = 2048;
const RESUME_MAP_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Mirrors core stableJsonUtf8: recursive key-sorted JSON with undefined dropped. */
function stableJsonUtf8(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function resumeMapUtf8Bytes(map: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(map), "utf8");
}

/** Mirrors core computeResumeMapFingerprint: sha256 of the stable-JSON body. */
function computeResumeMapFingerprint(body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableJsonUtf8(body), "utf8").digest("hex")}`;
}

/**
 * Mirrors core assertResumeMapHasNoForbiddenFields semantics: a key whose
 * normalized form is executionId or contains generation/lease/operation is
 * forbidden at any depth. Returns true when a forbidden key is present.
 */
function resumeMapHasForbiddenFields(value: Record<string, unknown>): boolean {
  const seen = new WeakSet<object>();
  const forbidden = (key: string): boolean => {
    const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    return normalized === "executionid"
      || normalized.includes("generation")
      || normalized.includes("lease")
      || normalized.includes("operation");
  };
  const visit = (item: unknown): boolean => {
    if (item === null || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.some((child) => visit(child));
    return Object.entries(item as Record<string, unknown>).some(([key, child]) =>
      forbidden(key) || visit(child),
    );
  };
  return visit(value);
}

/** The fingerprint must be a sha256 digest of the body minus the fingerprint. */
function resumeMapFingerprintMatches(value: Record<string, unknown>): boolean {
  const fingerprint = value.fingerprint;
  if (typeof fingerprint !== "string" || !RESUME_MAP_FINGERPRINT_PATTERN.test(fingerprint)) return false;
  const body: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "fingerprint") body[key] = child;
  }
  return fingerprint === computeResumeMapFingerprint(body);
}

/** Minimal manual shape guard for the identity fields the coordinator caches. */
const RESUME_MAP_ALLOWED_KEYS = new Set([
  "sessionId", "sessionStatus", "orchestrationRevision", "activityRevision",
  "activeRuns", "blockingGates", "openDecisions", "pendingPublications",
  "nextActions", "fingerprint",
]);

function resumeMapShapeValid(value: Record<string, unknown>): boolean {
  // Strict: any key outside the core ResumeMapV1 contract (including the
  // retired identityRevision) fails the shape check.
  if (Object.keys(value).some(key => !RESUME_MAP_ALLOWED_KEYS.has(key))) return false;
  return typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && Number.isSafeInteger(value.orchestrationRevision)
    && (value.orchestrationRevision as number) >= 0
    && Array.isArray(value.nextActions);
}

function requireHostSessionId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error("Current Pi host does not expose a stable session id; Workflow mutation is refused");
  return normalized;
}

/** Extract the value of --flag <value> from a prepared argv (audit #4 binding). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

/** Infer the expected v3 envelope operation from the requested command argv. */
const V3_RUN_OPERATION_CODES: Record<string, string> = {
  next: "next", create: "create", complete: "complete", brief: "brief",
  check: "check", recall: "recall", decide: "run-decide",
  transition: "run-transition", cancel: "run-cancel", seal: "run-seal",
};

function expectedV3Operation(argv: readonly string[]): string | null {
  const command = argv[0];
  const sub = argv[1];
  if (command === "run") return V3_RUN_OPERATION_CODES[sub ?? ""] ?? null;
  if (command === "session") {
    if (sub === "chain") {
      const chainIndex = argv.indexOf("chain");
      const action = argv.slice(chainIndex + 1).find(token => !token.startsWith("-"));
      return action ? `session-chain-${action}` : null;
    }
    return sub ? `session-${sub}` : null;
  }
  return null;
}

function requireRun(runs: WorkflowRun[], runId: string): WorkflowRun {
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

function hasBlockingFailure(gates: Array<{ blocking: boolean; status: string }>): boolean {
  return gates.some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
}
