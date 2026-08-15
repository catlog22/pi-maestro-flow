/**
 * The Pi subprocess backend.
 *
 * Pi reaches the orchestrator through the same `TeammateBackend` contract every
 * other backend uses. It ships in this package because its implementation needs
 * this package's agent resolution, model routing, and child-extension wiring —
 * not because it is exempt. Living beside the orchestrator is not a bypass;
 * skipping the interface would be, and there is no path that does.
 */

import type {
  AttemptOutcome,
  AttemptReclamation,
  AttemptRecoveryFacts,
  BackendCapabilities,
  BackendConfigField,
  BackendRun,
  BackendRunOptions,
  ConfigValue,
  RecoveryShape,
  ResolvedBackendConfig,
  SettlementAuthority,
  TeammateBackend,
} from "pi-maestro-backend-core/v1";
import type { ControlMode, SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { Writable } from "node:stream";
import { resolveAgent } from "../agents/agents.ts";
import type { ReplyTarget } from "../shared/routing.ts";
import type { RunSingleTeammateParams, RunTeammateOptions } from "../runs/execution-infra.ts";
import {
  attemptReclamations,
  attemptRecoveryFacts,
  runSingleAttempt,
  sendRpcMessage,
  type AttemptSettlementCapability,
} from "../runs/pi-subprocess-attempt.ts";

/** Pi serves every orchestrator-requestable capability natively. */
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native",
  forkContext: "native",
  modelSelection: "native",
  thinkingLevel: "native",
  todoBinding: "native",
  toolFilter: "native",
  steer: "native",
  followUp: "native",
  abort: "native",
};

/**
 * Timing bounds the deployment may tune.
 *
 * These are per-runtime, not per-task: how long a Pi child may take to show
 * first activity says nothing about what the orchestrator asked for. They are
 * therefore configuration rather than capabilities or spec fields.
 */
const TUNABLE_KEYS = [
  "firstActivityTimeoutMs",
  "resultReadyGraceMs",
  "outputLimitRecoveryTimeoutMs",
  "structuredOutputRecoveryTimeoutMs",
  "toolExecutionHeartbeatMs",
  "interruptingSteerTimeoutMs",
  "foregroundMaxRunMs",
] as const satisfies readonly (keyof RunTeammateOptions)[];

type TunableKey = (typeof TUNABLE_KEYS)[number];

/**
 * Pi's own configuration fields.
 *
 * Exported so a settings shell renders the same list the backend validates
 * against. A host that restated them would drift the moment a tunable is added.
 */
export const PI_SUBPROCESS_CONFIG_FIELDS: readonly BackendConfigField[] = TUNABLE_KEYS.map((key) => ({
  key,
  kind: "integer",
  labelKey: `piSubprocess.${key}`,
}));

const CONFIG_FIELDS = PI_SUBPROCESS_CONFIG_FIELDS;

/**
 * Facts reported when an attempt settles without recording any.
 *
 * `unknown` settlement plus `externalReplayRisk` is the safe reading: the host's
 * replay fence blocks recovery rather than replaying work whose effects nobody
 * observed.
 */
const UNOBSERVED: AttemptRecoveryFacts = {
  settlementAuthority: "unknown",
  completedToolCount: 0,
  inFlightToolCount: 0,
  preActivityInfrastructureExit: false,
  externalReplayRisk: true,
};

/**
 * Translate Pi's internal settlement vocabulary to the contract's.
 *
 * The parameter is the closed union rather than `string`: widening it would
 * turn a new Pi marker into a silent `unknown`, which reads as "the attempt
 * observed nothing" and fences a failover that may not need fencing.
 *
 * @param capability - Pi's own settlement marker.
 * @returns how authoritatively the turn end was established.
 */
function settlementAuthorityOf(capability: AttemptSettlementCapability): SettlementAuthority {
  switch (capability) {
    case "agent_settled": return "authoritative";
    case "legacy": return "inferred";
    case "unknown": return "unknown";
    default: return assertNever(capability);
  }
}

/** Refuse to compile when a settlement marker is added without a mapping. */
function assertNever(value: never): never {
  throw new Error(`unhandled settlement capability: ${String(value)}`);
}

/**
 * Normalize Pi's child-process reclamation outcome.
 *
 * `forced` is dropped: the host's only decision is whether a stale runtime may
 * still deliver callbacks, and a forced-but-confirmed reclamation answers that
 * exactly as a graceful one does.
 *
 * @param outcome - the termination controller's bounded outcome, if any.
 * @returns the contract-shaped reclamation.
 */
function reclamationOf(outcome: unknown): AttemptReclamation {
  if (typeof outcome !== "object" || outcome === null) return { status: "reclaimed" };
  const shape = outcome as { status?: string; reason?: string };
  if (shape.status !== "unreaped") return { status: "reclaimed" };
  return { status: "unreaped", reason: shape.reason ?? "unspecified" };
}

/**
 * Read the facts an attempt recorded about itself.
 *
 * Exported so the legacy dispatch path yields the same shape as the backend
 * path: with both producing an outcome, the orchestrator reads recovery facts
 * from a value instead of from a side channel it can forget to consult.
 *
 * @param result - the settled result the attempt keyed its facts on.
 * @returns the settled attempt, in contract shape.
 */
