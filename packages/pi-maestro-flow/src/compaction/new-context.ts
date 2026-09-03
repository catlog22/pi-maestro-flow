import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeTodoResourceUris } from "../tools/todo-contract.ts";
import { getTodoCompactionSnapshot, type TodoTask } from "../tools/todo.ts";
import type {
  MaestroCompactionDetails,
  MaestroNewContextDetails,
  MaestroRecoveryState,
} from "./maestro-compaction.ts";
import type {
  CompactionArbiter,
  NewContextCompactionTrigger,
} from "./compaction-arbiter.ts";
import { requireNewContextCompactionEnabled } from "./compaction-settings.ts";

export const NEW_CONTEXT_MAX_BYTES = 32 * 1024;
export const NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES = 4 * 1024;
const CAPSULE_BODY_MAX_BYTES = NEW_CONTEXT_MAX_BYTES - 1_500;
const NEW_CONTEXT_INSTRUCTIONS = [
  "Perform the requested deterministic same-session context reset.",
  "Do not call a model to summarize the conversation.",
].join("\n");

/** Private child→root broker used to refresh the recovery capsule at settlement. */
export const NEW_CONTEXT_RECOVERY_BROKER_NAME = "maestro-new-context-recovery";

export interface NewContextScheduleInput {
  source: "todo-transition" | "tool";
  actorId: string;
  carryForward?: string;
  resourceUris?: readonly string[];
  /** Root-authorized shared state required when a child session owns the reset. */
  recoveryState?: MaestroRecoveryState;
}

export interface ScheduledNewContextRequest extends MaestroNewContextDetails {
  actorId: string;
  lifecycleGeneration: number;
  sessionId: string;
  todoRevision: number;
  recoveryState?: MaestroRecoveryState;
}

export interface NewContextScheduleReceipt {
  requestId: number;
  coalesced: boolean;
}

export type NewContextControllerContext = Pick<
  ExtensionContext,
  "cwd" | "sessionManager" | "compact" | "ui" | "hasPendingMessages"
>;

export interface NewContextController {
  onSessionStart(ctx: Pick<ExtensionContext, "sessionManager">): void;
  onSessionShutdown(): void;
  schedule(input: NewContextScheduleInput, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): NewContextScheduleReceipt;
  onAgentSettled(ctx: NewContextControllerContext): Promise<boolean>;
  /** Retry a deferred request only after the host proves the prior compaction settled. */
  onCompactionSettled(ctx: NewContextControllerContext): Promise<boolean>;
  consume(trigger: NewContextCompactionTrigger, ctx: Pick<ExtensionContext, "sessionManager">): ScheduledNewContextRequest | undefined;
  hasPending(): boolean;
}

export interface NewContextControllerOptions {
  continueAfterReset?: (
    ctx: Pick<ExtensionContext, "sessionManager" | "ui" | "hasPendingMessages">,
    request: ScheduledNewContextRequest,
  ) => void;
  /** Refresh root-authorized state immediately before a child reset owns a lease. */
  refreshRecoveryState?: (
    request: ScheduledNewContextRequest,
    ctx: NewContextControllerContext,
  ) => MaestroRecoveryState | undefined | Promise<MaestroRecoveryState | undefined>;
}

function sessionIdOf(ctx: Pick<ExtensionContext, "sessionManager">): string {
  const manager = ctx.sessionManager as {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  const sessionId = manager.getSessionId?.();
  if (sessionId) return sessionId;
  const sessionFile = manager.getSessionFile?.();
  return sessionFile ? `file:${sessionFile}` : "unknown-session";
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let output = "";
  for (const codePoint of value) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes + width > maxBytes) break;
    output += codePoint;
    bytes += width;
  }
  return output;
}

