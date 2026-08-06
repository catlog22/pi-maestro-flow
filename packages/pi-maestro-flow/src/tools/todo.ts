import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FlowToolResult } from "./tool-result.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getActiveGoal, getGoalById, switchCurrentGoal } from "./goal.ts";
import {
  TodoSkillLoader,
  type TodoSkillConfig,
} from "../skills/skill-loader.ts";
import type {
  LoadedTodoSkillBinding,
  TodoSkillBinding,
  TodoSkillRole,
} from "../skills/skill-composer.ts";
import {
  SkillRuntime,
  type AnySkillActivation,
  type SkillActivation,
  type SkillActivationMetadata,
} from "../skills/skill-runtime.ts";
import {
  todoOriginKey,
  type TodoMirrorTaskSpec,
  type TodoTaskOrigin,
} from "../session/types.ts";
import type { TodoUpdateField } from "./todo-contract.ts";
import {
  TODO_STATE_VERSION,
  assertTodoGeneration,
  configureTodoSerialization,
  isTodoMutation,
  loadTasksFromSession,
  persist,
} from "./todo-serialization.ts";
import {
  activateTask,
  activationMetadata,
  assertActiveSkillStack,
  clearCommittedSkillSnapshots,
  clearSkillSnapshot,
  cloneActivationBinding,
  configureTodoSkillEngine,
  createActiveSkillMessage,
  createContextInjectionAnchor,
  degradedActivation,
  formatSkillBinding,
  normalizeSkillBindings,
  normalizeTodoParams,
  requireSkillRuntime,
  resolveContextInjectionAnchor,
  type RunSkillInjection,
} from "./todo-skill-engine.ts";

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
  goalId?: string;
  createdBy: TodoActorRef;
  assignee: TodoActorRef;
  createdAt: number;
  updatedAt: number;
}

