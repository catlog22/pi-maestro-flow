/** Canonical path authorization and hard Gateway resource bounds. */
import {
  GATEWAY_DEFAULT_LIMITS,
  GATEWAY_HARD_LIMITS,
  GATEWAY_STATE_VERSION,
  type GatewayPrincipal,
  type GatewayWorkspace,
} from "./contracts.ts";
import type { GatewayLimitsConfig, GatewayTrustedFullAccessConfig, GatewayWorkspaceConfig } from "./config.ts";
import { principalKey } from "./principal.ts";
import {
  canonicalizeWorkspaceChild,
  canonicalizeWorkspacePath,
  isPathWithin,
  utf8Bytes,
  workspaceIdForPath,
} from "./state-paths.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export type GatewayPolicyOperation = "read" | "write" | "patch" | "exec" | "job" | "task" | "register";
export type GatewayConcurrencyKind = "request" | "job" | "task" | "monitor-wait";

export interface GatewayMonitorWaitLimits {
  global: number;
  perPrincipal: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}
export const DEFAULT_GATEWAY_MONITOR_WAIT_LIMITS: GatewayMonitorWaitLimits = {
  global: 32,
  perPrincipal: 4,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
};

export interface GatewayPolicyLimits extends GatewayLimitsConfig {}

export const DEFAULT_GATEWAY_POLICY_LIMITS: GatewayPolicyLimits = {
  ...GATEWAY_DEFAULT_LIMITS,
};
export const GATEWAY_POLICY_LIMITS = GATEWAY_HARD_LIMITS;

export interface GatewayPolicyOptions {
  workspaceRoot?: string;
  workspaces?: readonly (GatewayWorkspaceConfig | string | { path: string; workspaceId?: string; id?: string })[];
  registry?: WorkspaceRegistry;
  limits?: Partial<GatewayPolicyLimits>;
  now?: () => number;
  trustedFullAccess?: Partial<GatewayTrustedFullAccessConfig>;
  monitorWait?: Partial<GatewayMonitorWaitLimits>;
}

export interface GatewayPolicyDecision {
  allowed: boolean;
  reason: string;
  operation?: GatewayPolicyOperation;
  workspaceId?: string;
  workspacePath?: string;
  canonicalPath?: string;
  principal?: string;
}

export type GatewayVisibleWorkspace = Omit<GatewayWorkspace, "ownerToken">;

export class GatewayPolicyError extends Error {
  readonly code: string;
  constructor(message: string, code = "policy_denied") {
    super(message);
    this.name = "GatewayPolicyError";
    this.code = code;
  }
}
export class GatewayBoundsError extends GatewayPolicyError {
  constructor(message: string) { super(message, "bounds_exceeded"); this.name = "GatewayBoundsError"; }
}

function limit(name: keyof GatewayPolicyLimits, value: unknown, fallback: number): number {
  const candidate = value === undefined ? fallback : value;
  const hard = GATEWAY_HARD_LIMITS[name];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > hard) {
    throw new GatewayPolicyError(`${name} must be an integer in [1, ${hard}]`, "invalid_policy_limit");
  }
  return candidate as number;
}

