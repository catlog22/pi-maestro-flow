import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WORKSPACE_PEER_PROTOCOL_VERSION = 1 as const;
/**
 * Reserved targetCorrelationId for commands addressed to a window's main
 * session (window-level monitor interventions) instead of a sub-agent.
 */
export const WORKSPACE_MAIN_SESSION_MARKER = "window-main-session" as const;
export const DEFAULT_PEER_STALE_MS = 20_000;
export const DEFAULT_PEER_HEARTBEAT_MS = 5_000;
export const DEFAULT_PEER_PUBLISH_THROTTLE_MS = 200;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_OWNER_AGENTS = 256;
export const MAX_OWNER_SETTLED = 256;
export const MAX_OWNER_BACKGROUND_JOBS = 32;
export const MAX_OWNER_FILE_BYTES = 256 * 1024;
export const MAX_COMMAND_FILE_BYTES = 96 * 1024;
export const MAX_RESPONSE_FILE_BYTES = 32 * 1024;
export const MAX_COMMAND_MESSAGE_BYTES = 64 * 1024;

export const MONITOR_LEASE_STALE_MS = 60_000;

const MAX_STRING = 4_096;
const MAX_SUMMARY = 8_192;
const MAX_MAILBOX_ENTRIES = 512;
const MAX_COMMAND_TTL_MS = 10 * 60_000;
const MAX_RESPONSE_RETENTION_MS = 24 * 60 * 60_000;
const OWNER_ID_PATTERN = /^[a-f0-9]{32}$/;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{64}$/;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type WorkspaceAgentStatus = "running" | "sleeping";
export type WorkspaceSettledStatus = "completed" | "failed" | "terminated";
export type WorkspacePeerCommandAction = "steer" | "follow_up";
export type WorkspacePeerResponseStatus = "accepted" | "rejected" | "error" | "expired";
export type WorkspacePeerMessageSource = "user" | "monitor" | "system";
export type WorkspacePeerMessageKind = "message" | "supervision";
export type WorkspacePeerDeliveryStage = "queued" | "injected";

export interface WorkspacePeerPaths {
  rootDir: string;
  ownersDir: string;
  commandsDir: string;
  responsesDir: string;
}

export interface WorkspacePeerIdentity {
  version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
  normalizedCwd: string;
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  paths: WorkspacePeerPaths;
}
export interface WorkspaceAgentSnapshot {
  correlationId: string;
  name?: string;
  agent: string;
  status: WorkspaceAgentStatus;
  phase?: string;
  lastOutcome?: {
    status: WorkspaceSettledStatus;
    message?: string;
    settledAt: number;
  };
  startedAt: number;
  lastActivityAt: number;
  resultReadyAt?: number;
  summary?: string;
  objective?: string;
  outputTail?: string[];
  pendingInteractions?: number;
  depth?: number;
  parentCorrelationId?: string;
  wakeable?: boolean;
}

export interface WorkspaceSettledSnapshot {
  correlationId: string;
  name?: string;
  agent: string;
  status: WorkspaceSettledStatus;
  settledAt: number;
  summary?: string;
}

export interface WorkspaceBackgroundJobSnapshot {
  id: string;
  command: string;
  status: "running" | "stopping";
  /** False while bash_bg action=run still owns the foreground tool call. */
  background: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface WorkspaceOwnerState {
  agents: readonly WorkspaceAgentSnapshot[];
  settled?: readonly WorkspaceSettledSnapshot[];
  backgroundJobs?: readonly WorkspaceBackgroundJobSnapshot[];
  sessionId?: string;
  sessionName?: string;
  /** Context pressure as percentage of the window's context window (0-100). */
  contextPressure?: number;
}

export interface WorkspaceOwnerSnapshot {
  version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
  kind: "owner";
  workspaceId: string;
  normalizedCwd: string;
  ownerId: string;
  ownerNonce: string;
  pid: number;
  publishedAt: number;
  sessionId?: string;
  sessionName?: string;
  /** Context pressure as percentage of the window's context window (0-100). */
  contextPressure?: number;
  agents: WorkspaceAgentSnapshot[];
  settled: WorkspaceSettledSnapshot[];
  backgroundJobs?: WorkspaceBackgroundJobSnapshot[];
}

export interface WorkspacePeerWindowListing {
  /** Selector accepted by teammate-send for the window's main session. */
  target: string;
  ownerId: string;
  sessionId?: string;
  sessionName?: string;
  status: "running" | "sleeping";
  agentCount: number;
  publishedAt: number;
  contextPressure?: number;
}

/** Peer discovery result retained for existing callers and ledger reconciliation. */
export interface WorkspacePeerDiscovery {
  peers: WorkspaceOwnerSnapshot[];
  staleOwnerIds: string[];
  corruptFiles: string[];
}

export interface WorkspaceResolvedTarget {
  scope: "local" | "remote";
  ownerId: string;
  ownerNonce: string;
  state: "active" | "settled";
  agent: WorkspaceAgentSnapshot | WorkspaceSettledSnapshot;
}

export type WorkspaceTargetResolutionCode = "invalid" | "not_found" | "ambiguous" | "not_routable";

export class WorkspaceTargetResolutionError extends Error {
  readonly code: WorkspaceTargetResolutionCode;
  readonly candidates: readonly string[];

