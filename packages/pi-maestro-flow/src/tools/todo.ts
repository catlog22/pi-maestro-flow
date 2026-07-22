import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getActiveGoal } from "./goal.ts";
import {
  TodoSkillLoader,
  type TodoSkillConfig,
} from "../skills/skill-loader.ts";
import {
  composeSkillBindings,
  type LoadedTodoSkillBinding,
  type TodoSkillBinding,
  type TodoSkillRole,
} from "../skills/skill-composer.ts";
import {
  SkillRuntime,
  type SkillActivation,
  type SkillActivationBindingMetadata,
  type SkillActivationMetadata,
} from "../skills/skill-runtime.ts";
import {
  todoOriginKey,
  type TodoMirrorTaskSpec,
  type TodoTaskOrigin,
} from "../session/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "deleted";

export interface TodoActorRef {
  kind: "root" | "teammate";
  id: string;
  label: string;
  agentType?: string;
}

export const ROOT_TODO_ACTOR: TodoActorRef = {
  kind: "root",
  id: "root",
  label: "root",
};

export type { TodoSkillBinding, TodoSkillRole } from "../skills/skill-composer.ts";

export interface TodoTask {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  context?: string;
  skills: TodoSkillBinding[];
  skillActivation?: SkillActivationMetadata;
  summary?: string;
  origin?: TodoTaskOrigin;
  planHandoffKey?: string;
  createdBy: TodoActorRef;
  assignee: TodoActorRef;
  createdAt: number;
  updatedAt: number;
}

export interface TodoParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear" | "next";
  subject?: string;
  description?: string;
  status?: TaskStatus;
  blockedBy?: string[];
  context?: string;
  skills?: TodoSkillBinding[] | null;
  summary?: string;
  id?: string;
  assignee?: string;
  filter?: { status?: TaskStatus; memberId?: string };
  planHandoffKey?: string;
}

type TodoParamsInput = TodoParams & {
  /** Legacy single-skill input accepted only at the tool normalization boundary. */
  skill?: TodoSkillConfig | null;
};

export interface InjectableContent {
  taskId: string;
  subject: string;
  description?: string;
  goalContext?: string;
  context?: string;
  skills: LoadedTodoSkillBinding[];
  blocks: Array<{ tag: string; content: string }>;
}

export interface TodoResultDetails {
  action: string;
  tasks: TodoTask[];
  error?: string;
}

export interface TodoCompactionSnapshot {
  stateVersion: number;
  revision: number;
  activeTaskId?: string;
  tasks: TodoTask[];
}

export interface TodoMirrorReconcileResult {
  created: string[];
  updated: string[];
  tombstoned: string[];
  unchanged: string[];
}

export interface TodoContext {
  cwd: string;
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
  };
  sessionManager?: unknown;
  skillLoader?: TodoSkillLoader;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const TODO_STATE_ENTRY_TYPE = "todo-state";
const TODO_STATE_VERSION = 5;

let tasks: Map<string, TodoTask> = new Map();
let knownActors: Map<string, TodoActorRef> = new Map([[ROOT_TODO_ACTOR.id, ROOT_TODO_ACTOR]]);
let extensionApi: ExtensionAPI | undefined;
let skillLoader: TodoSkillLoader | undefined;
let skillRuntime: SkillRuntime | undefined;
let activeSkillSnapshots: Map<string, SkillActivation> = new Map();
let runInjectedStackRevision: string | undefined;
let todoRevision = 0;
let todoGeneration = 0;
let todoMutationQueue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

export function onSessionStart(ctx: TodoContext): void {
  todoGeneration++;
  todoMutationQueue = Promise.resolve();
  skillLoader = ctx.skillLoader ?? new TodoSkillLoader({ cwd: ctx.cwd });
  skillRuntime = new SkillRuntime(skillLoader);
  activeSkillSnapshots = new Map();
  runInjectedStackRevision = undefined;
  tasks = loadTasksFromSession(ctx);
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  for (const task of tasks.values()) {
    rememberActor(task.createdBy);
    rememberActor(task.assignee);
  }
  markTodoChanged();
  ctx.ui.setStatus("todo", undefined);
}

export function onSessionShutdown(ctx: TodoContext): void {
  todoGeneration++;
  todoMutationQueue = Promise.resolve();
  tasks.clear();
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  skillLoader = undefined;
  skillRuntime = undefined;
  activeSkillSnapshots.clear();
  runInjectedStackRevision = undefined;
  markTodoChanged();
  ctx.ui.setStatus("todo", undefined);
}

export function getVisibleTasks(): TodoTask[] {
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
  visible.sort((a, b) => a.createdAt - b.createdAt);
  return visible;
}

export function getTodoActors(): TodoActorRef[] {
  return [...knownActors.values()].map(cloneActor).sort((left, right) =>
    left.kind === right.kind ? left.label.localeCompare(right.label) : left.kind === "root" ? -1 : 1
  );
}

export function registerTodoActor(actor: TodoActorRef): void {
  rememberActor(actor);
}

export function formatTodoActorSelector(
  actor: { id: string; label: string },
  actors: readonly { id: string; label: string }[],
): string {
  const collidingIds = new Set(actors
    .filter((candidate) => candidate.label === actor.label)
    .map((candidate) => candidate.id));
  if (collidingIds.size < 2) return actor.label;
  for (let length = Math.min(4, actor.id.length); length < actor.id.length; length++) {
    const prefix = actor.id.slice(0, length);
    if ([...collidingIds].every((candidate) => candidate === actor.id || !candidate.startsWith(prefix))) {
      return `${actor.label}#${prefix}`;
    }
  }
  return `${actor.label}#${actor.id}`;
}

/**
 * Internal projection boundary. Canonical Session/Run state is authoritative;
 * this function never writes canonical files and is intentionally not exposed
 * as a public Todo tool action.
 */