export function normalizeGatewayPolicyLimits(input: Partial<GatewayPolicyLimits> = {}): GatewayPolicyLimits {
  return {
    maxRequestBytes: limit("maxRequestBytes", input.maxRequestBytes, DEFAULT_GATEWAY_POLICY_LIMITS.maxRequestBytes),
    maxOutputBytes: limit("maxOutputBytes", input.maxOutputBytes, DEFAULT_GATEWAY_POLICY_LIMITS.maxOutputBytes),
    maxConcurrentRequests: limit("maxConcurrentRequests", input.maxConcurrentRequests, DEFAULT_GATEWAY_POLICY_LIMITS.maxConcurrentRequests),
    maxConcurrentJobs: limit("maxConcurrentJobs", input.maxConcurrentJobs, DEFAULT_GATEWAY_POLICY_LIMITS.maxConcurrentJobs),
    maxConcurrentTasks: limit("maxConcurrentTasks", input.maxConcurrentTasks, DEFAULT_GATEWAY_POLICY_LIMITS.maxConcurrentTasks),
    maxJobs: limit("maxJobs", input.maxJobs, DEFAULT_GATEWAY_POLICY_LIMITS.maxJobs),
    maxTasks: limit("maxTasks", input.maxTasks, DEFAULT_GATEWAY_POLICY_LIMITS.maxTasks),
    maxCommandBytes: limit("maxCommandBytes", input.maxCommandBytes, DEFAULT_GATEWAY_POLICY_LIMITS.maxCommandBytes),
    maxFileReadBytes: limit("maxFileReadBytes", input.maxFileReadBytes, DEFAULT_GATEWAY_POLICY_LIMITS.maxFileReadBytes),
    maxFileWriteBytes: limit("maxFileWriteBytes", input.maxFileWriteBytes, DEFAULT_GATEWAY_POLICY_LIMITS.maxFileWriteBytes),
    maxPatchFiles: limit("maxPatchFiles", input.maxPatchFiles, DEFAULT_GATEWAY_POLICY_LIMITS.maxPatchFiles),
    maxExecTimeoutMs: limit("maxExecTimeoutMs", input.maxExecTimeoutMs, DEFAULT_GATEWAY_POLICY_LIMITS.maxExecTimeoutMs),
    maxLeaseTtlMs: limit("maxLeaseTtlMs", input.maxLeaseTtlMs, DEFAULT_GATEWAY_POLICY_LIMITS.maxLeaseTtlMs),
    maxWorkspaceCount: limit("maxWorkspaceCount", input.maxWorkspaceCount, DEFAULT_GATEWAY_POLICY_LIMITS.maxWorkspaceCount),
  };
}

function bytesOf(value: unknown): number {
  if (typeof value === "string") return utf8Bytes(value);
  if (value instanceof Uint8Array) return value.byteLength;
  try { return utf8Bytes(JSON.stringify(value) ?? ""); } catch { return Number.POSITIVE_INFINITY; }
}

function configuredWorkspacePath(value: GatewayWorkspaceConfig | string | { path: string }): string {
  return canonicalizeWorkspacePath(typeof value === "string" ? value : value.path);
}

export class GatewayPolicy {
  readonly limits: GatewayPolicyLimits;
  private readonly workspaceRoot?: string;
  private readonly configuredWorkspaces: GatewayVisibleWorkspace[];
  private readonly registry?: WorkspaceRegistry;
  private readonly trustedRoots: string[];
  private readonly now: () => number;
  private readonly active = new Map<GatewayConcurrencyKind, number>();
  private readonly activeMonitorWaitByPrincipal = new Map<string, number>();
  readonly monitorWaitLimits: GatewayMonitorWaitLimits;

  constructor(options: GatewayPolicyOptions = {}) {
    this.limits = normalizeGatewayPolicyLimits(options.limits);
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : canonicalizeWorkspacePath(options.workspaceRoot);
    this.registry = options.registry;
    this.trustedRoots = options.trustedFullAccess?.enabled === true
      ? (options.trustedFullAccess.workspaceRoots ?? []).map(canonicalizeWorkspacePath)
      : [];
    this.now = options.now ?? (() => Date.now());
    this.monitorWaitLimits = this.normalizeMonitorWaitLimits(options.monitorWait);
    this.configuredWorkspaces = (options.workspaces ?? []).map((entry) => {
      const path = configuredWorkspacePath(entry);
      const id = typeof entry === "object" && entry !== null && ("workspaceId" in entry || "id" in entry)
        ? String((entry as { workspaceId?: string; id?: string }).workspaceId ?? (entry as { id?: string }).id)
        : workspaceIdForPath(path);
      const lease = typeof entry === "object" && entry !== null && "mode" in entry && entry.mode === "lease";
      const ttlMs = typeof entry === "object" && entry !== null && "ttlMs" in entry ? entry.ttlMs : undefined;
      const generation = typeof entry === "object" && entry !== null && "generation" in entry && Number.isSafeInteger(entry.generation)
        ? entry.generation as number
        : 1;
      return {
        version: GATEWAY_STATE_VERSION,
        id,
        path,
        canonicalPath: path,
        mode: lease ? "lease" as const : "permanent" as const,
        generation,
        registeredAt: 0,
        updatedAt: 0,
        ...(lease ? { expiresAt: this.now() + (typeof ttlMs === "number" ? ttlMs : 0) } : {}),
      };
    });
    if (this.workspaceRoot && !this.configuredWorkspaces.some((entry) => entry.path === this.workspaceRoot)) {
      this.configuredWorkspaces.unshift({
        version: GATEWAY_STATE_VERSION,
        path: this.workspaceRoot,
        canonicalPath: this.workspaceRoot,
        id: workspaceIdForPath(this.workspaceRoot),
        mode: "permanent",
        generation: 1,
        registeredAt: 0,
        updatedAt: 0,
      });
    }
    if (this.configuredWorkspaces.length > this.limits.maxWorkspaceCount) throw new GatewayPolicyError("too many configured workspaces", "workspace_limit");
  }

