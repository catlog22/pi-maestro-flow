/** Bounded asynchronous local jobs with cursor-addressable output logs. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, readdir, unlink } from "node:fs/promises";
import type { GatewayCommandSecurityConfig } from "../config.ts";
import type { GatewayJob, GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { createLocalGatewayPrincipal } from "../principal.ts";
import { GatewayPolicy, GatewayPolicyError } from "../policy.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { canonicalizeWorkspaceChild, canonicalizeWorkspacePath, containedPath, readGatewayJson, utf8Bytes, writeGatewayJsonAtomic } from "../state-paths.ts";
import { parseGatewayJob, parseGatewayPrincipal, parseGatewayResult } from "../validation.ts";
import { evaluateCommandPolicy } from "./exec-service.ts";

const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_LOG_EVENTS = 1024;
const TERMINATION_GRACE_MS = 150;
const TERMINATION_FORCE_MS = 500;

class GatewayJobServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayJobServiceError";
    this.code = code;
  }
}

export interface JobServiceOptions {
  policy?: GatewayPolicy;
  commandPolicy?: Partial<GatewayCommandSecurityConfig>;
  security?: { commands?: Partial<GatewayCommandSecurityConfig> };
  workspaceRoot?: string;
  principal?: GatewayPrincipal;
  jobsRoot?: string;
  stateDir?: string;
  maxOutputBytes?: number;
  maxLogEvents?: number;
  retentionMs?: number;
  now?: () => number;
  trustedFullAccess?: boolean;
}

export interface JobStartInput {
  command?: string;
  argv?: readonly string[];
  args?: readonly string[];
  cwd?: string;
  workspace?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  readonly?: boolean;
  signal?: AbortSignal;
  principal?: GatewayPrincipal;
  requestId?: string;
}

export interface JobLookupInput {
  id: string;
  principal?: GatewayPrincipal;
  requestId?: string;
}

export interface JobLogsInput extends JobLookupInput {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
}

export interface JobStdinInput extends JobLookupInput {
  data: string | Uint8Array;
}

export interface JobLogEntry {
  cursor: number;
  stream: "stdout" | "stderr";
  data: string;
  at: number;
}

export interface JobLogsData {
  id: string;
  entries: JobLogEntry[];
  cursor: number;
  nextCursor: number;
  done: boolean;
  truncated: boolean;
}

export interface JobStdinData {
  id: string;
  bytes: number;
  accepted: true;
}

export type JobAction = "start" | "list" | "status" | "logs" | "stdin" | "cancel";
export type JobActionRequest = JobStartInput & Partial<JobLookupInput & JobLogsInput & JobStdinInput> & { action: JobAction };

interface RuntimeJob {
  snapshot: GatewayJob;
  args: string[];
  child?: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
  outputBytes: number;
  logs: JobLogEntry[];
  nextCursor: number;
  cancelRequested: boolean;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError?: unknown;
  termination?: Promise<void>;
  finishing: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  releaseConcurrency?: () => void;
}

function mergeCommandPolicy(input: Partial<GatewayCommandSecurityConfig> | undefined): GatewayCommandSecurityConfig {
  return {
    default: input?.default ?? "allow",
    allow: [...(input?.allow ?? [])],
    confirm: [...(input?.confirm ?? [])],
    deny: [...(input?.deny ?? [])],
    autoAllowReadonly: input?.autoAllowReadonly ?? null,
  };
}

function requestOptions(principal: GatewayPrincipal, requestId: string | undefined, startedAt: number) {
  return {
    requestId: requestId && requestId.trim() ? requestId : randomUUID(),
    principalId: principal.id,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof GatewayPolicyError) return error.code;
  if (error instanceof Error && error.name === "GatewayValidationError") return "invalid_principal";
  const candidate = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) return candidate.toLowerCase();
  return "internal_error";
}

function errorResult<T>(
  error: unknown,
  principal: GatewayPrincipal,
  requestId: string | undefined,
  startedAt: number,
  data?: T,
  status: "failed" | "cancelled" | "lost" = "failed",
): GatewayResult<T> {
  const base = gatewayError({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) }, {
    ...requestOptions(principal, requestId, startedAt),
    status,
  });
  return data === undefined ? base as GatewayResult<T> : parseGatewayResult<T>({ ...base, data });
}

function validateArgv(input: JobStartInput): { command: string; args: string[] } {
  if (input.argv !== undefined && input.command !== undefined) throw new GatewayJobServiceError("invalid_input", "provide either argv or command, not both");
  if (input.argv !== undefined && input.args !== undefined) throw new GatewayJobServiceError("invalid_input", "args cannot be combined with argv");
  const argv = input.argv === undefined
    ? input.command === undefined ? [] : [input.command, ...(input.args ?? [])]
    : [...input.argv];
  if (argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim() === "") throw new GatewayJobServiceError("invalid_input", "command is required");
  for (const value of argv) if (typeof value !== "string" || value.includes("\0")) throw new GatewayJobServiceError("invalid_input", "command arguments must be strings without NUL bytes");
  return { command: argv[0]!, args: argv.slice(1) };
}

function appendOutput(buffers: Buffer[], chunk: unknown, runtime: RuntimeJob, maximum: number): { truncated: boolean; acceptedBytes: number } {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = Math.max(0, maximum - runtime.outputBytes);
  const accepted = remaining >= buffer.byteLength ? buffer : buffer.subarray(0, remaining);
  if (accepted.byteLength > 0) buffers.push(accepted);
  runtime.outputBytes += accepted.byteLength;
  return { truncated: accepted.byteLength < buffer.byteLength, acceptedBytes: accepted.byteLength };
}

function addLog(runtime: RuntimeJob, stream: "stdout" | "stderr", chunk: unknown, acceptedBytes: number, maxEvents: number, at: number): void {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const accepted = data.subarray(0, Math.max(0, Math.min(data.byteLength, acceptedBytes)));
  if (accepted.byteLength === 0) return;
  runtime.logs.push({ cursor: runtime.nextCursor++, stream, data: accepted.toString("utf8"), at });
  while (runtime.logs.length > maxEvents) runtime.logs.shift();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      let killer: ChildProcess;
      try { killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
      catch { finish(); return; }
      killer.once("error", finish);
      killer.once("close", finish);
      const timer = setTimeout(() => { try { killer.kill(); } catch { /* taskkill already exited */ } finish(); }, TERMINATION_FORCE_MS);
      timer.unref?.();
    });
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* the leader already exited */ }
    }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill("SIGTERM"); } catch { /* process exited during cleanup */ }
    }
  }
  await delay(TERMINATION_GRACE_MS);
  if (processGroupRunning(pid)) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try { child.kill("SIGKILL"); } catch { /* process exited during cleanup */ }
      }
    }
  } else if (child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* process exited during cleanup */ }
  }
  await delay(TERMINATION_FORCE_MS);
}

