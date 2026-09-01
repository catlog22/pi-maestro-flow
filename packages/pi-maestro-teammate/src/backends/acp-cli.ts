/**
 * The ACP-CLI backend: run one external CLI that speaks the Agent Client
 * Protocol, over the same `TeammateBackend` contract every other backend uses.
 *
 * Generic by construction. Nothing here names a particular CLI: the executable,
 * its argv, its working directory, and its ssh connection are configuration
 * fields, so adding a CLI that speaks ACP needs no host source change. One
 * registration serves one CLI, which is what lets two of them declare different
 * routes and different timeouts.
 *
 * Two documents, each sufficient for one thing and neither for both. A
 * registration in `.pi/teammate-backends.json` is necessary and sufficient to
 * *run* `cli/<tool>`: the launch takes its configuration from the registration
 * and reads no file. An entry in `teammate-cli-tools.json` is necessary and
 * sufficient for `cli/<tool>` to *appear* in the model catalog, which is all the
 * host still derives from that file. So a registered tool missing from the tools
 * file runs when a task names it and is never offered, and a tool present only
 * in the tools file is offered and then refused by name — including one the
 * tools file marks `enabled: false`, because the registration is the enablement
 * decision.
 *
 * It ships in this package because its implementation reuses this package's ACP
 * driver and CLI launch helpers, and it is registered by module specifier like
 * any third-party adapter — the host loader has no branch for it.
 *
 * Recovery facts travel on the returned outcome. The dispatch path this backend
 * replaces fed them through a `WeakMap` keyed on the result, with a hardcoded
 * zero completed-tool count: a CLI run that edited files and then failed was
 * reported as having touched nothing, so the host's replay fence cleared a
 * replay that would repeat those edits.
 */

import type {
  AttemptOutcome,
  AttemptRecoveryFacts,
  BackendCapabilities,
  BackendConfigField,
  BackendConfigOption,
  BackendRun,
  BackendRunOptions,
  ConfigValue,
  RecoveryShape,
  ResolvedBackendConfig,
  TeammateBackend,
} from "pi-maestro-backend-core/v1";
import type {
  AgentTerminalStatus,
  ControlMode,
  SingleResult,
  TeammateRunSpec,
} from "pi-maestro-backend-core/v1/spec";
import {
  cliToolArgv,
  probeCliToolCommand,
  sshHostConfigIssue,
  type CliToolConfig,
} from "../cli-tools/cli-tools-config.ts";
import {
  ACP_MODE_CONFIG_ID,
  ACP_MODEL_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  advertisedValues,
} from "../remote/acp-config-options.ts";
import { probeAcpConfigOptions } from "../remote/acp-driver.ts";
import {
  findRegistryAgent,
  installRegistryAgent,
  installedExecutable,
  registryAgentChoices,
  resolveRegistryLaunch,
} from "./acp-registry.ts";
import {
  CLI_TOOL_MODEL_PREFIX,
  cliToolNameFromModel,
  isCliToolModel,
  runCliTool,
  type CliToolRunResult,
  type RunLocalCliToolParams,
} from "../cli-tools/local-acp.ts";

/**
 * What driving an external CLI over ACP actually serves.
 *
 * `outputSchema` — the ACP prompt turn carries no schema and this backend adds
 * no host-side extraction, so a task asking for one is rejected by capability
 * adjudication before anything is spawned. The dispatch this replaces made the
 * same decision inside the run, after the config had been loaded.
 * `forkContext` — a Pi history entry describes a different runtime's tool set.
 * `modelSelection` — honoured on both axes. The registration is the route, and a
 * spec naming anything else names a model in the CLI's own catalogue, which
 * `start` selects on the session it opens. A value that CLI does not advertise
 * fails the run rather than silently leaving the agent on its current model.
 * `thinkingLevel` — no ACP field expresses it; the CLI's own config decides.
 * `todoBinding` — this backend passes no host tool to the child, so a task with
 * todos would stall at `in_progress` while the host waited for updates.
 * `toolFilter` — the CLI's own configuration owns its tool set.
 * `steer` — the driver has no mid-turn injection, and queueing to a turn
 * boundary is not built here.
 * `followUp` — one prompt per run; the process exits with the turn.
 * `abort` — `BackendRun.abort()` aborts the signal the driver cancels on, which
 * cancels the ACP session and tears down the process.
 */
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "unsupported",
  forkContext: "unsupported",
  modelSelection: "native",
  thinkingLevel: "unsupported",
  todoBinding: "unsupported",
  toolFilter: "unsupported",
  steer: "unsupported",
  followUp: "unsupported",
  abort: "native",
};