  constructor(code: WorkspaceTargetResolutionCode, message: string, candidates: readonly string[] = []) {
    super(message);
    this.name = "WorkspaceTargetResolutionError";
    this.code = code;
    this.candidates = candidates;
  }
}

export interface WorkspacePeerCommand {
  version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
  kind: "command";
  workspaceId: string;
  commandId: string;
  fromOwnerId: string;
  fromOwnerNonce: string;
  toOwnerId: string;
  toOwnerNonce: string;
  targetCorrelationId: string;
  action: WorkspacePeerCommandAction;
  message: string;
  source?: WorkspacePeerMessageSource;
  messageKind?: WorkspacePeerMessageKind;
  traceId?: string;
  replyTo?: string;
  fromSessionName?: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkspacePeerCommandResponse {
  version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
  kind: "response";
  workspaceId: string;
  commandId: string;
  fromOwnerId: string;
  fromOwnerNonce: string;
  toOwnerId: string;
  toOwnerNonce: string;
  targetCorrelationId: string;
  status: WorkspacePeerResponseStatus;
  message?: string;
  effectiveAction?: WorkspacePeerCommandAction;
  deliveryStage?: WorkspacePeerDeliveryStage;
  traceId?: string;
  respondedAt: number;
  expiresAt: number;
}

export interface WorkspaceCommandHandlerResult {
  status?: Exclude<WorkspacePeerResponseStatus, "expired">;
  message?: string;
  effectiveAction?: WorkspacePeerCommandAction;
  deliveryStage?: WorkspacePeerDeliveryStage;
}

export interface WorkspaceConsumedCommand {
  commandId: string;
  replayed: boolean;
  response: WorkspacePeerCommandResponse;
}

export interface WorkspacePeerRuntimeOptions {
  cwd: string;
  rootDir?: string;
  ownerId?: string;
  ownerNonce?: string;
  heartbeatMs?: number;
  publishThrottleMs?: number;
  now?: () => number;
  getState: () => WorkspaceOwnerState;
}

export interface StopWorkspacePeerRuntimeOptions {
  removeOwnerFile?: boolean;
}

function randomProtocolId(): string {
  return randomBytes(16).toString("hex");
}

function assertOwnerId(value: string, label: string): void {
  if (!OWNER_ID_PATTERN.test(value)) throw new Error(`${label} must be 32 lowercase hexadecimal characters`);
}

function assertWorkspaceId(value: string): void {
  if (!WORKSPACE_ID_PATTERN.test(value)) throw new Error("workspaceId must be a SHA-256 hexadecimal digest");
}

function assertCorrelationId(value: string): void {
  if (!CORRELATION_ID_PATTERN.test(value)) throw new Error("invalid target correlation id");
}

function boundedInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function boundedString(value: unknown, maximum = MAX_STRING): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

function safeCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optional<T>(value: unknown, predicate: (candidate: unknown) => candidate is T): value is T | undefined {
  return value === undefined || predicate(value);
}

function safeMetadataToken(value: unknown): value is string {
  return boundedString(value, 128) && value.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function safeReplySelector(value: unknown): value is string {
  return boundedString(value, 192) && value.length > 0 && !/\s/.test(value);
}

function safeSessionName(value: unknown): value is string {
  return boundedString(value, 256)
    && value.length > 0
    && !/[\r\n\t\u0085\u2028\u2029]/.test(value);
}

export function normalizeWorkspacePath(cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) throw new Error("cwd must be a non-empty path");
  let normalized = resolve(cwd).replace(/\\/g, "/");
  if (normalized.length > 1 && /^[A-Za-z]:\/$/.test(normalized) === false) normalized = normalized.replace(/\/+$/, "");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

export function workspaceIdForCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256").update(normalizeWorkspacePath(cwd, platform), "utf8").digest("hex");
}

export function defaultWorkspacePeerRoot(cwd: string): string {
  return join(homedir(), ".pi", "teammate", "workspaces", workspaceIdForCwd(cwd), "runtime");
}

export function createWorkspacePeerPaths(cwd: string, rootDir?: string): WorkspacePeerPaths {
  const root = resolve(rootDir ?? defaultWorkspacePeerRoot(cwd));
  return {
    rootDir: root,
    ownersDir: join(root, "owners"),
    commandsDir: join(root, "commands"),
    responsesDir: join(root, "responses"),
  };
}

export function createWorkspacePeerIdentity(
  cwd: string,
  options: { rootDir?: string; ownerId?: string; ownerNonce?: string } = {},
): WorkspacePeerIdentity {
  const ownerId = options.ownerId ?? randomProtocolId();
  const ownerNonce = options.ownerNonce ?? randomProtocolId();
  assertOwnerId(ownerId, "ownerId");
  assertOwnerId(ownerNonce, "ownerNonce");
  const normalizedCwd = normalizeWorkspacePath(cwd);
  return {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    normalizedCwd,
    workspaceId: createHash("sha256").update(normalizedCwd, "utf8").digest("hex"),
    ownerId,
    ownerNonce,
    paths: createWorkspacePeerPaths(cwd, options.rootDir),
  };
}

function containedPath(root: string, ...parts: string[]): string {
  const candidate = resolve(root, ...parts);
  const rel = relative(resolve(root), candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("protocol path escapes its root directory");
  return candidate;
}

export function ownerSnapshotPath(identity: WorkspacePeerIdentity, ownerId = identity.ownerId): string {
  assertOwnerId(ownerId, "ownerId");
  return containedPath(identity.paths.ownersDir, `${ownerId}.json`);
}

export function commandMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string {
  assertOwnerId(ownerId, "ownerId");
  return containedPath(identity.paths.commandsDir, ownerId);
}

export function responseMailboxPath(identity: WorkspacePeerIdentity, ownerId: string): string {
  assertOwnerId(ownerId, "ownerId");
  return containedPath(identity.paths.responsesDir, ownerId);
}

function commandPath(identity: WorkspacePeerIdentity, ownerId: string, commandId: string): string {
  assertOwnerId(commandId, "commandId");
  return containedPath(commandMailboxPath(identity, ownerId), `${commandId}.json`);
}

function responsePath(identity: WorkspacePeerIdentity, ownerId: string, commandId: string): string {
  assertOwnerId(commandId, "commandId");
  return containedPath(responseMailboxPath(identity, ownerId), `${commandId}.json`);
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`protocol directory is not a private real directory: ${path}`);
  }
  try {
    await chmod(path, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOSYS" && code !== "EPERM" && code !== "EINVAL") throw error;
  }
}

export async function ensureWorkspacePeerDirectories(identity: WorkspacePeerIdentity): Promise<void> {
  await makePrivateDirectory(identity.paths.rootDir);
  await Promise.all([
    makePrivateDirectory(identity.paths.ownersDir),
    makePrivateDirectory(identity.paths.commandsDir),
    makePrivateDirectory(identity.paths.responsesDir),
    makePrivateDirectory(commandMailboxPath(identity, identity.ownerId)),
    makePrivateDirectory(responseMailboxPath(identity, identity.ownerId)),
  ]);
}

export async function writePrivateJsonAtomic(path: string, value: unknown, maximumBytes: number): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (payload.byteLength > maximumBytes) throw new Error(`JSON payload exceeds ${maximumBytes} bytes`);
  await makePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomProtocolId()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    try {
      await chmod(path, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // TEST-003: ENOENT — a consumer may read and delete the file between
      // rename and chmod; the write already succeeded, so tolerate it.
      if (code !== "ENOSYS" && code !== "EPERM" && code !== "EINVAL" && code !== "ENOENT") throw error;
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBoundedJson(path: string, maximumBytes: number): Promise<unknown | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) return undefined;
    const bytes = await readFile(path);
    if (bytes.byteLength > maximumBytes) return undefined;
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Supervision lease — one monitor per peer window
// ---------------------------------------------------------------------------

/**
 * Lease file declaring that `monitorOwnerId` supervises `targetOwnerId`.
 * Lives next to the target's owner snapshot in the shared workspace root, so
 * any Pi root session can see who is monitoring a window before binding.
 */
export interface MonitorLease {
  version: typeof WORKSPACE_PEER_PROTOCOL_VERSION;
  monitorOwnerId: string;
  targetOwnerId: string;
  sessionName?: string;
  pid: number;
  since: number;
}

export function monitorLeasePath(identity: WorkspacePeerIdentity, targetOwnerId: string): string {
  assertOwnerId(targetOwnerId, "targetOwnerId");
  return containedPath(identity.paths.ownersDir, `${targetOwnerId}.monitor.json`);
}

export function validateMonitorLease(value: unknown): MonitorLease | undefined {
  if (!isRecord(value)
    || value.version !== WORKSPACE_PEER_PROTOCOL_VERSION
    || !assertOwnerIdSafe(value.monitorOwnerId)
    || !assertOwnerIdSafe(value.targetOwnerId)
    || !boundedInteger(value.pid) || (value.pid as number) <= 0
    || !boundedInteger(value.since)) return undefined;
  return {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    monitorOwnerId: value.monitorOwnerId as string,
    targetOwnerId: value.targetOwnerId as string,
    ...(typeof value.sessionName === "string" && value.sessionName.trim() ? { sessionName: value.sessionName.trim().slice(0, MAX_SUMMARY) } : {}),
    pid: value.pid as number,
    since: value.since as number,
  };
}

/** Read the current physical lease without changing the workspace-peer protocol. */
export async function readMonitorLease(
  identity: WorkspacePeerIdentity,
  targetOwnerId: string,
): Promise<MonitorLease | undefined> {
  return validateMonitorLease(await readBoundedJson(
    monitorLeasePath(identity, targetOwnerId),
    MAX_COMMAND_FILE_BYTES,
  ));
}

/** True when the given ownerId has a fresh owner snapshot (process alive). */
async function ownerSnapshotAlive(identity: WorkspacePeerIdentity, ownerId: string, staleMs: number, now: number): Promise<boolean> {
  const raw = await readBoundedJson(ownerSnapshotPath(identity, ownerId), MAX_OWNER_FILE_BYTES);
  if (!isRecord(raw)) return false;
  const snapshot = validateWorkspaceOwnerSnapshot(raw);
  if (!snapshot) return false;
  if (!boundedInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  return now - snapshot.publishedAt < staleMs;
}

export interface AcquireMonitorLeaseResult {
  ok: boolean;
  error?: string;
  lease?: MonitorLease;
}

export interface AcquireMonitorLeaseOptions {
  sessionName?: string;
  /** Lease staleness: an offline holder's lease may be taken over. */
  staleMs?: number;
  now?: number;
}

/**
 * Acquire the supervision lease for a peer window. Refuses when another
 * live monitor already holds it (double-monitoring prevention); a stale
 * lease whose holder has gone offline is taken over silently.
 */
export async function acquireMonitorLease(
  identity: WorkspacePeerIdentity,
  targetOwnerId: string,
  options: AcquireMonitorLeaseOptions = {},
): Promise<AcquireMonitorLeaseResult> {
  if (targetOwnerId === identity.ownerId) {
    return { ok: false, error: "Cannot monitor your own session window." };
  }
  const path = monitorLeasePath(identity, targetOwnerId);
  const existing = validateMonitorLease(await readBoundedJson(path, MAX_COMMAND_FILE_BYTES));
  if (existing && existing.monitorOwnerId !== identity.ownerId) {
    const now = options.now ?? Date.now();
    const staleMs = options.staleMs ?? MONITOR_LEASE_STALE_MS;
    const holderAlive = await ownerSnapshotAlive(identity, existing.monitorOwnerId, staleMs, now);
    if (holderAlive) {
      const holder = existing.sessionName ? ` (${existing.sessionName})` : ` (${existing.monitorOwnerId.slice(0, 6)})`;
      return { ok: false, error: `Window is already monitored by ${holder} since ${new Date(existing.since).toISOString()}.` };
    }
  }
  const lease: MonitorLease = {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    monitorOwnerId: identity.ownerId,
    targetOwnerId,
    ...(options.sessionName && options.sessionName.trim() ? { sessionName: options.sessionName.trim().slice(0, MAX_SUMMARY) } : {}),
    pid: process.pid,
    since: options.now ?? Date.now(),
  };
  await writePrivateJsonAtomic(path, lease, MAX_COMMAND_FILE_BYTES);
  // Write-then-verify: two monitors acquiring concurrently could both pass
  // the empty check and both write; the file is single-writer by atomic
  // rename, so the last writer wins — read back and confirm it is us.
  const verified = validateMonitorLease(await readBoundedJson(path, MAX_COMMAND_FILE_BYTES));
  if (!verified || verified.monitorOwnerId !== identity.ownerId) {
    return { ok: false, error: "Lease race: another monitor acquired the window concurrently." };
  }
  return { ok: true, lease };
}

/**
 * Release the supervision lease. Only the lease holder may release it;
 * returns false when the lease belongs to someone else.
 */
export async function releaseMonitorLease(
  identity: WorkspacePeerIdentity,
  targetOwnerId: string,
  monitorOwnerId: string = identity.ownerId,
): Promise<boolean> {
  const path = monitorLeasePath(identity, targetOwnerId);
  const existing = validateMonitorLease(await readBoundedJson(path, MAX_COMMAND_FILE_BYTES));
  if (!existing) return true;
  if (existing.monitorOwnerId !== monitorOwnerId) return false;
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}

function assertOwnerIdSafe(value: unknown): value is string {
  return typeof value === "string" && OWNER_ID_PATTERN.test(value);
}

function validateAgent(value: unknown): WorkspaceAgentSnapshot | undefined {
  if (!isRecord(value)
    || !safeCorrelationId(value.correlationId)
    || !boundedString(value.agent, 64)
    || !["pending", "running", "retrying", "sleeping"].includes(String(value.status))
    || !boundedInteger(value.startedAt)
    || !boundedInteger(value.lastActivityAt)
    || !optional(value.name, (candidate): candidate is string => boundedString(candidate, 256))
    || !optional(value.phase, (candidate): candidate is string => boundedString(candidate, 64))
    || !optional(value.lastOutcome, (candidate): candidate is Record<string, unknown> => isRecord(candidate)
      && ["completed", "failed", "terminated"].includes(String(candidate.status))
      && boundedInteger(candidate.settledAt)
      && optional(candidate.message, (message): message is string => boundedString(message, MAX_SUMMARY)))
    || !optional(value.resultReadyAt, boundedInteger)
    || !optional(value.summary, (candidate): candidate is string => boundedString(candidate, MAX_SUMMARY))
    || !optional(value.objective, (candidate): candidate is string => boundedString(candidate, MAX_SUMMARY))
    || !optional(value.outputTail, (candidate): candidate is string[] => Array.isArray(candidate)
      && candidate.length <= 20
      && candidate.every((line) => boundedString(line, MAX_SUMMARY)))
    || !optional(value.pendingInteractions, boundedInteger)
    || !optional(value.depth, boundedInteger)
    || !optional(value.parentCorrelationId, safeCorrelationId)
    || !optional(value.wakeable, (candidate): candidate is boolean => typeof candidate === "boolean")) return undefined;
  return {
    correlationId: value.correlationId,
    ...(value.name === undefined ? {} : { name: value.name }),
    agent: value.agent,
    status: value.status === "sleeping" ? "sleeping" : "running",
    ...(value.phase === undefined ? {} : { phase: value.phase }),
    ...(value.lastOutcome === undefined ? {} : {
      lastOutcome: {
        status: value.lastOutcome.status as WorkspaceSettledStatus,
        ...(value.lastOutcome.message === undefined ? {} : { message: value.lastOutcome.message as string }),
        settledAt: value.lastOutcome.settledAt as number,
      },
    }),
    startedAt: value.startedAt,
    lastActivityAt: value.lastActivityAt,
    ...(value.resultReadyAt === undefined ? {} : { resultReadyAt: value.resultReadyAt }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.objective === undefined ? {} : { objective: value.objective }),
    ...(value.outputTail === undefined ? {} : { outputTail: value.outputTail }),
    ...(value.pendingInteractions === undefined ? {} : { pendingInteractions: value.pendingInteractions }),
    ...(value.depth === undefined ? {} : { depth: value.depth }),
    ...(value.parentCorrelationId === undefined ? {} : { parentCorrelationId: value.parentCorrelationId }),
    ...(value.wakeable === undefined ? {} : { wakeable: value.wakeable }),
  };
}

function validateSettled(value: unknown): WorkspaceSettledSnapshot | undefined {
  if (!isRecord(value)
    || !safeCorrelationId(value.correlationId)
    || !boundedString(value.agent, 64)
    || !["completed", "failed", "terminated"].includes(String(value.status))
    || !boundedInteger(value.settledAt)
    || !optional(value.name, (candidate): candidate is string => boundedString(candidate, 256))
    || !optional(value.summary, (candidate): candidate is string => boundedString(candidate, MAX_SUMMARY))) return undefined;
  return {
    correlationId: value.correlationId,
    ...(value.name === undefined ? {} : { name: value.name }),
    agent: value.agent,
    status: value.status as WorkspaceSettledStatus,
    settledAt: value.settledAt,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  };
}

export function activeWorkspaceBackgroundJobsFromPayload(
  payload: unknown,
): WorkspaceBackgroundJobSnapshot[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) return undefined;
  const active: WorkspaceBackgroundJobSnapshot[] = [];
  for (const value of payload.jobs) {
    if (!isRecord(value) || (value.status !== "running" && value.status !== "stopping")) continue;
    const candidate = validateWorkspaceBackgroundJobSnapshot({
      ...value,
      command: typeof value.command === "string" ? value.command.slice(0, MAX_STRING) : value.command,
    });
    if (candidate) active.push(candidate);
  }
  return active
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_OWNER_BACKGROUND_JOBS);
}

export interface WorkspaceMainSessionDeliveryDecision {
  action: WorkspacePeerCommandAction;
  deliverAs: "steer" | "followUp";
  deferred: boolean;
}

export function workspaceMainSessionDeliveryDecision(
  requested: WorkspacePeerCommandAction,
  backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[],
): WorkspaceMainSessionDeliveryDecision {
  const hasForegroundWork = backgroundJobs.some((job) =>
    !job.background && (job.status === "running" || job.status === "stopping")
  );
  const action = requested === "steer" && hasForegroundWork ? "follow_up" : requested;
  return {
    action,
    deliverAs: action === "steer" ? "steer" : "followUp",
    deferred: action !== requested,
  };
}

export function workspaceMainSessionDeliveryAction(
  requested: WorkspacePeerCommandAction,
  backgroundJobs: readonly WorkspaceBackgroundJobSnapshot[],
): WorkspacePeerCommandAction {
  return workspaceMainSessionDeliveryDecision(requested, backgroundJobs).action;
}

export function shouldReplayWorkspaceRootQueue(
  reason: "startup" | "reload" | "new" | "resume" | "fork",
): boolean {
  return reason === "startup" || reason === "new" || reason === "resume" || reason === "fork";
}

export interface WorkspaceRemoteRootMessage {
  messageId: string;
  fromOwnerId: string;
  message: string;
  effectiveAction: WorkspacePeerCommandAction;
  source?: WorkspacePeerMessageSource;
  messageKind?: WorkspacePeerMessageKind;
  traceId?: string;
  replyTo?: string;
  fromSessionName?: string;
}

/** Canonical model-visible envelope for all remote root messages. */
export function formatWorkspaceRemoteRootMessage(input: WorkspaceRemoteRootMessage): string {
  const source = input.source ?? "system";
  const messageKind = input.messageKind ?? "message";
  const traceId = input.traceId ?? input.messageId;
  const replyTo = `owner:${input.fromOwnerId}`;
  const sender = input.fromSessionName
    ? `${JSON.stringify(input.fromSessionName)} (owner ${input.fromOwnerId})`
    : `owner ${input.fromOwnerId}`;
  return [
    "[workspace teammate message]",
    `Source: ${source}`,
    `Kind: ${messageKind}`,
    `Sender: ${sender}`,
    `Message id: ${input.messageId}`,
    `Trace id: ${traceId}`,
    `Effective delivery mode: ${input.effectiveAction}`,
    "Delivery note: queued messages are injected at a turn boundary and may lag the peer's latest state; verify against current evidence before acting.",
    `Reply route: when the body requests a response, call teammate-send with to=\"${replyTo}\".`,
    "--- BEGIN ORIGINAL BODY ---",
    input.message,
    "--- END ORIGINAL BODY ---",
  ].join("\n");
}

export function validateWorkspaceBackgroundJobSnapshot(value: unknown): WorkspaceBackgroundJobSnapshot | undefined {
  if (!isRecord(value)
    || !boundedString(value.id, 256)
    || !boundedString(value.command, MAX_STRING)
    || (value.status !== "running" && value.status !== "stopping")
    || typeof value.background !== "boolean"
    || !boundedInteger(value.startedAt)
    || !boundedInteger(value.updatedAt)) return undefined;
  return {
    id: value.id,
    command: value.command,
    status: value.status,
    background: value.background,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}

export function validateWorkspaceOwnerSnapshot(
  value: unknown,
  expected?: { workspaceId?: string; ownerId?: string },
): WorkspaceOwnerSnapshot | undefined {
  if (!isRecord(value)
    || value.version !== WORKSPACE_PEER_PROTOCOL_VERSION
    || value.kind !== "owner"
    || typeof value.workspaceId !== "string"
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || !boundedString(value.normalizedCwd, MAX_STRING)
    || createHash("sha256").update(value.normalizedCwd, "utf8").digest("hex") !== value.workspaceId
    || typeof value.ownerId !== "string"
    || !OWNER_ID_PATTERN.test(value.ownerId)
    || typeof value.ownerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.ownerNonce)
    || !boundedInteger(value.pid)
    || !boundedInteger(value.publishedAt)
    || !optional(value.sessionId, (candidate): candidate is string => boundedString(candidate, 256))
    || !optional(value.sessionName, (candidate): candidate is string => boundedString(candidate, 256))
    || !optional(value.contextPressure, (candidate): candidate is number => boundedInteger(candidate) && candidate >= 0 && candidate <= 100)
    || !Array.isArray(value.agents)
    || value.agents.length > MAX_OWNER_AGENTS
    || !Array.isArray(value.settled)
    || value.settled.length > MAX_OWNER_SETTLED
    || (value.backgroundJobs !== undefined
      && (!Array.isArray(value.backgroundJobs) || value.backgroundJobs.length > MAX_OWNER_BACKGROUND_JOBS))
    || (expected?.workspaceId !== undefined && value.workspaceId !== expected.workspaceId)
    || (expected?.ownerId !== undefined && value.ownerId !== expected.ownerId)) return undefined;
  const agents = value.agents.map(validateAgent);
  const settled = value.settled.map(validateSettled);
  const backgroundJobs = value.backgroundJobs === undefined
    ? undefined
    : value.backgroundJobs.map(validateWorkspaceBackgroundJobSnapshot);
  if (agents.some((item) => item === undefined)
    || settled.some((item) => item === undefined)
    || backgroundJobs?.some((item) => item === undefined)) return undefined;
  const ids = [...agents, ...settled].map((item) => item!.correlationId);
  if (new Set(ids).size !== ids.length) return undefined;
  return {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    kind: "owner",
    workspaceId: value.workspaceId,
    normalizedCwd: value.normalizedCwd,
    ownerId: value.ownerId,
    ownerNonce: value.ownerNonce,
    pid: value.pid,
    publishedAt: value.publishedAt,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.sessionName === undefined ? {} : { sessionName: value.sessionName }),
    ...(value.contextPressure === undefined ? {} : { contextPressure: value.contextPressure }),
    agents: agents as WorkspaceAgentSnapshot[],
    settled: settled as WorkspaceSettledSnapshot[],
    ...(backgroundJobs === undefined ? {} : { backgroundJobs: backgroundJobs as WorkspaceBackgroundJobSnapshot[] }),
  };
}

export function buildWorkspaceOwnerSnapshot(
  identity: WorkspacePeerIdentity,
  state: WorkspaceOwnerState,
  publishedAt = Date.now(),
): WorkspaceOwnerSnapshot {
  const raw: WorkspaceOwnerSnapshot = {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    kind: "owner",
    workspaceId: identity.workspaceId,
    normalizedCwd: identity.normalizedCwd,
    ownerId: identity.ownerId,
    ownerNonce: identity.ownerNonce,
    pid: process.pid,
    publishedAt,
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(state.sessionName === undefined ? {} : { sessionName: state.sessionName }),
    // Protocol boundary: clamp/round pressure so publish never rejects.
    ...(state.contextPressure === undefined ? {} : { contextPressure: Math.max(0, Math.min(100, Math.round(state.contextPressure))) }),
    agents: [...state.agents],
    settled: [...(state.settled ?? [])],
    ...(state.backgroundJobs === undefined ? {} : { backgroundJobs: [...state.backgroundJobs] }),
  };
  const validated = validateWorkspaceOwnerSnapshot(raw, identity);
  if (!validated) throw new Error("workspace owner state is invalid or exceeds protocol bounds");
  return validated;
}

export async function publishWorkspaceOwner(
  identity: WorkspacePeerIdentity,
  state: WorkspaceOwnerState,
  publishedAt = Date.now(),
): Promise<WorkspaceOwnerSnapshot> {
  await ensureWorkspacePeerDirectories(identity);
  const snapshot = buildWorkspaceOwnerSnapshot(identity, state, publishedAt);
  await writePrivateJsonAtomic(ownerSnapshotPath(identity), snapshot, MAX_OWNER_FILE_BYTES);
  return snapshot;
}

async function listJsonFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && OWNER_ID_PATTERN.test(entry.name.slice(0, -5)) && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_MAILBOX_ENTRIES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function discoverWorkspacePeers(
  identity: WorkspacePeerIdentity,
  options: { now?: number; staleAfterMs?: number; cleanupStale?: boolean; includeSelf?: boolean } = {},
): Promise<WorkspacePeerDiscovery> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PEER_STALE_MS;
  if (!boundedInteger(staleAfterMs, 1)) throw new Error("staleAfterMs must be a positive integer");
  const peers: WorkspaceOwnerSnapshot[] = [];
  const staleOwnerIds: string[] = [];
  const corruptFiles: string[] = [];
  for (const file of await listJsonFiles(identity.paths.ownersDir)) {
    const ownerId = file.slice(0, -5);
    const path = containedPath(identity.paths.ownersDir, file);
    const snapshot = validateWorkspaceOwnerSnapshot(
      await readBoundedJson(path, MAX_OWNER_FILE_BYTES),
      { workspaceId: identity.workspaceId, ownerId },
    );
    if (!snapshot) {
      corruptFiles.push(file);
      continue;
    }
    if (snapshot.publishedAt > now + staleAfterMs || now - snapshot.publishedAt > staleAfterMs) {
      staleOwnerIds.push(ownerId);
      if (options.cleanupStale) await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    if (options.includeSelf || ownerId !== identity.ownerId) peers.push(snapshot);
  }
  return { peers, staleOwnerIds, corruptFiles };
}

function targetLabel(target: WorkspaceResolvedTarget): string {
  const name = target.agent.name ? `${target.agent.name}#` : "";
  return `${name}${target.agent.correlationId.slice(0, 12)}@${target.ownerId.slice(0, 8)}`;
}

function uniqueTarget(query: string, candidates: WorkspaceResolvedTarget[]): WorkspaceResolvedTarget {
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const labels = candidates.map(targetLabel);
    throw new WorkspaceTargetResolutionError("ambiguous", `Target ${JSON.stringify(query)} is ambiguous: ${labels.join(", ")}`, labels);
  }
  throw new WorkspaceTargetResolutionError("not_found", `Target ${JSON.stringify(query)} was not found`);
}

