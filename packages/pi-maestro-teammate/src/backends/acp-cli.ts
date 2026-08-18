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
import type { CliToolConfig } from "../cli-tools/cli-tools-config.ts";
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
 * `modelSelection` — the registration *is* the route: one CLI per registration,
 * and `start` refuses a spec naming any other model rather than running the
 * wrong CLI under the requested model's name.
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
 * This backend's settings — one CLI's launch, its location, and its route.
 *
 * No field is a `credential-ref`: an ACP CLI resolves its own provider
 * credentials from its own configuration, so there is no secret for the host to
 * hold or forward. `env` carries variable *names* the parent process may pass
 * through, which is why an entry containing a value is refused below.
 */
const CONFIG_FIELDS: readonly BackendConfigField[] = [
  {
    key: "command",
    kind: "text",
    labelKey: "acpCli.command",
    descriptionKey: "acpCli.command.description",
    required: true,
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
  { key: "host", kind: "text", labelKey: "acpCli.host" },
  { key: "user", kind: "text", labelKey: "acpCli.user" },
  { key: "port", kind: "integer", labelKey: "acpCli.port", default: 22 },
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
    // Per registration, not per task: `TeammateRunSpec` carries no timeout, so
    // this is the finest granularity the contract can express today.
    key: "runTimeoutMs",
    kind: "integer",
    labelKey: "acpCli.runTimeoutMs",
    descriptionKey: "acpCli.runTimeoutMs.description",
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
function launchConfigOf(config: Record<string, ConfigValue>): CliToolConfig {
  const command = text(config, "command");
  const cwd = text(config, "cwd");
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

/**
 * Create the ACP-CLI backend.
 *
 * @param run - launches one CLI run; the default drives a real subprocess.
 * @returns the backend, ready for registration.
 */
export function createAcpCliBackend(run: CliToolRunner = runCliTool): TeammateBackend {
  return {
    name: "acp-cli",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    // The CLI process exits with its turn and keeps no addressable session, so a
    // failed attempt can only be re-run from the original prompt.
    recoveryShape: "replay" satisfies RecoveryShape,
    configFields: CONFIG_FIELDS,

    resolveConfig(config: Record<string, ConfigValue>): ResolvedBackendConfig {
      const errors: string[] = [];
      const mode = text(config, "mode") ?? "local";
      if (mode !== "local" && mode !== "ssh") {
        errors.push(`"mode" must be "local" or "ssh", got "${mode}"`);
      }
      if ((text(config, "command") ?? "").trim().length === 0) {
        errors.push('"command" must name the executable to launch');
      }
      const port = count(config, "port");
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        errors.push(`"port" must be a TCP port between 1 and 65535, got ${port}`);
      }
      const runTimeoutMs = count(config, "runTimeoutMs");
      if (runTimeoutMs !== undefined && runTimeoutMs <= 0) {
        errors.push(`"runTimeoutMs" must be a positive number of milliseconds, got ${runTimeoutMs}`);
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
      // Checked at load rather than at launch: the runner's ssh path already
      // fails closed on an incomplete host, but it does so per run, long after
      // the operator stopped looking at the file that caused it.
      if (mode === "ssh") {
        for (const key of ["host", "user", "hostKeySha256"]) {
          if ((text(config, key) ?? "").trim().length > 0) continue;
          errors.push(`"${key}" is required when "mode" is "ssh"`);
        }
      }
      return { values: config, errors };
    },

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const route = routeOf(options.config, spec.backend);
      // One registration serves one CLI. A spec asking for another model is
      // refused by name rather than answered by this CLI under that name —
      // silently ignoring it is exactly the failure the capability table exists
      // to prevent, and `modelSelection: "native"` is only true because of this.
      if (spec.model !== undefined && spec.model !== route) {
        throw new Error(
          `teammate backend "acp-cli" registration serves model "${route}", `
          + `but this task requested "${spec.model}"`,
        );
      }
      const tool = isCliToolModel(route) ? cliToolNameFromModel(route) : route;
      const aborter = new AbortController();
      const timeoutMs = count(options.config, "runTimeoutMs");
      const cancellation = combineSignals(options.signal, aborter.signal);

      const outcome = (async (): Promise<AttemptOutcome> => {
        const settled = await run({
          tool,
          config: launchConfigOf(options.config),
          prompt: spec.task,
          cwd: spec.cwd ?? options.baseCwd,
          signal: cancellation.signal,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
          model: route,
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
 * The registered instance.
 *
 * `asBackend` takes a loaded module's `.default` when it has one and narrows the
 * module namespace itself otherwise, so a default export is not required of
 * every adapter — it is required of this one. The named exports here are a
 * factory and a fold, neither of which is `name`, `capabilities`, or `start`, so
 * a namespace without the default carries no backend to find.
 */
export default createAcpCliBackend();