/**
 * The arguments that follow an executable, with no package specifier before them.
 *
 * A registration that names its own executable, and one that reached an
 * installed copy, both launch the agent directly; only the runner path needs
 * the specifier it resolves. Reading them from the snapshot keeps the two in
 * step — the ACP-mode flag is the same either way.
 *
 * @param agent - the snapshot entry the registration named.
 * @param launch - the launch resolved for this machine.
 * @returns arguments to pass after the executable.
 */
function runnerArgumentsOf(
  agent: ReturnType<typeof findRegistryAgent> & {},
  launch: { args: readonly string[] },
): readonly string[] {
  return agent.launch.kind === "binary" ? launch.args : agent.launch.runnerArgs;
}

/**
 * Fill a registration's launch from the ACP registry snapshot.
 *
 * Writes into `values` rather than returning a launch, because `resolveConfig`
 * publishes one resolved document and every later reader — the runner, the
 * probe, the settings shell — must see the same one.
 *
 * A registration that names an agent *and* restates its launch is refused
 * rather than silently preferring one: the two would disagree the moment the
 * snapshot is refreshed, and the operator could not tell which one ran.
 * `command` stays the operator's for binary agents, which this host never
 * installs; only the arguments come from the registry.
 *
 * @param agentId - value of the `acpAgent` field.
 * @param config - the registration as written.
 * @param values - resolved document to fill; mutated in place.
 * @returns an error message, or undefined when the launch resolved.
 */