/**
 * Resolve a workspace peer window by its sessionName (window title).
 * Accepts an exact name, a unique name prefix, or the `name#ownerIdPrefix`
 * disambiguator used elsewhere in the peer protocol.
 */
export function resolveWorkspaceOwnerByName(
  owners: readonly WorkspaceOwnerSnapshot[],
  selector: string,
): WorkspaceOwnerSnapshot | undefined {
  const value = selector.trim().replace(/^@/, "");
  const marker = value.lastIndexOf("#");
  const name = marker > 0 && marker < value.length - 1 ? value.slice(0, marker) : value;
  const idPrefix = marker > 0 && marker < value.length - 1 ? value.slice(marker + 1) : undefined;
  const exact = owners.filter((candidate) => candidate.sessionName === name);
  let matches = exact.length > 0 ? exact : owners.filter(
    (candidate) => candidate.sessionName !== undefined && candidate.sessionName.startsWith(name),
  );
  if (idPrefix !== undefined) matches = matches.filter((candidate) => candidate.ownerId.startsWith(idPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveWorkspaceTarget(
  query: string,
  localIdentity: WorkspacePeerIdentity,
  localState: WorkspaceOwnerState,
  remoteOwners: readonly WorkspaceOwnerSnapshot[],
  options: { includeSettled?: boolean } = {},
): WorkspaceResolvedTarget {
  const requested = query.startsWith("@") ? query.slice(1) : query;
  if (!boundedString(requested, 192) || requested.length === 0 || /[\s\u0000-\u001f]/.test(requested)) {
    throw new WorkspaceTargetResolutionError("invalid", "Target must be a non-empty bounded identifier");
  }
  const targets: WorkspaceResolvedTarget[] = [];
  const addOwner = (ownerId: string, ownerNonce: string, scope: "local" | "remote", state: WorkspaceOwnerState): void => {
    for (const agent of state.agents) targets.push({ scope, ownerId, ownerNonce, state: "active", agent });
    if (options.includeSettled !== false) {
      for (const agent of state.settled ?? []) targets.push({ scope, ownerId, ownerNonce, state: "settled", agent });
    }
  };
  addOwner(localIdentity.ownerId, localIdentity.ownerNonce, "local", localState);
  for (const owner of remoteOwners) addOwner(owner.ownerId, owner.ownerNonce, "remote", owner);

  const active = targets.filter((target) => target.state === "active");
  const settled = targets.filter((target) => target.state === "settled");
  const exactCid = targets.filter((target) => target.agent.correlationId === requested);
  if (exactCid.length > 0) return uniqueTarget(query, exactCid);

  const hash = requested.lastIndexOf("#");
  if (hash > 0 && hash < requested.length - 1) {
    const name = requested.slice(0, hash);
    const prefix = requested.slice(hash + 1);
    if (!safeName(name) || !safeCorrelationId(prefix)) throw new WorkspaceTargetResolutionError("invalid", "Invalid name#prefix target");
    const matches = targets.filter((target) => target.agent.name === name && target.agent.correlationId.startsWith(prefix));
    return uniqueTarget(query, matches);
  }

  if (safeName(requested)) {
    const activeNames = active.filter((target) => target.agent.name === requested);
    if (activeNames.length > 0) return uniqueTarget(query, activeNames);
    const settledNames = settled.filter((target) => target.agent.name === requested);
    if (settledNames.length > 0) return uniqueTarget(query, settledNames);
  }

  if (!safeCorrelationId(requested)) throw new WorkspaceTargetResolutionError("invalid", "Invalid target identifier");
  const prefixMatches = targets.filter((target) => target.agent.correlationId.startsWith(requested));
  return uniqueTarget(query, prefixMatches);
}

export function requireRoutableWorkspaceTarget(target: WorkspaceResolvedTarget): WorkspaceResolvedTarget & { state: "active" } {
  if (target.state !== "active") {
    throw new WorkspaceTargetResolutionError("not_routable", `Target ${targetLabel(target)} is settled and cannot receive commands`);
  }
  return target as WorkspaceResolvedTarget & { state: "active" };
}

export class WorkspacePeerPublisher {
  readonly identity: WorkspacePeerIdentity;
  readonly heartbeatMs: number;
  readonly publishThrottleMs: number;
  readonly #getState: () => WorkspaceOwnerState;
  readonly #now: () => number;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #scheduled: ReturnType<typeof setTimeout> | undefined;
  #publishing: Promise<void> = Promise.resolve();
  #lastPublishedAt = 0;
  #dirty = true;
  #stopped = true;

  constructor(options: WorkspacePeerRuntimeOptions) {
    this.identity = createWorkspacePeerIdentity(options.cwd, options);
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_PEER_HEARTBEAT_MS;
    this.publishThrottleMs = options.publishThrottleMs ?? DEFAULT_PEER_PUBLISH_THROTTLE_MS;
    if (!boundedInteger(this.heartbeatMs, 1) || !boundedInteger(this.publishThrottleMs, 0)) {
      throw new Error("heartbeatMs and publishThrottleMs must be bounded non-negative integers");
    }
    this.#getState = options.getState;
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#dirty = true;
    await this.publishNow();
    this.#heartbeat = setInterval(() => this.#schedule(true), this.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  markDirty(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#schedule(false);
  }

  async publishNow(): Promise<void> {
    if (this.#stopped) return;
    this.#dirty = false;
    const publishedAt = this.#now();
    this.#publishing = this.#publishing.catch(() => undefined).then(async () => {
      await publishWorkspaceOwner(this.identity, this.#getState(), publishedAt);
      this.#lastPublishedAt = publishedAt;
    });
    await this.#publishing;
    if (this.#dirty && !this.#stopped) this.#schedule(false);
  }

  async stop(options: StopWorkspacePeerRuntimeOptions = {}): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#scheduled) clearTimeout(this.#scheduled);
    this.#heartbeat = undefined;
    this.#scheduled = undefined;
    await this.#publishing.catch(() => undefined);
    if (options.removeOwnerFile !== false) await rm(ownerSnapshotPath(this.identity), { force: true }).catch(() => undefined);
  }

  #schedule(heartbeat: boolean): void {
    if (this.#stopped || this.#scheduled) return;
    if (!heartbeat && !this.#dirty) return;
    const delay = Math.max(0, this.#lastPublishedAt + this.publishThrottleMs - this.#now());
    this.#scheduled = setTimeout(() => {
      this.#scheduled = undefined;
      void this.publishNow().catch(() => undefined);
    }, delay);
    this.#scheduled.unref?.();
  }
}

export function createWorkspacePeerRuntime(options: WorkspacePeerRuntimeOptions): WorkspacePeerPublisher {
  return new WorkspacePeerPublisher(options);
}

function validateCommand(value: unknown, expectedWorkspaceId?: string): WorkspacePeerCommand | undefined {
  if (!isRecord(value)
    || value.version !== WORKSPACE_PEER_PROTOCOL_VERSION
    || value.kind !== "command"
    || typeof value.workspaceId !== "string"
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || (expectedWorkspaceId !== undefined && value.workspaceId !== expectedWorkspaceId)
    || typeof value.commandId !== "string"
    || !OWNER_ID_PATTERN.test(value.commandId)
    || typeof value.fromOwnerId !== "string"
    || !OWNER_ID_PATTERN.test(value.fromOwnerId)
    || typeof value.fromOwnerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.fromOwnerNonce)
    || typeof value.toOwnerId !== "string"
    || !OWNER_ID_PATTERN.test(value.toOwnerId)
    || typeof value.toOwnerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.toOwnerNonce)
    || !safeCorrelationId(value.targetCorrelationId)
    || (value.action !== "steer" && value.action !== "follow_up")
    || !boundedString(value.message, MAX_COMMAND_MESSAGE_BYTES)
    || Buffer.byteLength(value.message, "utf8") > MAX_COMMAND_MESSAGE_BYTES
    || !optional(value.source, (candidate): candidate is WorkspacePeerMessageSource => candidate === "user" || candidate === "monitor" || candidate === "system")
    || !optional(value.messageKind, (candidate): candidate is WorkspacePeerMessageKind => candidate === "message" || candidate === "supervision")
    || !optional(value.traceId, safeMetadataToken)
    || !optional(value.replyTo, safeReplySelector)
    || (value.replyTo !== undefined && value.replyTo !== `owner:${value.fromOwnerId}`)
    || !optional(value.fromSessionName, safeSessionName)
    || !boundedInteger(value.createdAt)
    || !boundedInteger(value.expiresAt)
    || value.expiresAt < value.createdAt
    || value.expiresAt - value.createdAt > MAX_COMMAND_TTL_MS) return undefined;
  return value as unknown as WorkspacePeerCommand;
}

export function validateWorkspacePeerCommand(value: unknown, workspaceId?: string): WorkspacePeerCommand | undefined {
  return validateCommand(value, workspaceId);
}

function validateResponse(value: unknown, command?: WorkspacePeerCommand): WorkspacePeerCommandResponse | undefined {
  if (!isRecord(value)
    || value.version !== WORKSPACE_PEER_PROTOCOL_VERSION
    || value.kind !== "response"
    || typeof value.workspaceId !== "string"
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || typeof value.commandId !== "string"
    || !OWNER_ID_PATTERN.test(value.commandId)
    || typeof value.fromOwnerId !== "string"
    || !OWNER_ID_PATTERN.test(value.fromOwnerId)
    || typeof value.fromOwnerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.fromOwnerNonce)
    || typeof value.toOwnerId !== "string"
    || !OWNER_ID_PATTERN.test(value.toOwnerId)
    || typeof value.toOwnerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.toOwnerNonce)
    || !safeCorrelationId(value.targetCorrelationId)
    || !["accepted", "rejected", "error", "expired"].includes(String(value.status))
    || !optional(value.message, (candidate): candidate is string => boundedString(candidate, MAX_SUMMARY))
    || !optional(value.effectiveAction, (candidate): candidate is WorkspacePeerCommandAction => candidate === "steer" || candidate === "follow_up")
    || !optional(value.deliveryStage, (candidate): candidate is WorkspacePeerDeliveryStage => candidate === "queued" || candidate === "injected")
    || !optional(value.traceId, safeMetadataToken)
    || !boundedInteger(value.respondedAt)
    || !boundedInteger(value.expiresAt)
    || value.expiresAt < value.respondedAt
    || value.expiresAt - value.respondedAt > MAX_RESPONSE_RETENTION_MS) return undefined;
  if (command && (value.workspaceId !== command.workspaceId
    || value.commandId !== command.commandId
    || value.fromOwnerId !== command.toOwnerId
    || (value.fromOwnerNonce !== command.toOwnerNonce && value.status !== "rejected")
    || value.toOwnerId !== command.fromOwnerId
    || value.toOwnerNonce !== command.fromOwnerNonce
    || value.targetCorrelationId !== command.targetCorrelationId
    || (value.traceId !== undefined && value.traceId !== (command.traceId ?? command.commandId)))) return undefined;
  return value as unknown as WorkspacePeerCommandResponse;
}

