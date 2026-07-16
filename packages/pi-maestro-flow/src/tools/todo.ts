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
  filter?: { status?: TaskStatus };
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
const TODO_STATE_VERSION = 4;
const STATUS_KEY = "todo";

let tasks: Map<string, TodoTask> = new Map();
let extensionApi: ExtensionAPI | undefined;
let skillLoader: TodoSkillLoader | undefined;
let skillRuntime: SkillRuntime | undefined;
let activeSkillSnapshot: { taskId: string; activation: SkillActivation } | undefined;
let runInjectedStackRevision: string | undefined;
let todoRevision = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

export function onSessionStart(ctx: TodoContext): void {
  skillLoader = ctx.skillLoader ?? new TodoSkillLoader({ cwd: ctx.cwd });
  skillRuntime = new SkillRuntime(skillLoader);
  activeSkillSnapshot = undefined;
  runInjectedStackRevision = undefined;
  tasks = loadTasksFromSession(ctx);
  markTodoChanged();
  updateStatusLine(ctx);
}

export function onSessionShutdown(ctx: TodoContext): void {
  tasks.clear();
  skillLoader = undefined;
  skillRuntime = undefined;
  activeSkillSnapshot = undefined;
  runInjectedStackRevision = undefined;
  markTodoChanged();
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function getVisibleTasks(): TodoTask[] {
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
  visible.sort((a, b) => a.createdAt - b.createdAt);
  return visible;
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

  const idsByOrigin = new Map<string, string>();
  for (const spec of specs) {
    const key = todoOriginKey(spec.origin);
    idsByOrigin.set(key, existingByOrigin.get(key)?.id ?? mirrorTaskId(key));
  }
  const desiredKeys = new Set(idsByOrigin.keys());
  const incomingSessions = new Set(specs.map((spec) => spec.origin.sessionId));
  const authoritativeProjection = sessionGeneration !== undefined;

  for (const spec of specs) {
    const key = todoOriginKey(spec.origin);
    const existing = existingByOrigin.get(key);
    if (existing?.status === "deleted") {
      result.unchanged.push(existing.id);
      continue;
    }
    const id = uniqueMirrorId(idsByOrigin.get(key)!, key, nextTasks);
    idsByOrigin.set(key, id);
    const blockedBy = spec.blockedByOriginKeys
      .map((originKey) => idsByOrigin.get(originKey))
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
      origin: { ...spec.origin },
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
    commitTodoState(nextTasks, ctx);
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
  const active = findActiveTask();
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
  const active = findActiveTask();
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
): Promise<AgentToolResult> {
  const { action } = input;
  try {
    const params = normalizeTodoParams(input);
    switch (action) {
      case "create":
        return handleCreate(params, ctx);
      case "update":
        return await handleUpdate(params, ctx);
      case "list":
        return handleList(params);
      case "get":
        return handleGet(params);
      case "delete":
        return handleDelete(params, ctx);
      case "clear":
        return handleClear(ctx);
      case "next":
        return await handleNext(ctx);
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

function handleCreate(params: TodoParams, ctx: ExtensionContext): AgentToolResult {
  if (!params.subject) return err("subject is required for create", "create");

  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  const blockerResolution = resolveBlockedBy(id, params.blockedBy ?? []);
  if (blockerResolution.error) return err(blockerResolution.error, "create");
  const blockedBy = blockerResolution.blockedBy;

  const task: TodoTask = {
    id,
    subject: params.subject,
    description: params.description,
    status: blockedBy.length > 0 ? "blocked" : "pending",
    blockedBy,
    skills: params.skills ?? [],
    ...(params.context ? { context: params.context } : {}),
    ...(params.planHandoffKey ? { planHandoffKey: params.planHandoffKey } : {}),
    createdAt: now,
    updatedAt: now,
  };

  if (hasCycle(id, blockedBy)) return err("blockedBy would create a dependency cycle", "create");

  const nextTasks = new Map(tasks);
  nextTasks.set(id, task);
  commitTodoState(nextTasks, ctx);

  return ok(`Created #${id}: ${task.subject} (${task.status})`, "create");
}

async function handleUpdate(params: TodoParams, ctx: ExtensionContext): Promise<AgentToolResult> {
  if (!params.id) return err("id is required for update", "update");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "update");
  if (task.status === "deleted") return err(`Cannot update deleted task: ${params.id}`, "update");

  const before = cloneTodoTask(task);
  const draft = cloneTodoTask(task);

  if (params.subject !== undefined) draft.subject = params.subject;
  if (params.description !== undefined) draft.description = params.description;
  if (params.summary !== undefined) draft.summary = params.summary;

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
  if (draft.status === "in_progress" && before.status !== "in_progress") {
    const active = findActiveTask(draft.id);
    if (active) {
      return err(`Task #${active.id} is already in progress; complete or pause it before activating another task`, "update");
    }
  }

  if (draft.status !== before.status && !isValidTransition(before.status, draft.status)) {
    return err(`Invalid status transition: ${before.status} → ${draft.status}`, "update");
  }

  const activationInputsChanged = before.context !== draft.context
    || JSON.stringify(before.skills) !== JSON.stringify(draft.skills);
  const shouldActivate = draft.status === "in_progress"
    && (before.status !== "in_progress" || activationInputsChanged || !draft.skillActivation);
  const activation = shouldActivate ? await activateTask(draft) : undefined;
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
  commitTodoState(nextTasks, ctx);
  if (activation) {
    activeSkillSnapshot = { taskId: draft.id, activation };
    runInjectedStackRevision = undefined;
  } else if (activationInputsChanged || draft.status !== "in_progress") {
    clearSkillSnapshot(draft.id);
  }

  const statusNote = before.status !== draft.status ? ` (${before.status} → ${draft.status})` : "";
  return ok(`Updated #${draft.id}: ${draft.subject}${statusNote}`, "update");
}

function handleList(params: TodoParams): AgentToolResult {
  let filtered = getVisibleTasks();

  if (params.filter?.status) {
    filtered = filtered.filter((t) => t.status === params.filter!.status);
  }

  if (filtered.length === 0) {
    return ok("No tasks found.", "list");
  }

  const lines = filtered.map((t) => {
    const depTag = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
    return `${statusIcon(t.status)} #${t.id} ${t.subject}${depTag}`;
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

function handleDelete(params: TodoParams, ctx: ExtensionContext): AgentToolResult {
  if (!params.id) return err("id is required for delete", "delete");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "delete");

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

  commitTodoState(nextTasks, ctx);
  clearCommittedSkillSnapshots(new Set([deleted.id]));
  return ok(`Deleted #${deleted.id}: ${deleted.subject}`, "delete");
}

function handleClear(ctx: ExtensionContext): AgentToolResult {
  const count = [...tasks.values()].filter((t) => t.status !== "deleted").length;
  const nextTasks = new Map<string, TodoTask>();
  commitTodoState(nextTasks, ctx);
  clearSkillSnapshot();
  return ok(`Cleared ${count} task(s).`, "clear");
}

async function handleNext(ctx: ExtensionContext): Promise<AgentToolResult> {
  const active = findActiveTask();
  if (active) {
    return err(`Task #${active.id} is already in progress; complete or pause it before activating another task`, "next");
  }

  const pending = [...tasks.values()]
    .filter((t) => t.status === "pending" && t.blockedBy.length === 0)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (pending.length === 0) {
    const inProgress = [...tasks.values()].filter((t) => t.status === "in_progress");
    if (inProgress.length > 0) {
      return ok(`No pending tasks. ${inProgress.length} task(s) in progress.`, "next");
    }
    const blocked = getVisibleTasks().filter(
      (task) => task.status === "blocked" || (task.status === "pending" && task.blockedBy.length > 0),
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

  const activation = await activateTask(draft);
  for (const binding of activation.skills) {
    parts.push(`\n<skill_prompt role="${binding.role}">\n${binding.skill.prompt}\n</skill_prompt>`);
  }

  draft.status = "in_progress";
  draft.skillActivation = activationMetadata(activation);
  draft.updatedAt = Date.now();
  const nextTasks = new Map(tasks);
  nextTasks.set(draft.id, draft);
  commitTodoState(nextTasks, ctx);
  activeSkillSnapshot = { taskId: draft.id, activation };
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
  ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } },
): void {
  persist(nextTasks);
  updateStatusLine(ctx, nextTasks);
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

function updateStatusLine(
  ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } },
  state: Map<string, TodoTask> = tasks,
): void {
  const visible = [...state.values()].filter((t) => t.status !== "deleted");
  if (visible.length === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const done = visible.filter((t) => t.status === "completed").length;
  const inProg = visible.filter((t) => t.status === "in_progress").length;
  const pending = visible.filter((t) => t.status === "pending" || t.status === "blocked").length;
  ctx.ui.setStatus(STATUS_KEY, `${done}/${visible.length} done${inProg ? ` ${inProg} running` : ""}${pending ? ` ${pending} pending` : ""}`);
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
    JSON.stringify(before.origin) !== JSON.stringify(after.origin)
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
  if (
    activeSkillSnapshot?.taskId === task.id
    && activeSkillSnapshot.activation.stackRevision === task.skillActivation?.stackRevision
  ) {
    return activeSkillSnapshot.activation;
  }
  const activation = await requireSkillRuntime().activate(
    task.skills,
    task.context ?? "",
    task.skillActivation,
  );
  const nextMetadata: SkillActivationMetadata = {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
  if (JSON.stringify(task.skillActivation) !== JSON.stringify(nextMetadata)) {
    const draft = cloneTodoTask(task);
    draft.skillActivation = nextMetadata;
    const nextTasks = new Map(tasks);
    nextTasks.set(draft.id, draft);
    persist(nextTasks);
    tasks = nextTasks;
    markTodoChanged();
  }
  activeSkillSnapshot = { taskId: task.id, activation };
  return activation;
}

function clearSkillSnapshot(taskId?: string): void {
  if (!taskId || activeSkillSnapshot?.taskId === taskId) activeSkillSnapshot = undefined;
  runInjectedStackRevision = undefined;
}

function clearCommittedSkillSnapshots(taskIds: ReadonlySet<string>): void {
  if (taskIds.size === 0) return;
  if (activeSkillSnapshot && taskIds.has(activeSkillSnapshot.taskId)) {
    activeSkillSnapshot = undefined;
  }
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

function findActiveTask(excludeId?: string): TodoTask | undefined {
  return [...tasks.values()].find(
    (task) => task.status === "in_progress" && task.id !== excludeId,
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
    ...(typeof origin.runId === "string" ? { runId: origin.runId } : {}),
    ...(typeof origin.runSeq === "string" ? { runSeq: origin.runSeq } : {}),
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
