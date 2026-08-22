/**
 * Turning a registry agent id into the command that launches it.
 *
 * The snapshot beside this module states how each listed agent is distributed;
 * this decides what that means on the machine running the dispatch. Nothing
 * here reaches the network — refreshing the snapshot is an explicit, reviewed
 * step, so a registration launches the version its commit pinned rather than
 * whatever upstream published since.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { probeCliToolCommand, type CliToolConfig } from "../cli-tools/cli-tools-config.ts";
import { ACP_REGISTRY_AGENTS, type AcpRegistryAgent } from "./acp-registry-snapshot.ts";

/** Where a resolved launch command came from. */
export type AcpLaunchSource = "local" | "runner" | "operator";

/** A launch resolved against one machine. */
export interface ResolvedRegistryLaunch {
  /** Absent only when the agent ships as a binary the operator must name. */
  command?: string;
  args: readonly string[];
  source: AcpLaunchSource;
}

/**
 * Name this machine the way the registry names platform targets.
 *
 * Upstream keys binary targets `<platform>-<arch>` with its own spellings, so
 * the mapping is stated rather than derived from Node's names.
 *
 * @param platform - Node platform id; defaults to the running one.
 * @param arch - Node architecture id; defaults to the running one.
 * @returns the upstream target key, or undefined when upstream names no target
 * for this machine.
 */
export function currentRegistryTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return os === undefined || cpu === undefined ? undefined : `${os}-${cpu}`;
}

/**
 * Look up one listed agent.
 *
 * @param id - registry agent id, such as `claude-acp`.
 * @returns the snapshot entry, or undefined when the snapshot lists no such id.
 */
export function findRegistryAgent(id: string): AcpRegistryAgent | undefined {
  return ACP_REGISTRY_AGENTS.find((agent) => agent.id === id);
}

/**
 * Every listed agent, for a configuration surface to offer.
 *
 * @returns each agent as its id, display name, and how it is distributed.
 */
export function registryAgentChoices(): readonly { value: string; label: string; description: string }[] {
  return ACP_REGISTRY_AGENTS.map((agent) => ({
    value: agent.id,
    label: `${agent.name} (${agent.version})`,
    description: agent.launch.kind === "binary"
      ? "Ships as a platform binary — set the executable path yourself; the arguments come from the registry."
      : `Launches through ${agent.launch.kind}; an installed copy is preferred when one is on PATH.`,
  }));
}

/** Probe used to decide whether an installed copy exists; injectable for tests. */
export type ExecutableProbe = (command: string) => boolean;

const probeOnPath: ExecutableProbe = (command) =>
  probeCliToolCommand(command, { enabled: true, command } as CliToolConfig).ok;

/**
 * Decide how to launch one listed agent on this machine.
 *
 * A runner-distributed agent prefers an executable it already installed: `npx`
 * re-resolves the package on every launch and may download it first, which is
 * the difference between a handshake that answers in seconds and one that needs
 * the startup bound raised. The candidates come from the package's own manifest
 * rather than from its name, so preferring one cannot land on an unrelated
 * program that happens to share the package's name.
 *
 * @param agent - the snapshot entry to resolve.
 * @param options - platform target override and executable probe, for tests.
 * @returns the command and arguments, and which of the three sources decided them.
 * @throws when the agent ships as a binary and upstream names no target for
 * this machine, so the registry has no arguments to contribute.
 */
export function resolveRegistryLaunch(
  agent: AcpRegistryAgent,
  options: { target?: string | undefined; isExecutable?: ExecutableProbe } = {},
): ResolvedRegistryLaunch {
  if (agent.launch.kind === "binary") {
    const target = options.target === undefined ? currentRegistryTarget() : options.target;
    const args = target === undefined ? undefined : agent.launch.argsByTarget[target];
    if (args === undefined) {
      throw new Error(
        `ACP registry agent "${agent.id}" lists no binary for ${target ?? "this platform"}; `
        + `it names: ${Object.keys(agent.launch.argsByTarget).join(", ")}`,
      );
    }
    return { args, source: "operator" };
  }
  const isExecutable = options.isExecutable ?? probeOnPath;
  for (const bin of agent.launch.bins) {
    if (isExecutable(bin)) return { command: bin, args: agent.launch.runnerArgs, source: "local" };
  }
  return { command: agent.launch.command, args: agent.launch.args, source: "runner" };
}

