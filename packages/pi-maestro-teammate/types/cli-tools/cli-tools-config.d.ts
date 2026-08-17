/**
 * Teammate CLI tool configuration (teammate-cli-tools.json).
 *
 * A standalone config (independent from ~/.maestro/cli-tools.json) that
 * declares external CLI tools exposed as selectable `cli/<tool>` teammate
 * models and executed over the Agent Client Protocol:
 *
 * - mode "local": the CLI is spawned on this machine (which/where reachability);
 * - mode "ssh": the CLI runs on a remote host over a direct ssh2 exec, with the
 *   ssh connection fields embedded per tool (host/user/port/hostKeySha256/identityFile).
 *
 * Discovery follows the same convention as teammate-models.json / teammate-remotes.json:
 * the global file is ~/.pi/agent/teammate-cli-tools.json and the project file is
 * ./.pi/teammate-cli-tools.json; project tools override global ones.
 *
 * The legacy Maestro delegate loader (loadMaestroDelegateConfig) still parses
 * ~/.maestro/cli-tools.json for pi-maestro-flow's original provider registration.
 */
import type { AvailableModelEntry } from "../models/model-catalog.ts";
import type { RemoteHostConfig } from "../remote/types.ts";
/** Launch configuration for a teammate-managed CLI tool. */
export interface CliToolConfig {
    enabled: boolean;
    /** local (default) spawns on this machine; "ssh" execs on a remote host. */
    mode?: "local" | "ssh";
    /** Executable to launch; defaults to the tool name. */
    command?: string;
    /** Fixed extra argv appended after the executable. */
    args?: readonly string[];
    /** Working directory: local path for mode "local", remote path for "ssh". */
    cwd?: string;
    /** Trusted environment-variable names forwarded from the parent process. */
    env?: readonly string[];
    host?: string;
    user?: string;
    port?: number;
    hostKeySha256?: string;
    identityFile?: string;
}
export interface CliToolsConfig {
    version: string;
    tools: Record<string, CliToolConfig>;
}
/** Legacy ~/.maestro/cli-tools.json shapes consumed by pi-maestro-flow's provider registration. */
export interface MaestroDelegateToolAcpConfig {
    command?: string;
    args?: readonly string[];
    cwd?: string;
    env?: readonly string[];
}
export interface MaestroDelegateToolConfig {
    enabled: boolean;
    primaryModel: string;
    tags: string[];
    type: string;
    settingsFile?: string;
    reasoningEffort?: string;
    acp?: MaestroDelegateToolAcpConfig;
}
export interface MaestroDelegateConfig {
    version: string;
    tools: Record<string, MaestroDelegateToolConfig>;
    roles: Record<string, unknown>;
    proxy?: {
        enabled: boolean;
        httpProxy?: string;
        noProxy?: string;
    };
}
export declare function getGlobalCliToolsConfigPath(): string;
export declare function getProjectCliToolsConfigPath(cwd: string): string;
/**
 * Load the effective teammate CLI tool config: project tools override global
 * tools (a project entry with enabled:false hides the global one). Returns null
 * when neither file exists. `cwd` drives project-file discovery and
 * `globalFilePath` overrides the global file location (used by tests).
 */
export declare function loadCliToolsConfig(cwd?: string, globalFilePath?: string): CliToolsConfig | null;
/** Load the legacy ~/.maestro/cli-tools.json (Maestro delegate provider registration). */
export declare function loadMaestroDelegateConfig(configPath?: string): MaestroDelegateConfig | null;
/**
 * Get all enabled tools from a config's tools table (teammate or legacy).
 */
export declare function getEnabledTools<T extends {
    enabled: boolean;
}>(config: {
    tools: Record<string, T>;
}): Array<{
    name: string;
    config: T;
}>;
/** Executable used to launch a CLI tool; falls back to the tool name. */
export declare function cliToolCommand(name: string, config: CliToolConfig): string;
/** Full argv used to launch a CLI tool. */
export declare function cliToolArgv(name: string, config: CliToolConfig): [string, ...string[]];
/** SSH connection fields lifted from a tool config; null if incomplete. */
export declare function sshHostConfigOf(config: CliToolConfig): RemoteHostConfig | null;
export interface CliToolProbeResult {
    ok: boolean;
    command: string;
    error?: string;
}
/**
 * Probe whether a CLI tool is reachable. Local tools are checked with
 * which/where; ssh tools first validate config completeness (fail-closed) and
 * then optimistically report ok while an async SSH probe warms the cache, so
 * subsequent catalog refreshes drop unreachable hosts. Results are cached for a
 * short TTL because catalog refresh runs frequently.
 */
export declare function probeCliToolCommand(name: string, config: CliToolConfig): CliToolProbeResult;
/**
 * Map enabled CLI tools to teammate catalog entries (`cli/<tool>`). Tools whose
 * backend is not reachable (or, for ssh mode, whose config is incomplete) are
 * excluded so routing and specifier validation never select an unlaunchable
 * backend. The async SSH probe warms `probeCliToolCommand`'s cache for later
 * refreshes.
 */
export declare function toCliToolModelEntries(config: CliToolsConfig): AvailableModelEntry[];
