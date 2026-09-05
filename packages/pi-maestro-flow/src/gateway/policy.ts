/** Canonical path authorization and hard Gateway resource bounds. */
import {
  GATEWAY_DEFAULT_LIMITS,
  GATEWAY_HARD_LIMITS,
  type GatewayPrincipal,
} from "./contracts.ts";
import type { GatewayLimitsConfig, GatewayWorkspaceConfig } from "./config.ts";
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
export type GatewayConcurrencyKind = "request" | "job" | "task";

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
}

export interface GatewayPolicyDecision {
  allowed: boolean;
  reason: string;
  operation?: GatewayPolicyOperation;
  workspacePath?: string;
  canonicalPath?: string;
  principal?: string;
}

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
  private readonly configuredWorkspaces: Array<{ path: string; id: string; expiresAt?: number }>;
  private readonly registry?: WorkspaceRegistry;
  private readonly now: () => number;
  private readonly active = new Map<GatewayConcurrencyKind, number>();

  constructor(options: GatewayPolicyOptions = {}) {
    this.limits = normalizeGatewayPolicyLimits(options.limits);
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : canonicalizeWorkspacePath(options.workspaceRoot);
    this.registry = options.registry;
    this.now = options.now ?? (() => Date.now());
    this.configuredWorkspaces = (options.workspaces ?? []).map((entry) => {
      const path = configuredWorkspacePath(entry);
      const id = typeof entry === "object" && entry !== null && ("workspaceId" in entry || "id" in entry)
        ? String((entry as { workspaceId?: string; id?: string }).workspaceId ?? (entry as { id?: string }).id)
        : workspaceIdForPath(path);
      const lease = typeof entry === "object" && entry !== null && "mode" in entry && entry.mode === "lease";
      const ttlMs = typeof entry === "object" && entry !== null && "ttlMs" in entry ? entry.ttlMs : undefined;
      return { path, id, ...(lease ? { expiresAt: this.now() + (typeof ttlMs === "number" ? ttlMs : 0) } : {}) };
    });
    if (this.workspaceRoot && !this.configuredWorkspaces.some((entry) => entry.path === this.workspaceRoot)) {
      this.configuredWorkspaces.unshift({ path: this.workspaceRoot, id: workspaceIdForPath(this.workspaceRoot) });
    }
    if (this.configuredWorkspaces.length > this.limits.maxWorkspaceCount) throw new GatewayPolicyError("too many configured workspaces", "workspace_limit");
  }

  /** Canonicalise the workspace before doing any principal/path comparison. */
  canonicalWorkspace(input: string): string {
    return canonicalizeWorkspacePath(input);
  }
  normalizeWorkspace(input: string): string { return this.canonicalWorkspace(input); }

  canonicalPath(workspace: string, requestedPath: string): string {
    const canonicalWorkspace = this.canonicalWorkspace(workspace);
    return canonicalizeWorkspaceChild(canonicalWorkspace, requestedPath);
  }
  normalizePath(workspace: string, requestedPath: string): string { return this.canonicalPath(workspace, requestedPath); }

  authorizeWorkspaceSync(principal: GatewayPrincipal, workspaceInput: string): GatewayPolicyDecision {
    const workspace = this.canonicalWorkspace(workspaceInput);
    const entry = this.configuredWorkspaces.find((candidate) => candidate.path === workspace);
    if (!entry) return { allowed: false, reason: "workspace is not registered", workspacePath: workspace, principal: principalKey(principal) };
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) return { allowed: false, reason: "workspace lease has expired", workspacePath: workspace, principal: principalKey(principal) };
    if (principal.workspaceId !== undefined && principal.workspaceId !== entry.id && principal.workspaceId !== workspace) {
      return { allowed: false, reason: "principal is bound to a different workspace", workspacePath: workspace, principal: principalKey(principal) };
    }
    return { allowed: true, reason: "workspace is registered", workspacePath: workspace, principal: principalKey(principal) };
  }

  async authorizeWorkspace(principal: GatewayPrincipal, workspaceInput: string): Promise<GatewayPolicyDecision> {
    const workspace = this.canonicalWorkspace(workspaceInput);
    const configured = await this.knownWorkspaces();
    const entry = configured.find((candidate) => candidate.path === workspace);
    if (!entry) return { allowed: false, reason: "workspace is not registered", workspacePath: workspace, principal: principalKey(principal) };
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) return { allowed: false, reason: "workspace lease has expired", workspacePath: workspace, principal: principalKey(principal) };
    if (principal.workspaceId !== undefined && principal.workspaceId !== entry.id && principal.workspaceId !== workspace) {
      return { allowed: false, reason: "principal is bound to a different workspace", workspacePath: workspace, principal: principalKey(principal) };
    }
    if (principal.workspacePath !== undefined && !isPathWithin(principal.workspacePath, workspace)) {
      return { allowed: false, reason: "workspace is outside the principal workspace", workspacePath: workspace, principal: principalKey(principal) };
    }
    return { allowed: true, reason: "workspace is registered", workspacePath: workspace, principal: principalKey(principal) };
  }

  async authorizePath(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): Promise<GatewayPolicyDecision> {
    const workspace = this.canonicalWorkspace(workspaceInput);
    let canonicalPath: string;
    try { canonicalPath = this.canonicalPath(workspace, requestedPath); }
    catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "path is outside the registered workspace",
        operation,
        workspacePath: workspace,
        principal: principalKey(principal),
      };
    }
    const workspaceDecision = await this.authorizeWorkspace(principal, workspace);
    if (!workspaceDecision.allowed) return { ...workspaceDecision, operation, canonicalPath };
    return { allowed: true, reason: `${operation} path is within the registered workspace`, operation, workspacePath: workspace, canonicalPath, principal: principalKey(principal) };
  }

  authorizePathSync(principal: GatewayPrincipal, workspaceInput: string, requestedPath: string, operation: GatewayPolicyOperation = "read"): GatewayPolicyDecision {
    const workspace = this.canonicalWorkspace(workspaceInput);
    let canonicalPath: string;
    try { canonicalPath = this.canonicalPath(workspace, requestedPath); }
    catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : "path is outside the registered workspace", operation, workspacePath: workspace, principal: principalKey(principal) };
    }
    const decision = this.authorizeWorkspaceSync(principal, workspace);
    return decision.allowed ? { ...decision, allowed: true, operation, canonicalPath, reason: `${operation} path is within the registered workspace` } : { ...decision, operation, canonicalPath };
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
    const maximum = kind === "request" ? this.limits.maxConcurrentRequests : kind === "job" ? this.limits.maxConcurrentJobs : this.limits.maxConcurrentTasks;
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
  tryAcquire(kind: GatewayConcurrencyKind = "request"): (() => void) | undefined {
    try { return this.acquire(kind); } catch (error) { if (error instanceof GatewayBoundsError) return undefined; throw error; }
  }
  activeCount(kind: GatewayConcurrencyKind = "request"): number { return this.active.get(kind) ?? 0; }

  async withConcurrency<T>(kind: GatewayConcurrencyKind, operation: () => Promise<T> | T): Promise<T> {
    const release = this.acquire(kind);
    try { return await operation(); } finally { release(); }
  }

  private assertBytes(value: unknown, maximum: number, label: string): number {
    const bytes = bytesOf(value);
    if (bytes > maximum) throw new GatewayBoundsError(`${label} exceeds ${maximum} bytes`);
    return bytes;
  }

  private async knownWorkspaces(): Promise<Array<{ path: string; id: string; expiresAt?: number }>> {
    const configured = [...this.configuredWorkspaces];
    if (this.registry) {
      const registered = await this.registry.list();
      for (const workspace of registered) {
        const path = canonicalizeWorkspacePath(workspace.canonicalPath ?? workspace.path);
        const id = workspace.id || workspaceIdForPath(path);
        if (!configured.some((entry) => entry.path === path)) configured.push({ path, id });
      }
    }
    return configured;
  }
}

export const createGatewayPolicy = (options?: GatewayPolicyOptions): GatewayPolicy => new GatewayPolicy(options);
export const canonicalizeGatewayPath = canonicalizeWorkspaceChild;
