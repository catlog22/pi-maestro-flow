import { Type } from "typebox";
import {
  publicWorkflowErrorMessage,
  type WorkflowCoordinator,
  type WorkflowLeaseOwnership,
} from "../session/coordinator.ts";

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
    description: "Workflow step or command to preview (e.g. \"implement\", \"verify\"); required for prepare.",
  })),
  pick: Type.Optional(Type.String({
    description: "Pending chain-step selector for next: a step ID (e.g. \"step-2\") or a command name (e.g. \"implement\"). Omit to take the default next step.",
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
    description: "Insertion point for edit: \"current\" (after active step), \"latest\", \"start\", a step ID (e.g. \"step-3\"), or a numeric index. Defaults to \"current\".",
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
}, { additionalProperties: false });

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

export interface RunControlExecutionContext {
  hostSessionId: string;
}

export async function executeRunControl(
  input: RunControlInput,
  coordinator: WorkflowCoordinator,
  context?: RunControlExecutionContext,
): Promise<RunControlResult> {
  try {
    const hostSessionId = context?.hostSessionId?.trim();
    switch (input.action) {
      case "status": {
        const snapshot = coordinator.status();
        if (!snapshot) return failure(input.action, "Coordinator is not attached; attach during session_start first");
        const ownership = hostSessionId ? await coordinator.ownership(hostSessionId) : undefined;
        return success(
          input.action,
          statusMessage(`${snapshot.source} snapshot ${snapshot.revision.fingerprint.slice(0, 12)}`, ownership),
          attributed(snapshot, ownership),
        );
      }
      case "brief": {
        const result = await coordinator.brief(input.runId);
        const ownership = hostSessionId ? await coordinator.ownership(hostSessionId) : undefined;
        return success(input.action, readMessage(result.stdout, ownership), attributed(result, ownership));
      }
      case "prepare": {
        const result = await coordinator.prepare(required(input.step, "step"));
        const ownership = hostSessionId ? await coordinator.ownership(hostSessionId) : undefined;
        return success(input.action, readMessage(result.stdout, ownership), attributed(result, ownership));
      }
      case "check": {
        const result = await coordinator.check(input.runId);
        const ownership = hostSessionId ? await coordinator.ownership(hostSessionId) : undefined;
        return success(input.action, readMessage(result.stdout, ownership), attributed(result, ownership));
      }
      case "next": {
        const currentHostSessionId = required(hostSessionId, "hostSessionId");
        const result = await coordinator.next(input.pick, { hostSessionId: currentHostSessionId });
        return success(input.action, result.command.stdout, result);
      }
      case "done": {
        const currentHostSessionId = required(hostSessionId, "hostSessionId");
        const result = await coordinator.done(required(input.runId, "runId"), {
          verdict: input.verdict,
          summary: input.summary,
          reason: input.reason,
          notes: input.notes,
          decisions: input.decisions,
          evidence: input.evidence,
          artifacts: input.artifacts,
        }, { hostSessionId: currentHostSessionId });
        return success(input.action, result.command.stdout, result);
      }
      case "edit": {
        const currentHostSessionId = required(hostSessionId, "hostSessionId");
        const result = await coordinator.edit(input.commands ?? [], {
          after: input.after,
          replace: input.replace,
          remove: input.remove,
          args: input.args,
          stage: input.stage,
          goalRef: input.goalRef,
          insertedBy: input.insertedBy,
        }, { hostSessionId: currentHostSessionId });
        return success(input.action, result.command.stdout, result);
      }
    }
  } catch (error) {
    return failure(input.action, publicWorkflowErrorMessage(error));
  }
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this action`);
  return normalized;
}

function attributed<T extends object>(
  details: T,
  ownership: WorkflowLeaseOwnership | undefined,
): T & { ownership?: WorkflowLeaseOwnership } {
  return ownership ? { ...details, ownership } : details;
}

function statusMessage(message: string, ownership: WorkflowLeaseOwnership | undefined): string {
  return ownership ? `${message}; ${ownershipSummary(ownership)}` : message;
}

function readMessage(message: string, ownership: WorkflowLeaseOwnership | undefined): string {
  const notice = ownership ? readOwnershipNotice(ownership) : undefined;
  return notice ? `${notice}\n${message}` : message;
}

function ownershipSummary(ownership: WorkflowLeaseOwnership): string {
  if (ownership.state === "unowned") return "workflow mutation lease is unowned";
  const owner = ownership.ownerHostSessionId ?? "unknown";
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const relation = ownership.isOwner
    ? ownership.isAttached ? "this Pi session owns" : "this Pi session is recorded as owner of"
    : `Pi session ${owner} owns`;
  return `${relation} the ${freshness} mutation lease `
    + `(epoch ${ownership.epoch}, heartbeat ${ownership.heartbeatAt})`;
}

function readOwnershipNotice(ownership: WorkflowLeaseOwnership): string | undefined {
  if (ownership.state === "owned" && ownership.isOwner && ownership.isAttached) return undefined;
  if (ownership.state === "unowned") {
    return `Read-only view: Workflow Session ${ownership.sessionId} has no mutation lease owner.`;
  }
  if (ownership.isOwner) {
    return `Read-only view: Pi session ${ownership.currentHostSessionId} is recorded as the `
      + `${ownership.state} lease owner, but this coordinator is not attached.`;
  }
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const article = freshness === "active" ? "an" : "a";
  return `Read-only view: Workflow Session ${ownership.sessionId} has ${article} ${freshness} mutation lease `
    + `owned by Pi session ${ownership.ownerHostSessionId}.`;
}

function success(action: RunControlAction, message: string, details?: unknown): RunControlResult {
  return { ok: true, action, message, ...(details === undefined ? {} : { details }) };
}

function failure(action: RunControlAction, message: string): RunControlResult {
  return { ok: false, action, message };
}
