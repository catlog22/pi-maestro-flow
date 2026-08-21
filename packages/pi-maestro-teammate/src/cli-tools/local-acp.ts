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
import {
  AcpDriver,
  ACP_STARTUP_TIMEOUT_MS,
  type AcpDriverOptions,
  type AcpRunHandleView,
} from "../remote/acp-driver.ts";
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

/**
 * What one run's ACP event stream revealed about tool activity.
 *
 * The host's replay fence reads these: a failed run that already completed a
 * tool call has side effects a fresh replay would repeat, so the run must
 * report what it saw rather than leaving the fence to assume nothing happened.
 */
export interface AcpToolObservation {
  /** Names of tool calls that reached `phase: "end"`, deduplicated by call id. */
  completedTools: readonly string[];
  /** Tool calls that started and never ended; their effects are unknown. */
  inFlightToolCount: number;
  /**
   * The model or one of its tools did something: at least one `run/event`
   * arrived.
   *
   * Lifecycle transitions (`run/state`) are deliberately excluded. The driver
   * emits one the moment the ACP handshake succeeds, so counting them would
   * make this true for every run whose CLI launched at all — including the CLI
   * that answered `initialize`, answered `session/new`, and then died on a bad
   * flag or a missing config. The host reads this to decide whether a fresh
   * attempt would repeat work, and a completed handshake is not work.
   */
  sawActivity: boolean;
  /**
   * How the run established that the turn ended.
   *
   * `authoritative` once an ACP protocol result arrived; `unknown` when the
   * event stream ended without one, which is also the value every pre-launch
   * failure reports.
   */
  settlementAuthority: "authoritative" | "unknown";
}

/** Reported by every run that ended before its ACP event stream produced anything. */
const UNOBSERVED_RUN: AcpToolObservation = {
  completedTools: [],
  inFlightToolCount: 0,
  sawActivity: false,
  settlementAuthority: "unknown",
};

export interface CliToolRunResult extends AcpToolObservation {
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  durationMs: number;
  terminalStatus: "completed" | "failed" | "cancelled" | "lost";
  /**
   * The model the CLI's session was put on, in that CLI's own catalogue.
   *
   * Absent when no model was requested, and on every failure that settles
   * before the handshake selected one. Distinct from the `cli/<tool>` route
   * that chose the CLI: the route names the process, this names what that
   * process ran, and only this one answers which model produced the output.
   */
  selectedModel?: string;
}

export interface RunLocalCliToolParams {
  tool: string;
  config: CliToolConfig;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** Optional overall execution timeout applied on top of the caller's signal. */
  timeoutMs?: number;
  /**
   * How long the ACP handshake may take before the launch is declared failed.
   *
   * Separate from `timeoutMs`, which bounds the run once it is talking. A CLI
   * launched through a package runner downloads before it answers, and a cold
   * cache routinely outlasts the driver's default; the operator who chose that
   * launch command is the one who can say how long it needs.
   */
  startupTimeoutMs?: number;
  /**
   * The model to select on the session the CLI opens.
   *
   * Names one of the values the agent advertises on `session/new`, which is a
   * different space from the `cli/<tool>` route that chose this CLI: the route
   * picks the process, this picks what that process runs. Absent leaves the
   * agent on its own current model.
   */
  acpModel?: string;
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
    ...(params.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: params.startupTimeoutMs }),
    ...(params.acpModel === undefined ? {} : { model: params.acpModel }),
  });
  let handle: AcpRunHandleView;
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
    const selected = selectedModelOf(handle);
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
        ...observationOf(result),
        ...selected,
      };
    }
    const reason = result.error
      ?? (result.status === "cancelled" ? "CLI tool run was cancelled" : "CLI tool run did not complete");
    return {
      ...failedResult(startedAt, reason, result.usage, durationMs, result.status, observationOf(result)),
      ...selected,
    };
  } finally {
    await driver.close();
  }
}

/**
 * The settled session's model, as a spreadable fragment.
 *
 * Reported on failed and cancelled runs too: a session that selected a model
 * and then failed still ran on it, and which model failed is the first thing a
 * reader needs. Empty when the handshake settled before any selection, so an
 * absent key never has to stand for a model nobody chose.
 *
 * @param handle - the settled run's handle.
 * @returns `{ selectedModel }`, or an empty object when none was selected.
 */