export function validateWorkspacePeerCommandResponse(
  value: unknown,
  command?: WorkspacePeerCommand,
): WorkspacePeerCommandResponse | undefined {
  return validateResponse(value, command);
}

export async function enqueueWorkspacePeerCommand(
  identity: WorkspacePeerIdentity,
  target: WorkspaceResolvedTarget,
  action: WorkspacePeerCommandAction,
  message: string,
  options: {
    now?: number;
    ttlMs?: number;
    commandId?: string;
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
    beforePublish?: (command: WorkspacePeerCommand) => void | Promise<void>;
  } = {},
): Promise<WorkspacePeerCommand> {
  requireRoutableWorkspaceTarget(target);
  if (action !== "steer" && action !== "follow_up") throw new Error("remote command action must be steer or follow_up");
  if (!boundedString(message, MAX_COMMAND_MESSAGE_BYTES) || Buffer.byteLength(message, "utf8") > MAX_COMMAND_MESSAGE_BYTES) {
    throw new Error(`command message exceeds ${MAX_COMMAND_MESSAGE_BYTES} bytes or contains control characters`);
  }
  const commandId = options.commandId ?? randomProtocolId();
  assertOwnerId(commandId, "commandId");
  const createdAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_COMMAND_TIMEOUT_MS + 5_000;
  if (!boundedInteger(ttlMs, 1) || ttlMs > MAX_COMMAND_TTL_MS) throw new Error("command ttl is outside protocol bounds");
  const command: WorkspacePeerCommand = {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    kind: "command",
    workspaceId: identity.workspaceId,
    commandId,
    fromOwnerId: identity.ownerId,
    fromOwnerNonce: identity.ownerNonce,
    toOwnerId: target.ownerId,
    toOwnerNonce: target.ownerNonce,
    targetCorrelationId: target.agent.correlationId,
    action,
    message,
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.messageKind === undefined ? {} : { messageKind: options.messageKind }),
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    ...(options.fromSessionName === undefined ? {} : { fromSessionName: options.fromSessionName }),
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
  if (!validateCommand(command, identity.workspaceId)) throw new Error("constructed command failed protocol validation");
  await options.beforePublish?.(command);
  await writePrivateJsonAtomic(commandPath(identity, target.ownerId, commandId), command, MAX_COMMAND_FILE_BYTES);
  return command;
}

