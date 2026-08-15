/**
 * The DeepSeek Harness backend: drive a `dsh` runtime subprocess over stdio
 * JSON-RPC through the published SDK client.
 *
 * Every capability verdict below was read off the SDK's own declarations rather
 * than inferred, and the notes name where. What the runtime can be told splits
 * in two: the SDK carries the session route (provider, model, token cap), while
 * the endpoint, credential reference, and model catalogue live in the runtime's
 * own `cordis.yml`. Fields here therefore describe the launch and the route,
 * and point at the config file for the rest instead of pretending to own it.
 *
 * Agent presets — the runtime's named compositions, each supplying its own tool
 * set and persona — are deliberately absent from this table. The SDK server
 * states that it performs no preset composition and reads model-facing rows
 * from the global layer, so a preset cannot be selected per session over this
 * transport. A deployment that wants several presets registers this backend
 * several times, once per composition, and a task picks one by naming that
 * registration. Modelling a preset field here would advertise a selector the
 * transport cannot honour.
 */

import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendConfigField,
  BackendRun,
  BackendRunOptions,
  ConfigValue,
  ResolvedBackendConfig,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type {
  ControlMode,
  SingleResult,
  TeammateRunSpec,
  Usage,
} from "pi-maestro-backend-core/v1/spec";

/**
 * What the SDK surface actually supports.
 *
 * `outputSchema` — no schema parameter exists; `RunResult.finalResponse` is
 * text, so a structured value must be prompted for and extracted.
 * `forkContext` — permanently unsupported, and semantically so: a Pi history
 * entry records what a different runtime did with a different tool set.
 * `modelSelection` — `DeepSeekHarnessOptions.model` fixes the route per harness
 * instance; a different model means a new instance, which matches the host
 * starting a fresh attempt per model candidate anyway.
 * `thinkingLevel` — absent from `RunOptions`, so it cannot vary per task. The
 * runtime's own config sets a deployment-wide default, which is a different
 * thing from the per-task control the orchestrator asks for here.
 * `outputSchema` / `todoBinding` — both were declared `emulated` while nothing
 * implemented the emulation, which is worse than declaring neither: adjudication
 * lets an `emulated` capability through with an advisory warning, so a task
 * needing structured output routed here and got none. They stay `unsupported`
 * until the extraction and the host tool relay actually exist.
 * `toolFilter` — the child's tool set comes from its `cordis.yml`.
 * `steer` — `HarnessClient` states plainly that there is no wire-level cancel.
 * Boundary-queued emulation is buildable but is not built here, so this reads
 * `unsupported`: the table records what the backend does, and claiming
 * emulation it lacks would route steering tasks here only to fail.
 * `followUp` — a session id stays addressable, so a later message is simply
 * another run on the same session, with the agent's context intact.
 * `abort` — no per-run cancel either; stopping one run means closing the
 * runtime, which is coarser than asked but does stop the work.
 */
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "unsupported",
  forkContext: "unsupported",
  modelSelection: "native",
  thinkingLevel: "unsupported",
  todoBinding: "unsupported",
  toolFilter: "unsupported",
  steer: "unsupported",
  followUp: "native",
  abort: "emulated",
};

const CONFIG_FIELDS: readonly BackendConfigField[] = [
  {
    key: "command",
    kind: "text",
    labelKey: "dsh.command",
    descriptionKey: "dsh.command.description",
    default: "dsh-jsonrpc-agent",
  },
  {
    key: "cordisConfig",
    kind: "path",
    labelKey: "dsh.cordisConfig",
    descriptionKey: "dsh.cordisConfig.description",
    required: true,
  },
  {
    key: "cwd",
    kind: "path",
    labelKey: "dsh.cwd",
    descriptionKey: "dsh.cwd.description",
  },
  {
    key: "provider",
    kind: "text",
    labelKey: "dsh.provider",
    default: "deepseek-official",
  },
  {
    key: "model",
    kind: "text",
    labelKey: "dsh.model",
    descriptionKey: "dsh.model.description",
    default: "deepseek-v4-flash",
  },
  {
    // Read by the settings layer, not by this backend: it names the variable
    // written into the runtime's own env file, which the runtime then resolves
    // for itself. Nothing here ever reads the value.
    key: "apiKeyEnv",
    kind: "credential-ref",
    // The runtime loads its own env file from beside its cordis.yml, so the
    // host writes a key there. Declaring "env-var" would ask the host to build
    // the child's environment around a provider credential it must never hold.
    credentialLocation: "env-file-key",
    labelKey: "dsh.apiKeyEnv",
    descriptionKey: "dsh.apiKeyEnv.description",
    default: "DEEPSEEK_API_KEY",
  },
  {
    // The child is given a minimal environment, so a deployment whose runtime
    // needs a host variable — a proxy setting, a CA bundle path — names it
    // rather than being handed everything this process holds.
    key: "envPassthrough",
    kind: "string-list",
    labelKey: "dsh.envPassthrough",
    descriptionKey: "dsh.envPassthrough.description",
  },
  {
    key: "maxTokens",
    kind: "integer",
    labelKey: "dsh.maxTokens",
  },
  {
    key: "requestTimeoutMs",
    kind: "integer",
    labelKey: "dsh.requestTimeoutMs",
    default: 300_000,
  },
];

