/**
 * The remote-workers backend: run one task on a configured remote target
 * through the host's remote worker manager.
 *
 * One registration serves one target, under the name `remote:<targetId>`, so a
 * task selects its target by naming that registration. The manager itself is
 * injected rather than imported: it lives in the host process, owns the SSH
 * connection and the Monitor term's ownership nonce, and a second instance
 * built here would open a second connection whose runs the host's own
 * observation surfaces could not see.
 *
 * Every capability verdict below is read off the two remote drivers'
 * declarations rather than inferred, and each is a function of the configured
 * `driver` alone:
 *
 * `steer` — the ACP driver refuses mid-turn injection outright, while the
 * Pi-RPC driver carries it on the wire, so the verdict differs per driver.
 * `outputSchema` — Pi-RPC has a structured-output field; ACP has none, so an
 * ACP registration serves it through the same prompt-append plus extraction
 * this package already uses for the dsh runtime, and records the emulation.
 * `modelSelection` and `thinkingLevel` — the remote start parameters carry
 * neither a model nor a thinking field, so neither can vary per task.
 * `todoBinding` — the host's `proxyToolCall` is an in-process closure and does
 * not cross SSH, so a task binding todos is refused before dispatch rather than
 * started with a tool it can never reach.
 * `forkContext` — semantically untransferable, as for every non-Pi backend.
 *
 * Streaming, tool events, and usage reporting are deliberately absent from that
 * list. None of them is named by a `TaskSpec` field or a teammate-send mode, so
 * none is a capability: they are run-level facts, and a target that reports none
 * of them is dispatched rather than refused.
 *
 * What the fold does with under-reported tool activity is a known gap, not a
 * protection: `foldRemoteOutcome` derives settlement authority and replay risk
 * from the final `run/result` alone, and tool events feed only the counts. A
 * target that did real work but reported no tool event therefore folds into a
 * run that reads as tool-free and authoritative, which the host's replay fence
 * clears as having nothing to repeat. Both remote drivers do report tool events,
 * so this bites only a target whose agent under-reports them.
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
  CapabilityDelivery,
  ControlMode,
  TeammateRunSpec,
} from "pi-maestro-backend-core/v1/spec";
import {
  resolveStructuredOutput,
  structuredOutputInstruction,
} from "../dsh/structured-output.ts";
import { foldRemoteOutcome } from "./outcome.ts";
import type {
  RemoteDriverId,
  RemoteInputMode,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteWorkerManagerLike,
} from "./types.ts";

/** Supplies the host's manager at the moment a run starts. */
export type RemoteManagerFactory = () => RemoteWorkerManagerLike;

const CONFIG_FIELDS: readonly BackendConfigField[] = [
  {
    key: "targetId",
    kind: "text",
    labelKey: "remoteWorkers.targetId",
    descriptionKey: "remoteWorkers.targetId.description",
    required: true,
  },
  {
    key: "driver",
    kind: "enum",
    labelKey: "remoteWorkers.driver",
    descriptionKey: "remoteWorkers.driver.description",
    required: true,
    options: [
      { value: "pi-rpc", labelKey: "remoteWorkers.driver.piRpc" },
      { value: "acp", labelKey: "remoteWorkers.driver.acp" },
    ],
  },
];