async function readResponse(
  identity: WorkspacePeerIdentity,
  ownerId: string,
  command: WorkspacePeerCommand,
): Promise<WorkspacePeerCommandResponse | undefined> {
  return validateResponse(
    await readBoundedJson(responsePath(identity, ownerId, command.commandId), MAX_RESPONSE_FILE_BYTES),
    command,
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    // PERFSEC-002: Remove the abort listener when the timer fires normally
    // so polling loops don't accumulate listeners on a long-lived signal.
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForWorkspacePeerCommandResponse(
  identity: WorkspacePeerIdentity,
  command: WorkspacePeerCommand,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<WorkspacePeerCommandResponse | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 25;
  if (!boundedInteger(timeoutMs, 1) || timeoutMs > MAX_COMMAND_TTL_MS || !boundedInteger(pollMs, 1) || pollMs > 1_000) {
    throw new Error("command response wait is outside protocol bounds");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await readResponse(identity, identity.ownerId, command);
    if (response) return response;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await delay(Math.min(pollMs, remaining), options.signal);
  } while (Date.now() < deadline);
  return undefined;
}

export async function sendWorkspacePeerCommand(
  identity: WorkspacePeerIdentity,
  target: WorkspaceResolvedTarget,
  action: WorkspacePeerCommandAction,
  message: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    ttlMs?: number;
    signal?: AbortSignal;
    source?: WorkspacePeerMessageSource;
    messageKind?: WorkspacePeerMessageKind;
    traceId?: string;
    replyTo?: string;
    fromSessionName?: string;
  } = {},
): Promise<{ command: WorkspacePeerCommand; response?: WorkspacePeerCommandResponse; timedOut: boolean }> {
  const commandTimeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? Math.min(MAX_COMMAND_TTL_MS, commandTimeoutMs + 5_000);
  const command = await enqueueWorkspacePeerCommand(identity, target, action, message, {
    ttlMs,
    source: options.source,
    messageKind: options.messageKind,
    traceId: options.traceId,
    replyTo: options.replyTo,
    fromSessionName: options.fromSessionName,
  });
  const response = await waitForWorkspacePeerCommandResponse(identity, command, options);
  return { command, ...(response ? { response } : {}), timedOut: response === undefined };
}

function safeResponseMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, MAX_SUMMARY);
}