function applyRegistryLaunch(
  agentId: string,
  config: Record<string, ConfigValue>,
  values: Record<string, ConfigValue>,
): string | undefined {
  const agent = findRegistryAgent(agentId);
  if (agent === undefined) {
    return `"acpAgent" names "${agentId}", which the ACP registry snapshot does not list`;
  }
  if (list(config, "args").length > 0) {
    return `"args" cannot be set beside "acpAgent": agent "${agentId}" carries its own arguments`;
  }
  let launch;
  try {
    launch = resolveRegistryLaunch(agent);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // An explicit executable overrides the resolved one: an operator with a build
  // outside PATH is naming where it is, not disagreeing with the registry. The
  // arguments still come from the registry, and are the ones that follow an
  // executable rather than the runner's package specifier.
  const override = text(config, "command");
  if (override !== undefined && override.trim().length > 0) {
    values.args = [...runnerArgumentsOf(agent, launch)];
    return undefined;
  }
  if (launch.command !== undefined) values.command = launch.command;
  values.args = [...launch.args];
  return undefined;
}

/**
 * Registration fields that name a value on one of the agent's own selectors.
 *
 * The map is the whole per-axis story: each field carries a value in the
 * agent's vocabulary, and the ACP config id says which selector that vocabulary
 * belongs to. Listing an axis and setting it read this same table, so a field
 * whose picker fills is a field the run can set, and adding an axis is adding a
 * row plus its field.
 */
const SELECTOR_FIELDS: Readonly<Record<string, string>> = {
  acpModel: ACP_MODEL_CONFIG_ID,
  acpMode: ACP_MODE_CONFIG_ID,
  acpThoughtLevel: ACP_THOUGHT_LEVEL_CONFIG_ID,
};

/**
 * This backend's settings — one CLI's launch, its location, and its route.
 *
 * No field is a `credential-ref`: an ACP CLI resolves its own provider
 * credentials from its own configuration, so there is no secret for the host to
 * hold or forward. `env` carries variable *names* the parent process may pass
 * through, which is why an entry containing a value is refused below.
 */
/**
 * Exported so the models CLI edit flow renders exactly the fields this backend
 * validates against, without loading the backend for its capability table.
 */
export const ACP_CLI_CONFIG_FIELDS: readonly BackendConfigField[] = [
  {
    // An id from the checked-in ACP registry snapshot. Supplies the launch so a
    // registration does not have to restate a package specifier the registry
    // already pins; `command` stays required for agents that ship as binaries,
    // because nothing here installs one.
    key: "acpAgent",
    kind: "dynamic-enum",
    labelKey: "acpCli.acpAgent",
    descriptionKey: "acpCli.acpAgent.description",
  },
  {
    // Off by default: installing writes to disk and reaches the network, and a
    // registration that only names an agent has not asked for either. The
    // runner path works without it, so the choice is a speed-up an operator
    // opts into rather than a side effect of naming an agent.
    key: "acpInstall",
    kind: "enum",
    labelKey: "acpCli.acpInstall",
    descriptionKey: "acpCli.acpInstall.description",
    options: [
      { value: "never", labelKey: "acpCli.acpInstall.never" },
      { value: "auto", labelKey: "acpCli.acpInstall.auto" },
    ],
    default: "never",
  },
  {
    // Bounds the one-off install, not the run. Exceeding it falls back to the
    // runner rather than failing the task.
    key: "installTimeoutMs",
    kind: "integer",
    labelKey: "acpCli.installTimeoutMs",
    descriptionKey: "acpCli.installTimeoutMs.description",
  },
  {
    // Not declared `required`: `acpAgent` supplies it for every agent the
    // registry distributes through a package runner. The requirement is
    // conditional, so `resolveConfig` owns it and can say which of the two ways
    // to satisfy it applies.
    key: "command",
    kind: "text",
    labelKey: "acpCli.command",
    descriptionKey: "acpCli.command.description",
  },
  {
    key: "args",
    kind: "string-list",
    labelKey: "acpCli.args",
    descriptionKey: "acpCli.args.description",
    default: [],
  },
  {
    // Local path under mode "local"; a path on the remote host under "ssh".
    key: "cwd",
    kind: "path",
    labelKey: "acpCli.cwd",
    descriptionKey: "acpCli.cwd.description",
  },
  {
    key: "env",
    kind: "string-list",
    labelKey: "acpCli.env",
    descriptionKey: "acpCli.env.description",
    default: [],
  },
  {
    key: "mode",
    kind: "enum",
    options: [
      { value: "local", labelKey: "acpCli.mode.local" },
      { value: "ssh", labelKey: "acpCli.mode.ssh" },
    ],
    labelKey: "acpCli.mode",
    default: "local",
  },
  {
    key: "sshHostRef",
    kind: "text",
    labelKey: "acpCli.sshHostRef",
    descriptionKey: "acpCli.sshHostRef.description",
  },
  { key: "host", kind: "text", labelKey: "acpCli.host" },
  { key: "user", kind: "text", labelKey: "acpCli.user" },
  // Applied only to embedded SSH below. Leaving this declaration without a
  // generic default lets validation distinguish an explicit override from a
  // reference that must take its port exclusively from `/ssh`.
  { key: "port", kind: "integer", labelKey: "acpCli.port" },
  { key: "hostKeySha256", kind: "text", labelKey: "acpCli.hostKeySha256" },
  { key: "identityFile", kind: "path", labelKey: "acpCli.identityFile" },
  {
    // The `cli/<tool>` route this registration serves. Defaulted from the
    // registration name so the common case needs no setting at all.
    key: "modelId",
    kind: "text",
    labelKey: "acpCli.modelId",
    descriptionKey: "acpCli.modelId.description",
  },
  {
    // The registration's default model, applied when a task names only the
    // route. A task naming a model overrides it, so one registration serves a
    // whole CLI rather than one model of it.
    //
    // The value belongs to the CLI's own catalogue, which is only knowable once
    // a session is open: validation happens there, against what the agent
    // advertises, and names every accepted value when it rejects one.
    key: "acpModel",
    kind: "dynamic-enum",
    labelKey: "acpCli.acpModel",
    descriptionKey: "acpCli.acpModel.description",
  },
  {
    // The agent's own operating mode, where it has one — Cursor advertises
    // agent / plan / ask. Declared for every registration and filled from the
    // agent, so a CLI that offers no modes reports an empty list rather than
    // this backend deciding which CLIs have modes.
    key: "acpMode",
    kind: "dynamic-enum",
    labelKey: "acpCli.acpMode",
    descriptionKey: "acpCli.acpMode.description",
  },
  {
    // The agent's own reasoning-depth selector, for agents that publish one as
    // a separate axis. Many bake reasoning depth into the model value instead
    // and advertise nothing here; for those the picker is empty, which is the
    // honest answer rather than a synthesised level this backend cannot set.
    key: "acpThoughtLevel",
    kind: "dynamic-enum",
    labelKey: "acpCli.acpThoughtLevel",
    descriptionKey: "acpCli.acpThoughtLevel.description",
  },
  {
    // Per registration, not per task: `TeammateRunSpec` carries no timeout, so
    // this is the finest granularity the contract can express today.
    key: "runTimeoutMs",
    kind: "integer",
    labelKey: "acpCli.runTimeoutMs",
    descriptionKey: "acpCli.runTimeoutMs.description",
  },
  {
    // How long the ACP handshake may take, separate from `runTimeoutMs`, which
    // bounds the run once it is talking. Raising it is the point; lowering it
    // is a mistake the default already guards against. The bound covers
    // `initialize` and `session/new`, and installing the adapter locally only
    // removes the download in front of the first — measured against Claude
    // Code, an installed adapter still fails at `session/new` under 5s and
    // needs the 15s default. Raise it when `command` resolves or downloads
    // before answering, or when the agent is slow to open a session.
    key: "startupTimeoutMs",
    kind: "integer",
    labelKey: "acpCli.startupTimeoutMs",
    descriptionKey: "acpCli.startupTimeoutMs.description",
  },
];

/** Read a string setting, or undefined when unset. */
function text(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a string-list setting; an unset list is empty. */
function list(config: Record<string, ConfigValue>, key: string): readonly string[] {
  const value = config[key];
  return Array.isArray(value) ? value : [];
}

/** Read a numeric setting, or undefined when unset. */
function count(config: Record<string, ConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Rebuild the launch configuration the CLI runner consumes.
 *
 * `enabled` is unconditionally true: a registration in the document is the
 * enablement decision, and a second switch inside it could only disagree with
 * the file that named it.
 *
 * @param config - this registration's resolved settings.
 * @returns the launch configuration.
 */
/**
 * The launch configuration for one run, installing the agent first when asked.
 *
 * `acpInstall: "auto"` trades one slow first run for fast later ones: `npx`
 * re-resolves the package on every launch, so an installed copy is the
 * difference between a handshake that answers immediately and one that waits on
 * the network. A failed install is not a failed run — the runner path is still
 * there, and returning it beats refusing to work because a speed-up did not
 * apply.
 *
 * Never overrides an executable the registration named: that path is the
 * operator's answer to "where is it", and installing a second copy would run
 * something they did not point at.
 *
 * @param config - the resolved registration.
 * @param signal - cancellation for the install.
 * @returns the configuration to launch with.
 */
async function installedLaunchConfig(
  config: Record<string, ConfigValue>,
  signal: AbortSignal,
): Promise<CliToolConfig> {
  const base = launchConfigOf(config);
  const agentId = text(config, "acpAgent");
  if (agentId === undefined || text(config, "acpInstall") !== "auto") return base;
  const agent = findRegistryAgent(agentId);
  if (agent === undefined || agent.launch.kind !== "npx") return base;
  // Already resolved to something other than the runner — an operator path or a
  // copy on PATH — so there is nothing to speed up.
  if (base.command !== agent.launch.command) return base;
  const executable = installedExecutable(agent)
    ?? await installRegistryAgent(agent, { signal, ...(count(config, "installTimeoutMs") === undefined ? {} : { timeoutMs: count(config, "installTimeoutMs")! }) });
  return executable === undefined
    ? base
    : { ...base, command: executable, args: [...agent.launch.runnerArgs] };
}

function launchConfigOf(config: Record<string, ConfigValue>): CliToolConfig {
  const command = text(config, "command");
  const cwd = text(config, "cwd");
  const sshHostRef = text(config, "sshHostRef");
  const host = text(config, "host");
  const user = text(config, "user");
  const port = count(config, "port");
  const hostKeySha256 = text(config, "hostKeySha256");
  const identityFile = text(config, "identityFile");
  return {
    enabled: true,
    mode: text(config, "mode") === "ssh" ? "ssh" : "local",
    ...(command === undefined ? {} : { command }),
    args: list(config, "args"),
    ...(cwd === undefined ? {} : { cwd }),
    env: list(config, "env"),
    ...(sshHostRef === undefined ? {} : { sshHostRef }),
    ...(host === undefined ? {} : { host }),
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
    ...(hostKeySha256 === undefined ? {} : { hostKeySha256 }),
    ...(identityFile === undefined ? {} : { identityFile }),
  };
}

/**
 * The `cli/<tool>` route one registration serves.
 *
 * Derived from the registration name when `modelId` is unset, so registering a
 * CLI under its own name is enough to make `cli/<name>` reach it.
 *
 * @param config - this registration's resolved settings.
 * @param backendName - the registration name from the spec, when it named one.
 * @returns the model id this registration answers to.
 */
function routeOf(config: Record<string, ConfigValue>, backendName?: string): string {
  const declared = text(config, "modelId")?.trim();
  if (declared !== undefined && declared.length > 0) return declared;
  return `${CLI_TOOL_MODEL_PREFIX}${backendName ?? ""}`;
}

/**
 * Translate one settled CLI run into the facts the host's failover reads.
 *
 * Exported because this fold is the whole of D1a: every field is an observation
 * the run reported, and a count invented here would be indistinguishable to the
 * fence from one the CLI actually earned.
 *
 * @param run - the settled CLI run.
 * @returns the recovery facts, in contract shape.
 */
export function recoveryFactsOf(run: CliToolRunResult): AttemptRecoveryFacts {
  return {
    settlementAuthority: run.settlementAuthority,
    completedToolCount: run.completedTools.length,
    inFlightToolCount: run.inFlightToolCount,
    // Read off observed activity, never off the exit code: a CLI that edited
    // files and then exited non-zero has plenty to replay, and calling that a
    // pre-activity exit is what cleared the fence on the path this replaces.
    //
    // The tool counts are not repeated here. Both are written only from a
    // `run/event`, which is the same event that sets `sawActivity`, so
    // `!sawActivity` already implies both are zero; naming them would read as a
    // three-part safety check in which two parts can never change the answer.
    preActivityInfrastructureExit: !run.sawActivity,
    // The stream ended with no protocol result, so what the CLI did before it
    // went silent is outside this attempt's own accounting.
    externalReplayRisk: run.terminalStatus === "lost",
  };
}

/** Map the CLI runner's terminal vocabulary to the contract's. */
function terminalStatusOf(run: CliToolRunResult): AgentTerminalStatus {
  if (run.terminalStatus === "completed") return "completed";
  if (run.terminalStatus === "cancelled") return "terminated";
  return "failed";
}

/** The CLI launcher this backend drives; injected so tests need no subprocess. */
export type CliToolRunner = (params: RunLocalCliToolParams) => Promise<CliToolRunResult>;

/**
 * Forward several abort sources into one signal.
 *
 * `release` must be called once the run settles. `once: true` removes a listener
 * only when it fires, and the dispatch signal outlives any single run, so
 * without the teardown a session that dispatches many CLI tasks on one signal
 * accumulates one listener per task until Node warns past ten.
 *
 * @param sources - the signals to follow; undefined entries are ignored.
 * @returns a signal aborted as soon as any source aborts, and the teardown that
 *   detaches it from every source it is still attached to.
 */
function combineSignals(
  ...sources: readonly (AbortSignal | undefined)[]
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const attached: Array<{ source: AbortSignal; listener: () => void }> = [];
  for (const source of sources) {
    if (source === undefined) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const listener = (): void => controller.abort(source.reason);
    source.addEventListener("abort", listener, { once: true });
    attached.push({ source, listener });
  }
  const release = (): void => {
    for (const { source, listener } of attached.splice(0)) {
      source.removeEventListener("abort", listener);
    }
  };
  return { signal: controller.signal, release };
}

/** Reads the configuration options an agent advertises, without running a task. */
export type AcpConfigOptionProbe = typeof probeAcpConfigOptions;

/**
 * Create the ACP-CLI backend.
 *
 * @param run - launches one CLI run; the default drives a real subprocess.
 * @param probe - reads an agent's advertised options; the default launches it.
 * @returns the backend, ready for registration.
 */
export function createAcpCliBackend(
  run: CliToolRunner = runCliTool,
  probe: AcpConfigOptionProbe = probeAcpConfigOptions,
): TeammateBackend {
  return {
    name: "acp-cli",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    // The CLI process exits with its turn and keeps no addressable session, so a
    // failed attempt can only be re-run from the original prompt.
    recoveryShape: "replay" satisfies RecoveryShape,
    configFields: ACP_CLI_CONFIG_FIELDS,

    resolveConfig(config: Record<string, ConfigValue>): ResolvedBackendConfig {
      const errors: string[] = [];
      const mode = text(config, "mode") ?? "local";
      if (mode !== "local" && mode !== "ssh") {
        errors.push(`"mode" must be "local" or "ssh", got "${mode}"`);
      }
      const values: Record<string, ConfigValue> = { ...config };
      const agentId = text(config, "acpAgent");
      const registryFailure = agentId === undefined
        ? undefined
        : applyRegistryLaunch(agentId, config, values);
      if (registryFailure !== undefined) errors.push(registryFailure);
      // Skipped once the registry step already failed: it stopped before it
      // could fill the launch, so a further complaint about the executable
      // describes that failure rather than a second thing to fix.
      if (registryFailure === undefined && (text(values, "command") ?? "").trim().length === 0) {
        errors.push(
          agentId === undefined
            ? '"command" must name the executable to launch, or "acpAgent" must name a registry agent that carries one'
            : `"command" must name the executable: ACP registry agent "${agentId}" ships as a platform binary, which this host never installs`,
        );
      }
      const port = count(config, "port");
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        errors.push(`"port" must be a TCP port between 1 and 65535, got ${port}`);
      }
      const runTimeoutMs = count(config, "runTimeoutMs");
      if (runTimeoutMs !== undefined && runTimeoutMs <= 0) {
        errors.push(`"runTimeoutMs" must be a positive number of milliseconds, got ${runTimeoutMs}`);
      }
      const installTimeoutMs = count(config, "installTimeoutMs");
      if (installTimeoutMs !== undefined && installTimeoutMs <= 0) {
        errors.push(`"installTimeoutMs" must be a positive number of milliseconds, got ${installTimeoutMs}`);
      }
      const startupTimeoutMs = count(config, "startupTimeoutMs");
      if (startupTimeoutMs !== undefined && startupTimeoutMs <= 0) {
        errors.push(
          `"startupTimeoutMs" must be a positive number of milliseconds, got ${startupTimeoutMs}`,
        );
      }
      // The field holds variable names the parent may forward, so an entry
      // shaped like NAME=value is a secret written into a committed
      // registration document. Only the offending name is quoted back — the
      // text after "=" may be the secret, and this message reaches transcripts.
      for (const name of list(config, "env")) {
        if (!name.includes("=")) continue;
        errors.push(
          `"env" names ${name.slice(0, name.indexOf("="))}=…, but it holds variable names that the `
          + "parent process forwards by name; a name=value entry puts the value in the registration document",
        );
      }
      // Checked at load rather than at launch: one SSH source must be complete
      // and authoritative. A reference cannot be paired with even a seemingly
      // harmless port override, because that would recreate two sources of
      // truth for the connection.
      if (mode === "ssh") {
        const issue = sshHostConfigIssue(launchConfigOf(values));
        if (issue !== undefined) errors.push(issue);
        else if ((text(values, "sshHostRef") ?? "").trim().length === 0 && count(values, "port") === undefined) {
          values.port = 22;
        }
      } else if ((text(values, "sshHostRef") ?? "").trim().length > 0) {
        errors.push('"sshHostRef" requires "mode" to be "ssh"');
      }
      return { values, errors };
    },

    async listConfigOptions(
      field: string,
      config: Record<string, ConfigValue>,
      signal: AbortSignal,
    ): Promise<readonly BackendConfigOption[]> {
      // Answered from the checked-in snapshot: the choices are agent ids, which
      // are known without launching anything. Every other picker asks the agent
      // itself, which is why the launch checks below apply only to those.
      if (field === "acpAgent") return registryAgentChoices();
      const configId = SELECTOR_FIELDS[field];
      if (configId === undefined) {
        throw new Error(`teammate backend "acp-cli" publishes no options for setting "${field}"`);
      }
      const launch = launchConfigOf(config);
      if (launch.mode === "ssh") {
        // The probe launches the agent from this process. An ssh registration's
        // catalogue lives on the far host, and reaching it would need the run
        // path's ssh transport, which this operation does not build. Saying so
        // beats returning the local machine's answer for a remote target.
        throw new Error(
          `teammate backend "acp-cli" cannot list "${field}" for an "ssh" registration: `
          + "whether embedded or selected by sshHostRef, the target host's catalogue is not reachable by the local probe",
        );
      }
      const route = routeOf(config);
      const tool = isCliToolModel(route) ? cliToolNameFromModel(route) : route;
      const launchable = probeCliToolCommand(tool, launch);
      if (!launchable.ok) {
        throw new Error(`CLI tool "${tool}" is not launchable: ${launchable.error}`);
      }
      const startupTimeoutMs = count(config, "startupTimeoutMs");
      const advertised = await probe(
        {
          command: cliToolArgv(tool, launch),
          cwd: launch.cwd?.trim() || process.cwd(),
          env: launch.env ?? [],
        },
        {
          signal,
          ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
        },
      );
      return advertisedValues(advertised, configId);
    },

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const route = routeOf(options.config, spec.backend);
      // Two axes share one field. The route names the CLI this registration
      // launches; anything else names a model inside that CLI's own catalogue,
      // which is a space the host does not know. A task naming the route asks
      // for the CLI and nothing more, so the registration's own default (if
      // any) applies. Selecting nothing when a model was named is the silent
      // failure the capability table exists to prevent, so an unadvertised
      // value fails the session rather than running the agent's default.
      const acpModel = spec.model === undefined || spec.model === route
        ? text(options.config, "acpModel")
        : spec.model;
      // Every axis this registration named, in the agent's own vocabulary. An
      // axis left unset is absent rather than defaulted here: the agent's own
      // current setting is the only sensible default, and this backend does not
      // know it.
      const acpSelections: Record<string, string> = {};
      if (acpModel !== undefined) acpSelections[ACP_MODEL_CONFIG_ID] = acpModel;
      for (const [field, configId] of Object.entries(SELECTOR_FIELDS)) {
        if (configId === ACP_MODEL_CONFIG_ID) continue;
        const value = text(options.config, field);
        if (value !== undefined) acpSelections[configId] = value;
      }
      const tool = isCliToolModel(route) ? cliToolNameFromModel(route) : route;
      const aborter = new AbortController();
      const startedAt = Date.now();
      const publishProgress = (data: object): void => {
        try {
          options.onProgress?.({
            ...data,
            ...(spec.name === undefined ? {} : { name: spec.name }),
            correlationId: options.correlationId,
          });
        } catch {
          // Advisory observer failure is isolated from execution.
        }
      };
      // ACP runners may spend seconds in install, launch, and handshake before
      // their first protocol event. Publish the host-owned starting state now so
      // foreground teammate calls and Cockpit never render as an empty tool.
      publishProgress({
        status: "running",
        phase: "starting",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        startedAt,
        durationMs: 0,
        lastActivityAt: startedAt,
      });
      // Installing is deferred to here because `resolveConfig` is synchronous
      // and runs whenever the document is read — including while the settings
      // shell renders. A registration stays launchable without it: this only
      // upgrades the runner path to an installed copy.
      const launchConfig = await installedLaunchConfig(options.config, aborter.signal);
      const timeoutMs = count(options.config, "runTimeoutMs");
      const startupTimeoutMs = count(options.config, "startupTimeoutMs");
      const cancellation = combineSignals(options.signal, aborter.signal);

      const outcome = (async (): Promise<AttemptOutcome> => {
        const settled = await run({
          tool,
          config: launchConfig,
          prompt: spec.task,
          cwd: spec.cwd ?? options.baseCwd,
          signal: cancellation.signal,
          onProgress: publishProgress,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
          ...(Object.keys(acpSelections).length === 0 ? {} : { acpSelections }),
        }).finally(cancellation.release);
        const terminalStatus = terminalStatusOf(settled);
        const result: SingleResult = {
          agent: spec.agent,
          ...(spec.name === undefined ? {} : { name: spec.name }),
          task: spec.task,
          exitCode: settled.exitCode,
          messages: settled.messages,
          usage: {
            inputTokens: settled.usage.inputTokens ?? 0,
            outputTokens: settled.usage.outputTokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: settled.usage.costUsd ?? 0,
            turns: 1,
          },
          // The route, because that is what the host dispatched and the only
          // name it shares with this registration. What the CLI actually ran
          // has its own namespace and is reported beside it; collapsing the two
          // into one field would lose whichever it did not carry.
          model: route,
          ...(settled.selectedModel === undefined ? {} : { executorModel: settled.selectedModel }),
          correlationId: options.correlationId,
          originCwd: spec.cwd ?? options.baseCwd,
          durationMs: settled.durationMs,
          toolCount: settled.completedTools.length,
          // The process exits with its turn, so nothing remains to address.
          wakeable: false,
          terminalStatus,
        };
        options.onTurnComplete?.(result, terminalStatus);
        return {
          result,
          recovery: recoveryFactsOf(settled),
          // The runner closes its driver in a `finally`, so the ACP process tree
          // is already gone by the time this outcome exists.
          reclamation: Promise.resolve({ status: "reclaimed" }),
        };
      })();

      return {
        outcome,
        // No control channel exists: the CLI is handed one prompt on stdin and
        // speaks ACP back. Reporting that plainly beats accepting a message the
        // host would then record as delivered.
        send(_message: string, _mode: ControlMode): boolean {
          return false;
        },
        abort(): void {
          aborter.abort();
        },
      };
    },
  };
}

/**
 * Display text for the `acpCli.*` keys the fields above carry.
 *
 * Re-exported here because a host that registers this backend reads its
 * `configFields` from this module: taking the wording from anywhere else lets a
 * registration ship fields whose keys have no text.
 */
export { ACP_CLI_SETTINGS_CATALOGS } from "./acp-cli-catalog.ts";
export { probeSshCliExecutable } from "../remote/ssh-exec.ts";

/**
 * The registered instance.
 *
 * `asBackend` takes a loaded module's `.default` when it has one and narrows the
 * module namespace itself otherwise, so a default export is not required of
 * every adapter — it is required of this one. The named exports here are a
 * factory and a fold, neither of which is `name`, `capabilities`, or `start`, so
 * a namespace without the default carries no backend to find.
 */
export default createAcpCliBackend();
