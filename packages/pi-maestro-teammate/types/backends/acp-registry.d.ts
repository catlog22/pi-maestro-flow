/**
 * Turning a registry agent id into the command that launches it.
 *
 * The snapshot beside this module states how each listed agent is distributed;
 * this decides what that means on the machine running the dispatch. Nothing
 * here reaches the network — refreshing the snapshot is an explicit, reviewed
 * step, so a registration launches the version its commit pinned rather than
 * whatever upstream published since.
 */
import { type AcpRegistryAgent } from "./acp-registry-snapshot.ts";
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
export declare function currentRegistryTarget(platform?: string, arch?: string): string | undefined;
/**
 * Look up one listed agent.
 *
 * @param id - registry agent id, such as `claude-acp`.
 * @returns the snapshot entry, or undefined when the snapshot lists no such id.
 */
export declare function findRegistryAgent(id: string): AcpRegistryAgent | undefined;
/**
 * Every listed agent, for a configuration surface to offer.
 *
 * @returns each agent as its id, display name, and how it is distributed.
 */
export declare function registryAgentChoices(): readonly {
    value: string;
    label: string;
    description: string;
}[];
/** Probe used to decide whether an installed copy exists; injectable for tests. */
export type ExecutableProbe = (command: string) => boolean;
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
export declare function resolveRegistryLaunch(agent: AcpRegistryAgent, options?: {
    target?: string | undefined;
    isExecutable?: ExecutableProbe;
}): ResolvedRegistryLaunch;
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
export declare function installPrefixFor(agent: AcpRegistryAgent): string;
/**
 * The executable an install of this agent would provide, if it is there.
 *
 * @param agent - the snapshot entry to look for.
 * @returns the absolute path to the installed executable, or undefined when no
 * install is present or the agent declares no bin to look for.
 */
export declare function installedExecutable(agent: AcpRegistryAgent): string | undefined;
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
export declare function installRegistryAgent(agent: AcpRegistryAgent, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    install?: AgentInstaller;
}): Promise<string | undefined>;
/** Installs one package specifier into a prefix; injectable for tests. */
export type AgentInstaller = (spec: string, prefix: string, signal: AbortSignal | undefined, timeoutMs: number) => Promise<void>;
/**
 * Default install bound.
 *
 * Not a registration setting: this is one npm install of one small package, and
 * a deployment that needs longer is on a network where the runner path is the
 * better answer anyway. Exceeding it falls back rather than failing.
 */
export declare const ACP_INSTALL_TIMEOUT_MS = 180000;