function makeResponse(
  identity: WorkspacePeerIdentity,
  command: WorkspacePeerCommand,
  status: WorkspacePeerResponseStatus,
  message: string | undefined,
  now: number,
  delivery: Pick<WorkspaceCommandHandlerResult, "effectiveAction" | "deliveryStage"> = {},
): WorkspacePeerCommandResponse {
  return {
    version: WORKSPACE_PEER_PROTOCOL_VERSION,
    kind: "response",
    workspaceId: identity.workspaceId,
    commandId: command.commandId,
    fromOwnerId: identity.ownerId,
    fromOwnerNonce: identity.ownerNonce,
    toOwnerId: command.fromOwnerId,
    toOwnerNonce: command.fromOwnerNonce,
    targetCorrelationId: command.targetCorrelationId,
    status,
    ...(safeResponseMessage(message) === undefined ? {} : { message: safeResponseMessage(message) }),
    ...(delivery.effectiveAction === undefined ? {} : { effectiveAction: delivery.effectiveAction }),
    ...(delivery.deliveryStage === undefined ? {} : { deliveryStage: delivery.deliveryStage }),
    ...(command.traceId === undefined ? {} : { traceId: command.traceId }),
    respondedAt: now,
    expiresAt: now + MAX_RESPONSE_RETENTION_MS,
  };
}

