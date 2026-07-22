import { Type } from "typebox";
import type { WorkflowCoordinator } from "../session/coordinator.ts";

/** Read-only across both the native run-control tool and Maestro CLI aliases. */
export const RUN_CONTROL_READ_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "brief",
  "prepare",
  "check",
  "recall",
  "skill",
  "mutations",
  "list",
  "show",
]);
export const RUN_CONTROL_WRITE_ACTIONS = new Set(["next", "done", "edit"] as const);
export type RunControlAction = "status" | "brief" | "prepare" | "check" | "next" | "done" | "edit";

export function isRunControlReadAction(action: string): boolean {
  return RUN_CONTROL_READ_ACTIONS.has(action);
}

export const RunControlParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("brief"),
    Type.Literal("prepare"),
    Type.Literal("check"),
    Type.Literal("next"),
    Type.Literal("done"),
    Type.Literal("edit"),
  ], {
    description: "Operation to perform. Read: status, brief, prepare, check. Write: next, done, edit.",
  }),
  runId: Type.Optional(Type.String({
    description: "Run ID. Required for done; optional for brief/check, which default to the active Run.",
  })),
  step: Type.Optional(Type.String({
    description: "Workflow step or command to preview; required for prepare.",
  })),
  pick: Type.Optional(Type.String({
    description: "Optional pending chain-step selector for next.",
  })),
  verdict: Type.Optional(Type.Union([
    Type.Literal("done"),
    Type.Literal("done-with-concerns"),
    Type.Literal("needs-retry"),
    Type.Literal("blocked"),
  ], {
    description: "Completion verdict for done; defaults to done.",
  })),
  summary: Type.Optional(Type.String({ description: "Completion summary for done." })),
  reason: Type.Optional(Type.String({ description: "Completion reason for done." })),
  notes: Type.Optional(Type.Array(Type.String(), {
    description: "Completion notes for done; each item is forwarded as --note.",
  })),
  decisions: Type.Optional(Type.Array(Type.String(), {
    description: "Decision records for done; each item is forwarded as --decision.",
  })),
  evidence: Type.Optional(Type.Array(Type.String(), {
    description: "Evidence paths for done; each item is forwarded as --evidence.",
  })),
  artifacts: Type.Optional(Type.Array(Type.String(), {
    description: "Artifact paths for done; each item is forwarded as --artifact.",
  })),
  commands: Type.Optional(Type.Array(Type.String(), {
    description: "Commands to insert with edit. Supply one command for replace; omit when only removing a step.",
  })),
  after: Type.Optional(Type.String({
    description: "Insertion selector for edit: current, latest, start, a step ID, or an index; defaults to current.",
  })),
  replace: Type.Optional(Type.String({
    description: "Pending step ID to replace with the first edit command.",
  })),
  remove: Type.Optional(Type.String({
    description: "Pending step ID to remove by marking it skipped; commands may be omitted.",
  })),
  args: Type.Optional(Type.String({
    description: "Step arguments for edit; valid only when commands contains exactly one command.",
  })),
  stage: Type.Optional(Type.String({ description: "Optional stage label for an inserted edit step." })),
  goalRef: Type.Optional(Type.String({ description: "Optional goal reference for an inserted edit step." })),
  insertedBy: Type.Optional(Type.String({
    description: "Actor recorded for an inserted edit step; Maestro defaults to manual.",
  })),
});

export interface RunControlInput {
  action: RunControlAction;
  runId?: string;
  step?: string;
  pick?: string;
  verdict?: "done" | "done-with-concerns" | "needs-retry" | "blocked";
  summary?: string;
  reason?: string;
  notes?: string[];
  decisions?: string[];
  evidence?: string[];
  artifacts?: string[];
  commands?: string[];
  after?: string;
  replace?: string;
  remove?: string;
  args?: string;
  stage?: string;
  goalRef?: string;
  insertedBy?: string;
}

export interface RunControlResult {
  ok: boolean;
  action: RunControlAction;
  message: string;
  details?: unknown;
}

export async function executeRunControl(
  input: RunControlInput,
  coordinator: WorkflowCoordinator,
): Promise<RunControlResult> {
  try {
    switch (input.action) {
      case "status": {
        const snapshot = coordinator.status();
        return snapshot
          ? success(input.action, `${snapshot.source} snapshot ${snapshot.revision.fingerprint.slice(0, 12)}`, snapshot)
          : failure(input.action, "Coordinator is not attached; attach during session_start first");
      }
      case "brief": {
        const result = await coordinator.brief(input.runId);
        return success(input.action, result.stdout, result);
      }
      case "prepare": {
        const result = await coordinator.prepare(required(input.step, "step"));
        return success(input.action, result.stdout, result);
      }
      case "check": {
        const result = await coordinator.check(input.runId);
        return success(input.action, result.stdout, result);
      }
      case "next": {
        const result = await coordinator.next(input.pick);
        return success(input.action, result.command.stdout, result);
      }
      case "done": {
        const result = await coordinator.done(required(input.runId, "runId"), {
          verdict: input.verdict,
          summary: input.summary,
          reason: input.reason,
          notes: input.notes,
          decisions: input.decisions,
          evidence: input.evidence,
          artifacts: input.artifacts,
        });
        return success(input.action, result.command.stdout, result);
      }
      case "edit": {
        const result = await coordinator.edit(input.commands ?? [], {
          after: input.after,
          replace: input.replace,
          remove: input.remove,
          args: input.args,
          stage: input.stage,
          goalRef: input.goalRef,
          insertedBy: input.insertedBy,
        });
        return success(input.action, result.command.stdout, result);
      }
    }
  } catch (error) {
    return failure(input.action, error instanceof Error ? error.message : String(error));
  }
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this action`);
  return normalized;
}

function success(action: RunControlAction, message: string, details?: unknown): RunControlResult {
  return { ok: true, action, message, ...(details === undefined ? {} : { details }) };
}

function failure(action: RunControlAction, message: string): RunControlResult {
  return { ok: false, action, message };
}