  /** Canonicalise the workspace before doing any principal/path comparison. */
  canonicalWorkspace(input: string): string {
    return canonicalizeWorkspacePath(input);
  }
  normalizeWorkspace(input: string): string { return this.canonicalWorkspace(input); }

  isTrustedWorkspace(input: string): boolean {
    const workspace = this.canonicalWorkspace(input);
    return this.trustedRoots.some((root) => isPathWithin(root, workspace));
  }

  canonicalPath(workspace: string, requestedPath: string): string {
    const canonicalWorkspace = this.canonicalWorkspace(workspace);
    return canonicalizeWorkspaceChild(canonicalWorkspace, requestedPath);
  }
  normalizePath(workspace: string, requestedPath: string): string { return this.canonicalPath(workspace, requestedPath); }

  authorizeWorkspaceSync(principal: GatewayPrincipal, workspaceInput: string): GatewayPolicyDecision {
    const entry = this.findWorkspace(this.configuredWorkspaces, workspaceInput);
    if (!entry) return { allowed: false, reason: "workspace is not registered", principal: principalKey(principal) };
    return this.authorizeKnownWorkspace(principal, entry);
  }

  async authorizeWorkspace(principal: GatewayPrincipal, workspaceInput: string): Promise<GatewayPolicyDecision> {
    const entry = this.findWorkspace(await this.knownWorkspaces(), workspaceInput);
    if (!entry) return { allowed: false, reason: "workspace is not registered", principal: principalKey(principal) };
    return this.authorizeKnownWorkspace(principal, entry);
  }

  async assertWorkspace(principal: GatewayPrincipal, workspaceInput: string): Promise<string> {
    const decision = await this.authorizeWorkspace(principal, workspaceInput);
    if (!decision.allowed || decision.workspacePath === undefined) throw new GatewayPolicyError(decision.reason);
    return decision.workspacePath;
  }

  async listAuthorizedWorkspaces(principal: GatewayPrincipal): Promise<GatewayVisibleWorkspace[]> {
    const result: GatewayVisibleWorkspace[] = [];
    for (const workspace of await this.knownWorkspaces()) {
      if (this.authorizeKnownWorkspace(principal, workspace).allowed) result.push(structuredClone(workspace));
    }
    return result;
  }

  async authorizePath(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): Promise<GatewayPolicyDecision> {
    const workspaceDecision = await this.authorizeWorkspace(principal, workspaceInput);
    if (!workspaceDecision.allowed || workspaceDecision.workspacePath === undefined) return { ...workspaceDecision, operation };
    const workspace = workspaceDecision.workspacePath;
    let canonicalPath: string;
    try { canonicalPath = this.canonicalPath(workspace, requestedPath); }
    catch (error) {
      return {
        ...workspaceDecision,
        allowed: false,
        reason: error instanceof Error ? error.message : "path is outside the registered workspace",
        operation,
      };
    }
    return { ...workspaceDecision, allowed: true, reason: `${operation} path is within the registered workspace`, operation, canonicalPath };
  }

  authorizePathSync(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): GatewayPolicyDecision {
    const decision = this.authorizeWorkspaceSync(principal, workspaceInput);
    if (!decision.allowed || decision.workspacePath === undefined) return { ...decision, operation };
    let canonicalPath: string;
    try { canonicalPath = this.canonicalPath(decision.workspacePath, requestedPath); }
    catch (error) {
      return { ...decision, allowed: false, reason: error instanceof Error ? error.message : "path is outside the registered workspace", operation };
    }
    return { ...decision, allowed: true, operation, canonicalPath, reason: `${operation} path is within the registered workspace` };
  }

