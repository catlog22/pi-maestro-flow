/**
 * The Pi subprocess backend.
 *
 * Pi reaches the orchestrator through the same `TeammateBackend` contract every
 * other backend uses. It ships in this package because its implementation needs
 * this package's agent resolution, model routing, and child-extension wiring —
 * not because it is exempt. Living beside the orchestrator is not a bypass;
 * skipping the interface would be, and there is no path that does.
 */
import type { AttemptOutcome, BackendConfigField, BackendRunOptions, TeammateBackend } from "pi-maestro-backend-core/v1";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { ReplyTarget } from "../shared/routing.ts";
import type { RunTeammateOptions } from "../runs/execution-infra.ts";
/**
 * Pi's own configuration fields.
 *
 * Exported so a settings shell renders the same list the backend validates
 * against. A host that restated them would drift the moment a tunable is added.
 */
export declare const PI_SUBPROCESS_CONFIG_FIELDS: readonly BackendConfigField[];
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
export declare function outcomeOf(result: SingleResult): AttemptOutcome;
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
 * Create the Pi subprocess backend.
 *
 * @param extrasOf - supplies the per-run host wiring the contract does not carry.
 * @returns the backend, ready for registration.
 */
export declare function createPiSubprocessBackend(extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras): TeammateBackend;
