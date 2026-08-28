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
 * Read one compatibility overlay without the legacy loader's fail-open
 * fallback. Model-registry publication must distinguish a missing overlay from
 * a malformed one: the latter invalidates the new projection pair instead of
 * retaining routes compiled from an earlier edit.
 */
function readProjectionConfigFile(filePath: string): CliToolsConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`teammate CLI tools projection at ${filePath} could not be read`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`teammate CLI tools projection at ${filePath} is not valid JSON`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`teammate CLI tools projection at ${filePath} must contain a JSON object`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== undefined && typeof document.version !== "string") {
    throw new Error(`teammate CLI tools projection at ${filePath} must name a string "version"`);
  }
  if (!document.tools || typeof document.tools !== "object" || Array.isArray(document.tools)) {
    throw new Error(`teammate CLI tools projection at ${filePath} must map "tools" to registrations`);
  }
  for (const [name, value] of Object.entries(document.tools as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`teammate CLI tools projection at ${filePath}: tool "${name}" must be an object`);
    }
    if (typeof (value as { enabled?: unknown }).enabled !== "boolean") {
      throw new Error(`teammate CLI tools projection at ${filePath}: tool "${name}" must name boolean "enabled"`);
    }
  }
  return parsed as CliToolsConfig;
}

function mergeCliToolsConfigs(
  globalConfig: CliToolsConfig | null,
  projectConfig: CliToolsConfig | null,
): CliToolsConfig | null {
  if (!globalConfig && !projectConfig) return null;
  if (!projectConfig) return globalConfig;
  if (!globalConfig) return projectConfig;

  return {
    version: projectConfig.version ?? globalConfig.version ?? "1",
    tools: { ...globalConfig.tools, ...projectConfig.tools },
  };
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
  return mergeCliToolsConfigs(globalConfig, projectConfig);
}

/**
 * Load the effective CLI compatibility overlay for model-registry compilation.
 * This uses the same project-over-global merge as {@link loadCliToolsConfig},
 * but malformed files throw so a changed invalid source cannot leave a stale
 * discovery/dispatch pair published. It performs no executable or network
 * probes; only explicit `enabled` flags are consumed by the compiler.
 */
export function loadCliToolsConfigProjection(
  cwd?: string,
  globalFilePath?: string,
): CliToolsConfig | null {
  const dir = cwd ?? process.cwd();
  const globalFile = globalFilePath ?? getGlobalCliToolsConfigPath();
  const projectFile = getProjectCliToolsConfigPath(dir);
  return mergeCliToolsConfigs(
    readProjectionConfigFile(globalFile),
    readProjectionConfigFile(projectFile),
  );
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
 * Cache key for one probe: what the probe actually validates.
 *
 * Never the tool name. `command` is a per-registration field now that a CLI is
 * configured by a `.pi/teammate-backends.json` registration, so two
 * registrations can serve the same `cli/<tool>` route with different
 * executables on different hosts. Keying by name would validate the second
 * against the first's executable for the whole TTL and report a launchable
 * command unlaunchable, or the reverse.
 *
 * @param command - the resolved executable.
 * @param config - the tool configuration the command was resolved from.
 * @returns a key distinguishing every launch target the probe can be asked about.
 */
function probeCacheKey(command: string, config: CliToolConfig): string {
  if ((config.mode ?? "local") !== "ssh") return JSON.stringify(["local", command]);
  const hostConfig = sshHostConfigOf(config);
  // An incomplete ssh config has no target to name; the verdict is the same
  // refusal for every such registration, so they share one entry.
  if (!hostConfig) return JSON.stringify(["ssh", null, command]);
  const target = `${hostConfig.user}@${hostConfig.host}:${hostConfig.port}`;
  return JSON.stringify(["ssh", target, command]);
}

/**
 * Probe whether a CLI tool is reachable. Absolute local commands are checked
 * directly, while bare and relative commands are resolved with which/where;
 * ssh tools first validate config completeness (fail-closed) and then
 * optimistically report ok while an async SSH probe warms the cache, so
 * subsequent catalog refreshes drop unreachable hosts. Results are cached for
 * a short TTL because catalog refresh runs frequently.
 */
export function probeCliToolCommand(
  name: string,
  config: CliToolConfig,
): CliToolProbeResult {
  const command = cliToolCommand(name, config);
  const key = probeCacheKey(command, config);
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.result;

  if ((config.mode ?? "local") === "ssh") return probeSshTool(key, command, config);
  return probeLocalExecutable(key, command);
}

/**
 * Known ACP adapters and the npm package that provides each, so a launch
 * probe that cannot find one can name the exact install command instead of
 * leaving the operator to guess where "codex-acp" comes from.
 */
const KNOWN_ACP_ADAPTER_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["codex-acp", "@agentclientprotocol/codex-acp"],
  ["claude-agent-acp", "@agentclientprotocol/claude-agent-acp"],
]);

