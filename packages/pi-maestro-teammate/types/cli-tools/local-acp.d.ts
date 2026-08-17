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
import { type SshDirectExecOptions } from "../remote/ssh-exec.ts";
import { type CliToolConfig } from "./cli-tools-config.ts";
export declare const CLI_TOOL_MODEL_PREFIX = "cli/";
export declare function isCliToolModel(model: string): boolean;
/** Extract the tool name from a `cli/<tool>` model id. */
export declare function cliToolNameFromModel(model: string): string;
export interface CliToolRunResult {
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
/** Re-exported constant so callers can check the prefix without importing internals. */
export declare const LOCAL_CLI_STARTUP_TIMEOUT_MS = 15000;
