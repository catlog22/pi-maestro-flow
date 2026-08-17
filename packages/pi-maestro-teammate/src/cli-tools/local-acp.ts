/**
 * Local ACP execution backend for `cli/<tool>` teammate models.
 *
 * When a teammate dispatch resolves to a `cli/<tool>` model, the run does not
 * spawn a pi subprocess: the configured external CLI is launched locally and
 * driven over the Agent Client Protocol (same AcpDriver used by remote ACP
 * targets, without the SSH layer). The CLI subprocess receives the same
 * sanitized environment contract as remote targets: PATH and other launch
 * variables pass through, secret-bearing variables are forwarded only when the
 * tool config lists them in `acp.env`.
 */

import { randomUUID } from "node:crypto";
import type { RemoteAcpPolicy } from "../remote/types.ts";
import { AcpDriver, ACP_STARTUP_TIMEOUT_MS, type AcpDriverOptions } from "../remote/acp-driver.ts";
import type {
  RemoteDriverContext,
  RemoteRunHandle,
} from "../remote/driver.ts";
import {
  spawnSshChild,
  type SshDirectExecOptions,
} from "../remote/ssh-exec.ts";
import type {
  RemoteRunResultEvent,
  ResolvedRemoteTarget,
} from "../remote/types.ts";
import {
  cliToolArgv,
  probeCliToolCommand,
  sshHostConfigOf,
  type CliToolConfig,
} from "./cli-tools-config.ts";

export const CLI_TOOL_MODEL_PREFIX = "cli/";

export function isCliToolModel(model: string): boolean {
  return model.startsWith(CLI_TOOL_MODEL_PREFIX)
    && model.length > CLI_TOOL_MODEL_PREFIX.length
    && !model.slice(CLI_TOOL_MODEL_PREFIX.length).includes("/");
}

/** Extract the tool name from a `cli/<tool>` model id. */
export function cliToolNameFromModel(model: string): string {
  return model.slice(CLI_TOOL_MODEL_PREFIX.length);
}

export interface CliToolRunResult {
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  durationMs: number;
  terminalStatus: "completed" | "failed" | "cancelled" | "lost";
}

export interface RunLocalCliToolParams {
  tool: string;
  config: CliToolConfig;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** Optional overall execution timeout applied on top of the caller's signal. */
  timeoutMs?: number;
  /** Injectable ssh2 connection factory (tests only; defaults to real clients). */
  sshOptions?: SshDirectExecOptions;
}

/**
 * Execute one prompt against a CLI tool (local or ssh mode) and settle into a
 * teammate SingleResult-shaped outcome. Throws only on infrastructure errors
 * that prevent a launch; ACP-level failures are reported through the result.
 */
export function runCliTool(
  params: RunLocalCliToolParams,
): Promise<CliToolRunResult> {
  return (params.config.mode ?? "local") === "ssh"
    ? runSshCliTool(params)
    : runLocalCliTool(params);
}

/**
 * Execute one prompt against a remote CLI tool over a direct ssh2 exec (the
 * ssh2 channel is adapted to the surface AcpRunHandle consumes, so the ACP
 * client pipeline is identical to the local backend).
 */