export interface TodoBatchSpec {
  subject: string;
  description?: string;
  context?: string;
  skills?: TodoSkillBinding[];
  assignee?: string;
  blockedBy?: number[];
  goalId?: string;
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
  updateFields?: TodoUpdateField[];
  id?: string;
  assignee?: string;
  tasks?: TodoBatchSpec[];
  filter?: { status?: TaskStatus; memberId?: string };
  planHandoffKey?: string;
  goalId?: string;
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

let tasks: Map<string, TodoTask> = new Map();
let nextTaskId = 0;
let knownActors: Map<string, TodoActorRef> = new Map([[ROOT_TODO_ACTOR.id, ROOT_TODO_ACTOR]]);
let extensionApi: ExtensionAPI | undefined;
let onTodoStateChanged: (() => void) | undefined;
let skillLoader: TodoSkillLoader | undefined;
let skillRuntime: SkillRuntime | undefined;
let activeSkillSnapshots: Map<string, SkillActivation> = new Map();
let runSkillInjection: RunSkillInjection | undefined;
let todoRevision = 0;
let todoGeneration = 0;
let todoSessionLoaded = false;
let todoMutationQueue: Promise<void> = Promise.resolve();

configureTodoSerialization({
  getExtensionApi: () => extensionApi,
  getTasks: () => tasks,
  getTodoGeneration: () => todoGeneration,
  rootActor: ROOT_TODO_ACTOR,
});
configureTodoSkillEngine({
  getSkillRuntime: () => skillRuntime,
  getActiveSkillSnapshots: () => activeSkillSnapshots,
  getRunSkillInjection: () => runSkillInjection,
  setRunSkillInjection: (injection) => {
    runSkillInjection = injection;
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

export function onSessionStart(ctx: TodoContext): void {
  todoGeneration++;
  todoSessionLoaded = false;
  todoMutationQueue = Promise.resolve();
  skillLoader = ctx.skillLoader ?? new TodoSkillLoader({ cwd: ctx.cwd });
  skillRuntime = new SkillRuntime(skillLoader);
  activeSkillSnapshots = new Map();
  runSkillInjection = undefined;
  tasks = loadTasksFromSession(ctx);
  syncTaskIdCounter();
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  for (const task of tasks.values()) {
    rememberActor(task.createdBy);
    rememberActor(task.assignee);
  }
  todoSessionLoaded = true;
  markTodoChanged();
  ctx.ui.setStatus("todo", undefined);
}

export function onSessionShutdown(ctx: TodoContext): void {
  todoGeneration++;
  todoSessionLoaded = false;
  todoMutationQueue = Promise.resolve();
  tasks.clear();
  nextTaskId = 0;
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  skillLoader = undefined;
  skillRuntime = undefined;
  activeSkillSnapshots.clear();
  runSkillInjection = undefined;
  markTodoChanged();
  ctx.ui.setStatus("todo", undefined);
}

export function isolateTodoForTeammateAttach(): void {
  let changed = false;
  const next = new Map(tasks);
  for (const [id, task] of next) {
    if (task.status !== "in_progress" || task.assignee.id !== ROOT_TODO_ACTOR.id || task.skills.length === 0) continue;
    next.set(id, {
      ...task,
      status: "pending",
      skillActivation: undefined,
      updatedAt: Date.now(),
    });
    changed = true;
  }
  if (!changed) return;
  tasks = next;
  activeSkillSnapshots.clear();
  runSkillInjection = undefined;
  persist(tasks);
  markTodoChanged();
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
  _event: { systemPrompt: string },
): Promise<{ systemPrompt: string } | undefined> {
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) {
    runSkillInjection = undefined;
  }
  return undefined;
}

export async function onContextTodo(
  messages: AgentMessage[],
): Promise<{ messages: AgentMessage[] } | undefined> {
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) return undefined;
  const activation = await ensureSkillActivation(active);
  assertActiveSkillStack(active, activation);
  if (runSkillInjection?.taskId === active.id
    && runSkillInjection.stackRevision === activation.stackRevision
    && runSkillInjection.channel === "system") return undefined;
  if (runSkillInjection?.taskId !== active.id
    || runSkillInjection.stackRevision !== activation.stackRevision
    || runSkillInjection.channel !== "context") {
    runSkillInjection = {
      taskId: active.id,
      stackRevision: activation.stackRevision,
      channel: "context",
      anchor: createContextInjectionAnchor(messages),
    };
  }
  const anchor = resolveContextInjectionAnchor(messages, runSkillInjection.anchor);
  runSkillInjection.anchor = anchor;
  const injected = createActiveSkillMessage(active, activation);
  return {
    messages: [
      ...messages.slice(0, anchor.index),
      injected,
      ...messages.slice(anchor.index),
    ],
  };
}

export function onAgentEndTodo(): void {
  runSkillInjection = undefined;
}

export async function executeTodo(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef = ROOT_TODO_ACTOR,
): Promise<FlowToolResult> {
  const generation = todoGeneration;
  const execute = () => executeTodoAction(input, ctx, actor, generation);
  if (!isTodoMutation(input.action)) return execute();

  const result = todoMutationQueue.then(execute, execute);
  todoMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Auto-delegation hook for `teammate:started` events that carry `todo`
 * bindings (tasks[].todo at dispatch time, single id or ordered array). Each
 * bound task's assignee moves from root to the agent, and the first runnable
 * one (priority order, pending and not blocked) is auto-activated so the
 * agent can drive it immediately without calling `todo next`.
 */
export interface TodoDelegationResult {
  /** Task ids whose assignee now is the agent. */
  delegated: string[];
  /** Task ids whose assignee was actually changed by this delegation. */
  reassigned: string[];
  /** Task ids auto-activated (at most one unless one was already active). */
  activated: string[];
  /** Human-readable errors for bindings that could not be delegated. */
  errors: string[];
}

/**
 * Delegate an ordered list of Todo tasks to an agent and auto-activate the
 * first runnable one. Blocked tasks keep their state (they auto-unblock when
 * the dependency completes); already-active tasks are preserved; if the agent
 * already holds an in_progress task, nothing new is activated (one
 * in_progress per actor).
 */
export async function delegateTodoTasksToAgent(
  todos: readonly string[],
  actor: TodoActorRef,
  ctx: ExtensionContext,
): Promise<TodoDelegationResult> {
  const delegated: string[] = [];
  const reassigned: string[] = [];
  const activated: string[] = [];
  const errors: string[] = [];
  if (todos.length === 0) return { delegated, reassigned, activated, errors };
  // Mirror the started-event listener: the agent's identity must be known to
  // the assignee selector before the update resolves `actor.id`.
  rememberActor(actor);
  let alreadyActive = findActiveTask(actor.id) !== undefined;
  for (const raw of todos) {
    const trimmed = String(raw).trim();
    const id = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    if (!id) {
      errors.push("Todo delegation: empty task id.");
      continue;
    }
    const task = tasks.get(id);
    if (!task || task.status === "deleted") {
      errors.push(`Todo delegation: unknown task "${raw}"; no assignment performed.`);
      continue;
    }
    if (task.assignee.id !== actor.id) {
      const result = await executeTodo(
        { action: "update", id, assignee: actor.id },
        ctx,
        ROOT_TODO_ACTOR,
      );
      if (result.isError) {
        errors.push(`Todo delegation: task #${id} failed to reassign: ${result.content[0] && "text" in result.content[0] ? result.content[0].text : "unknown"}`);
        continue;
      }
      reassigned.push(id);
    }
    delegated.push(id);
  }
  // Auto-activate the highest-priority runnable task (first pending,
  // non-blocked binding). A task already in_progress counts as activated.
  for (const id of delegated) {
    const task = tasks.get(id);
    if (!task || task.status === "completed" || task.status === "deleted") continue;
    if (task.status === "in_progress") {
      activated.push(id);
      break;
    }
    if (task.status !== "pending" || task.blockedBy.length > 0) continue;
    if (alreadyActive) break;
    const result = await executeTodo(
      { action: "update", id, status: "in_progress" },
      ctx,
      ROOT_TODO_ACTOR,
    );
    if (!result.isError) {
      activated.push(id);
      alreadyActive = true;
    }
    break;
  }
  return { delegated, reassigned, activated, errors };
}

/**
 * Single-binding convenience wrapper over {@link delegateTodoTasksToAgent};
 * returns a FlowToolResult for callers that need one (e.g. tests).
 */
export async function delegateTodoTaskToAgent(
  taskId: string,
  actor: TodoActorRef,
  ctx: ExtensionContext,
): Promise<FlowToolResult> {
  const result = await delegateTodoTasksToAgent([taskId], actor, ctx);
  if (result.errors.length > 0) return err(result.errors[0], "update");
  const id = result.delegated[0] ?? "";
  const task = tasks.get(id);
  if (task && result.reassigned.length === 0) {
    return ok(`Todo task #${id} already assigned to @${actor.label}${result.activated.length > 0 ? ` (active #${result.activated[0]})` : ""}.`, "update");
  }
  const extra = result.activated.length > 0
    ? `; activated #${result.activated[0]}`
    : task && task.status === "blocked" && task.blockedBy.length > 0
      ? ` (blocked by ${task.blockedBy.map((depId) => `#${depId}`).join(", ")}; auto-unblocks when the dependency completes)`
      : "";
  return ok(
    id
      ? `Todo task #${id} delegated to @${actor.label}${extra}.`
      : "Todo delegation: no task delegated.",
    "update",
  );
}

export interface TodoSealResult {
  /** Task ids auto-sealed to `completed` on a successful agent completion. */
  sealed: string[];
}

/**
 * Auto-seal hook for `teammate:complete`. On a clean agent exit (exitCode 0
 * and not cancelled) every task the agent left `in_progress` is sealed to
 * `completed` with a marker summary, so a delegated task never dangles after
 * its agent finishes — even if the agent forgot to update it. Pending/blocked
 * tasks are left untouched (the agent never activated them), and failed or
 * cancelled runs leave everything as-is.
 */
export async function sealTodoTasksOnAgentComplete(
  actor: TodoActorRef,
  exitCode: number,
  cancelled: boolean,
  ctx: ExtensionContext,
): Promise<TodoSealResult> {
  const sealed: string[] = [];
  if (exitCode !== 0 || cancelled) return { sealed };
  const candidates = getVisibleTasks().filter(
    (task) => task.assignee.id === actor.id && task.status === "in_progress",
  );
  for (const task of candidates) {
    const result = await executeTodo(
      {
        action: "update",
        id: task.id,
        status: "completed",
        summary: `Agent @${actor.label} finished (auto-sealed by teammate:complete)`,
      },
      ctx,
      ROOT_TODO_ACTOR,
    );
    if (!result.isError) sealed.push(task.id);
  }
  return { sealed };
}

async function executeTodoAction(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<FlowToolResult> {
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

function handleCreate(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): FlowToolResult {
  // `status`/`summary` are update-only concepts. Silently dropping them here
  // would make a create that passes JSON Schema validation behave differently
  // than the caller intended.
  const rejected: string[] = [];
  if (params.status !== undefined) rejected.push("status");
  if (params.summary !== undefined) rejected.push("summary");
  if (rejected.length > 0) {
    return err(`create does not support ${rejected.join(" and ")}; they are set via update`, "create");
  }
  if (params.tasks && params.tasks.length > 0) {
    const conflicting: string[] = [];
    if (params.subject !== undefined) conflicting.push("subject");
    if (params.description !== undefined) conflicting.push("description");
    if (params.blockedBy !== undefined) conflicting.push("blockedBy");
    if (params.assignee !== undefined) conflicting.push("assignee");
    if (params.context !== undefined) conflicting.push("context");
    if (params.skills !== undefined) conflicting.push("skills");
    if (params.goalId !== undefined) conflicting.push("goalId");
    if (conflicting.length > 0) {
      return err(`create accepts either a single task (subject) or a batch (tasks), not both; ${conflicting.join(", ")} cannot accompany tasks.`, "create");
    }
    return handleBatchCreate(params.tasks, actor, params.planHandoffKey);
  }
  const subject = params.subject?.trim();
  if (!subject) return err("subject is required for create", "create");

  const id = allocateTaskId();
  const now = Date.now();

  const blockerResolution = resolveBlockedBy(id, params.blockedBy ?? []);
  if (blockerResolution.error) return err(blockerResolution.error, "create");
  const blockedBy = blockerResolution.blockedBy;
  const assignee = resolveAssignee(params.assignee, actor);
  if ("error" in assignee) return err(assignee.error, "create");

  const task: TodoTask = {
    id,
    subject,
    description: params.description,
    status: blockedBy.length > 0 ? "blocked" : "pending",
    blockedBy,
    skills: params.skills ?? [],
    ...(params.context ? { context: params.context } : {}),
    ...(params.planHandoffKey ? { planHandoffKey: params.planHandoffKey } : {}),
    ...(params.goalId ? { goalId: params.goalId } : {}),
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

/**
 * Create an entire multi-step plan in one call. Array order is the execution
 * order (monotonic createdAt); each blockedBy integer is a zero-based index
 * into this same batch. The whole batch commits atomically — any invalid
 * spec aborts the create without touching existing state.
 */
function handleBatchCreate(specs: TodoBatchSpec[], actor: TodoActorRef, planHandoffKey?: string): FlowToolResult {
  const nextTasks = cloneTaskMap();

  const ids: string[] = [];
  const reserved = new Set<string>(nextTasks.keys());
  for (let i = 0; i < specs.length; i++) {
    const id = allocateTaskId();
    reserved.add(id);
    ids.push(id);
  }

  const resolvedDeps: string[][] = [];
  for (let i = 0; i < specs.length; i++) {
    const deps: string[] = [];
    for (const index of specs[i].blockedBy ?? []) {
      if (!Number.isInteger(index) || index < 0) {
        return err(`tasks[${i}].blockedBy contains invalid batch index ${index}; indexes must be non-negative integers.`, "create");
      }
      if (index >= i) {
        const validRange = i === 0
          ? "tasks[0] cannot have dependencies because it has no earlier batch items"
          : `valid indexes for tasks[${i}] are 0 through ${i - 1}`;
        return err(
          `tasks[${i}].blockedBy index ${index} must reference an earlier batch item; ${validRange}.`,
          "create",
        );
      }
      deps.push(ids[index]);
    }
    resolvedDeps.push(deps);
  }

  const created: TodoTask[] = [];
  let clock = Date.now();
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const subject = spec.subject?.trim();
    if (!subject) return err(`tasks[${i}].subject is required`, "create");

    const blockerResolution = resolveBlockedBy(ids[i], resolvedDeps[i], nextTasks);
    if (blockerResolution.error) return err(`tasks[${i}]: ${blockerResolution.error}`, "create");
    const blockedBy = blockerResolution.blockedBy;

    const assignee = resolveAssignee(spec.assignee, actor);
    if ("error" in assignee) return err(`tasks[${i}]: ${assignee.error}`, "create");

    let skills: TodoSkillBinding[];
    try {
      skills = spec.skills ? normalizeSkillBindings(spec.skills) : [];
    } catch (e) {
      return err(`tasks[${i}]: ${e instanceof Error ? e.message : String(e)}`, "create");
    }

    clock += 1;
    const task: TodoTask = {
      id: ids[i],
      subject,
      description: spec.description,
      status: blockedBy.length > 0 ? "blocked" : "pending",
      blockedBy,
      skills,
      ...(spec.context ? { context: spec.context } : {}),
      ...(planHandoffKey ? { planHandoffKey } : {}),
      ...(spec.goalId ? { goalId: spec.goalId } : {}),
      createdBy: cloneActor(actor),
      assignee: assignee.actor,
      createdAt: clock,
      updatedAt: clock,
    };
    nextTasks.set(ids[i], task);
    created.push(task);
  }

  commitTodoState(nextTasks);

  const lines = created.map((t) => `#${t.id} ${t.subject} (${t.status})`);
  return ok(`Created ${created.length} tasks:\n${lines.join("\n")}`, "create");
}

async function handleUpdate(
  params: TodoParams,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<FlowToolResult> {
  if (!params.id) return err("id is required for update", "update");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "update");
  if (task.status === "deleted") return err(`Cannot update deleted task: ${params.id}`, "update");
  if (!canEditTask(actor, task)) return err(`@${actor.label} cannot update task #${params.id}`, "update");

  const before = cloneTodoTask(task);
  const draft = cloneTodoTask(task);
  const updateFields = params.updateFields ? new Set(params.updateFields) : undefined;
  const updates = (field: TodoUpdateField): boolean =>
    updateFields ? updateFields.has(field) : params[field] !== undefined;

  if (updateFields) {
    for (const field of updateFields) {
      if (params[field] === undefined) return err(`${field} is required when listed in updateFields`, "update");
    }
  }

  if (updates("subject")) {
    const subject = params.subject!;
    if (!subject.trim()) return err("subject cannot be empty", "update");
    draft.subject = subject;
  }
  if (updates("description")) {
    if (params.description === "") delete draft.description;
    else draft.description = params.description;
  }
  if (updates("summary")) {
    if (params.summary === "") delete draft.summary;
    else draft.summary = params.summary;
  }
  if (updates("goalId")) {
    if (params.goalId === "") delete draft.goalId;
    else draft.goalId = params.goalId;
  }

  if (updates("assignee")) {
    const assignee = resolveAssignee(params.assignee!, actor);
    if ("error" in assignee) return err(assignee.error, "update");
    draft.assignee = assignee.actor;
  }

  if (updates("context")) {
    if (params.context === "") delete draft.context;
    else draft.context = params.context;
    draft.skillActivation = undefined;
  }

  if (updates("skills")) {
    draft.skills = params.skills ?? [];
    draft.skillActivation = undefined;
  }

  if (updates("blockedBy")) {
    const blockerResolution = resolveBlockedBy(draft.id, params.blockedBy!);
    if (blockerResolution.error) return err(blockerResolution.error, "update");
    draft.blockedBy = blockerResolution.blockedBy;
  }

  if (updates("status")) draft.status = params.status!;
  if (
    (updates("status") && (params.status === "pending" || params.status === "blocked"))
    || (!updates("status") && updates("blockedBy"))
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
      return err(`Task #${active.id} is already in progress for @${draft.assignee.label} (one in_progress per actor). For parallel work, dispatch teammates without changing todo status; update each task when its agent completes.`, "update");
    }
  }

  if (draft.status !== before.status && !isValidTransition(before.status, draft.status)) {
    return err(`Invalid status transition: ${before.status} → ${draft.status}`, "update");
  }

  if (draft.status === "completed" && before.status !== "completed" && draft.goalId) {
    const gate = getGoalById(draft.goalId);
    if (!gate) {
      return err(`Quality gate Goal ${draft.goalId} for task #${draft.id} was not found; cannot verify completion.`, "update");
    }
    if (gate.status !== "done") {
      // A paused Goal cannot be driven to done by `goal complete` — it has to be
      // resumed first. Pointing at the wrong command is worst exactly when the
      // Goal paused because its verifier kept erroring out.
      const how = gate.status === "paused"
        ? "Resume the Goal (/goal resume) and let it verify before completing this task."
        : "Complete the Goal (goal complete) to verify it before completing this task.";
      return err(`Quality gate Goal not verified for task #${draft.id}: "${gate.text}" (${gate.status}). ${how}`, "update");
    }
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
    runSkillInjection = undefined;
  } else if (activationInputsChanged || draft.status !== "in_progress") {
    clearSkillSnapshot(draft.id);
  }

  const statusNote = before.status !== draft.status ? ` (${before.status} → ${draft.status})` : "";
  return ok(`Updated #${draft.id}: ${draft.subject}${statusNote}`, "update");
}

function handleList(params: TodoParams, actor: TodoActorRef): FlowToolResult {
  let filtered = getVisibleTasks();

  if (params.filter?.status) {
    filtered = filtered.filter((t) => t.status === params.filter!.status);
  }
  const memberSelector = params.filter?.memberId;
  if (memberSelector) {
    const member = resolveTodoActorSelector(memberSelector, actor);
    if ("error" in member) {
      // Ambiguous and unknown selectors are both caller errors: report them
      // instead of silently filtering down to an empty list.
      return err(member.error, "list");
    }
    filtered = filtered.filter((task) => task.createdBy.id === member.actor.id
      || task.assignee.id === member.actor.id);
  }

  if (filtered.length === 0) {
    return ok("No tasks found.", "list");
  }

  // Pre-compute reverse dependency map: taskId -> list of task IDs it blocks
  const blocksMap = new Map<string, string[]>();
  for (const t of getVisibleTasks()) {
    for (const dep of t.blockedBy) {
      const existing = blocksMap.get(dep);
      if (existing) existing.push(`#${t.id}`);
      else blocksMap.set(dep, [`#${t.id}`]);
    }
  }

  const lines = filtered.map((t) => {
    const tags: string[] = [];
    if (t.blockedBy.length > 0) tags.push(`blocked by: ${t.blockedBy.join(", ")}`);
    const blocks = blocksMap.get(t.id);
    if (blocks && blocks.length > 0) tags.push(`blocks: ${blocks.join(", ")}`);
    if (t.goalId) {
      const gate = getGoalById(t.goalId);
      const goalLabel = t.goalId.length > 8 ? t.goalId.slice(0, 8) : t.goalId;
      tags.push(gate ? `goal: ${goalLabel} (${gate.status})` : `goal: ${goalLabel} (missing)`);
    }
    if (t.skills.length > 0) tags.push(`skills: ${t.skills.map((s) => s.name).join(", ")}`);
    const tagStr = tags.length > 0 ? ` [${tags.join("] [")}]` : "";
    return `${statusIcon(t.status)} ${actorTag(t)} #${t.id} ${t.subject}${tagStr}`;
  });

  return ok(lines.join("\n"), "list");
}

function handleGet(params: TodoParams): FlowToolResult {
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

function handleDelete(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): FlowToolResult {
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

function handleClear(ctx: ExtensionContext, actor: TodoActorRef): FlowToolResult {
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
): Promise<FlowToolResult> {
  const active = findActiveTask(actor.id);
  if (active) {
    return err(`Task #${active.id} is already in progress for @${actor.label} (one in_progress per actor). Complete or pause it first, or dispatch parallel work via teammates without changing todo status.`, "next");
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
  // Set when the task's quality gate is a Goal the user stopped by hand, so the notice
  // below can be appended after the header is built.
  let userStoppedGate: string | undefined;
  if (task.goalId) {
    const current = getActiveGoal();
    if (current?.id !== task.goalId || current?.status === "paused") {
      const gate = getGoalById(task.goalId);
      // `/goal stop` is the user speaking. Auto-resuming here would silently undo it,
      // and advancing a task is not consent to restart a Goal that was deliberately
      // halted. Every other pause reason is system-internal, so resuming is right there.
      if (gate?.status === "paused" && gate.pauseReason === "user") userStoppedGate = gate.text;
      switchCurrentGoal(task.goalId, ctx, { resume: !userStoppedGate });
    }
  }
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

  if (userStoppedGate) {
    parts.push(
      `\n<goal_stopped_by_user>\nThe quality-gate Goal "${userStoppedGate}" was stopped by the user and has been left stopped.`
      + `\nYou can work on this task, but completing it is blocked until the user runs /goal resume. Do not resume the Goal yourself.`
      + `\n</goal_stopped_by_user>`,
    );
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
  runSkillInjection = undefined;

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

function allocateTaskId(): string {
  return String(nextTaskId++);
}

function syncTaskIdCounter(state: Map<string, TodoTask> = tasks): void {
  let max = -1;
  for (const id of state.keys()) {
    const n = Number(id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  nextTaskId = max + 1;
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
  state: Map<string, TodoTask> = tasks,
): { blockedBy: string[]; error?: string } {
  const blockedBy: string[] = [];
  const seen = new Set<string>();
  for (const rawDepId of proposedDeps) {
    const depId = rawDepId.replace(/^#+/, "");
    if (seen.has(depId)) continue;
    seen.add(depId);
    if (depId === taskId) return { blockedBy: [], error: "Task cannot block itself" };
    const dependency = state.get(depId);
    if (!dependency) {
      return { blockedBy: [], error: `blockedBy references unknown task: ${depId}` };
    }
    if (dependency.status === "deleted") {
      return { blockedBy: [], error: `blockedBy references deleted task: ${depId}` };
    }
    if (dependency.status === "completed") continue;
    blockedBy.push(depId);
  }
  if (hasCycle(taskId, blockedBy, state)) {
    return { blockedBy: [], error: "blockedBy would create a dependency cycle" };
  }
  return { blockedBy };
}

function deriveDependencyStatus(blockedBy: readonly string[]): "blocked" | "pending" {
  return blockedBy.length > 0 ? "blocked" : "pending";
}

function hasCycle(
  taskId: string,
  proposedDeps: string[],
  state: Map<string, TodoTask> = tasks,
): boolean {
  const visited = new Set<string>();
  const stack = [...proposedDeps];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const dep = state.get(current);
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

/**
 * Drop the quality-gate binding from every task pointing at `goalId`.
 *
 * Mirrors {@link autoUnblock}: when an entity is destroyed, the references to it must go with
 * it. Without this, clearing a Goal leaves its bound tasks stuck at the completion gate
 * (`getGoalById` returns undefined) with no path to completion short of a manual
 * `update goalId: ""`.
 *
 * Returns the number of tasks detached so callers can surface it instead of failing silently.
 */
export function detachTasksFromGoal(goalId: string): number {
  if (!goalId) return 0;
  const next = new Map(tasks);
  let detached = 0;
  for (const [id, task] of next) {
    if (task.status === "deleted" || task.goalId !== goalId) continue;
    const draft = cloneTodoTask(task);
    delete draft.goalId;
    draft.updatedAt = Date.now();
    next.set(id, draft);
    detached += 1;
  }
  if (detached === 0) return 0;
  commitTodoState(next);
  return detached;
}

/** Persist and publish the state restored by Todo startup before a Goal recovery marker clears. */
export function persistLoadedTodoStateForGoalDetachRecovery(): void {
  if (!todoSessionLoaded) throw new Error("Todo state must be loaded before Goal cleanup recovery.");
  commitTodoState(new Map(tasks));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function commitTodoState(
  nextTasks: Map<string, TodoTask>,
): void {
  persist(nextTasks);
  tasks = nextTasks;
  markTodoChanged();
  onTodoStateChanged?.();
}

/** Bind the root UI/UCL to durable Todo state changes. */
export function setTodoStateChangeListener(listener: (() => void) | undefined): void {
  onTodoStateChanged = listener;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
        `Task #${active.id} is already in progress for @${check.draft.assignee.label} (one in_progress per actor). For parallel work, dispatch teammates without changing todo status; update each task when its agent completes.`,
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
    before.goalId !== after.goalId ||
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

async function ensureSkillActivation(task: TodoTask): Promise<AnySkillActivation> {
  const cached = activeSkillSnapshots.get(task.id);
  // Without the `cached &&` guard, a task with no cached snapshot and no
  // skillActivation compares undefined === undefined and returns undefined
  // from a function declared to yield a SkillActivation.
  if (cached && cached.stackRevision === task.skillActivation?.stackRevision) {
    return cached;
  }
  const generation = todoGeneration;
  const revisionBeforeActivation = todoRevision;
  const before = cloneTodoTask(task);
  let activation: SkillActivation;
  try {
    activation = await requireSkillRuntime().activate(
      task.skills,
      task.context ?? "",
      task.skillActivation,
    );
  } catch (error) {
    // onContextTodo is wired to pi.on("context"), so a throw here escapes into the
    // host on *every* turn and wedges the session. Re-activation is guaranteed to be
    // attempted after a restart (snapshots live in memory, persist only writes tasks),
    // so a skill file that has gone missing or invalid since activation would do
    // exactly that.
    //
    // Degrade instead: prefer the last snapshot that did load, otherwise synthesize an
    // empty activation whose prompt is a warning block. Neither is cached and neither is
    // persisted, so the next turn retries the real load and recovers on its own.
    const stale = activeSkillSnapshots.get(task.id);
    if (stale) return stale;
    return degradedActivation(task, error);
  }
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

  if (!selector.includes("#")) {
    const idPrefixMatches = [...knownActors.values()].filter((candidate) => candidate.id.startsWith(selector));
    if (idPrefixMatches.length === 1) return { actor: cloneActor(idPrefixMatches[0]) };
    if (idPrefixMatches.length > 1) {
      return {
        error: `Ambiguous Todo member selector: ${requested}; use a longer id prefix or the full member id`,
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

function snapshotDetails(action: string, error?: string): TodoResultDetails {
  const visible = getVisibleTasks();
  return { action, tasks: visible, ...(error ? { error } : {}) };
}

function ok(text: string, action = "unknown"): FlowToolResult {
  return { content: [{ type: "text", text }], details: snapshotDetails(action) };
}

function err(text: string, action = "unknown"): FlowToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true, details: snapshotDetails(action, text) };
}