export function reconcileMirrorTasks(
  specs: readonly TodoMirrorTaskSpec[],
  ctx: ExtensionContext,
  sessionGeneration?: string,
): TodoMirrorReconcileResult {
  const activeSpecs = specs.filter((spec) => spec.status === "in_progress");
  if (activeSpecs.length > 1) {
    throw new Error(`Canonical projection has ${activeSpecs.length} active Todo tasks; expected at most one`);
  }

  const result: TodoMirrorReconcileResult = { created: [], updated: [], tombstoned: [], unchanged: [] };
  const nextTasks = cloneTaskMap();
  const skillSnapshotsToClear = new Set<string>();
  const existingByOrigin = new Map<string, TodoTask>();
  for (const task of nextTasks.values()) {
    if (task.origin) existingByOrigin.set(todoOriginKey(task.origin), task);
  }

  const projectedSpecs = specs.map((spec) => {
    const origin = sessionGeneration === undefined
      ? { ...spec.origin }
      : { ...spec.origin, sessionGeneration };
    return { spec, origin, sourceOriginKey: todoOriginKey(spec.origin) };
  });
  const idsByOrigin = new Map<string, string>();
  const idsByOriginReference = new Map<string, string>();
  for (const projected of projectedSpecs) {
    const key = todoOriginKey(projected.origin);
    const id = existingByOrigin.get(key)?.id ?? mirrorTaskId(key);
    idsByOrigin.set(key, id);
    idsByOriginReference.set(projected.sourceOriginKey, id);
    idsByOriginReference.set(key, id);
  }
  const desiredKeys = new Set(idsByOrigin.keys());
  const incomingSessions = new Set(projectedSpecs.map(({ origin }) => origin.sessionId));
  const authoritativeProjection = sessionGeneration !== undefined;

  for (const { spec, origin, sourceOriginKey } of projectedSpecs) {
    const key = todoOriginKey(origin);
    const existing = existingByOrigin.get(key);
    if (existing?.status === "deleted") {
      result.unchanged.push(existing.id);
      continue;
    }
    const id = uniqueMirrorId(idsByOrigin.get(key)!, key, nextTasks);
    idsByOrigin.set(key, id);
    idsByOriginReference.set(sourceOriginKey, id);
    idsByOriginReference.set(key, id);
    const blockedBy = spec.blockedByOriginKeys
      .map((originKey) => idsByOriginReference.get(originKey))
      .filter((value): value is string => Boolean(value));
    const now = Date.now();
    const next: TodoTask = {
      id,
      subject: spec.subject,
      ...(spec.description ? { description: spec.description } : {}),
      status: blockedBy.length > 0 && spec.status === "pending" ? "blocked" : spec.status,
      blockedBy,
      ...(spec.context ? { context: spec.context } : {}),
      skills: spec.skills.map((skill) => ({ ...skill })),
      ...(spec.summary ? { summary: spec.summary } : {}),
      origin,
      createdBy: cloneActor(ROOT_TODO_ACTOR),
      assignee: cloneActor(ROOT_TODO_ACTOR),
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    };
    if (existing?.skillActivation && mirrorActivationStillValid(existing, next)) {
      next.skillActivation = cloneSkillActivation(existing.skillActivation);
    }
    if (!existing) {
      nextTasks.set(id, next);
      result.created.push(id);
      continue;
    }
    if (taskChanged(existing, next)) {
      next.updatedAt = now;
      nextTasks.set(existing.id, { ...next, id: existing.id });
      skillSnapshotsToClear.add(existing.id);
      result.updated.push(existing.id);
    } else {
      result.unchanged.push(existing.id);
    }
  }

  for (const task of nextTasks.values()) {
    if (!task.origin) continue;
    const key = todoOriginKey(task.origin);
    const belongsToUpdatedProjection = authoritativeProjection
      ? true
      : incomingSessions.has(task.origin.sessionId);
    if (!belongsToUpdatedProjection || desiredKeys.has(key) || task.status === "deleted") continue;
    task.status = "deleted";
    task.updatedAt = Date.now();
    skillSnapshotsToClear.add(task.id);
    result.tombstoned.push(task.id);
  }

  if (result.created.length || result.updated.length || result.tombstoned.length) {
    commitTodoState(nextTasks);
    clearCommittedSkillSnapshots(skillSnapshotsToClear);
  }
  return result;
}

/** Return a detached Todo snapshot suitable for compaction metadata and prompts. */
export function getTodoCompactionSnapshot(): TodoCompactionSnapshot {
  const visible = getVisibleTasks().map(cloneTodoTask);
  const activeTask = visible
    .filter((task) => task.status === "in_progress")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return {
    stateVersion: TODO_STATE_VERSION,
    revision: todoRevision,
    ...(activeTask ? { activeTaskId: activeTask.id } : {}),
    tasks: visible,
  };
}

export async function getInjectableContent(taskId: string): Promise<InjectableContent | null> {
  const task = tasks.get(taskId);
  if (!task) return null;

  const activation = await ensureSkillActivation(task);
  const blocks: Array<{ tag: string; content: string }> = [];
  if (task.context) blocks.push({ tag: "context", content: task.context });
  for (const binding of activation.skills) {
    blocks.push({ tag: `skill_prompt:${binding.role}`, content: binding.skill.prompt });
  }

  return {
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    goalContext: getActiveGoal()?.text,
    context: task.context,
    skills: activation.skills,
    blocks,
  };
}

export async function onBeforeAgentStartTodo(
  event: { systemPrompt: string },
): Promise<{ systemPrompt: string } | undefined> {
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) {
    runInjectedStackRevision = undefined;
    return undefined;
  }
  const activation = await ensureSkillActivation(active);
  assertActiveSkillStack(active, activation);
  runInjectedStackRevision = activation.stackRevision;
  return {
    systemPrompt: `${event.systemPrompt}\n\n${renderActivationPrompt(active, activation)}`,
  };
}

export async function onContextTodo(
  messages: AgentMessage[],
): Promise<{ messages: AgentMessage[] } | undefined> {
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) return undefined;
  const activation = await ensureSkillActivation(active);
  assertActiveSkillStack(active, activation);
  if (runInjectedStackRevision === activation.stackRevision) return undefined;
  return {
    messages: [
      ...messages,
      {
        role: "custom",
        customType: "todo-active-skill",
        content: renderActivationPrompt(active, activation),
        display: false,
        details: {
          taskId: active.id,
          activationId: activation.activationId,
          stackRevision: activation.stackRevision,
        },
        timestamp: activation.activatedAt,
      },
    ],
  };
}

export function onAgentEndTodo(): void {
  runInjectedStackRevision = undefined;
}

