/**
 * Turning a registry agent id into the command that launches it.
 *
 * The snapshot beside this module states how each listed agent is distributed;
 * this decides what that means on the machine running the dispatch. Nothing
 * here reaches the network — refreshing the snapshot is an explicit, reviewed
 * step, so a registration launches the version its commit pinned rather than
 * whatever upstream published since.
 */

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
