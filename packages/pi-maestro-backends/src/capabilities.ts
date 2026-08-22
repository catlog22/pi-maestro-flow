/**
 * Capability adjudication: what one task needs, and whether its backend serves
 * it.
 *
 * Adjudication belongs to graph validation, not dispatch. A task declaring
 * `outputSchema` whose downstream sibling reads `{name.field}` would otherwise
 * burn a full model turn before the missing capability surfaced.
 */

import type {
  BackendCapabilities,
  CapabilityName,
  CapabilitySupport,
} from "pi-maestro-backend-core/v1/backend";
import type {
  CapabilityValidation,
  CapabilityVerdict,
  DegradableCapability,
} from "pi-maestro-backend-core/v1/registry";
import type { ControlMode, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";

/**
 * Capabilities whose absence degrades the run instead of rejecting the graph.
 *
 * Mirrors `DegradableCapability`; kept as a value here because adjudication
 * needs to test membership at runtime and the contract package holds no code.
 */
const DEGRADABLE: ReadonlySet<CapabilityName> = new Set<DegradableCapability>(["forkContext"]);

/**
 * One task as graph validation sees it, before any backend has been started.
 *
 * Carries only what the orchestrator has already decided. `steer` and
 * `followUp` are deliberately absent: a teammate-send arrives later, from the
 * model, and nothing at validation time can say whether one will. Requiring
 * them up front would reject every addressable task on a backend that cannot
 * steer, almost always for a message that never comes — so those two are
 * enforced where they are actually known, when the message is delivered and
 * the backend refuses it.
 */
export interface AdjudicatedTask {
  spec: TeammateRunSpec;
  name?: string;
}

/**
 * Derive the capabilities one task actually requires.
 *
 * Requirements come only from what the orchestrator asked for: a task that
 * never sets `outputSchema` does not require it, so a backend lacking it stays
 * eligible. The canonical `thinking: "off"` value means that no thinking
 * control was requested and therefore does not require `thinkingLevel`.
 * This keeps adjudication a pure function of orchestrator-visible input rather
 * than of backend inventory.
 *
 * @param task - the task under validation.
 * @returns the required capability names, in declaration order.
 */
export function requiredCapabilities(task: AdjudicatedTask): CapabilityName[] {
  const required: CapabilityName[] = [];
  if (task.spec.outputSchema !== undefined) required.push("outputSchema");
  if (task.spec.context === "fork") required.push("forkContext");
  if (task.spec.model !== undefined) required.push("modelSelection");
  if (task.spec.thinking !== undefined && task.spec.thinking !== "off") required.push("thinkingLevel");
  if (task.spec.todos !== undefined && task.spec.todos.length > 0) required.push("todoBinding");
  // `toolFilter`, `steer`, and `followUp` are absent by construction: no
  // orchestrator-visible field expresses the first, and the other two are not
  // knowable until a message is sent. See AdjudicatedTask.
  return required;
}

/**
 * Adjudicate one task against its resolved backend.
 *
 * @param task - the task under validation.
 * @param taskIndex - position in the graph, for diagnostics that must name it.
 * @param backendName - the resolved backend's name.
 * @param capabilities - that backend's declared capability table.
 * @returns the verdict, partitioned into rejecting, degrading, and emulated.
 */
export function adjudicateTask(
  task: AdjudicatedTask,
  taskIndex: number,
  backendName: string,
  capabilities: BackendCapabilities,
): CapabilityVerdict {
  const unsupported: CapabilityName[] = [];
  const degraded: DegradableCapability[] = [];
  const emulated: CapabilityName[] = [];

  for (const name of requiredCapabilities(task)) {
    const support: CapabilitySupport = capabilities[name];
    if (support === "native") continue;
    if (support === "emulated") emulated.push(name);
    else if (DEGRADABLE.has(name)) degraded.push(name as DegradableCapability);
    else unsupported.push(name);
  }

  return {
    taskIndex,
    ...(task.name === undefined ? {} : { taskName: task.name }),
    backendName,
    unsupported,
    degraded,
    emulated,
  };
}

/** Human-readable task label used in every diagnostic. */
function label(verdict: CapabilityVerdict): string {
  return verdict.taskName === undefined
    ? `task #${verdict.taskIndex + 1}`
    : `task #${verdict.taskIndex + 1} ("${verdict.taskName}")`;
}

/**
 * Adjudicate a whole graph.
 *
 * Every message names the task, the capability, and the backend, because the
 * operator's next action differs for each: reroute the task, drop the field, or
 * register a different backend.
 *
 * @param tasks - the graph's tasks in dispatch order.
 * @param backendOf - resolves each task's backend name and capability table.
 * @returns verdicts plus the rejecting errors and advisory warnings.
 */
export function validateBackendCapabilities(
  tasks: readonly AdjudicatedTask[],
  backendOf: (task: AdjudicatedTask, index: number) => { name: string; capabilities: BackendCapabilities },
): CapabilityValidation {
  const verdicts: CapabilityVerdict[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [index, task] of tasks.entries()) {
    const backend = backendOf(task, index);
    const verdict = adjudicateTask(task, index, backend.name, backend.capabilities);
    verdicts.push(verdict);

    for (const name of verdict.unsupported) {
      errors.push(`${label(verdict)} requires "${name}", which backend "${verdict.backendName}" does not support`);
    }
    for (const name of verdict.degraded) {
      warnings.push(
        `${label(verdict)} requested "${name}", which backend "${verdict.backendName}" cannot serve; `
        + "the task runs without it and the transcript records the degradation",
      );
    }
    for (const name of verdict.emulated) {
      warnings.push(`${label(verdict)} uses "${name}" emulated by backend "${verdict.backendName}"`);
    }
  }

  return { verdicts, errors, warnings };
}