export async function executeTodo(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef = ROOT_TODO_ACTOR,
): Promise<AgentToolResult> {
  const generation = todoGeneration;
  const execute = () => executeTodoAction(input, ctx, actor, generation);
  if (!isTodoMutation(input.action)) return execute();

  const result = todoMutationQueue.then(execute, execute);
  todoMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function executeTodoAction(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<AgentToolResult> {
  const { action } = input;
  try {
    assertTodoGeneration(generation);
    rememberActor(actor);
    const params = normalizeTodoParams(input);
    switch (action) {
      case "create":
        return handleCreate(params, ctx, actor);
      case "update":
        return await handleUpdate(params, ctx, actor, generation);
      case "list":
        return handleList(params, actor);
      case "get":
        return handleGet(params);
      case "delete":
        return handleDelete(params, ctx, actor);
      case "clear":
        return handleClear(ctx, actor);
      case "next":
        return await handleNext(ctx, actor, generation);
      default:
        return err(`Unknown action "${action}". Valid: create, update, list, get, delete, clear, next`);
    }
  } catch (e) {
    return err(`Error in todo ${action}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

function handleCreate(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): AgentToolResult {
  if (!params.subject) return err("subject is required for create", "create");

  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  const blockerResolution = resolveBlockedBy(id, params.blockedBy ?? []);
  if (blockerResolution.error) return err(blockerResolution.error, "create");
  const blockedBy = blockerResolution.blockedBy;
  const assignee = resolveAssignee(params.assignee, actor);
  if ("error" in assignee) return err(assignee.error, "create");

  const task: TodoTask = {
    id,
    subject: params.subject,
    description: params.description,
    status: blockedBy.length > 0 ? "blocked" : "pending",
    blockedBy,
    skills: params.skills ?? [],
    ...(params.context ? { context: params.context } : {}),
    ...(params.planHandoffKey ? { planHandoffKey: params.planHandoffKey } : {}),
    createdBy: cloneActor(actor),
    assignee: assignee.actor,
    createdAt: now,
    updatedAt: now,
  };

  if (hasCycle(id, blockedBy)) return err("blockedBy would create a dependency cycle", "create");

  const nextTasks = new Map(tasks);
  nextTasks.set(id, task);
  commitTodoState(nextTasks);

  return ok(`Created #${id}: ${task.subject} (${task.status})`, "create");
}

async function handleUpdate(
  params: TodoParams,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<AgentToolResult> {
  if (!params.id) return err("id is required for update", "update");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "update");
  if (task.status === "deleted") return err(`Cannot update deleted task: ${params.id}`, "update");
  if (!canEditTask(actor, task)) return err(`@${actor.label} cannot update task #${params.id}`, "update");

  const before = cloneTodoTask(task);
  const draft = cloneTodoTask(task);

  if (params.subject !== undefined) draft.subject = params.subject;
  if (params.description !== undefined) draft.description = params.description;
  if (params.summary !== undefined) draft.summary = params.summary;

  if (params.assignee !== undefined) {
    const assignee = resolveAssignee(params.assignee, actor);
    if ("error" in assignee) return err(assignee.error, "update");
    draft.assignee = assignee.actor;
  }

  if (params.context !== undefined) {
    if (params.context === "") delete draft.context;
    else draft.context = params.context;
    draft.skillActivation = undefined;
  }

  if (params.skills !== undefined) {
    draft.skills = params.skills ?? [];
    draft.skillActivation = undefined;
  }

  if (params.blockedBy !== undefined) {
    const blockerResolution = resolveBlockedBy(draft.id, params.blockedBy);
    if (blockerResolution.error) return err(blockerResolution.error, "update");
    draft.blockedBy = blockerResolution.blockedBy;
  }

  if (params.status !== undefined) draft.status = params.status;
  if (
    params.status === "pending"
    || params.status === "blocked"
    || (params.status === undefined && params.blockedBy !== undefined)
  ) {
    draft.status = deriveDependencyStatus(draft.blockedBy);
  }

  if (draft.status === "in_progress" && draft.blockedBy.length > 0) {
    return err(`Task #${draft.id} is blocked by: ${draft.blockedBy.join(", ")}`, "update");
  }
  if (
    draft.status === "in_progress"
    && (before.status !== "in_progress" || before.assignee.id !== draft.assignee.id)
  ) {
    const active = findActiveTask(draft.assignee.id, draft.id);
    if (active) {
      return err(`Task #${active.id} is already in progress for @${draft.assignee.label}; complete or pause it before activating another task`, "update");
    }
  }

  if (draft.status !== before.status && !isValidTransition(before.status, draft.status)) {
    return err(`Invalid status transition: ${before.status} → ${draft.status}`, "update");
  }

  const activationInputsChanged = before.context !== draft.context
    || JSON.stringify(before.skills) !== JSON.stringify(draft.skills);
  const assigneeChanged = before.assignee.id !== draft.assignee.id;
  const shouldActivate = draft.status === "in_progress"
    && (before.status !== "in_progress" || activationInputsChanged || assigneeChanged || !draft.skillActivation);
  const revisionBeforeActivation = todoRevision;
  const activation = shouldActivate ? await activateTask(draft) : undefined;
  if (shouldActivate) {
    revalidateAsyncTodoMutation({
      generation,
      revision: revisionBeforeActivation,
      before,
      draft,
      actor,
    });
  }
  if (activation) draft.skillActivation = activationMetadata(activation);
  if (draft.status === "pending") draft.skillActivation = undefined;

  const changed = taskChanged(before, draft)
    || JSON.stringify(before.skillActivation) !== JSON.stringify(draft.skillActivation);
  if (!changed) return ok(`No change: #${draft.id}`, "update");

  draft.updatedAt = Date.now();
  const nextTasks = new Map(tasks);
  nextTasks.set(draft.id, draft);
  if (draft.status === "completed" && before.status !== "completed") {
    autoUnblock(nextTasks, draft.id);
  }

  // Persist and update the UI against the detached candidate state. Only after
  // every fallible operation succeeds do we publish the task and skill snapshot.
  commitTodoState(nextTasks);
  if (activation) {
    activeSkillSnapshots.set(draft.id, activation);
    runInjectedStackRevision = undefined;
  } else if (activationInputsChanged || draft.status !== "in_progress") {
    clearSkillSnapshot(draft.id);
  }

  const statusNote = before.status !== draft.status ? ` (${before.status} → ${draft.status})` : "";
  return ok(`Updated #${draft.id}: ${draft.subject}${statusNote}`, "update");
}

function handleList(params: TodoParams, actor: TodoActorRef): AgentToolResult {
  let filtered = getVisibleTasks();

  if (params.filter?.status) {
    filtered = filtered.filter((t) => t.status === params.filter!.status);
  }
  const memberSelector = params.filter?.memberId;
  if (memberSelector) {
    const member = resolveTodoActorSelector(memberSelector, actor);
    if ("error" in member) {
      if (member.reason === "ambiguous") return err(member.error, "list");
      filtered = [];
    } else {
      filtered = filtered.filter((task) => task.createdBy.id === member.actor.id
        || task.assignee.id === member.actor.id);
    }
  }

  if (filtered.length === 0) {
    return ok("No tasks found.", "list");
  }

  const lines = filtered.map((t) => {
    const depTag = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
    return `${statusIcon(t.status)} ${actorTag(t)} #${t.id} ${t.subject}${depTag}`;
  });

  return ok(lines.join("\n"), "list");
}

function handleGet(params: TodoParams): AgentToolResult {
  if (!params.id) return err("id is required for get", "get");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "get");

  const lines: string[] = [
    `# #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Created by: @${task.createdBy.label}`,
    `Assignee: @${task.assignee.label}`,
  ];
  if (task.description) lines.push(`Description: ${task.description}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(", ")}`);

  const blockers = [...tasks.values()].filter(
    (t) => t.blockedBy.includes(task.id) && t.status !== "deleted",
  );
  if (blockers.length > 0) {
    lines.push(`Blocks: ${blockers.map((b) => `#${b.id}`).join(", ")}`);
  }

  if (task.summary) lines.push(`Summary: ${task.summary}`);

  if (task.context) lines.push(`Context: ${truncate(task.context, 120)}`);
  if (task.skills.length > 0) {
    lines.push(`Skills: ${task.skills.map(formatSkillBinding).join(", ")}`);
  }
  if (task.skillActivation) {
    lines.push(`Skill activation: ${task.skillActivation.activationId}`);
    lines.push(`Stack revision: ${task.skillActivation.stackRevision}`);
  }

  return ok(lines.join("\n"), "get");
}

function handleDelete(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): AgentToolResult {
  if (!params.id) return err("id is required for delete", "delete");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "delete");
  if (!canDeleteTask(actor, task)) return err(`@${actor.label} cannot delete task #${params.id}`, "delete");

  const nextTasks = cloneTaskMap();
  const deleted = nextTasks.get(params.id)!;
  deleted.status = "deleted";
  deleted.updatedAt = Date.now();

  for (const t of nextTasks.values()) {
    if (t.status !== "deleted" && t.blockedBy.includes(params.id)) {
      t.blockedBy = t.blockedBy.filter((d) => d !== params.id);
      if (t.status === "blocked" || t.status === "pending") {
        t.status = deriveDependencyStatus(t.blockedBy);
      }
      t.updatedAt = Date.now();
    }
  }

  commitTodoState(nextTasks);
  clearCommittedSkillSnapshots(new Set([deleted.id]));
  return ok(`Deleted #${deleted.id}: ${deleted.subject}`, "delete");
}

function handleClear(ctx: ExtensionContext, actor: TodoActorRef): AgentToolResult {
  if (actor.kind !== "root") return err("Only root can clear the shared Todo list.", "clear");
  const count = [...tasks.values()].filter((t) => t.status !== "deleted").length;
  const nextTasks = new Map<string, TodoTask>();
  commitTodoState(nextTasks);
  clearSkillSnapshot();
  return ok(`Cleared ${count} task(s).`, "clear");
}

async function handleNext(
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<AgentToolResult> {
  const active = findActiveTask(actor.id);
  if (active) {
    return err(`Task #${active.id} is already in progress for @${actor.label}; complete or pause it before activating another task`, "next");
  }

  const pending = [...tasks.values()]
    .filter((t) => t.assignee.id === actor.id && t.status === "pending" && t.blockedBy.length === 0)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (pending.length === 0) {
    const inProgress = [...tasks.values()].filter((t) => t.assignee.id === actor.id && t.status === "in_progress");
    if (inProgress.length > 0) {
      return ok(`No pending tasks. ${inProgress.length} task(s) in progress.`, "next");
    }
    const blocked = getVisibleTasks().filter(
      (task) => task.assignee.id === actor.id
        && (task.status === "blocked" || (task.status === "pending" && task.blockedBy.length > 0)),
    );
    if (blocked.length > 0) {
      const blockerDetails = blocked.map((task) => {
        const dependencies = task.blockedBy.map((depId) => {
          const dependency = tasks.get(depId);
          return dependency
            ? `#${depId} (${dependency.status}: ${dependency.subject})`
            : `#${depId} (missing)`;
        });
        return `#${task.id} ${task.subject} blocked by ${dependencies.join(", ") || "an unresolved dependency"}`;
      });
      return err(
        `Dependency deadlock: no runnable pending task. ${blockerDetails.join("; ")}`,
        "next",
      );
    }
    return ok("All tasks completed or no tasks exist.", "next");
  }

  const task = pending[0];
  const draft = cloneTodoTask(task);
  const allTasks = getVisibleTasks();
  const taskIndex = allTasks.findIndex((t) => t.id === task.id);

  const parts: string[] = [
    `## Task #${task.id} [${taskIndex + 1}/${allTasks.length}]: ${task.subject}`,
  ];
  if (task.description) parts.push(task.description);

  const prevContext = buildPrevContext(task.id);
  if (prevContext) {
    parts.push(`\n<prev_steps>\n${prevContext}\n</prev_steps>`);
  }

  const goalText = getActiveGoal()?.text;
  if (goalText) {
    parts.push(`\n<goal_context>\n${goalText}\n</goal_context>`);
  }

  if (task.context) {
    parts.push(`\n<context>\n${task.context}\n</context>`);
  }

  const revisionBeforeActivation = todoRevision;
  const activation = await activateTask(draft);
  draft.status = "in_progress";
  revalidateAsyncTodoMutation({
    generation,
    revision: revisionBeforeActivation,
    before: task,
    draft,
    actor,
  });
  for (const binding of activation.skills) {
    parts.push(`\n<skill_prompt role="${binding.role}">\n${binding.skill.prompt}\n</skill_prompt>`);
  }

  draft.skillActivation = activationMetadata(activation);
  draft.updatedAt = Date.now();
  const nextTasks = new Map(tasks);
  nextTasks.set(draft.id, draft);
  commitTodoState(nextTasks);
  activeSkillSnapshots.set(draft.id, activation);
  runInjectedStackRevision = undefined;

  return ok(parts.join("\n"), "next");
}

const PREV_CONTEXT_WINDOW = 5;

function buildPrevContext(currentId: string): string | null {
  const completed = [...tasks.values()]
    .filter((t) => t.status === "completed" && t.id !== currentId && t.summary)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  if (completed.length === 0) return null;

  return completed
    .slice(-PREV_CONTEXT_WINDOW)
    .map((t) => `[#${t.id}] ${t.subject}: ${t.summary}`)
    .join("\n");
}

function markTodoChanged(): void {
  todoRevision++;
}

function cloneTodoTask(task: TodoTask): TodoTask {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    skills: task.skills.map((skill) => ({ ...skill })),
    createdBy: cloneActor(task.createdBy),
    assignee: cloneActor(task.assignee),
    ...(task.origin ? { origin: { ...task.origin } } : {}),
    ...(task.skillActivation ? { skillActivation: cloneSkillActivation(task.skillActivation) } : {}),
  };
}

function cloneTaskMap(state: Map<string, TodoTask> = tasks): Map<string, TodoTask> {
  return new Map([...state].map(([id, task]) => [id, cloneTodoTask(task)]));
}

function cloneSkillActivation(activation: SkillActivationMetadata): SkillActivationMetadata {
  return {
    ...activation,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "blocked", "completed", "deleted"],
  in_progress: ["completed", "blocked", "pending", "deleted"],
  completed: ["deleted"],
  blocked: ["pending", "in_progress", "deleted"],
  deleted: [],
};

function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Dependency management
// ---------------------------------------------------------------------------

function resolveBlockedBy(
  taskId: string,
  proposedDeps: readonly string[],
): { blockedBy: string[]; error?: string } {
  const blockedBy: string[] = [];
  const seen = new Set<string>();
  for (const depId of proposedDeps) {
    if (seen.has(depId)) continue;
    seen.add(depId);
    if (depId === taskId) return { blockedBy: [], error: "Task cannot block itself" };
    const dependency = tasks.get(depId);
    if (!dependency) {
      return { blockedBy: [], error: `blockedBy references unknown task: ${depId}` };
    }
    if (dependency.status === "deleted") {
      return { blockedBy: [], error: `blockedBy references deleted task: ${depId}` };
    }
    if (dependency.status === "completed") continue;
    blockedBy.push(depId);
  }
  if (hasCycle(taskId, blockedBy)) {
    return { blockedBy: [], error: "blockedBy would create a dependency cycle" };
  }
  return { blockedBy };
}

function deriveDependencyStatus(blockedBy: readonly string[]): "blocked" | "pending" {
  return blockedBy.length > 0 ? "blocked" : "pending";
}

function hasCycle(taskId: string, proposedDeps: string[]): boolean {
  const visited = new Set<string>();
  const stack = [...proposedDeps];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const dep = tasks.get(current);
    if (dep) stack.push(...dep.blockedBy);
  }
  return false;
}

function autoUnblock(state: Map<string, TodoTask>, completedId: string): void {
  for (const [id, t] of state) {
    if (t.status === "deleted") continue;
    if (!t.blockedBy.includes(completedId)) continue;
    const next = cloneTodoTask(t);
    next.blockedBy = next.blockedBy.filter((d) => d !== completedId);
    if (next.status === "blocked" || next.status === "pending") {
      next.status = deriveDependencyStatus(next.blockedBy);
    }
    next.updatedAt = Date.now();
    state.set(id, next);
  }
}

function normalizeLoadedDependencies(state: Map<string, TodoTask>): void {
  for (const task of state.values()) {
    const seen = new Set<string>();
    task.blockedBy = task.blockedBy.filter((depId) => {
      if (seen.has(depId)) return false;
      seen.add(depId);
      const dependency = state.get(depId);
      return dependency?.status !== "completed" && dependency?.status !== "deleted";
    });
    if (task.status === "pending" || task.status === "blocked") {
      task.status = deriveDependencyStatus(task.blockedBy);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(state: Map<string, TodoTask> = tasks): void {
  extensionApi?.appendEntry?.(TODO_STATE_ENTRY_TYPE, {
    version: TODO_STATE_VERSION,
    tasks: Object.fromEntries(state),
  });
}

function commitTodoState(
  nextTasks: Map<string, TodoTask>,
): void {
  persist(nextTasks);
  tasks = nextTasks;
  markTodoChanged();
}

function loadTasksFromSession(ctx: TodoContext): Map<string, TodoTask> {
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
  const entry = entries
    .filter((e) => e.type === "custom" && e.customType === TODO_STATE_ENTRY_TYPE)
    .pop();
  const data = asRecord(entry?.data);
  const rawTasks = asRecord(data?.tasks);
  if (!rawTasks) return new Map();
  const loaded = new Map<string, TodoTask>();
  for (const [id, rawTask] of Object.entries(rawTasks)) {
    loaded.set(id, normalizeLoadedTask(id, rawTask));
  }
  normalizeLoadedDependencies(loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTodoMutation(action: TodoParams["action"]): boolean {
  return action !== "list" && action !== "get";
}

function assertTodoGeneration(generation: number): void {
  if (generation !== todoGeneration) {
    throw new Error("Todo session changed while the mutation was pending; retry against the active session.");
  }
}

interface AsyncTodoMutationCheck {
  generation: number;
  revision: number;
  before: TodoTask;
  draft: TodoTask;
  actor: TodoActorRef;
}

/**
 * Async skill loading must not publish a draft derived from stale Todo state.
 * Re-check every authority and graph invariant at the await boundary even
 * though ordinary tool mutations are serialized: canonical Workflow mirrors
 * and session lifecycle hooks can still change module state independently.
 */
function revalidateAsyncTodoMutation(check: AsyncTodoMutationCheck): TodoTask {
  assertTodoGeneration(check.generation);
  if (todoRevision !== check.revision) {
    throw new Error(`Todo state changed while activating task #${check.before.id}; retry the mutation.`);
  }

  const current = tasks.get(check.before.id);
  if (!current || current.status === "deleted") {
    throw new Error(`Task #${check.before.id} is no longer available after skill activation.`);
  }
  if (JSON.stringify(current) !== JSON.stringify(check.before)) {
    throw new Error(`Task #${check.before.id} changed while its skills were activating; retry the mutation.`);
  }
  if (!canEditTask(check.actor, current)) {
    throw new Error(`@${check.actor.label} can no longer update task #${check.before.id}.`);
  }

  const dependencyCheck = resolveBlockedBy(check.draft.id, check.draft.blockedBy);
  if (dependencyCheck.error) throw new Error(dependencyCheck.error);
  if (JSON.stringify(dependencyCheck.blockedBy) !== JSON.stringify(check.draft.blockedBy)) {
    throw new Error(`Dependencies changed while activating task #${check.draft.id}; retry the mutation.`);
  }
  if (check.draft.status === "in_progress") {
    if (dependencyCheck.blockedBy.length > 0) {
      throw new Error(`Task #${check.draft.id} is blocked by: ${dependencyCheck.blockedBy.join(", ")}`);
    }
    const active = findActiveTask(check.draft.assignee.id, check.draft.id);
    if (active) {
      throw new Error(
        `Task #${active.id} is already in progress for @${check.draft.assignee.label}; complete or pause it before activating another task`,
      );
    }
  }
  if (
    check.draft.status !== current.status
    && !isValidTransition(current.status, check.draft.status)
  ) {
    throw new Error(`Invalid status transition: ${current.status} → ${check.draft.status}`);
  }
  return current;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "[x]";
    case "in_progress": return "[>]";
    case "blocked": return "[!]";
    case "pending": return "[ ]";
    case "deleted": return "[-]";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function taskChanged(before: TodoTask, after: TodoTask): boolean {
  return (
    before.subject !== after.subject ||
    before.description !== after.description ||
    before.status !== after.status ||
    before.summary !== after.summary ||
    JSON.stringify(before.blockedBy) !== JSON.stringify(after.blockedBy) ||
    before.context !== after.context ||
    JSON.stringify(before.skills) !== JSON.stringify(after.skills) ||
    JSON.stringify(before.origin) !== JSON.stringify(after.origin) ||
    JSON.stringify(before.createdBy) !== JSON.stringify(after.createdBy) ||
    JSON.stringify(before.assignee) !== JSON.stringify(after.assignee)
  );
}

function mirrorTaskId(originKey: string): string {
  return `wf-${createHash("sha256").update(originKey).digest("hex").slice(0, 8)}`;
}

function uniqueMirrorId(
  candidate: string,
  originKey: string,
  state: Map<string, TodoTask> = tasks,
): string {
  const occupied = state.get(candidate);
  if (!occupied || (occupied.origin && todoOriginKey(occupied.origin) === originKey)) return candidate;
  return `wf-${createHash("sha256").update(`${originKey}\u0000collision`).digest("hex").slice(0, 12)}`;
}

function mirrorActivationStillValid(before: TodoTask, after: TodoTask): boolean {
  return before.status === "in_progress"
    && after.status === "in_progress"
    && before.context === after.context
    && JSON.stringify(before.skills) === JSON.stringify(after.skills);
}

function requireSkillRuntime(): SkillRuntime {
  if (!skillRuntime) throw new Error("todo skill runtime is not initialized");
  return skillRuntime;
}

function activateTask(task: TodoTask): Promise<SkillActivation> {
  return requireSkillRuntime().activate(task.skills, task.context ?? "");
}

function activationMetadata(activation: SkillActivation): SkillActivationMetadata {
  return {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
}

async function ensureSkillActivation(task: TodoTask): Promise<SkillActivation> {
  const cached = activeSkillSnapshots.get(task.id);
  if (cached?.stackRevision === task.skillActivation?.stackRevision) {
    return cached;
  }
  const generation = todoGeneration;
  const revisionBeforeActivation = todoRevision;
  const before = cloneTodoTask(task);
  const activation = await requireSkillRuntime().activate(
    task.skills,
    task.context ?? "",
    task.skillActivation,
  );
  const current = revalidateAsyncTodoMutation({
    generation,
    revision: revisionBeforeActivation,
    before,
    draft: before,
    actor: ROOT_TODO_ACTOR,
  });
  const nextMetadata: SkillActivationMetadata = {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
  if (JSON.stringify(current.skillActivation) !== JSON.stringify(nextMetadata)) {
    const draft = cloneTodoTask(current);
    draft.skillActivation = nextMetadata;
    const nextTasks = new Map(tasks);
    nextTasks.set(draft.id, draft);
    persist(nextTasks);
    tasks = nextTasks;
    markTodoChanged();
  }
  activeSkillSnapshots.set(current.id, activation);
  return activation;
}

function clearSkillSnapshot(taskId?: string): void {
  if (taskId) activeSkillSnapshots.delete(taskId);
  else activeSkillSnapshots.clear();
  runInjectedStackRevision = undefined;
}

function clearCommittedSkillSnapshots(taskIds: ReadonlySet<string>): void {
  if (taskIds.size === 0) return;
  for (const taskId of taskIds) activeSkillSnapshots.delete(taskId);
  runInjectedStackRevision = undefined;
}

function renderActivationPrompt(task: TodoTask, activation: SkillActivation): string {
  if (activation.state === "active") return activation.prompt;
  return [
    "<active_skill_stack_stale>",
    `Todo task #${task.id} skill files changed after activation.`,
    "Do not continue the previous skill workflow until the task is moved back to pending and activated again.",
    "</active_skill_stack_stale>",
  ].join("\n");
}

function assertActiveSkillStack(task: TodoTask, activation: SkillActivation): void {
  if (activation.state === "active") return;
  throw new Error(
    `Todo task #${task.id} skill activation is stale. Move the task back to pending and reactivate it before continuing the Run.`,
  );
}

function cloneActivationBinding(binding: SkillActivationBindingMetadata): SkillActivationBindingMetadata {
  return {
    ...binding,
    requiredFiles: [...binding.requiredFiles],
    deferredFiles: [...binding.deferredFiles],
  };
}

function normalizeSkillConfig(skill: TodoSkillConfig): TodoSkillConfig {
  const name = skill.name.trim();
  if (!name) throw new Error("skill.name must be non-empty");
  const args = skill.args?.trim();
  return { name, ...(args ? { args } : {}) };
}

function normalizeSkillBinding(skill: TodoSkillBinding): TodoSkillBinding {
  if (!isSkillRole(skill.role)) throw new Error(`Invalid skill role: ${String(skill.role)}`);
  return { ...normalizeSkillConfig(skill), role: skill.role };
}

function normalizeSkillBindings(skills: readonly TodoSkillBinding[]): TodoSkillBinding[] {
  return composeSkillBindings(skills.map(normalizeSkillBinding));
}

function normalizeTodoParams(input: TodoParamsInput): TodoParams {
  const { skill: legacySkill, ...params } = input;
  if (params.skills !== undefined) {
    return {
      ...params,
      skills: params.skills === null ? null : normalizeSkillBindings(params.skills),
    };
  }
  if (legacySkill !== undefined) {
    return {
      ...params,
      skills: legacySkill === null
        ? null
        : [{ ...normalizeSkillConfig(legacySkill), role: "primary" }],
    };
  }
  return params;
}

function formatSkillBinding(binding: TodoSkillBinding): string {
  return `${binding.role}:${binding.name}${binding.args ? ` ${binding.args}` : ""}`;
}

function cloneActor(actor: TodoActorRef): TodoActorRef {
  return { ...actor };
}

function rememberActor(actor: TodoActorRef): void {
  knownActors.set(actor.id, cloneActor(actor));
}

type TodoActorResolution =
  | { actor: TodoActorRef }
  | { error: string; reason: "unknown" | "ambiguous" };

function resolveTodoActorSelector(requested: string, actor: TodoActorRef): TodoActorResolution {
  const selector = requested.trim().replace(/^@/, "");
  if (selector === "self" || selector === actor.id || selector === actor.label) {
    return { actor: cloneActor(actor) };
  }
  if (selector === ROOT_TODO_ACTOR.id) return { actor: cloneActor(ROOT_TODO_ACTOR) };

  const exactId = knownActors.get(selector);
  if (exactId) return { actor: cloneActor(exactId) };

  const labelMatches = [...knownActors.values()].filter((candidate) => candidate.label === selector);
  if (labelMatches.length === 1) return { actor: cloneActor(labelMatches[0]) };
  if (labelMatches.length > 1) {
    return {
      error: `Ambiguous Todo member selector: ${requested}; use label#unique-id-prefix or the full member id`,
      reason: "ambiguous",
    };
  }

  const marker = selector.lastIndexOf("#");
  if (marker > 0 && marker < selector.length - 1) {
    const label = selector.slice(0, marker);
    const idPrefix = selector.slice(marker + 1);
    const decoratedMatches = [...knownActors.values()].filter((candidate) =>
      candidate.label === label && candidate.id.startsWith(idPrefix)
    );
    if (decoratedMatches.length === 1) return { actor: cloneActor(decoratedMatches[0]) };
    if (decoratedMatches.length > 1) {
      return {
        error: `Ambiguous Todo member selector: ${requested}; use a longer id prefix`,
        reason: "ambiguous",
      };
    }
  }

  return { error: `Unknown Todo member selector: ${requested}`, reason: "unknown" };
}

function resolveAssignee(
  requested: string | undefined,
  actor: TodoActorRef,
): { actor: TodoActorRef } | { error: string } {
  if (!requested) return { actor: cloneActor(actor) };
  const resolved = resolveTodoActorSelector(requested, actor);
  if ("error" in resolved) {
    if (actor.kind !== "root") {
      return { error: `@${actor.label} can only assign Todo tasks to self or root` };
    }
    return { error: resolved.reason === "ambiguous"
      ? resolved.error.replace("member selector", "assignee")
      : `Unknown Todo assignee: ${requested}` };
  }
  if (actor.kind !== "root" && resolved.actor.id !== actor.id && resolved.actor.id !== ROOT_TODO_ACTOR.id) {
    return { error: `@${actor.label} can only assign Todo tasks to self or root` };
  }
  return resolved;
}

function canEditTask(actor: TodoActorRef, task: TodoTask): boolean {
  return actor.kind === "root" || task.createdBy.id === actor.id || task.assignee.id === actor.id;
}

function canDeleteTask(actor: TodoActorRef, task: TodoTask): boolean {
  if (actor.kind === "root") return true;
  if (task.createdBy.id !== actor.id) return false;
  return task.assignee.id === actor.id || task.status !== "in_progress";
}

function actorTag(task: TodoTask): string {
  const actors = [...knownActors.values()];
  const createdBy = formatTodoActorSelector(task.createdBy, actors);
  const assignee = formatTodoActorSelector(task.assignee, actors);
  return task.createdBy.id === task.assignee.id
    ? `@${assignee}`
    : `@${createdBy}→@${assignee}`;
}

function findActiveTask(assigneeId: string, excludeId?: string): TodoTask | undefined {
  return [...tasks.values()].find(
    (task) => task.status === "in_progress"
      && task.assignee.id === assigneeId
      && task.id !== excludeId,
  );
}

function normalizeLoadedTask(id: string, raw: unknown): TodoTask {
  const task = asRecord(raw) ?? {};
  const contextParts: string[] = [];
  if (typeof task.context === "string" && task.context) contextParts.push(task.context);

  const skills = readSkillBindings(task.skills);
  if (skills.length === 0) appendLegacySkill(skills, task.skill);
  const legacyInject = Array.isArray(task.inject) ? task.inject : [];
  for (const item of legacyInject) {
    const entry = asRecord(item);
    if (!entry || typeof entry.source !== "string") continue;
    if (entry.type === "skill" && skills.length === 0) {
      appendLegacySkill(skills, { name: entry.source });
    } else if (entry.type === "text") {
      contextParts.push(wrapLegacyBlock(typeof entry.tag === "string" ? entry.tag : "content", entry.source));
    } else if (entry.type === "file") {
      contextParts.push(wrapLegacyBlock("legacy_file_reference", entry.source));
    }
  }

  const legacyInjection = asRecord(task.injection);
  if (legacyInjection) {
    if (skills.length === 0 && typeof legacyInjection.skillRef === "string") {
      appendLegacySkill(skills, { name: legacyInjection.skillRef });
    }
    appendLegacyValue(contextParts, "legacy_goal_context", legacyInjection.goalContext);
    appendLegacyValue(contextParts, "step_context", legacyInjection.stepContext);
    appendLegacyValue(contextParts, "boundary_contract", legacyInjection.boundaryContract);
    if (Array.isArray(legacyInjection.deferredReads)) {
      const paths = legacyInjection.deferredReads.filter((value): value is string => typeof value === "string");
      if (paths.length > 0) contextParts.push(wrapLegacyBlock("deferred_reads", paths.join("\n")));
    }
  }

  const legacyLoad = asRecord(task.load);
  if (legacyLoad && typeof legacyLoad.source === "string") {
    if (legacyLoad.type === "skill" && skills.length === 0) {
      appendLegacySkill(skills, { name: legacyLoad.source });
    }
    else if (legacyLoad.type === "text") contextParts.push(legacyLoad.source);
    else if (legacyLoad.type === "file") contextParts.push(wrapLegacyBlock("legacy_file_reference", legacyLoad.source));
  }

  const completion = asRecord(task.completion);
  const summary = typeof task.summary === "string"
    ? task.summary
    : typeof completion?.summary === "string"
      ? completion.summary
      : undefined;
  const status = isTaskStatus(task.status) ? task.status : "pending";
  const blockedBy = Array.isArray(task.blockedBy)
    ? task.blockedBy.filter((value): value is string => typeof value === "string")
    : [];
  const now = Date.now();
  const skillActivation = readSkillActivation(task.skillActivation);
  const legacySkillActivation = skillActivation ?? readLegacySkillActivation(id, task.skillLoad, skills);
  const origin = readTodoOrigin(task.origin);
  const createdBy = readTodoActor(task.createdBy) ?? cloneActor(ROOT_TODO_ACTOR);
  const assignee = readTodoActor(task.assignee) ?? cloneActor(ROOT_TODO_ACTOR);

  return {
    id: typeof task.id === "string" ? task.id : id,
    subject: typeof task.subject === "string" ? task.subject : `Task ${id}`,
    ...(typeof task.description === "string" ? { description: task.description } : {}),
    status,
    blockedBy,
    skills,
    ...(contextParts.length > 0 ? { context: contextParts.join("\n\n") } : {}),
    ...(legacySkillActivation ? { skillActivation: legacySkillActivation } : {}),
    ...(summary ? { summary } : {}),
    ...(origin ? { origin } : {}),
    ...(typeof task.planHandoffKey === "string" ? { planHandoffKey: task.planHandoffKey } : {}),
    createdBy,
    assignee,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
  };
}

function readTodoOrigin(value: unknown): TodoTaskOrigin | undefined {
  const origin = asRecord(value);
  if (!origin || typeof origin.sessionId !== "string" || typeof origin.step !== "string") return undefined;
  return {
    sessionId: origin.sessionId,
    step: origin.step,
    ...(typeof origin.sessionGeneration === "string" ? { sessionGeneration: origin.sessionGeneration } : {}),
    ...(typeof origin.runId === "string" ? { runId: origin.runId } : {}),
    ...(typeof origin.runSeq === "string" ? { runSeq: origin.runSeq } : {}),
  };
}

function readTodoActor(value: unknown): TodoActorRef | undefined {
  const actor = asRecord(value);
  if (
    !actor
    || (actor.kind !== "root" && actor.kind !== "teammate")
    || typeof actor.id !== "string"
    || !actor.id
    || typeof actor.label !== "string"
    || !actor.label
  ) return undefined;
  return {
    kind: actor.kind,
    id: actor.id,
    label: actor.label,
    ...(typeof actor.agentType === "string" ? { agentType: actor.agentType } : {}),
  };
}

function readSkillBindings(value: unknown): TodoSkillBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: TodoSkillBinding[] = [];
  for (const item of value) {
    const binding = readSkillBinding(item);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

function readSkillBinding(value: unknown): TodoSkillBinding | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  if (!isSkillRole(skill.role)) return undefined;
  return normalizeSkillBinding({
    name: skill.name,
    role: skill.role,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

function readSkillConfig(value: unknown): TodoSkillConfig | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  return normalizeSkillConfig({
    name: skill.name,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

function appendLegacySkill(bindings: TodoSkillBinding[], value: unknown): void {
  const skill = readSkillConfig(value);
  if (skill) bindings.push({ ...skill, role: "primary" });
}

function readSkillActivation(value: unknown): SkillActivationMetadata | undefined {
  const record = asRecord(value);
  if (
    !record
    || typeof record.activationId !== "string"
    || typeof record.stackRevision !== "string"
    || typeof record.activatedAt !== "number"
    || typeof record.validatedAt !== "number"
    || !["active", "stale"].includes(String(record.state))
  ) return undefined;
  const bindings = readActivationBindings(record.bindings);
  return {
    activationId: record.activationId,
    stackRevision: record.stackRevision,
    activatedAt: record.activatedAt,
    validatedAt: record.validatedAt,
    state: record.state as SkillActivationMetadata["state"],
    bindings,
  };
}

function readActivationBindings(value: unknown): SkillActivationBindingMetadata[] {
  if (!Array.isArray(value)) return [];
  const bindings: SkillActivationBindingMetadata[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      !record
      || !isSkillRole(record.role)
      || typeof record.name !== "string"
      || typeof record.filePath !== "string"
    ) continue;
    bindings.push({
      role: record.role,
      name: record.name,
      ...(typeof record.args === "string" ? { args: record.args } : {}),
      filePath: record.filePath,
      contentHash: typeof record.contentHash === "string" ? record.contentHash : "",
      configHash: typeof record.configHash === "string" ? record.configHash : "",
      requiredReadingHash: typeof record.requiredReadingHash === "string" ? record.requiredReadingHash : "",
      compiledKey: typeof record.compiledKey === "string" ? record.compiledKey : "",
      requiredFiles: stringArray(record.requiredFiles),
      deferredFiles: stringArray(record.deferredFiles),
      totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    });
  }
  return bindings;
}

function readLegacySkillActivation(
  taskId: string,
  value: unknown,
  skills: readonly TodoSkillBinding[],
): SkillActivationMetadata | undefined {
  const record = asRecord(value);
  const primary = skills.find((skill) => skill.role === "primary") ?? skills[0];
  if (!record || !primary || typeof record.filePath !== "string") return undefined;
  const activatedAt = typeof record.loadedAt === "string" ? Date.parse(record.loadedAt) : Date.now();
  return {
    activationId: `legacy-${taskId}`,
    stackRevision: "",
    activatedAt: Number.isFinite(activatedAt) ? activatedAt : Date.now(),
    validatedAt: Number.isFinite(activatedAt) ? activatedAt : Date.now(),
    state: "stale",
    bindings: [{
      role: primary.role,
      name: primary.name,
      ...(primary.args ? { args: primary.args } : {}),
      filePath: record.filePath,
      contentHash: "",
      configHash: "",
      requiredReadingHash: "",
      compiledKey: "",
      requiredFiles: stringArray(record.requiredFiles),
      deferredFiles: stringArray(record.deferredFiles),
      totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    }],
  };
}

function appendLegacyValue(parts: string[], tag: string, value: unknown): void {
  if (typeof value === "string" && value) parts.push(wrapLegacyBlock(tag, value));
}

function wrapLegacyBlock(tag: string, value: string): string {
  return `<${tag}>\n${value}\n</${tag}>`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return ["pending", "in_progress", "completed", "blocked", "deleted"].includes(String(value));
}

function isSkillRole(value: unknown): value is TodoSkillRole {
  return ["primary", "guard", "support"].includes(String(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function snapshotDetails(action: string, error?: string): TodoResultDetails {
  const visible = getVisibleTasks();
  return { action, tasks: visible, ...(error ? { error } : {}) };
}

function ok(text: string, action = "unknown"): AgentToolResult {
  return { content: [{ type: "text", text }], details: snapshotDetails(action) };
}

function err(text: string, action = "unknown"): AgentToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true, details: snapshotDetails(action, text) };
}