export async function runSshCliTool(
  params: RunLocalCliToolParams,
): Promise<CliToolRunResult> {
  const startedAt = Date.now();
  const hostConfig = sshHostConfigOf(params.config);
  if (!hostConfig) {
    return failedResult(
      startedAt,
      `CLI tool "${params.tool}" ssh mode requires host, user and hostKeySha256 in teammate-cli-tools.json`,
    );
  }

  // AcpClientOperations validates the target root as a local directory, so the
  // driver's cwd stays the (local) dispatch cwd; the remote working directory
  // comes from the tool config and is applied as a `cd` wrapper by spawnSshChild.
  const remoteCwd = params.config.cwd?.trim() || undefined;
  const localCwd = params.cwd;
  const argv = cliToolArgv(params.tool, params.config);
  const target: ResolvedRemoteTarget = {
    id: `cli:${params.tool}`,
    host: hostConfig.host,
    cwd: localCwd,
    driver: "acp",
    command: argv,
    env: params.config.env ?? [],
    acp: localAcpPolicy(),
    hostConfig,
  };

  const workerId = `ssh-${process.pid}`;
  const instanceNonce = randomUUID();
  const commandId = randomUUID();
  const runId = randomUUID();
  const monitorOwnerNonce = randomUUID();
  const contextSignal = combineSignals(
    params.signal,
    params.timeoutMs ? AbortSignal.timeout(params.timeoutMs) : undefined,
  );
  const context: RemoteDriverContext = {
    workerId,
    instanceNonce,
    target,
    signal: contextSignal,
  };

  // The AcpDriver passes cwd/env through spawnOptions; spawnSshChild uses the
  // configured remote cwd for the cd wrapper and forwards the whitelisted env
  // set to the remote exec environment.
  const driver = new AcpDriver({
    spawnChild: spawnSshChild(hostConfig, params.sshOptions, remoteCwd) as unknown as NonNullable<AcpDriverOptions["spawnChild"]>,
  });
  let handle: RemoteRunHandle;
  try {
    handle = await driver.start(
      {
        commandId,
        targetId: target.id,
        monitorOwnerNonce,
        name: params.tool,
        objective: params.prompt,
        cwd: localCwd,
        driver: "acp",
        command: argv,
      },
      context,
    );
  } catch (error) {
    await driver.close();
    return failedResult(
      startedAt,
      `CLI tool "${params.tool}" ACP startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const result = await settleAcpRun(handle, params);
    const durationMs = Date.now() - startedAt;
    if (result.status === "completed") {
      return {
        exitCode: 0,
        messages: [{
          role: "assistant",
          content: result.result?.trim() || "(no output)",
        }],
        usage: result.usage,
        durationMs,
        terminalStatus: "completed",
      };
    }
    const reason = result.error
      ?? (result.status === "cancelled" ? "CLI tool run was cancelled" : "CLI tool run did not complete");
    return failedResult(startedAt, reason, result.usage, durationMs, result.status);
  } finally {
    await driver.close();
  }
}

/**
 * Execute one prompt against a local ACP-enabled CLI tool and settle into a
 * teammate SingleResult-shaped outcome. Throws only on infrastructure errors
 * that prevent a launch (missing executable, spawn failure); ACP-level failures
 * are reported through the returned result.
 */
export async function runLocalCliTool(
  params: RunLocalCliToolParams,
): Promise<CliToolRunResult> {
  const startedAt = Date.now();
  const probe = probeCliToolCommand(params.tool, params.config);
  if (!probe.ok) {
    return failedResult(startedAt, `CLI tool "${params.tool}" is not launchable: ${probe.error}`);
  }

  const runCwd = params.config.cwd?.trim() || params.cwd;
  const argv = cliToolArgv(params.tool, params.config);
  const target: ResolvedRemoteTarget = {
    id: `cli:${params.tool}`,
    host: "local",
    cwd: runCwd,
    driver: "acp",
    command: argv,
    env: params.config.env ?? [],
    acp: localAcpPolicy(),
    hostConfig: {
      host: "local",
      user: "",
      port: 22,
      hostKeySha256: "local",
    },
  };

  const workerId = `local-${process.pid}`;
  const instanceNonce = randomUUID();
  const commandId = randomUUID();
  const runId = randomUUID();
  const monitorOwnerNonce = randomUUID();
  // The ACP driver binds cancellation to the context signal; a caller timeout
  // is folded in so a stalled CLI (no events) is still interrupted.
  const contextSignal = combineSignals(
    params.signal,
    params.timeoutMs ? AbortSignal.timeout(params.timeoutMs) : undefined,
  );
  const context: RemoteDriverContext = {
    workerId,
    instanceNonce,
    target,
    signal: contextSignal,
  };

  const driver = new AcpDriver();
  let handle: RemoteRunHandle;
  try {
    handle = await driver.start(
      {
        commandId,
        targetId: target.id,
        monitorOwnerNonce,
        name: params.tool,
        objective: params.prompt,
        cwd: runCwd,
        driver: "acp",
        command: argv,
      },
      context,
    );
  } catch (error) {
    await driver.close();
    return failedResult(
      startedAt,
      `CLI tool "${params.tool}" ACP startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const result = await settleAcpRun(handle, params);
    const durationMs = Date.now() - startedAt;
    if (result.status === "completed") {
      return {
        exitCode: 0,
        messages: [{
          role: "assistant",
          content: result.result?.trim() || "(no output)",
        }],
        usage: result.usage,
        durationMs,
        terminalStatus: "completed",
      };
    }
    const reason = result.error
      ?? (result.status === "cancelled" ? "CLI tool run was cancelled" : "CLI tool run did not complete");
    return failedResult(startedAt, reason, result.usage, durationMs, result.status);
  } finally {
    await driver.close();
  }
}

interface SettledAcpRun {
  status: RemoteRunResultEvent["status"];
  result?: string;
  error?: string;
  usage: CliToolRunResult["usage"];
}

async function settleAcpRun(
  handle: RemoteRunHandle,
  params: RunLocalCliToolParams,
): Promise<SettledAcpRun> {
  const usage: CliToolRunResult["usage"] = {};
  let settled: RemoteRunResultEvent | undefined;

  for await (const event of handle.events()) {
    if (params.signal.aborted) {
      await handle.cancel({
        commandId: `timeout-${randomUUID()}`,
        runId: handle.capture.runId,
        generation: handle.capture.generation,
        monitorOwnerNonce: handle.capture.monitorOwnerNonce,
        reason: "local-cli-aborted",
      });
    }
    if (event.type === "run/event" && event.event.type === "usage") {
      const value = event.event.usage;
      if (Number.isFinite(value.inputTokens)) usage.inputTokens = value.inputTokens;
      if (Number.isFinite(value.outputTokens)) usage.outputTokens = value.outputTokens;
      if (Number.isFinite(value.totalTokens)) usage.totalTokens = value.totalTokens;
      if (Number.isFinite(value.costUsd)) usage.costUsd = value.costUsd;
      continue;
    }
    if (event.type === "run/result") {
      settled = event;
      break;
    }
  }

  if (settled) {
    return {
      status: settled.status,
      result: settled.result,
      error: settled.error,
      usage,
    };
  }
  return {
    status: params.signal.aborted ? "cancelled" : "lost",
    error: "Local CLI tool run ended without a protocol result",
    usage,
  };
}

/** Forward multiple abort sources into a single signal (Node 16-safe). */
function combineSignals(
  primary: AbortSignal,
  secondary?: AbortSignal,
): AbortSignal {
  if (!secondary) return primary;
  const controller = new AbortController();
  const forward = (signal: AbortSignal): void => {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  };
  forward(primary);
  forward(secondary);
  return controller.signal;
}

function failedResult(
  startedAt: number,
  error: string,
  usage: CliToolRunResult["usage"] = {},
  durationMs: number = Date.now() - startedAt,
  terminalStatus: CliToolRunResult["terminalStatus"] = "failed",
): CliToolRunResult {
  return {
    exitCode: 1,
    messages: [{ role: "system", content: error }],
    usage,
    durationMs,
    terminalStatus,
  };
}

/**
 * Local ACP policy: like remote targets, permission requests are denied by
 * default and filesystem/terminal operations are off unless the tool config
 * declares them. Local CLIs run with the parent's identity, so the conservative
 * default protects against unexpected tool-driven writes.
 */
function localAcpPolicy(): RemoteAcpPolicy {
  return { permissionMode: "deny" };
}

/** Re-exported constant so callers can check the prefix without importing internals. */
export const LOCAL_CLI_STARTUP_TIMEOUT_MS = ACP_STARTUP_TIMEOUT_MS;
