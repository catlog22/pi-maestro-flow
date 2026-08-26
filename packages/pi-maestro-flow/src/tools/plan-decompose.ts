import { Type, type Static } from "typebox";

export const PlanDecomposeParams = Type.Object({
  planHandoffKey: Type.String({
    minLength: 1,
    description: "Exact handoff key returned by approval of the current Plan",
  }),
}, { additionalProperties: false });

export type PlanDecomposeInput = Static<typeof PlanDecomposeParams>;

export interface PlanDecomposeContractInput {
  planHandoffKey: string;
  approvedPlanPath: string;
  approvedChecksum: string;
}

/** Build the decomposition prompt without reading or mutating runtime state. */
export function buildPlanDecomposeContract(input: PlanDecomposeContractInput): string {
  if (!input.planHandoffKey.trim()) throw new Error("planHandoffKey must not be blank");
  if (!input.approvedPlanPath.trim()) throw new Error("approvedPlanPath must not be blank");
  if (!input.approvedChecksum.trim()) throw new Error("approvedChecksum must not be blank");

  return [
    "The approved Plan is the planning artifact; decompose now converts it into the execution plan.",
    "The main/root flow performs this conversion itself — do not delegate the decomposition step to a planner, decomposer, teammate, or any subagent (the output, not this step, is what later gets delegated).",
    `Approved Plan source: ${input.approvedPlanPath}`,
    `Approved checksum: ${input.approvedChecksum}`,
    `Plan handoff key: ${input.planHandoffKey}`,
    "Read the immutable approved Plan and preserve every requirement, boundary, non-goal, risk, and acceptance condition.",
    "The execution plan is saved as one complete, topologically ordered Todo batch — this batch IS the execution plan and the authoritative persisted record (a simplified counterpart of Maestro's plan.json artifact + session.decomposition; no separate file is created).",
    "Save location: the Todo batch itself, persisted by the todo store on `todo create`. Do not write any additional plan.json, decomposition file, or session artifact.",
    "Naming: each task's `subject` is an outcome title (verb + object, e.g. 'Add retry guard to lease hasher'); the system-assigned todo id is the stable, addressable identity of that work unit (the simplified counterpart of Maestro's goal.id).",
    "DAG decomposition (a simplified, single-layer counterpart of Maestro's boundary_contract + decomposition.goals):",
    "- Produce one complete, topologically ordered Todo batch covering the whole approved Plan; no missing or duplicate outcomes.",
    "- Each task maps to one independent, agent-ready work unit with its own boundary and done-when condition.",
    "- Use `blockedBy` with zero-based indexes of earlier tasks in this exact batch to express dependencies and form a DAG; cycles and forward dependencies are forbidden.",
    "For each task:",
    "- subject is a concise outcome title; description is a short scope summary.",
    "- context is the executing agent's independent work document: a self-contained Markdown brief (approved source identity, objective, in-scope / out-of-scope boundary, files or symbols, exact implementation requirements, dependencies, acceptance criteria / done-when, focused verification, risks, and recovery) that lets a delegated agent execute the task without re-reading the original Plan.",
    "- blockedBy contains only zero-based indexes of earlier tasks in this exact batch.",
    "- goalId is optional and reserved for key tasks with an independently verifiable quality gate.",
    "Validate complete Plan coverage, unique outcomes, no cycles or forward dependencies, and explicit acceptance criteria / done-when in every context.",
    "Then call todo create exactly once with the complete tasks array and this top-level planHandoffKey:",
    "```json",
    JSON.stringify({
      action: "create",
      tasks: [
        {
          subject: "<first outcome>",
          description: "<scope summary>",
          context: "# <self-contained Markdown work document with acceptance criteria>",
        },
        {
          subject: "<dependent outcome>",
          description: "<scope summary>",
          context: "# <self-contained Markdown work document with acceptance criteria>",
          blockedBy: [0],
          goalId: "<optional existing Goal id>",
        },
      ],
      planHandoffKey: input.planHandoffKey,
    }, null, 2),
    "```",
    "The example is a shape, not a task count or dependency prescription. Replace it with the complete DAG derived from the approved Plan.",
    "plan-decompose is prompt-only: it has not created files, Todos, messages, or agents; the main flow creates the Todo batch in the next step.",
  ].join("\n");
}