export async function consumeWorkspacePeerCommands(
  identity: WorkspacePeerIdentity,
  handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>,
  options: { now?: number; limit?: number } = {},
): Promise<WorkspaceConsumedCommand[]> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 64;
  if (!boundedInteger(limit, 1) || limit > MAX_MAILBOX_ENTRIES) throw new Error("command consume limit is outside protocol bounds");
  const mailbox = commandMailboxPath(identity, identity.ownerId);
  const results: WorkspaceConsumedCommand[] = [];
  for (const file of (await listJsonFiles(mailbox)).slice(0, limit)) {
    const commandId = file.slice(0, -5);
    const sourcePath = containedPath(mailbox, file);
    const claimPath = containedPath(mailbox, `${commandId}.${identity.ownerNonce}.processing`);
    try {
      await rename(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const command = validateCommand(await readBoundedJson(claimPath, MAX_COMMAND_FILE_BYTES), identity.workspaceId);
      if (!command || command.commandId !== commandId || command.toOwnerId !== identity.ownerId) continue;
      const existing = await readResponse(identity, command.fromOwnerId, command);
      if (existing) {
        results.push({ commandId, replayed: true, response: existing });
        continue;
      }
      let response: WorkspacePeerCommandResponse;
      if (command.toOwnerNonce !== identity.ownerNonce) {
        response = makeResponse(identity, command, "rejected", "destination owner instance has changed", now);
      } else if (command.expiresAt < now) {
        response = makeResponse(identity, command, "expired", "command expired before consumption", now);
      } else {
        try {
          const handled = await handler(command);
          response = makeResponse(
            identity,
            command,
            handled?.status ?? "accepted",
            handled?.message,
            now,
            handled ? {
              effectiveAction: handled.effectiveAction,
              deliveryStage: handled.deliveryStage,
            } : {},
          );
        } catch (error) {
          response = makeResponse(identity, command, "error", error instanceof Error ? error.message : String(error), now);
        }
      }
      await writePrivateJsonAtomic(
        responsePath(identity, command.fromOwnerId, command.commandId),
        response,
        MAX_RESPONSE_FILE_BYTES,
      );
      results.push({ commandId, replayed: false, response });
    } finally {
      await rm(claimPath, { force: true }).catch(() => undefined);
    }
  }
  return results;
}

