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
import type { RemoteRunHandle } from "../remote/driver.ts";
import { type SshDirectExecOptions } from "../remote/ssh-exec.ts";
import type { RemoteRunResultEvent } from "../remote/types.ts";
import { type CliToolConfig } from "./cli-tools-config.ts";
export declare const CLI_TOOL_MODEL_PREFIX = "cli/";
export declare function isCliToolModel(model: string): boolean;
/** Extract the tool name from a `cli/<tool>` model id. */
export declare function cliToolNameFromModel(model: string): string;
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
export interface CliToolRunResult extends AcpToolObservation {
    exitCode: number;
    messages: Array<{
        role: string;
        content: string;
    }>;
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        costUsd?: number;
    };
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
export declare function runCliTool(params: RunLocalCliToolParams): Promise<CliToolRunResult>;
/**
 * Execute one prompt against a remote CLI tool over a direct ssh2 exec (the
 * ssh2 channel is adapted to the surface AcpRunHandle consumes, so the ACP
 * client pipeline is identical to the local backend).
 */
export declare function runSshCliTool(params: RunLocalCliToolParams): Promise<CliToolRunResult>;
/**
 * Execute one prompt against a local ACP-enabled CLI tool and settle into a
 * teammate SingleResult-shaped outcome. Throws only on infrastructure errors
 * that prevent a launch (missing executable, spawn failure); ACP-level failures
 * are reported through the returned result.
 */
export declare function runLocalCliTool(params: RunLocalCliToolParams): Promise<CliToolRunResult>;
export interface SettledAcpRun extends AcpToolObservation {
    status: RemoteRunResultEvent["status"];
    result?: string;
    error?: string;
    usage: CliToolRunResult["usage"];
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
export declare function settleAcpRun(handle: RemoteRunHandle, params: RunLocalCliToolParams): Promise<SettledAcpRun>;
/** Re-exported constant so callers can check the prefix without importing internals. */
export declare const LOCAL_CLI_STARTUP_TIMEOUT_MS = 15000;