export function outcomeOf(result: SingleResult): AttemptOutcome {
  const facts = attemptRecoveryFacts.get(result);
  const reclamation = attemptReclamations.get(result);
  return {
    result,
    recovery: facts === undefined
      ? UNOBSERVED
      : {
        settlementAuthority: settlementAuthorityOf(facts.settlementCapability),
        completedToolCount: facts.completedToolCount,
        inFlightToolCount: facts.inFlightToolCount,
        preActivityInfrastructureExit: facts.preActivityInfrastructureExit,
        externalReplayRisk: facts.externalReplayRisk,
      },
    reclamation: reclamation === undefined
      ? Promise.resolve<AttemptReclamation>({ status: "reclaimed" })
      : reclamation.then(reclamationOf),
  };
}

/** Per-run wiring the host supplies but the contract keeps out of the spec. */
export interface PiSubprocessRunExtras {
  /** Host-owned run options that are not orchestrator-visible requests. */
  hostOptions: RunTeammateOptions;
  /** Resolved task cwd; already absolute. */
  cwd: string;
  /**
   * Where this run's completion is delivered.
   *
   * Supplied by the host because it owns the routing decision and holds the
   * `reply_to` the spec does not carry. Recomputing it here from the spec would
   * see only `name`, so a task addressed to `main` would silently reply to its
   * caller on this path and to `main` on the legacy one.
   */
  replyTo: ReplyTarget;
}

/**
 * Build the Pi-native parameters for one attempt.
 *
 * Fields absent from `TeammateRunSpec` are host concerns already applied before
 * dispatch: `taskType` has been resolved into a model, `fallbackModels` is
 * sequenced by the host across attempts, and `background` is host scheduling.
 *
 * @param spec - the orchestrator's request.
 * @param cwd - the resolved task cwd.
 * @returns parameters in Pi's own shape.
 */
function paramsOf(spec: TeammateRunSpec, cwd: string): RunSingleTeammateParams {
  return {
    agent: spec.agent,
    task: spec.task,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.context === undefined ? {} : { context: spec.context }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
    ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
    ...(spec.todos === undefined ? {} : { todos: spec.todos }),
    cwd,
  };
}

/** Merge configured timing bounds over whatever the host already set. */
function withTunables(
  hostOptions: RunTeammateOptions,
  config: Record<string, ConfigValue>,
): RunTeammateOptions {
  const tuned: Partial<Record<TunableKey, number>> = {};
  for (const key of TUNABLE_KEYS) {
    const value = config[key];
    if (typeof value === "number") tuned[key] = value;
  }
  return { ...hostOptions, ...tuned };
}

/**
 * Create the Pi subprocess backend.
 *
 * @param extrasOf - supplies the per-run host wiring the contract does not carry.
 * @returns the backend, ready for registration.
 */
export function createPiSubprocessBackend(
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
): TeammateBackend {
  return {
    name: "pi-subprocess",
    protocolVersion: 1,
    capabilities: CAPABILITIES,
    // A failed Pi attempt is replaced by a fresh child that replays the original
    // prompt, so the host's side-effect fence governs its recovery.
    recoveryShape: "replay" satisfies RecoveryShape,
    configFields: CONFIG_FIELDS,

    resolveConfig(config: Record<string, ConfigValue>): ResolvedBackendConfig {
      const errors: string[] = [];
      for (const field of CONFIG_FIELDS) {
        const value = config[field.key];
        if (value === undefined) continue;
        if (typeof value === "number" && value > 0) continue;
        errors.push(`"${field.key}" must be a positive number of milliseconds, got ${String(value)}`);
      }
      return { values: config, errors };
    },

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const { hostOptions, cwd, replyTo } = extrasOf(spec, options);
      // Both overloads of resolveAgent take (string, string), so a swapped
      // argument order compiles cleanly and only fails at run time.
      const agentConfig = await resolveAgent(cwd, spec.agent);
      if (agentConfig === undefined) {
        throw new Error(`teammate backend "pi-subprocess" cannot resolve agent "${spec.agent}"`);
      }

      // The control channel only exists once the child is up; teammate-send
      // addresses a task by name and may arrive before then, so a pre-spawn
      // send reports failure rather than being silently dropped.
      let childStdin: Writable | undefined;
      const hostOnChildSpawned = hostOptions.onChildSpawned;
      const wired = withTunables(
        {
          ...hostOptions,
          onChildSpawned: (stdin, sendControl, sessionDir, correlationId, generation) => {
            childStdin = stdin;
            hostOnChildSpawned?.(stdin, sendControl, sessionDir, correlationId, generation);
          },
        },
        options.config,
      );

      const outcome = runSingleAttempt(
        paramsOf(spec, cwd),
        agentConfig,
        cwd,
        options.correlationId,
        replyTo,
        Date.now(),
        spec.model,
        wired,
      ).then(outcomeOf);

      return {
        outcome,
        send(message: string, mode: ControlMode): boolean {
          if (childStdin === undefined) return false;
          return sendRpcMessage(childStdin, message, mode);
        },
        abort(): void {
          if (childStdin === undefined) return;
          sendRpcMessage(childStdin, "", "abort");
        },
      };
    },
  };
}