/** The SDK surface this backend drives; injected so tests need no subprocess. */
export interface DshHarnessDriver {
  run(input: string, options: {
    sessionId: string;
    onNotification?: (notification: { method: string; params: Record<string, unknown> }) => void;
  }): Promise<{
    sessionId: string;
    finalResponse: string;
    events: readonly Record<string, unknown>[];
  }>;
  close(): Promise<void>;
}

/** Builds a driver for one run from the resolved configuration. */
export type DshDriverFactory = (
  config: Record<string, ConfigValue>,
  options: BackendRunOptions,
) => Promise<DshHarnessDriver>;

/** Read a string setting, or undefined when unset. */
function text(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Marker a finished tool call carries.
 *
 * `tool/result` is what a real runtime emits — a live transcript pairs one
 * `tool/call` with one `tool/result`. The earlier guess of `tool/end` matched
 * nothing, so every tool-using run reported zero completed calls and the host's
 * replay fence saw a turn that had touched nothing.
 */
const TOOL_COMPLETED_EVENT = "tool/result";

/**
 * Count the tool calls an event stream reports as finished.
 *
 * @param events - the run's session events in wire order.
 * @returns how many tool calls completed.
 */
function completedTools(events: readonly Record<string, unknown>[]): number {
  return events.filter((event) => (event.type ?? event.kind) === TOOL_COMPLETED_EVENT).length;
}

/**
 * Whether the runtime declared the turn finished.
 *
 * The smoke transcript ends `step/end` then `turn/end`, so its presence is the
 * runtime's own settlement statement rather than an inference from exit codes.
 *
 * @param events - the run's session events in wire order.
 * @returns true when the runtime emitted its turn-end marker.
 */
function sawTurnEnd(events: readonly Record<string, unknown>[]): boolean {
  return events.some((event) => (event.type ?? event.kind) === "turn/end");
}

/** Usage is not reported through the SDK's run result; zeros say so honestly. */
const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  turns: 1,
};

/**
 * Create the DeepSeek Harness backend.
 *
 * @param driverOf - builds the SDK driver; the default spawns a real runtime.
 * @returns the backend, ready for registration.
 */