/** Read a string setting, or undefined when unset. */
function text(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The capability table this registration's driver supports.
 *
 * A pure function of the argument, as the seam requires: the driver is a
 * declared configuration field precisely so this never has to read the remote
 * configuration file to answer.
 *
 * @param config - this registration's validated config.
 * @returns the capability table.
 */
function capabilitiesOf(config: Record<string, ConfigValue>): BackendCapabilities {
  const driver = config.driver === "acp" ? "acp" : "pi-rpc";
  return {
    outputSchema: driver === "acp" ? "emulated" : "native",
    forkContext: "unsupported",
    modelSelection: "unsupported",
    thinkingLevel: "unsupported",
    todoBinding: "unsupported",
    toolFilter: "unsupported",
    steer: driver === "acp" ? "unsupported" : "native",
    followUp: "native",
    abort: "native",
  };
}

/**
 * Create the remote-workers backend for one registration.
 *
 * @param managerOf - yields the host's remote worker manager; called per run so
 * a host that has not entered Monitor mode fails at dispatch rather than at
 * registration.
 * @returns the backend, ready for registration under `remote:<targetId>`.
 */
export function createRemoteBackend(managerOf: RemoteManagerFactory): TeammateBackend {
  return {
    name: "remote-workers",
    protocolVersion: 1,
    capabilities: capabilitiesOf,
    // A remote run keeps its own session and could take a further prompt in
    // place. The host's failover still starts a fresh attempt under a new
    // correlation id, so this stays descriptive and clears no fence.
    recoveryShape: "in-context-continuation",
    configFields: CONFIG_FIELDS,

    resolveConfig(config: Record<string, ConfigValue>): ResolvedBackendConfig {
      const errors: string[] = [];
      const targetId = text(config, "targetId");
      if (targetId === undefined || targetId.length === 0) {
        errors.push(`"targetId" must name a configured remote target`);
      }
      const driver = config.driver;
      if (driver !== "pi-rpc" && driver !== "acp") {
        errors.push(`"driver" must be "pi-rpc" or "acp", got ${String(config.driver)}`);
      }
      return { values: config, errors };
    },

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const startedAt = Date.now();
      const manager = managerOf();
      const targetId = text(options.config, "targetId") ?? "";
      const driver: RemoteDriverId = options.config.driver === "acp" ? "acp" : "pi-rpc";
      // A registration that names one driver while the remote configuration
      // resolves another produces a capability table about a target it does not
      // describe: adjudication would pass a steering task to an ACP target that
      // cannot steer. Both values are named so an operator can see which side to
      // change.
      const actual = manager.resolveTargetDriver(targetId);
      if (actual !== driver) {
        throw new Error(
          `remote backend registration for target "${targetId}" declares driver `
          + `"${String(options.config.driver)}", but the remote configuration resolves that target `
          + `to driver "${actual}"`,
        );
      }

      const deliveries: CapabilityDelivery[] = [];
      let promptNormalized = false;
      /**
       * Record the one-per-run note that a `prompt` message was normalized.
       *
       * The member name is the real capability the normalization degrades —
       * `prompt` is not a `BackendCapabilities` member and inventing one would
       * put a name in the result that no adjudication can ever read.
       */
      const recordPromptNormalization = (): void => {
        if (promptNormalized) return;
        promptNormalized = true;
        deliveries.push({
          capability: "followUp",
          support: "emulated",
          note: 'ControlMode "prompt" has no remote wire mode; delivered as follow_up',
        });
      };

      const base = options.systemPrompt === undefined
        ? spec.task
        : `${options.systemPrompt}\n\n${spec.task}`;
      const objective = driver === "acp" && spec.outputSchema !== undefined
        ? `${base}\n${structuredOutputInstruction(spec.outputSchema)}`
        : base;

      // Collected outside the outcome closure because the listener that fills
      // it is attached by `start` itself: the manager replays a worker's
      // buffered notifications while admitting the run, so a listener the
      // backend attached from the returned capture would already be too late.
      const events: RemoteRunEvent[] = [];
      const { capture, unsubscribe } = await manager.start({
        targetId,
        name: spec.name ?? spec.agent,
        objective,
        ...(driver === "pi-rpc" && spec.outputSchema !== undefined
          ? { outputSchema: spec.outputSchema }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }, (event) => {
        events.push(event);
        options.onChildEvent?.({ ...event });
      });

      let settled = false;
      let aborted = false;
      // The first turn, plus one per delivered message. `send` increments it
      // while the run is still open, so the fold reports what the run cost
      // rather than what its first turn cost.
      let turns = 1;

      const outcome = (async (): Promise<AttemptOutcome> => {
        let snapshot: RemoteRunSnapshot;
        let disconnectedBeforeResult = false;
        try {
          snapshot = await manager.wait(capture, {
            ...(options.signal ? { signal: options.signal } : {}),
          });
          // A wait that settles leaves the channel intact, so the flag stays
          // false even when no `run/result` arrived. The fold still answers
          // `unreaped` in that case — it reads the absent result from `events`
          // — and the flag is what lets it say the channel is why, rather than
          // reporting a dropped connection on a channel that never dropped.
        } catch {
          // The manager closed, the run was aborted, or the wait timed out.
          // Which one does not change the fact the fold needs: this channel
          // stopped answering before any terminal result reached it.
          disconnectedBeforeResult = true;
          try {
            snapshot = manager.snapshot(capture);
          } catch {
            // The manager disowned the run along with the connection, so the
            // last thing known about it is its identity.
            snapshot = {
              workerId: capture.workerId,
              instanceNonce: capture.instanceNonce,
              runId: capture.runId,
              generation: capture.generation,
              targetId: capture.targetId,
              status: "lost",
              lastSequence: 0,
              updatedAt: startedAt,
            };
          }
        } finally {
          settled = true;
          unsubscribe();
        }

        const folded = foldRemoteOutcome({
          spec,
          correlationId: options.correlationId,
          // The remote protocol carries no model field, so there is no route
          // by which a task's model could have reached the target.
          model: "",
          events,
          snapshot,
          startedAt,
          settledAt: Date.now(),
          turns,
          disconnectedBeforeResult,
          ...(deliveries.length > 0 ? { capabilityDeliveries: deliveries } : {}),
        });
        // Emulated structured output, for a driver with no wire contract for
        // it: the schema went into the objective, so the value comes back out
        // of the final message and is recorded as emulated rather than passing
        // for a native one.
        if (driver === "acp" && spec.outputSchema !== undefined) {
          const finalText = folded.result.messages.at(-1)?.content ?? "";
          const structured = resolveStructuredOutput(finalText, spec.outputSchema);
          if (structured.status === "valid") {
            folded.result.structuredOutput = structured.value;
            folded.result.capabilityDeliveries = [
              ...(folded.result.capabilityDeliveries ?? []),
              {
                capability: "outputSchema",
                support: "emulated",
                note: "acp targets have no structured-output wire contract; the schema was appended "
                  + "to the objective and the value extracted from the final message",
              },
            ];
          }
        }
        options.onTurnComplete?.(folded.result, folded.result.terminalStatus);
        return folded;
      })();

      return {
        outcome,
        /**
         * Queue one control message for the remote run.
         *
         * Synchronous and optimistic, rather than widening the shared seam to
         * `boolean | Promise<boolean>`. Three reasons: the seam's zero-change
         * property is what keeps the two existing backends untouched, and
         * relaxing it for one consumer would move every host call site; the
         * contract's own wording for this return value is that returning false
         * is how a backend declines a message the host would otherwise report
         * as delivered, not that the model consumed it — the dsh backend is
         * already optimistic in exactly this shape; and the remote's own
         * three-state receipt is not lost, because it reaches the host through
         * `onProgress`, where the "queued is not consumed" reminder reads it.
         *
         * @param message - the text to deliver.
         * @param mode - what the orchestrator asked for.
         * @returns false when this run can no longer take the message.
         */
        send(message: string, mode: ControlMode): boolean {
          if (settled || aborted) return false;
          // Declared `unsupported` for this driver, so refusing here is what
          // that declaration means; delivering it late under its own name would
          // be the silent degradation the table exists to prevent.
          if (mode === "steer" && driver === "acp") return false;
          const remoteMode: RemoteInputMode = mode === "steer" ? "steer" : "follow_up";
          if (mode === "prompt") recordPromptNormalization();
          turns += 1;
          void manager.send(capture, remoteMode, message).then(
            (receipt) => options.onProgress?.({
              status: "running",
              lastMessage: `remote input receipt: ${receipt.receipt} `
                + `(mode=${receipt.effectiveMode}, accepted=${receipt.accepted})`,
            }),
            // Never swallowed: this is the only place a rejected delivery can
            // still be reported, because the return value already said true.
            (cause: unknown) => options.onProgress?.({
              status: "running",
              lastMessage: `remote input failed: ${String(cause)}`,
            }),
          );
          return true;
        },
        abort(): void {
          aborted = true;
          void manager.cancel(capture, "host abort").catch(() => {
            // A cancel the remote never confirmed surfaces through the
            // reclamation verdict, which is where the host's failover reads it.
          });
        },
      };
    },
  };
}