function cloneJob(job: GatewayJob): GatewayJob { return structuredClone(job); }

export class JobService {
  readonly policy?: GatewayPolicy;
  readonly commandPolicy: GatewayCommandSecurityConfig;
  private readonly workspaceRoot?: string;
  private readonly defaultPrincipal: GatewayPrincipal;
  private readonly jobsRoot?: string;
  private readonly configuredMaxOutputBytes: number;
  private readonly maxLogEvents: number;
  private readonly retentionMs?: number;
  private readonly now: () => number;
  private readonly trustedFullAccess: boolean;
  private readonly jobs = new Map<string, RuntimeJob>();
  private loaded = false;
  private loading?: Promise<void>;

  constructor(options: JobServiceOptions = {}) {
    this.policy = options.policy;
    this.commandPolicy = mergeCommandPolicy(options.commandPolicy ?? options.security?.commands);
    this.trustedFullAccess = options.trustedFullAccess === true;
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : canonicalizeWorkspacePath(options.workspaceRoot);
    this.defaultPrincipal = options.principal === undefined
      ? createLocalGatewayPrincipal("gateway-job", this.workspaceRoot ? { workspacePath: this.workspaceRoot } : {})
      : parseGatewayPrincipal(options.principal);
    this.jobsRoot = options.jobsRoot ?? options.stateDir;
    const policyMaximum = options.policy?.limits.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const configured = options.maxOutputBytes ?? policyMaximum;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > policyMaximum) throw new Error(`maxOutputBytes must be in [1, ${policyMaximum}]`);
    this.configuredMaxOutputBytes = configured;
    this.maxLogEvents = options.maxLogEvents ?? DEFAULT_LOG_EVENTS;
    if (!Number.isSafeInteger(this.maxLogEvents) || this.maxLogEvents < 1 || this.maxLogEvents > 100_000) throw new Error("maxLogEvents must be an integer in [1, 100000]");
    this.retentionMs = options.retentionMs;
    if (this.retentionMs !== undefined && (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1)) throw new Error("retentionMs must be a positive safe integer");
    this.now = options.now ?? (() => Date.now());
  }

  async start(input: JobStartInput): Promise<GatewayResult<{ job: GatewayJob }>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    try {
      await this.ensureLoaded();
      await this.pruneExpired();
      const { command, args } = validateArgv(input);
      const identity = [command, ...args].join(" ");
      const maximumCommand = this.policy?.limits.maxCommandBytes ?? 64 * 1024;
      if (utf8Bytes(identity) > maximumCommand) throw new GatewayJobServiceError("bounds_exceeded", `command exceeds ${maximumCommand} bytes`);
      if (this.policy) this.policy.checkCommand(identity);
      const requestedCwdForPolicy = input.cwd ?? input.workspace ?? principal.workspacePath ?? this.workspaceRoot ?? process.cwd();
      const workspaceForPolicy = input.workspace ?? this.workspaceRoot ?? principal.workspacePath ?? requestedCwdForPolicy;
      const trustedDefault = this.trustedFullAccess && this.policy?.isTrustedWorkspace(workspaceForPolicy)
        ? { ...this.commandPolicy, default: "allow" as const }
        : this.commandPolicy;
      const decision = evaluateCommandPolicy(identity, trustedDefault, input.readonly === true);
      if (decision === "deny") throw new GatewayPolicyError("command is denied by Gateway policy", "command_denied");
      if (decision === "confirm") throw new GatewayPolicyError("command requires confirmation", "confirmation_required");
      if (this.jobs.size >= (this.policy?.limits.maxJobs ?? 64)) throw new GatewayPolicyError("job limit reached", "job_limit");
      const timeoutMs = input.timeoutMs ?? this.policy?.limits.maxExecTimeoutMs ?? 5 * 60 * 1000;
      if (this.policy) this.policy.checkTimeout(timeoutMs);
      else if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new GatewayJobServiceError("invalid_input", "timeoutMs must be a positive safe integer");
      const maximumOutput = input.maxOutputBytes ?? this.configuredMaxOutputBytes;
      if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 1 || maximumOutput > this.configuredMaxOutputBytes) throw new GatewayJobServiceError("bounds_exceeded", `maxOutputBytes must be in [1, ${this.configuredMaxOutputBytes}]`);
      const requestedCwd = input.cwd ?? input.workspace ?? principal.workspacePath ?? this.workspaceRoot ?? process.cwd();
      const workspace = input.workspace ?? this.workspaceRoot ?? principal.workspacePath ?? requestedCwd;
      const cwd = this.policy
        ? await this.policy.assertPath(principal, workspace, requestedCwd, "job")
        : canonicalizeWorkspaceChild(workspace, requestedCwd);
      const cwdStat = await lstat(cwd);
      if (!cwdStat.isDirectory()) throw new GatewayJobServiceError("invalid_input", "job cwd must be a directory");
      const id = `job-${randomUUID()}`;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      const now = this.now();
      const snapshot = parseGatewayJob({
        version: 1,
        id,
        status: "queued",
        command,
        cwd,
        principalId: principal.id,
        createdAt: now,
        updatedAt: now,
        stdout: "",
        stderr: "",
      });
      const runtime: RuntimeJob = {
        snapshot,
        args,
        stdout: [],
        stderr: [],
        outputBytes: 0,
        logs: [],
        nextCursor: 0,
        cancelRequested: false,
        timedOut: false,
        outputTruncated: false,
        finishing: false,
        finished,
        resolveFinished,
        signal: input.signal,
      };
      this.jobs.set(id, runtime);
      await this.persist(runtime);
      if (input.signal?.aborted) {
        await this.cancelRuntime(runtime);
      } else {
        runtime.abortHandler = () => { void this.cancelRuntime(runtime); };
        input.signal?.addEventListener("abort", runtime.abortHandler, { once: true });
        queueMicrotask(() => { void this.launch(runtime, maximumOutput, timeoutMs, input.env); });
      }
      return gatewayOk({ job: cloneJob(runtime.snapshot) }, { ...requestOptions(principal, input.requestId, startedAt), status: "accepted" });
    } catch (error) {
      return errorResult(error, principal, input.requestId, startedAt);
    }
  }

  async list(input: { principal?: GatewayPrincipal; requestId?: string } = {}): Promise<GatewayResult<{ jobs: GatewayJob[] }>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); await this.ensureLoaded(); await this.pruneExpired(); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    return gatewayOk({ jobs: [...this.jobs.values()]
      .filter((runtime) => runtime.snapshot.principalId === principal.id)
      .sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt)
      .map((runtime) => cloneJob(runtime.snapshot)) }, requestOptions(principal, input.requestId, startedAt));
  }

  async status(input: JobLookupInput): Promise<GatewayResult<{ job: GatewayJob }>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); await this.ensureLoaded(); await this.pruneExpired(); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    const runtime = this.ownedRuntime(input.id, principal);
    if (!runtime) return errorResult(new GatewayJobServiceError("not_found", `unknown job: ${input.id}`), principal, input.requestId, startedAt);
    if (runtime.finishing) await runtime.finished;
    const data = { job: cloneJob(runtime.snapshot) };
    if (runtime.snapshot.status === "failed" || runtime.snapshot.status === "cancelled" || runtime.snapshot.status === "lost") {
      return errorResult(
        new GatewayJobServiceError(`job_${runtime.snapshot.status}`, runtime.snapshot.error ?? `job is ${runtime.snapshot.status}`),
        principal,
        input.requestId,
        startedAt,
        data,
        runtime.snapshot.status,
      );
    }
    return gatewayOk(data, { ...requestOptions(principal, input.requestId, startedAt), status: this.resultStatus(runtime.snapshot.status) });
  }

  async logs(input: JobLogsInput): Promise<GatewayResult<JobLogsData>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); await this.ensureLoaded(); await this.pruneExpired(); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    const runtime = this.ownedRuntime(input.id, principal);
    if (!runtime) return errorResult(new GatewayJobServiceError("not_found", `unknown job: ${input.id}`), principal, input.requestId, startedAt);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 500;
    const maximum = input.maxBytes ?? this.configuredMaxOutputBytes;
    try {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GatewayJobServiceError("invalid_input", "cursor must be a non-negative safe integer");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new GatewayJobServiceError("invalid_input", "limit must be an integer in [1, 500]");
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > this.configuredMaxOutputBytes) throw new GatewayJobServiceError("bounds_exceeded", `maxBytes must be in [1, ${this.configuredMaxOutputBytes}]`);
      const entries: JobLogEntry[] = [];
      let bytes = 0;
      let truncated = runtime.logs.length > 0 && cursor < runtime.logs[0]!.cursor;
      for (const entry of runtime.logs) {
        if (entry.cursor < cursor) continue;
        if (entries.length >= limit) { truncated = true; break; }
        const entryBytes = Buffer.byteLength(entry.data, "utf8");
        if (bytes + entryBytes > maximum) { truncated = true; break; }
        entries.push({ ...entry });
        bytes += entryBytes;
      }
      const nextCursor = entries.length > 0 ? entries[entries.length - 1]!.cursor + 1 : cursor;
      const data: JobLogsData = { id: input.id, entries, cursor, nextCursor, done: ["completed", "failed", "cancelled", "lost"].includes(runtime.snapshot.status), truncated };
      return gatewayOk(data, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async stdin(input: JobStdinInput): Promise<GatewayResult<JobStdinData>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); await this.ensureLoaded(); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    const runtime = this.ownedRuntime(input.id, principal);
    if (!runtime) return errorResult(new GatewayJobServiceError("not_found", `unknown job: ${input.id}`), principal, input.requestId, startedAt);
    try {
      const payload = typeof input.data === "string" ? Buffer.from(input.data, "utf8") : Buffer.from(input.data);
      const maximum = this.policy?.limits.maxCommandBytes ?? 64 * 1024;
      if (payload.byteLength > maximum) throw new GatewayJobServiceError("bounds_exceeded", `stdin exceeds ${maximum} bytes`);
      if (!runtime.child || runtime.snapshot.status !== "running" || !runtime.child.stdin) throw new GatewayJobServiceError("invalid_state", "job stdin is not writable");
      runtime.child.stdin.write(payload);
      return gatewayOk({ id: input.id, bytes: payload.byteLength, accepted: true }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async cancel(input: JobLookupInput): Promise<GatewayResult<{ job: GatewayJob; cancelled: boolean }>> {
    const startedAt = this.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); await this.ensureLoaded(); }
    catch (error) { return errorResult(error, this.defaultPrincipal, input.requestId, startedAt); }
    const runtime = this.ownedRuntime(input.id, principal);
    if (!runtime) return errorResult(new GatewayJobServiceError("not_found", `unknown job: ${input.id}`), principal, input.requestId, startedAt);
    try {
      const wasActive = !["completed", "failed", "cancelled", "lost"].includes(runtime.snapshot.status);
      await this.cancelRuntime(runtime);
      return gatewayOk({ job: cloneJob(runtime.snapshot), cancelled: wasActive }, requestOptions(principal, input.requestId, startedAt));
    } catch (error) { return errorResult(error, principal, input.requestId, startedAt); }
  }

  async handle(request: JobActionRequest): Promise<GatewayResult<unknown>> {
    if (request.action === "start") return this.start(request);
    if (request.action === "list") return this.list(request);
    if (request.action === "status") return this.status(request as JobLookupInput);
    if (request.action === "logs") return this.logs(request as JobLogsInput);
    if (request.action === "stdin") return this.stdin(request as JobStdinInput);
    if (request.action === "cancel") return this.cancel(request as JobLookupInput);
    return errorResult(new Error(`Unsupported job action: ${String(request.action)}`), this.defaultPrincipal, request.requestId, this.now());
  }

  async shutdown(): Promise<void> {
    await this.ensureLoaded();
    await Promise.all([...this.jobs.values()].filter((runtime) => !["completed", "failed", "cancelled", "lost"].includes(runtime.snapshot.status)).map((runtime) => this.cancelRuntime(runtime)));
  }

  async dispose(): Promise<void> { await this.shutdown(); }
  async close(): Promise<void> { await this.shutdown(); }

  private async launch(runtime: RuntimeJob, maximumOutput: number, timeoutMs: number, env: NodeJS.ProcessEnv | undefined): Promise<void> {
    if (runtime.snapshot.status !== "queued" || runtime.cancelRequested) return;
    try {
      runtime.releaseConcurrency = this.policy?.acquire("job");
      runtime.snapshot = parseGatewayJob({ ...runtime.snapshot, status: "running", startedAt: this.now(), updatedAt: this.now() });
      await this.persist(runtime);
      let child: ChildProcess;
      try {
        child = spawn(runtime.snapshot.command, runtime.args, {
          cwd: runtime.snapshot.cwd,
          env: env === undefined ? process.env : { ...process.env, ...env },
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        runtime.spawnError = error;
        await this.finish(runtime, null, null);
        return;
      }
      runtime.child = child;
      runtime.timer = setTimeout(() => {
        if (runtime.finishing) return;
        runtime.timedOut = true;
        void this.requestTermination(runtime);
      }, timeoutMs);
      runtime.timer.unref?.();
      child.stdout?.on("data", (chunk: unknown) => {
        const appended = appendOutput(runtime.stdout, chunk, runtime, maximumOutput);
        addLog(runtime, "stdout", chunk, appended.acceptedBytes, this.maxLogEvents, this.now());
        if (appended.truncated) {
          runtime.outputTruncated = true;
          void this.requestTermination(runtime);
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        const appended = appendOutput(runtime.stderr, chunk, runtime, maximumOutput);
        addLog(runtime, "stderr", chunk, appended.acceptedBytes, this.maxLogEvents, this.now());
        if (appended.truncated) {
          runtime.outputTruncated = true;
          void this.requestTermination(runtime);
        }
      });
      child.once("error", (error) => { runtime.spawnError = error; });
      child.once("close", (code, signal) => { void this.finish(runtime, code, signal); });
    } catch (error) {
      runtime.spawnError = error;
      await this.finish(runtime, null, null);
    }
  }

  private async requestTermination(runtime: RuntimeJob): Promise<void> {
    if (!runtime.child) return;
    if (!runtime.termination) runtime.termination = terminateProcessTree(runtime.child);
    await runtime.termination;
  }

  private async cancelRuntime(runtime: RuntimeJob): Promise<void> {
    if (runtime.finishing) { await runtime.finished; return; }
    if (["completed", "failed", "cancelled", "lost"].includes(runtime.snapshot.status)) return;
    runtime.cancelRequested = true;
    if (runtime.snapshot.status === "queued") {
      await this.finish(runtime, null, null);
      return;
    }
    await this.requestTermination(runtime);
    await runtime.finished;
  }

  private async finish(runtime: RuntimeJob, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (runtime.finishing) return runtime.finished;
    runtime.finishing = true;
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.termination) {
      try { await runtime.termination; }
      catch (error) { runtime.spawnError ??= new GatewayJobServiceError("cleanup_failed", error instanceof Error ? error.message : String(error)); }
    }
    if (runtime.signal && runtime.abortHandler) runtime.signal.removeEventListener("abort", runtime.abortHandler);
    const stdout = Buffer.concat(runtime.stdout).toString("utf8");
    const stderr = Buffer.concat(runtime.stderr).toString("utf8");
    let status: GatewayJob["status"] = "completed";
    let error: string | undefined;
    if (runtime.cancelRequested) { status = "cancelled"; error = "job cancelled"; }
    else if (runtime.timedOut) { status = "failed"; error = "job timed out"; }
    else if (runtime.outputTruncated) { status = "failed"; error = "job output exceeded configured limit"; }
    else if (runtime.spawnError !== undefined) { status = "failed"; error = runtime.spawnError instanceof Error ? runtime.spawnError.message : String(runtime.spawnError); }
    else if (exitCode !== 0) { status = "failed"; error = `job exited with code ${String(exitCode)}`; }
    runtime.snapshot = parseGatewayJob({
      ...runtime.snapshot,
      status,
      updatedAt: this.now(),
      finishedAt: this.now(),
      exitCode,
      ...(signal === null ? {} : { signal }),
      stdout,
      stderr,
      ...(error === undefined ? {} : { error }),
    });
    try {
      await this.persist(runtime);
    } finally {
      runtime.releaseConcurrency?.();
      runtime.releaseConcurrency = undefined;
      runtime.resolveFinished();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.loadPersisted();
    try { await this.loading; }
    finally { this.loading = undefined; }
  }

  private async loadPersisted(): Promise<void> {
    this.loaded = true;
    if (!this.jobsRoot) return;
    const entries = await readdir(this.jobsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    for (const entry of files) {
      const raw = await readGatewayJson<unknown>(containedPath(this.jobsRoot, entry.name));
      if (raw === undefined) continue;
      const snapshot = parseGatewayJob(raw);
      if (this.jobs.has(snapshot.id)) continue;
      let normalized = snapshot;
      if (snapshot.status === "queued" || snapshot.status === "running") {
        const now = this.now();
        normalized = parseGatewayJob({ ...snapshot, status: "lost", updatedAt: now, finishedAt: now, exitCode: null, error: "job process ownership was lost" });
      }
      if (this.expired(normalized)) {
        await unlink(containedPath(this.jobsRoot, entry.name)).catch((error: unknown) => {
          if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        continue;
      }
      if (this.jobs.size >= (this.policy?.limits.maxJobs ?? 64)) continue;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      resolveFinished();
      this.jobs.set(snapshot.id, {
        snapshot: normalized,
        args: [],
        stdout: normalized.stdout ? [Buffer.from(normalized.stdout)] : [],
        stderr: normalized.stderr ? [Buffer.from(normalized.stderr)] : [],
        outputBytes: Buffer.byteLength(normalized.stdout ?? "", "utf8") + Buffer.byteLength(normalized.stderr ?? "", "utf8"),
        logs: [],
        nextCursor: 0,
        cancelRequested: normalized.status === "cancelled",
        timedOut: false,
        outputTruncated: false,
        finishing: ["completed", "failed", "cancelled", "lost"].includes(normalized.status),
        finished,
        resolveFinished,
      });
      if (normalized !== snapshot) await writeGatewayJsonAtomic(containedPath(this.jobsRoot, entry.name), normalized, { mode: 0o600 });
    }
  }

  private async persist(runtime: RuntimeJob): Promise<void> {
    if (!this.jobsRoot) return;
    await writeGatewayJsonAtomic(containedPath(this.jobsRoot, `${runtime.snapshot.id}.json`), runtime.snapshot, { mode: 0o600 });
  }

  private expired(snapshot: GatewayJob): boolean {
    if (this.retentionMs === undefined || !["completed", "failed", "cancelled", "lost"].includes(snapshot.status)) return false;
    return (snapshot.finishedAt ?? snapshot.updatedAt) <= this.now() - this.retentionMs;
  }

  private async pruneExpired(): Promise<void> {
    const expired = [...this.jobs.entries()].filter(([, runtime]) => this.expired(runtime.snapshot));
    for (const [id] of expired) this.jobs.delete(id);
    if (!this.jobsRoot) return;
    await Promise.all(expired.map(([id]) => unlink(containedPath(this.jobsRoot!, `${id}.json`)).catch((error: unknown) => {
      if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
  }

  private resultStatus(status: GatewayJob["status"]): "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "lost" {
    if (status === "queued") return "accepted";
    if (status === "running") return "running";
    if (status === "completed") return "succeeded";
    if (status === "failed") return "failed";
    if (status === "cancelled") return "cancelled";
    if (status === "lost") return "lost";
    throw new Error(`Unsupported Gateway job status: ${String(status)}`);
  }

  private ownedRuntime(id: string, principal: GatewayPrincipal): RuntimeJob | undefined {
    const runtime = this.jobs.get(id);
    return runtime?.snapshot.principalId === principal.id ? runtime : undefined;
  }

  private principal(value: GatewayPrincipal | undefined): GatewayPrincipal {
    return value === undefined ? this.defaultPrincipal : parseGatewayPrincipal(value);
  }
}

export const GatewayJobService = JobService;
export const createJobService = (options?: JobServiceOptions): JobService => new JobService(options);
export const createGatewayJobService = createJobService;
