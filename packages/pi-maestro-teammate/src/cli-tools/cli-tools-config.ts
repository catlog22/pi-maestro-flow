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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AvailableModelEntry } from "../models/model-catalog.ts";
import type { RemoteHostConfig } from "../remote/types.ts";
import { probeSshCliExecutable } from "../remote/ssh-exec.ts";

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
  // SSH connection fields (mode "ssh" only):
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

const GLOBAL_CONFIG_FILE = "teammate-cli-tools.json";
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".maestro", "cli-tools.json");
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_CACHE_TTL_MS = 30_000;

export function getGlobalCliToolsConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", GLOBAL_CONFIG_FILE);
}

export function getProjectCliToolsConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", GLOBAL_CONFIG_FILE);
}

function readConfigFile(filePath: string): CliToolsConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const config = parsed as Record<string, unknown>;
    if (!config.tools || typeof config.tools !== "object") return null;
    return parsed as CliToolsConfig;
  } catch {
    return null;
  }
}

/**
 * Load the effective teammate CLI tool config: project tools override global
 * tools (a project entry with enabled:false hides the global one). Returns null
 * when neither file exists. `cwd` drives project-file discovery and
 * `globalFilePath` overrides the global file location (used by tests).
 */
export function loadCliToolsConfig(
  cwd?: string,
  globalFilePath?: string,
): CliToolsConfig | null {
  const dir = cwd ?? process.cwd();
  const globalFile = globalFilePath ?? getGlobalCliToolsConfigPath();
  const projectFile = getProjectCliToolsConfigPath(dir);

  const globalConfig = readConfigFile(globalFile);
  const projectConfig = readConfigFile(projectFile);
  if (!globalConfig && !projectConfig) return null;

  if (!projectConfig) return globalConfig;
  if (!globalConfig) return projectConfig;

  const tools: Record<string, CliToolConfig> = { ...globalConfig.tools };
  for (const [name, tool] of Object.entries(projectConfig.tools)) {
    tools[name] = tool;
  }
  return {
    version: projectConfig.version ?? globalConfig.version ?? "1",
    tools,
  };
}

/** Load the legacy ~/.maestro/cli-tools.json (Maestro delegate provider registration). */
export function loadMaestroDelegateConfig(
  configPath: string = LEGACY_CONFIG_PATH,
): MaestroDelegateConfig | null {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const config = parsed as Record<string, unknown>;
    if (!config.tools || typeof config.tools !== "object") return null;
    return parsed as MaestroDelegateConfig;
  } catch {
    return null;
  }
}

/**
 * Get all enabled tools from a config's tools table (teammate or legacy).
 */
export function getEnabledTools<T extends { enabled: boolean }>(
  config: { tools: Record<string, T> },
): Array<{ name: string; config: T }> {
  return Object.entries(config.tools)
    .filter(([_, toolConfig]) => toolConfig.enabled)
    .map(([name, toolConfig]) => ({ name, config: toolConfig }));
}

/** Executable used to launch a CLI tool; falls back to the tool name. */
export function cliToolCommand(name: string, config: CliToolConfig): string {
  return config.command?.trim() || name;
}

/** Full argv used to launch a CLI tool. */
export function cliToolArgv(name: string, config: CliToolConfig): [string, ...string[]] {
  return [cliToolCommand(name, config), ...(config.args ?? [])];
}

/** SSH connection fields lifted from a tool config; null if incomplete. */
export function sshHostConfigOf(config: CliToolConfig): RemoteHostConfig | null {
  if ((config.mode ?? "local") !== "ssh") return null;
  const host = config.host?.trim() ?? "";
  const user = config.user?.trim() ?? "";
  const port = config.port ?? 22;
  const hostKeySha256 = config.hostKeySha256?.trim() ?? "";
  if (!host || !user || !hostKeySha256) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    host,
    user,
    port,
    hostKeySha256,
    ...(config.identityFile?.trim() ? { identityFile: config.identityFile.trim() } : {}),
  };
}

export interface CliToolProbeResult {
  ok: boolean;
  command: string;
  error?: string;
}

const probeCache = new Map<string, { result: CliToolProbeResult; at: number }>();
const sshProbeInflight = new Map<string, Promise<void>>();

/**
 * Probe whether a CLI tool is reachable. Local tools are checked with
 * which/where; ssh tools first validate config completeness (fail-closed) and
 * then optimistically report ok while an async SSH probe warms the cache, so
 * subsequent catalog refreshes drop unreachable hosts. Results are cached for a
 * short TTL because catalog refresh runs frequently.
 */
export function probeCliToolCommand(
  name: string,
  config: CliToolConfig,
): CliToolProbeResult {
  const command = cliToolCommand(name, config);
  const cached = probeCache.get(name);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.result;

  if ((config.mode ?? "local") === "ssh") return probeSshTool(name, command, config);
  return probeLocalExecutable(name, command);
}

function probeLocalExecutable(name: string, command: string): CliToolProbeResult {
  let result: CliToolProbeResult;
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    execFileSync(lookup, [command], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    result = { ok: true, command };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    result = {
      ok: false,
      command,
      error: code === "ENOENT"
        ? `executable "${command}" not found on PATH`
        : `executable "${command}" unreachable${code ? ` (${code})` : ""}`,
    };
  }
  probeCache.set(name, { result, at: Date.now() });
  return result;
}

function probeSshTool(name: string, command: string, config: CliToolConfig): CliToolProbeResult {
  const hostConfig = sshHostConfigOf(config);
  if (!hostConfig) {
    const result: CliToolProbeResult = {
      ok: false,
      command,
      error: "ssh mode requires host, user and hostKeySha256 in teammate-cli-tools.json",
    };
    probeCache.set(name, { result, at: Date.now() });
    return result;
  }
  // Optimistically list a complete configuration; warm the cache asynchronously
  // so the next refresh filters unreachable hosts. Deduplicate concurrent probes.
  const result: CliToolProbeResult = { ok: true, command };
  probeCache.set(name, { result, at: Date.now() });
  if (!sshProbeInflight.has(name)) {
    const probe = probeSshCliExecutable(hostConfig, command)
      .then((outcome) => {
        probeCache.set(name, {
          result: outcome.ok
            ? { ok: true, command }
            : { ok: false, command, error: outcome.error ?? `remote executable "${command}" unreachable` },
          at: Date.now(),
        });
      })
      .catch(() => {
        probeCache.set(name, {
          result: { ok: false, command, error: `remote executable "${command}" probe failed` },
          at: Date.now(),
        });
      })
      .finally(() => sshProbeInflight.delete(name));
    sshProbeInflight.set(name, probe);
  }
  return result;
}

/**
 * Map enabled CLI tools to teammate catalog entries (`cli/<tool>`). Tools whose
 * backend is not reachable (or, for ssh mode, whose config is incomplete) are
 * excluded so routing and specifier validation never select an unlaunchable
 * backend. The async SSH probe warms `probeCliToolCommand`'s cache for later
 * refreshes.
 */
export function toCliToolModelEntries(config: CliToolsConfig): AvailableModelEntry[] {
  return getEnabledTools(config).flatMap(({ name, config: toolConfig }) => {
    const probe = probeCliToolCommand(name, toolConfig);
    if (!probe.ok) return [];
    return [{
      provider: "cli",
      id: name,
      name,
      reasoning: false,
      input: ["text"] as const,
    }];
  });
}