  assertPathSync(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): string {
    const decision = this.authorizePathSync(principal, workspaceInput, requestedPath, operation);
    if (!decision.allowed || decision.canonicalPath === undefined) throw new GatewayPolicyError(decision.reason);
    return decision.canonicalPath;
  }

  async assertPath(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): Promise<string> {
    const decision = await this.authorizePath(principal, workspaceInput, requestedPath, operation);
    if (!decision.allowed || decision.canonicalPath === undefined) throw new GatewayPolicyError(decision.reason);
    return decision.canonicalPath;
  }
  async assertAuthorizedPath(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): Promise<string> {
    return this.assertPath(principal, workspaceInput, requestedPath, operation);
  }

  checkRequest(value: unknown): number {
    return this.assertBytes(value, this.limits.maxRequestBytes, "request");
  }
  assertRequest(value: unknown): number { return this.checkRequest(value); }
  checkRequestBytes(value: unknown): number { return this.checkRequest(value); }
  checkOutput(value: unknown): number {
    return this.assertBytes(value, this.limits.maxOutputBytes, "output");
  }
  assertOutput(value: unknown): number { return this.checkOutput(value); }
  checkOutputBytes(value: unknown): number { return this.checkOutput(value); }
  checkCommand(command: string): number {
    return this.assertBytes(command, this.limits.maxCommandBytes, "command");
  }
  assertCommand(command: string): number { return this.checkCommand(command); }
  checkFileRead(value: unknown): number {
    return this.assertBytes(value, this.limits.maxFileReadBytes, "file read");
  }
  assertFileRead(value: unknown): number { return this.checkFileRead(value); }
  checkFileWrite(value: unknown): number {
    return this.assertBytes(value, this.limits.maxFileWriteBytes, "file write");
  }
  assertFileWrite(value: unknown): number { return this.checkFileWrite(value); }
  checkPatchFiles(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.maxPatchFiles) throw new GatewayBoundsError(`patch file count exceeds ${this.limits.maxPatchFiles}`);
  }
  checkTimeout(timeoutMs: number): number {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.limits.maxExecTimeoutMs) throw new GatewayBoundsError(`execution timeout exceeds ${this.limits.maxExecTimeoutMs}ms`);
    return timeoutMs;
  }

  acquire(kind: GatewayConcurrencyKind = "request"): () => void {
    const current = this.active.get(kind) ?? 0;
    const maximum = kind === "request" ? this.limits.maxConcurrentRequests
      : kind === "job" ? this.limits.maxConcurrentJobs
        : kind === "task" ? this.limits.maxConcurrentTasks
          : this.monitorWaitLimits.global;
    if (current >= maximum) throw new GatewayBoundsError(`${kind} concurrency limit ${maximum} reached`);
    this.active.set(kind, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(kind) ?? 1) - 1;
      if (next <= 0) this.active.delete(kind); else this.active.set(kind, next);
    };
  }

  acquireMonitorWait(principal: GatewayPrincipal): () => void {
    const key = principalKey(principal);
    const perPrincipal = this.activeMonitorWaitByPrincipal.get(key) ?? 0;
    if (perPrincipal >= this.monitorWaitLimits.perPrincipal) {
      throw new GatewayBoundsError(`monitor-wait principal concurrency limit ${this.monitorWaitLimits.perPrincipal} reached`);
    }
    const releaseGlobal = this.acquire("monitor-wait");
    this.activeMonitorWaitByPrincipal.set(key, perPrincipal + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeMonitorWaitByPrincipal.get(key) ?? 1) - 1;
      if (next <= 0) this.activeMonitorWaitByPrincipal.delete(key); else this.activeMonitorWaitByPrincipal.set(key, next);
      releaseGlobal();
    };
  }

  normalizeMonitorWaitTimeout(timeoutMs: unknown): number {
    const value = timeoutMs === undefined ? this.monitorWaitLimits.defaultTimeoutMs : timeoutMs;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > this.monitorWaitLimits.maxTimeoutMs) {
      throw new GatewayBoundsError(`monitor wait timeout must be in [1, ${this.monitorWaitLimits.maxTimeoutMs}]ms`);
    }
    return value as number;
  }
  tryAcquire(kind: GatewayConcurrencyKind = "request"): (() => void) | undefined {
    try { return this.acquire(kind); } catch (error) { if (error instanceof GatewayBoundsError) return undefined; throw error; }
  }
  activeCount(kind: GatewayConcurrencyKind = "request"): number { return this.active.get(kind) ?? 0; }
  activeMonitorWaitCount(principal?: GatewayPrincipal): number {
    return principal === undefined ? this.activeCount("monitor-wait") : this.activeMonitorWaitByPrincipal.get(principalKey(principal)) ?? 0;
  }

  async withConcurrency<T>(kind: GatewayConcurrencyKind, operation: () => Promise<T> | T): Promise<T> {
    const release = this.acquire(kind);
    try { return await operation(); } finally { release(); }
  }

  async withMonitorWait<T>(principal: GatewayPrincipal, operation: () => Promise<T> | T): Promise<T> {
    const release = this.acquireMonitorWait(principal);
    try { return await operation(); } finally { release(); }
  }

  private normalizeMonitorWaitLimits(input: Partial<GatewayMonitorWaitLimits> | undefined): GatewayMonitorWaitLimits {
    const value = { ...DEFAULT_GATEWAY_MONITOR_WAIT_LIMITS, ...input };
    for (const [name, candidate] of Object.entries(value)) {
      if (!Number.isSafeInteger(candidate) || candidate < 1) throw new GatewayPolicyError(`monitorWait.${name} must be a positive integer`, "invalid_policy_limit");
    }
    if (value.defaultTimeoutMs > value.maxTimeoutMs) throw new GatewayPolicyError("monitorWait.defaultTimeoutMs cannot exceed maxTimeoutMs", "invalid_policy_limit");
    return value;
  }

  private assertBytes(value: unknown, maximum: number, label: string): number {
    const bytes = bytesOf(value);
    if (bytes > maximum) throw new GatewayBoundsError(`${label} exceeds ${maximum} bytes`);
    return bytes;
  }

  private authorizeKnownWorkspace(principal: GatewayPrincipal, entry: GatewayVisibleWorkspace): GatewayPolicyDecision {
    const workspace = entry.canonicalPath ?? entry.path;
    const base = { workspaceId: entry.id, workspacePath: workspace, principal: principalKey(principal) };
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) return { ...base, allowed: false, reason: "workspace lease has expired" };
    if (principal.workspaceId !== undefined && principal.workspaceId !== entry.id && principal.workspaceId !== workspace) {
      return { ...base, allowed: false, reason: "principal is bound to a different workspace" };
    }
    if (principal.workspacePath !== undefined && !isPathWithin(principal.workspacePath, workspace)) {
      return { ...base, allowed: false, reason: "workspace is outside the principal workspace" };
    }
    return { ...base, allowed: true, reason: "workspace is registered" };
  }

  private findWorkspace(workspaces: readonly GatewayVisibleWorkspace[], input: string): GatewayVisibleWorkspace | undefined {
    const byId = workspaces.filter((entry) => entry.id === input);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return undefined;
    let path: string;
    try { path = canonicalizeWorkspacePath(input); } catch { return undefined; }
    const byPath = workspaces.filter((entry) => (entry.canonicalPath ?? entry.path) === path);
    return byPath.length === 1 ? byPath[0] : undefined;
  }

  private async knownWorkspaces(): Promise<GatewayVisibleWorkspace[]> {
    const known = new Map(this.configuredWorkspaces.map((entry) => [entry.path, entry]));
    if (this.registry) {
      const registered = await this.registry.list();
      for (const workspace of registered) {
        const path = canonicalizeWorkspacePath(workspace.canonicalPath ?? workspace.path);
        const { ownerToken: _ownerToken, ...visible } = workspace;
        known.set(path, { ...visible, path, canonicalPath: path, id: workspace.id || workspaceIdForPath(path) });
      }
    }
    return [...known.values()].sort((left, right) => left.path.localeCompare(right.path));
  }
}

export const createGatewayPolicy = (options?: GatewayPolicyOptions): GatewayPolicy => new GatewayPolicy(options);
export const canonicalizeGatewayPath = canonicalizeWorkspaceChild;