function normalizedCarryForward(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized, "utf8") > NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES) {
    throw new Error(`carryForward exceeds ${NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function mergeResourceUris(left: readonly string[], right: readonly string[]): string[] {
  return normalizeTodoResourceUris([...left, ...right]);
}

/** Session-local, generation-fenced scheduler. Requests are consumed only at agent_settled. */
export function createNewContextController(
  arbiter: CompactionArbiter,
  options: NewContextControllerOptions = {},
): NewContextController {
  let lifecycleGeneration = 0;
  let activeSessionId: string | undefined;
  let nextRequestId = 0;
  let pending: ScheduledNewContextRequest | undefined;
  let inFlight: ScheduledNewContextRequest | undefined;
  let settlingRequestId: number | undefined;
  let awaitingCompactionSettlement = false;
  let deferredNoticeKey: string | undefined;

  const reset = (sessionId?: string) => {
    lifecycleGeneration += 1;
    activeSessionId = sessionId;
    settlingRequestId = undefined;
    awaitingCompactionSettlement = false;
    deferredNoticeKey = undefined;
    pending = undefined;
    inFlight = undefined;
  };
  const continueAfterReset = (
    ctx: Pick<ExtensionContext, "sessionManager" | "ui" | "hasPendingMessages">,
    request: ScheduledNewContextRequest,
  ) => {
    if (ctx.hasPendingMessages?.()) return;
    try {
      options.continueAfterReset?.(ctx, request);
    } catch (error) {
      ctx.ui.notify(
        `New-context continuation could not be queued: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  };
  const isRequestLifecycleCurrent = (
    request: ScheduledNewContextRequest,
    ctx: Pick<ExtensionContext, "sessionManager">,
  ): boolean => request.lifecycleGeneration === lifecycleGeneration
    && request.sessionId === activeSessionId
    && request.sessionId === sessionIdOf(ctx);
  const isCurrentRequest = (
    request: ScheduledNewContextRequest,
    ctx: Pick<ExtensionContext, "sessionManager">,
  ): boolean => isRequestLifecycleCurrent(request, ctx)
    && pending?.requestId === request.requestId;
  const hasUniquePayload = (request: ScheduledNewContextRequest): boolean =>
    request.carryForward !== undefined || request.resourceUris.length > 0;
  const coalesceIntoEquivalentPlan = (
    request: ScheduledNewContextRequest,
    ctx: Pick<ExtensionContext, "ui">,
  ): boolean => {
    const trigger = arbiter.currentTrigger();
    if (arbiter.currentOwner() !== "plan-handoff"
      || trigger?.owner !== "plan-handoff"
      || trigger.reason !== "clean-context"
      || hasUniquePayload(request)) return false;
    pending = undefined;
    awaitingCompactionSettlement = false;
    deferredNoticeKey = undefined;
    ctx.ui.notify("New-context request was coalesced into the equivalent deterministic Plan context handoff.", "info");
    return true;
  };

  async function tryStart(ctx: NewContextControllerContext): Promise<boolean> {
    const request = pending;
    if (!request || inFlight || settlingRequestId !== undefined || awaitingCompactionSettlement) return false;
    const sessionId = sessionIdOf(ctx);
    if (request.lifecycleGeneration !== lifecycleGeneration
      || request.sessionId !== sessionId
      || activeSessionId !== sessionId
      || (!request.recoveryState && getTodoCompactionSnapshot().revision < request.todoRevision)) {
      pending = undefined;
      awaitingCompactionSettlement = false;
      ctx.ui.notify("New-context request was discarded because the session generation changed.", "warning");
      return false;
    }
    if (ctx.hasPendingMessages?.()) {
      pending = undefined;
      awaitingCompactionSettlement = false;
      deferredNoticeKey = undefined;
      ctx.ui.notify("New-context request was cancelled because a newer message is pending; continuing with the current context.", "info");
      return false;
    }
    try {
      requireNewContextCompactionEnabled(ctx.cwd);
    } catch (error) {
      pending = undefined;
      awaitingCompactionSettlement = false;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      continueAfterReset(ctx, request);
      return false;
    }

    const activeOwner = arbiter.currentOwner();
    if (activeOwner) {
      if (coalesceIntoEquivalentPlan(request, ctx)) return false;
      const noticeKey = `active:${activeOwner}`;
      if (deferredNoticeKey !== noticeKey) {
        deferredNoticeKey = noticeKey;
        const ownerLabel = activeOwner === "plan-handoff" ? "Plan" : activeOwner;
        ctx.ui.notify(
          `New-context request was deferred until the active ${ownerLabel} compaction settles; Todo state was preserved.`,
          "info",
        );
      }
      return false;
    }

    const tombstone = arbiter.timeoutTombstone();
    if (tombstone) {
      // Time alone cannot prove the timed-out host compaction stopped. Keep the
      // request pending until session_compact/session_compact_failed acknowledges settlement.
      awaitingCompactionSettlement = true;
      const noticeKey = "tombstone";
      if (deferredNoticeKey !== noticeKey) {
        deferredNoticeKey = noticeKey;
        ctx.ui.notify(
          `New-context request is waiting for a timed-out compaction to settle (~${Math.ceil(tombstone.remainingMs / 1000)}s hold left).`,
          "info",
        );
      }
      return false;
    }

    // Child sessions must not use the transition-time root snapshot. Refresh
    // immediately before the lease is acquired so the deterministic capsule
    // reflects all root mutations that occurred while the child was running.
    if (options.refreshRecoveryState) {
      settlingRequestId = request.requestId;
      try {
        const recoveryState = await options.refreshRecoveryState(request, ctx);
        if (!recoveryState) throw new Error("Root-authorized recovery state was unavailable");
        if (!isCurrentRequest(request, ctx)) return false;
        request.recoveryState = recoveryState;
        request.todoRevision = recoveryState.todo.revision;
      } catch (error) {
        if (isCurrentRequest(request, ctx)) {
          pending = undefined;
          awaitingCompactionSettlement = false;
          ctx.ui.notify(
            `New-context reset could not refresh root recovery state; continuing with the current context: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
          continueAfterReset(ctx, request);
        }
        return false;
      } finally {
        if (settlingRequestId === request.requestId) settlingRequestId = undefined;
      }
    }
    if (!isCurrentRequest(request, ctx)) return false;

    const trigger: NewContextCompactionTrigger = {
      owner: "new-context",
      requestId: request.requestId,
      source: request.source,
    };
    const lease = arbiter.request("new-context", trigger);
    if (!lease) {
      // The arbiter can become busy while the child/root snapshot refresh is
      // in flight. Preserve pending and classify the denial from the state
      // observed after the failed request; no transition is consumed here.
      const deniedOwner = arbiter.currentOwner();
      if (deniedOwner && coalesceIntoEquivalentPlan(request, ctx)) return false;
      const deniedTombstone = deniedOwner ? undefined : arbiter.timeoutTombstone();
      if (deniedTombstone) {
        awaitingCompactionSettlement = true;
        const noticeKey = "tombstone";
        if (deferredNoticeKey !== noticeKey) {
          deferredNoticeKey = noticeKey;
          ctx.ui.notify(
            `New-context request is waiting for a timed-out compaction to settle (~${Math.ceil(deniedTombstone.remainingMs / 1000)}s hold left).`,
            "info",
          );
        }
      } else if (deniedOwner) {
        const noticeKey = `active:${deniedOwner}`;
        if (deferredNoticeKey !== noticeKey) {
          deferredNoticeKey = noticeKey;
          const ownerLabel = deniedOwner === "plan-handoff" ? "Plan" : deniedOwner;
          ctx.ui.notify(
            `New-context request was deferred until the active ${ownerLabel} compaction settles; Todo state was preserved.`,
            "info",
          );
        }
      } else {
        ctx.ui.notify("New-context request could not acquire its compaction lease; Todo state was preserved.", "warning");
      }
      return false;
    }

    awaitingCompactionSettlement = false;
    deferredNoticeKey = undefined;
    // This is the sole pending→inFlight transition. Never clear pending before
    // arbiter.request succeeds: an active owner or tombstone must be retriable.
    pending = undefined;
    inFlight = request;
    try {
      ctx.compact({
        customInstructions: lease.tagInstructions(NEW_CONTEXT_INSTRUCTIONS),
        onComplete() {
          lease.release();
          if (request.lifecycleGeneration !== lifecycleGeneration
            || request.sessionId !== activeSessionId
            || request.sessionId !== sessionIdOf(ctx)
            || ctx.hasPendingMessages?.()) return;
          continueAfterReset(ctx, request);
        },
        onError(error) {
          if (inFlight?.requestId === request.requestId) inFlight = undefined;
          lease.release();
          if (!isRequestLifecycleCurrent(request, ctx)) return;
          ctx.ui.notify(`New-context reset failed; continuing with the current context: ${error.message}`, "warning");
          continueAfterReset(ctx, request);
        },
      });
      return true;
    } catch (error) {
      if (inFlight?.requestId === request.requestId) inFlight = undefined;
      lease.release();
      if (isRequestLifecycleCurrent(request, ctx)) {
        ctx.ui.notify(
          `New-context reset failed; continuing with the current context: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        continueAfterReset(ctx, request);
      }
      return false;
    }
  }

  return {
    onSessionStart(ctx) {
      reset(sessionIdOf(ctx));
    },

    onSessionShutdown() {
      reset();
    },

    schedule(input, ctx) {
      requireNewContextCompactionEnabled(ctx.cwd);
      const sessionId = sessionIdOf(ctx);
      if (!activeSessionId) activeSessionId = sessionId;
      if (activeSessionId !== sessionId) {
        throw new Error("New-context request belongs to a stale session generation");
      }
      const carryForward = normalizedCarryForward(input.carryForward);
      const resourceUris = normalizeTodoResourceUris(input.resourceUris);
      const todoRevision = input.recoveryState?.todo.revision ?? getTodoCompactionSnapshot().revision;
      if (pending) {
        if (pending.lifecycleGeneration !== lifecycleGeneration
          || pending.sessionId !== sessionId
          || pending.actorId !== input.actorId) {
          throw new Error("A new-context request from another actor or session generation is already pending");
        }
        pending.resourceUris = mergeResourceUris(pending.resourceUris, resourceUris);
        pending.todoRevision = todoRevision;
        if (input.recoveryState) pending.recoveryState = input.recoveryState;
        if (carryForward !== undefined) pending.carryForward = carryForward;
        return { requestId: pending.requestId, coalesced: true };
      }
      const requestId = ++nextRequestId;
      pending = {
        requestId,
        source: input.source,
        actorId: input.actorId,
        lifecycleGeneration,
        sessionId,
        todoRevision,
        ...(input.recoveryState ? { recoveryState: input.recoveryState } : {}),
        ...(carryForward ? { carryForward } : {}),
        resourceUris,
      };
      return { requestId, coalesced: false };
    },

    async onAgentSettled(ctx) {
      return tryStart(ctx);
    },

    async onCompactionSettled(ctx) {
      awaitingCompactionSettlement = false;
      return tryStart(ctx);
    },

    consume(trigger, ctx) {
      const request = inFlight;
      if (!request
        || trigger.requestId !== request.requestId
        || trigger.source !== request.source
        || request.lifecycleGeneration !== lifecycleGeneration
        || request.sessionId !== activeSessionId
        || request.sessionId !== sessionIdOf(ctx)) {
        return undefined;
      }
      inFlight = undefined;
      return {
        ...request,
        resourceUris: [...request.resourceUris],
      };
    },

    hasPending() {
      return pending !== undefined;
    },
  };
}

function statusCounts(tasks: TodoTask[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return ["in_progress", "pending", "blocked", "completed"]
    .map((status) => `${status}=${counts.get(status) ?? 0}`)
    .join(", ");
}

function taskOrder(left: TodoTask, right: TodoTask): number {
  const root = Number(right.assignee.id === "root") - Number(left.assignee.id === "root");
  return root || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function activeTaskIdentityBlock(task: TodoTask): string {
  const lines = [
    `- [#${boundedUtf8(task.id, 128)}] ${boundedUtf8(task.subject, 128)} (in_progress; assignee=${boundedUtf8(task.assignee.label || task.assignee.id, 128)})`,
  ];
  if (task.context) lines.push(`  next: ${boundedUtf8(task.context, 256)}`);
  if (task.resourceUris.length) lines.push(`  resource: ${boundedUtf8(task.resourceUris[0]!, 256)}`);
  return lines.join("\n");
}

function taskBlock(task: TodoTask, contextBytes: number, summaryBytes: number): string {
  const lines = [
    `- [#${boundedUtf8(task.id, 128)}] ${boundedUtf8(task.subject, 512)} (${task.status}; assignee=${boundedUtf8(task.assignee.label || task.assignee.id, 128)})`,
  ];
  if (task.context) lines.push(`  context: ${boundedUtf8(task.context, contextBytes)}`);
  if (task.summary) lines.push(`  summary: ${boundedUtf8(task.summary, summaryBytes)}`);
  if (task.blockedBy.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  if (task.goalId) lines.push(`  goalId: ${task.goalId}`);
  if (task.planHandoffKey) lines.push(`  planHandoffKey: ${task.planHandoffKey}`);
  if (task.skills.length) {
    lines.push(`  skills: ${task.skills.map((skill) => `${skill.name}:${skill.role}`).join(", ")}`);
  }
  const uris = task.resourceUris.slice(0, 8);
  if (uris.length) lines.push(`  resources: ${uris.map((uri) => boundedUtf8(uri, 512)).join(", ")}`);
  if (task.resourceUris.length > uris.length) lines.push(`  resourcesOmitted: ${task.resourceUris.length - uris.length}`);
  return lines.join("\n");
}

/** Build the non-model recovery capsule used as Pi's required non-empty compaction summary. */
export function buildNewContextRecoveryCapsule(details: MaestroCompactionDetails): string {
  const lines: string[] = [
    "<recovery_capsule version=\"2\">",
    "IMPORTANT:",
    "- This is the authoritative structured recovery state.",
    "- Continue from the active Todo's exact next action.",
    "- Use resource for listed URIs.",
    "- If a required current-session fact or URI is absent, use compact_history; do not guess.",
    "- Capsule: Maestro New Context Recovery Capsule v2; no model summary was generated.",
    "",
    "## Session",
    `- Session ID: ${boundedUtf8(details.sessionId, 512)}`,
    `- Checkpoint ID: ${boundedUtf8(details.checkpointId, 512)}`,
    `- Created At: ${details.createdAt}`,
    `- Todo: stateVersion=${details.todo.stateVersion}, revision=${details.todo.revision}, ${statusCounts(details.todo.tasks)}`,
  ];
  if (details.previousCheckpointId) lines.push(`- Previous Checkpoint: ${boundedUtf8(details.previousCheckpointId, 512)}`);
  if (details.workflow) {
    lines.push(`- Workflow Session: ${boundedUtf8(details.workflow.sessionId, 512)}`);
    lines.push(`- Workflow Run: ${boundedUtf8(details.workflow.runId, 512)}`);
    if (details.workflow.todoId) lines.push(`- Workflow Todo: ${boundedUtf8(details.workflow.todoId, 512)}`);
    if (details.workflow.nextAction) lines.push(`- Workflow Next Action: ${boundedUtf8(details.workflow.nextAction, 1024)}`);
  }

  const currentGoal = details.goal?.goals.find((goal) => goal.id === details.goal?.currentGoalId);
  if (currentGoal) {
    lines.push("", "## Goal");
    lines.push(`- ID: ${boundedUtf8(currentGoal.id, 512)}`);
    lines.push(`- Status: ${currentGoal.status}`);
    lines.push(`- Objective: ${boundedUtf8(currentGoal.objective, 2_048)}`);
    if (currentGoal.acceptance?.length) {
      lines.push("- Acceptance:");
      for (const criterion of currentGoal.acceptance.slice(0, 5)) lines.push(`  - ${boundedUtf8(criterion, 512)}`);
      if (currentGoal.acceptance.length > 5) lines.push(`  - [${currentGoal.acceptance.length - 5} omitted]`);
    }
  }

  if (details.plan) {
    lines.push("", "## Plan");
    lines.push(`- Mode: ${details.plan.mode}`);
    lines.push(`- Status: ${details.plan.status}`);
    lines.push(`- Revision: ${details.plan.revision}`);
    lines.push(`- Handoff Status: ${details.plan.handoffStatus}`);
    if (details.plan.handoffKey) lines.push(`- Handoff Key: ${boundedUtf8(details.plan.handoffKey, 512)}`);
    if (details.plan.path) lines.push(`- Reload Path: ${boundedUtf8(details.plan.path, 1_024)}`);
  }

  if (details.newContext?.carryForward) {
    lines.push("", "## Carry Forward", boundedUtf8(details.newContext.carryForward, NEW_CONTEXT_MAX_CARRY_FORWARD_BYTES));
  }

  const tasks = details.todo.tasks.filter((task) => task.status !== "deleted");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = tasks.filter((task) => task.status === "in_progress").sort(taskOrder);
  const runnable = tasks.filter((task) => task.status === "pending"
    && task.blockedBy.every((id) => byId.get(id)?.status === "completed")).sort(taskOrder);
  const blocked = tasks.filter((task) => task.status === "blocked").sort(taskOrder);
  const completed = tasks.filter((task) => task.status === "completed")
    .sort((left, right) => (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, 5);

  const omitted = {
    active: 0,
    runnable: 0,
    blocked: Math.max(0, blocked.length - 8),
    completed: Math.max(0, tasks.filter((task) => task.status === "completed").length - completed.length),
    transitionResources: 0,
    references: 0,
  };
  const appendSection = (title: string, entries: TodoTask[], contextBytes: number, summaryBytes: number) => {
    if (!entries.length) return;
    lines.push("", `## ${title}`);
    for (const [index, task] of entries.entries()) {
      let block = taskBlock(task, contextBytes, summaryBytes);
      if (title === "Active Todo Tasks") {
        const remainingIdentities = entries.slice(index + 1).map(activeTaskIdentityBlock);
        const keepsAllActiveIdentities = Buffer.byteLength(
          [...lines, block, ...remainingIdentities].join("\n"),
          "utf8",
        ) <= CAPSULE_BODY_MAX_BYTES;
        if (!keepsAllActiveIdentities) block = activeTaskIdentityBlock(task);
      }
      if (Buffer.byteLength([...lines, block].join("\n"), "utf8") > CAPSULE_BODY_MAX_BYTES) {
        if (title === "Active Todo Tasks") omitted.active += 1;
        else if (title === "Runnable Pending Frontier") omitted.runnable += 1;
        else if (title === "Blocked Todo Tasks") omitted.blocked += 1;
        else omitted.completed += 1;
        continue;
      }
      lines.push(block);
    }
  };
  appendSection("Active Todo Tasks", active, 2_048, 1_024);
  appendSection("Runnable Pending Frontier", runnable, 1_024, 512);
  appendSection("Blocked Todo Tasks", blocked.slice(0, 8), 512, 512);
  appendSection("Recently Completed", completed, 512, 1_024);

  if (details.newContext?.resourceUris.length) {
    lines.push("", "## Transition Resources");
    for (const uri of details.newContext.resourceUris) {
      const line = `- ${uri}`;
      if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > CAPSULE_BODY_MAX_BYTES) {
        omitted.transitionResources += 1;
        continue;
      }
      lines.push(line);
    }
  }

  const references = details.references
    .filter((reference) => reference.status === "active")
    .sort((left, right) => left.path.localeCompare(right.path));
  if (references.length) {
    lines.push("", "## Checkpoint Reference Lineage");
    const candidates = references.slice(0, 10);
    omitted.references = Math.max(0, references.length - candidates.length);
    for (const reference of candidates) {
      const line = `- ${boundedUtf8(reference.path, 1_024)} (${reference.role}; first=${boundedUtf8(reference.firstSeenCompaction, 256)}; last=${boundedUtf8(reference.lastConfirmedCompaction, 256)})`;
      if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > CAPSULE_BODY_MAX_BYTES) {
        omitted.references += 1;
        continue;
      }
      lines.push(line);
    }
  }

  lines.push(
    "",
    "## Omitted Counts",
    `- active=${omitted.active}, runnable=${omitted.runnable}, blocked=${omitted.blocked}, completed=${omitted.completed}, transitionResources=${omitted.transitionResources}, references=${omitted.references}`,
    "",
    "## Recovery Hint",
    "Use `todo list`/`todo get` for live task state. Use `compact_history` for bounded current-session recovery and `resource` for exact agent://, session://, pr://, issue://, skill://, or rule:// references.",
    "</recovery_capsule>",
  );

  const capsule = lines.join("\n").trim();
  if (Buffer.byteLength(capsule, "utf8") <= NEW_CONTEXT_MAX_BYTES) return capsule;
  const suffix = `\n[Capsule truncated at ${NEW_CONTEXT_MAX_BYTES} UTF-8 bytes]\n</recovery_capsule>`;
  return `${boundedUtf8(capsule.replace(/\n<\/recovery_capsule>$/, ""), NEW_CONTEXT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

export function newContextFirstKeptEntryId(request: Pick<ScheduledNewContextRequest, "lifecycleGeneration" | "requestId">): string {
  return `maestro-new-context-${request.lifecycleGeneration}-${request.requestId}`;
}