/** Install hint for a known adapter command; empty for anything else. */
function adapterInstallHint(command: string): string {
  const base = path.basename(command).replace(/\.(cmd|ps1|bat|exe)$/i, "").toLowerCase();
  const pkg = KNOWN_ACP_ADAPTER_PACKAGES.get(base);
  return pkg === undefined ? "" : `; install it with: npm i -g ${pkg}`;
}

function localExecutableCandidates(command: string): string[] {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const directories = hasPathSeparator
    ? [process.cwd()]
    : (process.env.PATH ?? "").split(path.delimiter).map((entry) => {
      const trimmed = entry.trim();
      return trimmed.replace(/^"|"$/g, "") || process.cwd();
    });
  const extensions = process.platform === "win32" && path.extname(command) === ""
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  return [...new Set(directories.flatMap((directory) =>
    extensions.map((extension) => path.resolve(directory, `${command}${extension.toLowerCase()}`)),
  ))];
}

function localExecutableExists(command: string): boolean {
  return localExecutableCandidates(command).some((candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function probeLocalExecutable(key: string, command: string): CliToolProbeResult {
  const quotedCommand = JSON.stringify(command);
  let result: CliToolProbeResult;
  if (path.isAbsolute(command)) {
    try {
      const stat = fs.statSync(command);
      if (!stat.isFile()) {
        result = { ok: false, command, error: `executable ${quotedCommand} is not a file` };
      } else {
        fs.accessSync(command, fs.constants.X_OK);
        result = { ok: true, command };
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      result = {
        ok: false,
        command,
        error: code === "ENOENT"
          ? `executable ${quotedCommand} does not exist${adapterInstallHint(command)}`
          : `executable ${quotedCommand} is unusable`,
      };
    }
  } else {
    result = localExecutableExists(command)
      ? { ok: true, command }
      : { ok: false, command, error: `executable ${quotedCommand} not found on PATH${adapterInstallHint(command)}` };
  }
  probeCache.set(key, { result, at: Date.now() });
  return result;
}

function probeSshTool(key: string, command: string, config: CliToolConfig): CliToolProbeResult {
  const hostConfig = sshHostConfigOf(config);
  if (!hostConfig) {
    const result: CliToolProbeResult = {
      ok: false,
      command,
      error: "ssh mode requires host, user and hostKeySha256 in teammate-cli-tools.json",
    };
    probeCache.set(key, { result, at: Date.now() });
    return result;
  }
  // Optimistically list a complete configuration; warm the cache asynchronously
  // so the next refresh filters unreachable hosts. Deduplicate concurrent probes.
  const result: CliToolProbeResult = { ok: true, command };
  probeCache.set(key, { result, at: Date.now() });
  if (!sshProbeInflight.has(key)) {
    const probe = probeSshCliExecutable(hostConfig, command)
      .then((outcome) => {
        probeCache.set(key, {
          result: outcome.ok
            ? { ok: true, command }
            : { ok: false, command, error: outcome.error ?? `remote executable "${command}" unreachable` },
          at: Date.now(),
        });
      })
      .catch(() => {
        probeCache.set(key, {
          result: { ok: false, command, error: `remote executable "${command}" probe failed` },
          at: Date.now(),
        });
      })
      .finally(() => sshProbeInflight.delete(key));
    sshProbeInflight.set(key, probe);
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