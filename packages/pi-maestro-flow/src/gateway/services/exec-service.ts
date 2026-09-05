/** Bounded, argv-based local process execution for the Gateway. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import type { GatewayCommandSecurityConfig } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { createLocalGatewayPrincipal } from "../principal.ts";
import { GatewayPolicy, GatewayPolicyError } from "../policy.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { canonicalizeWorkspaceChild, canonicalizeWorkspacePath, utf8Bytes } from "../state-paths.ts";
import { parseGatewayPrincipal, parseGatewayResult } from "../validation.ts";

const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 150;
const TERMINATION_FORCE_MS = 500;

const DEFAULT_COMMAND_POLICY: GatewayCommandSecurityConfig = {
  default: "allow",
  allow: [],
  confirm: [],
  deny: [],
  autoAllowReadonly: null,
};

class GatewayExecServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayExecServiceError";
    this.code = code;
  }
}

export interface ExecServiceOptions {
  policy?: GatewayPolicy;
  commandPolicy?: Partial<GatewayCommandSecurityConfig>;
  security?: { commands?: Partial<GatewayCommandSecurityConfig> };
  workspaceRoot?: string;
  principal?: GatewayPrincipal;
  maxOutputBytes?: number;
  trustedFullAccess?: boolean;
}

export interface ExecRunInput {
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

export interface ExecRunData {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface ExecActionRequest extends ExecRunInput {
  action: "run";
}

export type GatewayCommandDecision = "allow" | "confirm" | "deny";

function mergeCommandPolicy(input: Partial<GatewayCommandSecurityConfig> | undefined): GatewayCommandSecurityConfig {
  return {
    ...DEFAULT_COMMAND_POLICY,
    ...(input ?? {}),
    allow: [...(input?.allow ?? DEFAULT_COMMAND_POLICY.allow)],
    confirm: [...(input?.confirm ?? DEFAULT_COMMAND_POLICY.confirm)],
    deny: [...(input?.deny ?? DEFAULT_COMMAND_POLICY.deny)],
  };
}

function globMatches(pattern: string, value: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[\\^$.*+()[\]{}|]/g, "\\$&");
  }
  try { return new RegExp(`${expression}$`, "s").test(value); }
  catch { return false; }
}

function ruleMatches(pattern: string, identity: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed === identity) return true;
  if (trimmed.includes("*") && !trimmed.includes(".*")) return globMatches(trimmed, identity);
  try { return new RegExp(trimmed, "s").test(identity); }
  catch { return globMatches(trimmed, identity); }
}

export function evaluateCommandPolicy(
  identity: string,
  policy: Partial<GatewayCommandSecurityConfig> | undefined,
  readonly = false,
): GatewayCommandDecision {
  const config = mergeCommandPolicy(policy);
  if (config.deny.some((pattern) => ruleMatches(pattern, identity))) return "deny";
  if (config.confirm.some((pattern) => ruleMatches(pattern, identity))) return "confirm";
  if (config.allow.some((pattern) => ruleMatches(pattern, identity))) return "allow";
  if (readonly && config.autoAllowReadonly === true) return "allow";
  return config.default;
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
  if (error instanceof Error && /escapes the registered workspace|outside the registered workspace/.test(error.message)) return "policy_denied";
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(code)) return code.toLowerCase();
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
  const base = gatewayError({
    code: errorCode(error),
    message: error instanceof Error ? error.message : String(error),
  }, { ...requestOptions(principal, requestId, startedAt), status });
  return data === undefined ? base as GatewayResult<T> : parseGatewayResult<T>({ ...base, data });
}

function appendOutput(buffers: Buffer[], chunk: unknown, state: { bytes: number }, maximum: number): boolean {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = Math.max(0, maximum - state.bytes);
  if (remaining === 0) return buffer.byteLength > 0;
  const accepted = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
  if (accepted.byteLength > 0) buffers.push(accepted);
  state.bytes += accepted.byteLength;
  return accepted.byteLength < buffer.byteLength;
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
      try {
        killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        finish();
        return;
      }
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

function validateArgv(input: ExecRunInput): { command: string; args: string[] } {
  if (input.argv !== undefined && input.command !== undefined) throw new GatewayExecServiceError("invalid_input", "provide either argv or command, not both");
  const argv = input.argv === undefined
    ? input.command === undefined ? [] : [input.command, ...(input.args ?? [])]
    : [...input.argv];
  if (argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim() === "") throw new GatewayExecServiceError("invalid_input", "command is required");
  if (input.argv !== undefined && input.args !== undefined) throw new GatewayExecServiceError("invalid_input", "args cannot be combined with argv");
  for (const value of argv) {
    if (typeof value !== "string" || value.includes("\0")) throw new GatewayExecServiceError("invalid_input", "command arguments must be strings without NUL bytes");
  }
  return { command: argv[0]!, args: argv.slice(1) };
}

export class ExecService {
  readonly policy?: GatewayPolicy;
  readonly commandPolicy: GatewayCommandSecurityConfig;
  private readonly workspaceRoot?: string;
  private readonly defaultPrincipal: GatewayPrincipal;
  private readonly configuredMaxOutputBytes: number;
  private readonly trustedFullAccess: boolean;

  constructor(options: ExecServiceOptions = {}) {
    this.policy = options.policy;
    this.commandPolicy = mergeCommandPolicy(options.commandPolicy ?? options.security?.commands);
    this.trustedFullAccess = options.trustedFullAccess === true;
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : canonicalizeWorkspacePath(options.workspaceRoot);
    this.defaultPrincipal = options.principal === undefined
      ? createLocalGatewayPrincipal("gateway-exec", this.workspaceRoot ? { workspacePath: this.workspaceRoot } : {})
      : parseGatewayPrincipal(options.principal);
    const policyMaximum = options.policy?.limits.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const configured = options.maxOutputBytes ?? policyMaximum;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > policyMaximum) throw new GatewayExecServiceError("invalid_input", `maxOutputBytes must be in [1, ${policyMaximum}]`);
    this.configuredMaxOutputBytes = configured;
  }

  async run(input: ExecRunInput): Promise<GatewayResult<ExecRunData>> {
    const startedAt = Date.now();
    let principal: GatewayPrincipal;
    try { principal = this.principal(input.principal); }
    catch (error) {
      const fallback = this.defaultPrincipal;
      return errorResult(error, fallback, input.requestId, startedAt);
    }
    try {
      const { command, args } = validateArgv(input);
      const identity = [command, ...args].join(" ");
      const maximumCommand = this.policy?.limits.maxCommandBytes ?? 64 * 1024;
      if (utf8Bytes(identity) > maximumCommand) throw new GatewayExecServiceError("bounds_exceeded", `command exceeds ${maximumCommand} bytes`);
      if (this.policy) this.policy.checkCommand(identity);
      const requestedCwdForPolicy = input.cwd ?? input.workspace ?? principal.workspacePath ?? this.workspaceRoot ?? process.cwd();
      const workspaceForPolicy = input.workspace ?? this.workspaceRoot ?? principal.workspacePath ?? requestedCwdForPolicy;
      const trustedDefault = this.trustedFullAccess && this.policy?.isTrustedWorkspace(workspaceForPolicy)
        ? { ...this.commandPolicy, default: "allow" as const }
        : this.commandPolicy;
      const decision = evaluateCommandPolicy(identity, trustedDefault, input.readonly === true);
      if (decision === "deny") throw new GatewayPolicyError("command is denied by Gateway policy", "command_denied");
      if (decision === "confirm") throw new GatewayPolicyError("command requires confirmation", "confirmation_required");

      const timeoutMs = input.timeoutMs ?? this.policy?.limits.maxExecTimeoutMs ?? 5 * 60 * 1000;
      if (this.policy) this.policy.checkTimeout(timeoutMs);
      else if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new GatewayExecServiceError("invalid_input", "timeoutMs must be a positive safe integer");
      const maximumOutput = input.maxOutputBytes ?? this.configuredMaxOutputBytes;
      if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 1 || maximumOutput > this.configuredMaxOutputBytes) {
        throw new GatewayExecServiceError("bounds_exceeded", `maxOutputBytes must be in [1, ${this.configuredMaxOutputBytes}]`);
      }
      const requestedCwd = input.cwd ?? input.workspace ?? principal.workspacePath ?? this.workspaceRoot ?? process.cwd();
      const workspace = input.workspace ?? this.workspaceRoot ?? principal.workspacePath ?? requestedCwd;
      const cwd = this.policy
        ? await this.policy.assertPath(principal, workspace, requestedCwd, "exec")
        : canonicalizeWorkspaceChild(workspace, requestedCwd);
      const cwdStat = await lstat(cwd);
      if (!cwdStat.isDirectory()) throw new GatewayExecServiceError("invalid_input", "execution cwd must be a directory");
      if (input.signal?.aborted) return errorResult(new GatewayExecServiceError("cancelled", "execution aborted"), principal, input.requestId, startedAt, undefined, "cancelled");

      const outputState = { bytes: 0 };
      const stdoutBuffers: Buffer[] = [];
      const stderrBuffers: Buffer[] = [];
      const data = (): ExecRunData => ({
        command,
        args: [...args],
        cwd,
        stdout: Buffer.concat(stdoutBuffers).toString("utf8"),
        stderr: Buffer.concat(stderrBuffers).toString("utf8"),
        exitCode: null,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });

      return await new Promise<GatewayResult<ExecRunData>>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(command, args, {
            cwd,
            env: input.env === undefined ? process.env : { ...process.env, ...input.env },
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          resolve(errorResult(new GatewayExecServiceError("spawn_error", error instanceof Error ? error.message : String(error)), principal, input.requestId, startedAt, data()));
          return;
        }
        let settled = false;
        let timedOut = false;
        let outputTruncated = false;
        let cancellationRequested = false;
        let spawnError: unknown;
        let termination: Promise<void> | undefined;
        const timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          termination = terminateProcessTree(child);
          void termination;
        }, timeoutMs);
        timer.unref?.();
        const onAbort = () => {
          if (settled) return;
          cancellationRequested = true;
          termination = terminateProcessTree(child);
          void termination;
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });

        const settle = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          if (termination) {
            try { await termination; }
            catch (error) { if (spawnError === undefined) spawnError = new GatewayExecServiceError("cleanup_failed", error instanceof Error ? error.message : String(error)); }
          }
          const resultData = data();
          resultData.exitCode = code;
          resultData.signal = signal;
          resultData.timedOut = timedOut;
          resultData.outputTruncated = outputTruncated;
          if (cancellationRequested) {
            resolve(errorResult(new GatewayExecServiceError("cancelled", "execution cancelled"), principal, input.requestId, startedAt, resultData, "cancelled"));
          } else if (timedOut) {
            resolve(errorResult(new GatewayExecServiceError("timeout", `execution timed out after ${timeoutMs}ms`), principal, input.requestId, startedAt, resultData));
          } else if (outputTruncated) {
            resolve(errorResult(new GatewayExecServiceError("output_limit", `execution output exceeded ${maximumOutput} bytes`), principal, input.requestId, startedAt, resultData));
          } else if (spawnError !== undefined) {
            resolve(errorResult(spawnError, principal, input.requestId, startedAt, resultData));
          } else if (code === 0) {
            resolve(gatewayOk(resultData, requestOptions(principal, input.requestId, startedAt)));
          } else {
            resolve(errorResult(new GatewayExecServiceError("exit_code", `command exited with code ${String(code)}`), principal, input.requestId, startedAt, resultData));
          }
        };
        const terminate = () => {
          if (!termination) termination = terminateProcessTree(child);
          void termination;
        };
        child.stdout?.on("data", (chunk: unknown) => {
          if (appendOutput(stdoutBuffers, chunk, outputState, maximumOutput)) {
            outputTruncated = true;
            terminate();
          }
        });
        child.stderr?.on("data", (chunk: unknown) => {
          if (appendOutput(stderrBuffers, chunk, outputState, maximumOutput)) {
            outputTruncated = true;
            terminate();
          }
        });
        child.once("error", (error) => { spawnError = error; });
        child.once("close", (code, signal) => { void settle(code, signal); });
      });
    } catch (error) {
      return errorResult(error, principal, input.requestId, startedAt);
    }
  }

  runSync(input: ExecRunInput): Promise<GatewayResult<ExecRunData>> { return this.run(input); }

  handle(request: ExecActionRequest): Promise<GatewayResult<ExecRunData>> { return this.run(request); }

  private principal(value: GatewayPrincipal | undefined): GatewayPrincipal {
    return value === undefined ? this.defaultPrincipal : parseGatewayPrincipal(value);
  }
}

export const GatewayExecService = ExecService;
export const createExecService = (options?: ExecServiceOptions): ExecService => new ExecService(options);
export const createGatewayExecService = createExecService;