export function createDshBackend(driverOf: DshDriverFactory): TeammateBackend {
  return {
    name: "dsh",
    protocolVersion: 1,
    capabilities: CAPABILITIES,
    // A dsh session has a stable id and accepts further prompts, so this
    // backend could resume an interrupted conversation. The host does not: its
    // failover starts a fresh attempt under a new correlation id, which opens a
    // new session and replays the prompt. The fence gates this backend exactly
    // as it gates Pi, and this declaration does not change that.
    recoveryShape: "in-context-continuation",
    configFields: CONFIG_FIELDS,

    resolveConfig(config: Record<string, ConfigValue>): ResolvedBackendConfig {
      const errors: string[] = [];
      for (const key of ["maxTokens", "requestTimeoutMs"]) {
        const value = config[key];
        if (value === undefined) continue;
        if (typeof value === "number" && value > 0) continue;
        errors.push(`"${key}" must be a positive number, got ${String(value)}`);
      }
      // The credential field names a lookup; a value that looks like a key
      // means someone pasted the secret into a field built to hold a name. The
      // rejected value is never quoted back: the likeliest reason it failed is
      // that it is the key, and this message reaches logs and transcripts.
      const apiKeyEnv = text(config, "apiKeyEnv");
      if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        errors.push(
          `"apiKeyEnv" names the environment variable holding the key, not the key itself; `
          + "the configured value is not a variable name",
        );
      }
      return { values: config, errors };
    },

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const startedAt = Date.now();
      // The task's own directory wins over the host base, and is resolved once
      // here so the driver never has to know a task-level cwd exists.
      const driver = await driverOf(options.config, {
        ...options,
        ...(spec.cwd === undefined ? {} : { baseCwd: spec.cwd }),
      });
      const sessionId = options.correlationId;
      const followUps: string[] = [];
      // abort() and both settlement paths all want the runtime gone. Closing
      // once and sharing the settlement keeps a second close from reporting
      // "unreaped" for a runtime the first close already reaped.
      let closing: Promise<void> | undefined;
      const closeOnce = (): Promise<void> => (closing ??= driver.close());
      // A message accepted after the last turn has settled would never be
      // delivered, so the window is tracked explicitly and `send` reports its
      // closure instead of returning a success the orchestrator cannot verify.
      let acceptingFollowUps = true;
      let aborted = false;

      const outcome = (async (): Promise<AttemptOutcome> => {
        const prompt = options.systemPrompt === undefined
          ? spec.task
          : `${options.systemPrompt}\n\n${spec.task}`;
        try {
          const observe = (notification: { method: string; params: Record<string, unknown> }): void => {
            if (notification.method !== "session.event") return;
            options.onChildEvent?.(notification.params);
          };
          // Every turn contributes: the host's replay fence reads the tool
          // count, so keeping only the final turn's would understate how much
          // work a retry would repeat.
          const turns: { finalResponse: string; events: readonly Record<string, unknown>[] }[] = [];
          turns.push(await driver.run(prompt, { sessionId, onNotification: observe }));
          // A follow-up queued while the turn was running is answered on the
          // same session, so the agent keeps its context instead of restarting.
          while (followUps.length > 0 && !aborted) {
            turns.push(await driver.run(followUps.shift()!, { sessionId, onNotification: observe }));
          }
          acceptingFollowUps = false;
          const toolCount = turns.reduce((sum, turn) => sum + completedTools(turn.events), 0);
          const lastTurn = turns[turns.length - 1]!;
          const result: SingleResult = {
            agent: spec.agent,
            ...(spec.name === undefined ? {} : { name: spec.name }),
            task: spec.task,
            exitCode: aborted ? 1 : 0,
            messages: turns.map((turn) => ({ role: "assistant", content: turn.finalResponse })),
            usage: NO_USAGE,
            model: text(options.config, "model") ?? spec.model ?? "",
            correlationId: options.correlationId,
            durationMs: Date.now() - startedAt,
            toolCount,
            // The session id stays addressable, so a later teammate-send can
            // reach this agent again.
            wakeable: !aborted,
            terminalStatus: aborted ? "terminated" : "completed",
          };
          options.onTurnComplete?.(result, result.terminalStatus);
          return {
            result,
            recovery: {
              settlementAuthority: sawTurnEnd(lastTurn.events) ? "authoritative" : "inferred",
              completedToolCount: result.toolCount ?? 0,
              inFlightToolCount: 0,
              preActivityInfrastructureExit: false,
              externalReplayRisk: false,
            },
            reclamation: closeOnce().then(
              () => ({ status: "reclaimed" as const }),
              (cause: unknown) => ({
                status: "unreaped" as const,
                reason: `dsh runtime close failed: ${String(cause)}`,
              }),
            ),
          };
        } catch (cause) {
          // A close() triggered by abort() makes the in-flight run reject, so
          // the failure path must read the abort flag too; otherwise the same
          // user action settles as "terminated" or "failed" depending on a race.
          acceptingFollowUps = false;
          const result: SingleResult = {
            agent: spec.agent,
            ...(spec.name === undefined ? {} : { name: spec.name }),
            task: spec.task,
            exitCode: 1,
            messages: [{
              role: "system",
              content: aborted ? `dsh run aborted: ${String(cause)}` : `dsh run failed: ${String(cause)}`,
            }],
            usage: NO_USAGE,
            model: text(options.config, "model") ?? spec.model ?? "",
            correlationId: options.correlationId,
            durationMs: Date.now() - startedAt,
            wakeable: false,
            terminalStatus: aborted ? "terminated" : "failed",
          };
          return {
            result,
            recovery: {
              settlementAuthority: "unknown",
              completedToolCount: 0,
              // A transport failure hides whatever the runtime already did, so
              // the host must treat the attempt's effects as unobserved.
              inFlightToolCount: 0,
              preActivityInfrastructureExit: false,
              externalReplayRisk: true,
            },
            reclamation: closeOnce().then(
              () => ({ status: "reclaimed" as const }),
              (closeCause: unknown) => ({
                status: "unreaped" as const,
                reason: `dsh runtime close failed after run failure: ${String(closeCause)}`,
              }),
            ),
          };
        }
      })();

      return {
        outcome,
        send(message: string, mode: ControlMode): boolean {
          // Mid-turn interruption has no wire representation here, so steering
          // is refused outright rather than delivered late under its name.
          if (mode === "steer") return false;
          if (aborted || !acceptingFollowUps) return false;
          followUps.push(message);
          return true;
        },
        abort(): void {
          aborted = true;
          void closeOnce().catch(() => {
            // Close failures surface through the reclamation outcome instead.
          });
        },
      };
    },
  };
}