function selectedModelOf(handle: AcpRunHandleView): Pick<CliToolRunResult, "selectedModel"> {
  return handle.selectedModel === undefined ? {} : { selectedModel: handle.selectedModel };
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

  const driver = new AcpDriver({
    ...(params.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: params.startupTimeoutMs }),
    ...(params.acpModel === undefined ? {} : { model: params.acpModel }),
  });
  let handle: AcpRunHandleView;
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
    const selected = selectedModelOf(handle);
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
        ...observationOf(result),
        ...selected,
      };
    }
    const reason = result.error
      ?? (result.status === "cancelled" ? "CLI tool run was cancelled" : "CLI tool run did not complete");
    return {
      ...failedResult(startedAt, reason, result.usage, durationMs, result.status, observationOf(result)),
      ...selected,
    };
  } finally {
    await driver.close();
  }
}

export interface SettledAcpRun extends AcpToolObservation {
  status: RemoteRunResultEvent["status"];
  result?: string;
  error?: string;
  usage: CliToolRunResult["usage"];
}

/** Lift the observation half of a settled run, for callers that carry both. */
function observationOf(run: SettledAcpRun): AcpToolObservation {
  return {
    completedTools: run.completedTools,
    inFlightToolCount: run.inFlightToolCount,
    sawActivity: run.sawActivity,
    settlementAuthority: run.settlementAuthority,
  };
}

/**
 * Drain one ACP run's event stream into its terminal status, usage, and tool
 * accounting.
 *
 * Tool events are counted here rather than discarded because they are the only
 * evidence the host's replay fence has: a run that completed a tool call and
 * then failed did work a replay would repeat, and a run whose tools are still
 * outstanding did work nobody can describe. Exported so that accounting is
 * testable without a real CLI subprocess.
 *
 * @param handle - the started run, whose events are consumed to completion.
 * @param params - the originating request; its signal drives cancellation.
 * @returns the settled run, including what its tool events revealed.
 */
export async function settleAcpRun(
  handle: RemoteRunHandle,
  params: RunLocalCliToolParams,
): Promise<SettledAcpRun> {
  const usage: CliToolRunResult["usage"] = {};
  // Ended ids are tracked separately from the driver's own `#endedTools`
  // deduplication so the count stays right when a stream is stitched from more
  // than one driver instance.
  const startedToolIds = new Set<string>();
  const endedToolIds = new Set<string>();
  const completedTools: string[] = [];
  let sawActivity = false;
  let settled: RemoteRunResultEvent | undefined;

  for await (const event of handle.events()) {
    if (event.type === "run/event") sawActivity = true;
    if (params.signal.aborted) {
      await handle.cancel({
        commandId: `timeout-${randomUUID()}`,
        runId: handle.capture.runId,
        generation: handle.capture.generation,
        monitorOwnerNonce: handle.capture.monitorOwnerNonce,
        reason: "local-cli-aborted",
      });
    }
    if (event.type === "run/event" && event.event.type === "tool") {
      const tool = event.event.tool;
      if (tool.phase === "start") {
        startedToolIds.add(tool.toolCallId);
      } else if (!endedToolIds.has(tool.toolCallId)) {
        endedToolIds.add(tool.toolCallId);
        completedTools.push(tool.toolName);
      }
      continue;
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

  const observed = {
    completedTools,
    // Paired per call id, not `started.size - ended.size`: the driver falls back
    // to an "unknown" tool name for a `tool_call_update` whose `tool_call` it
    // never saw (acp-driver.ts), so an end can arrive without its start. The
    // sizes then cancel out and an unrelated tool that is genuinely outstanding
    // is reported as finished.
    inFlightToolCount: [...startedToolIds].filter((id) => !endedToolIds.has(id)).length,
    sawActivity,
  };
  if (settled) {
    return {
      status: settled.status,
      result: settled.result,
      error: settled.error,
      usage,
      ...observed,
      settlementAuthority: "authoritative",
    };
  }
  return {
    status: params.signal.aborted ? "cancelled" : "lost",
    error: "Local CLI tool run ended without a protocol result",
    usage,
    ...observed,
    settlementAuthority: "unknown",
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
  observed: AcpToolObservation = UNOBSERVED_RUN,
): CliToolRunResult {
  return {
    exitCode: 1,
    messages: [{ role: "system", content: error }],
    usage,
    durationMs,
    terminalStatus,
    ...observed,
  };
}

/**
 * Local ACP policy: like remote targets, permission requests are denied by
 * default and filesystem/terminal operations are off unless the tool config
 * declares them.
 *
 * The scope is exactly the operations the CLI routes back to the host over ACP.
 * A CLI that owns its own file and shell tools writes directly, with the parent
 * process's identity, and nothing here sees it — launching an untrusted CLI is
 * not gated by this policy.
 */
function localAcpPolicy(): RemoteAcpPolicy {
  return { permissionMode: "deny" };
}

/** Re-exported constant so callers can check the prefix without importing internals. */
export const LOCAL_CLI_STARTUP_TIMEOUT_MS = ACP_STARTUP_TIMEOUT_MS;