/**
 * Where installed agent copies live.
 *
 * Under Pi's agent directory rather than a global npm prefix: installing an
 * agent must not change what the operator's own `npx`, `npm ls -g`, or PATH
 * resolve, and removing the directory must undo it completely. Keyed by agent
 * and version so refreshing the snapshot installs the new pin instead of
 * silently reusing the old contents under the same path.
 *
 * @param agent - the snapshot entry to house.
 * @returns the prefix `npm install --prefix` is given.
 */
export function installPrefixFor(agent: AcpRegistryAgent): string {
  return join(getAgentDir(), "acp-agents", agent.id, agent.version);
}

/**
 * The executable an install of this agent would provide, if it is there.
 *
 * @param agent - the snapshot entry to look for.
 * @returns the absolute path to the installed executable, or undefined when no
 * install is present or the agent declares no bin to look for.
 */
export function installedExecutable(agent: AcpRegistryAgent): string | undefined {
  if (agent.launch.kind !== "npx") return undefined;
  const prefix = installPrefixFor(agent);
  for (const bin of agent.launch.bins) {
    const candidate = join(prefix, "node_modules", ".bin", bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Install one agent into its own prefix, so later runs skip the package runner.
 *
 * Only `npx` agents: a uvx package does not publish the script name this
 * product would have to invoke afterwards, so installing one would leave
 * nothing to run and the runner stays the only honest answer.
 *
 * Failure returns undefined rather than throwing. The runner path still works,
 * so a network hiccup during an optional speed-up must not fail a task the
 * operator asked to run.
 *
 * @param agent - the snapshot entry to install.
 * @param options - abort signal, timeout, and installer injection for tests.
 * @returns the installed executable, or undefined when the install did not
 * produce one.
 */
export async function installRegistryAgent(
  agent: AcpRegistryAgent,
  options: { signal?: AbortSignal; timeoutMs?: number; install?: AgentInstaller } = {},
): Promise<string | undefined> {
  if (agent.launch.kind !== "npx") return undefined;
  const existing = installedExecutable(agent);
  if (existing !== undefined) return existing;
  // The pinned specifier, not the runner's argv: `-y` and any ACP-mode flags
  // belong to launching it, not to installing it.
  const spec = agent.launch.args.find((argument) => argument !== "-y" && !argument.startsWith("-"));
  if (spec === undefined) return undefined;
  const prefix = installPrefixFor(agent);
  const install = options.install ?? npmInstall;
  try {
    mkdirSync(prefix, { recursive: true });
    await install(spec, prefix, options.signal, options.timeoutMs ?? ACP_INSTALL_TIMEOUT_MS);
  } catch {
    // Diagnosed by the caller falling back to the runner, which reports its own
    // failure if the agent is genuinely unreachable.
    return undefined;
  }
  return installedExecutable(agent);
}

/** Installs one package specifier into a prefix; injectable for tests. */
export type AgentInstaller = (
  spec: string,
  prefix: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) => Promise<void>;

/**
 * Default install bound.
 *
 * Not a registration setting: this is one npm install of one small package, and
 * a deployment that needs longer is on a network where the runner path is the
 * better answer anyway. Exceeding it falls back rather than failing.
 */
export const ACP_INSTALL_TIMEOUT_MS = 180_000;

const npmInstall: AgentInstaller = (spec, prefix, signal, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", spec],
      { timeout: timeoutMs, windowsHide: true, ...(signal ? { signal } : {}) },
      (error) => (error ? reject(error) : resolve()),
    );
  });