export class WorkspacePeerCommandConsumer {
  readonly identity: WorkspacePeerIdentity;
  readonly pollMs: number;
  readonly #handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<WorkspaceConsumedCommand[]> | undefined;

  constructor(
    identity: WorkspacePeerIdentity,
    handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>,
    options: { pollMs?: number } = {},
  ) {
    this.identity = identity;
    this.pollMs = options.pollMs ?? 50;
    if (!boundedInteger(this.pollMs, 1) || this.pollMs > 1_000) throw new Error("command poll interval is outside protocol bounds");
    this.#handler = handler;
  }

  start(): void {
    if (this.#timer) return;
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), this.pollMs);
    this.#timer.unref?.();
  }

  async poll(): Promise<WorkspaceConsumedCommand[]> {
    if (this.#polling) return this.#polling;
    this.#polling = consumeWorkspacePeerCommands(this.identity, this.#handler);
    try {
      return await this.#polling;
    } finally {
      this.#polling = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#polling;
  }
}

export function createWorkspacePeerCommandConsumer(
  identity: WorkspacePeerIdentity,
  handler: (command: WorkspacePeerCommand) => WorkspaceCommandHandlerResult | void | Promise<WorkspaceCommandHandlerResult | void>,
  options: { pollMs?: number } = {},
): WorkspacePeerCommandConsumer {
  return new WorkspacePeerCommandConsumer(identity, handler, options);
}

export async function cleanupWorkspacePeerMailboxes(
  identity: WorkspacePeerIdentity,
  options: { now?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  let removed = 0;
  const mailboxes: Array<[string, number]> = [
    [commandMailboxPath(identity, identity.ownerId), MAX_COMMAND_FILE_BYTES],
    [responseMailboxPath(identity, identity.ownerId), MAX_RESPONSE_FILE_BYTES],
  ];
  for (const [directory, maximumBytes] of mailboxes) {
    for (const file of await listJsonFiles(directory)) {
      const path = containedPath(directory, file);
      const raw = await readBoundedJson(path, maximumBytes);
      const expiresAt = isRecord(raw) && boundedInteger(raw.expiresAt) ? raw.expiresAt : undefined;
      if (expiresAt !== undefined && expiresAt < now) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
