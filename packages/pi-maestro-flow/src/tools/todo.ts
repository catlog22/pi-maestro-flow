import { randomUUID } from "node:crypto";
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
const TODO_STATE_VERSION = 3;
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
        return handleUpdate(params, ctx);
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

  const blockedBy = params.blockedBy ?? [];
  for (const depId of blockedBy) {
    if (!tasks.has(depId)) return err(`blockedBy references unknown task: ${depId}`, "create");
    const dep = tasks.get(depId)!;
    if (dep.status === "deleted") return err(`blockedBy references deleted task: ${depId}`, "create");
  }

  const task: TodoTask = {
    id,
    subject: params.subject,
    description: params.description,
    status: blockedBy.length > 0 ? "blocked" : "pending",
    blockedBy,
    skills: params.skills ?? [],
    ...(params.context ? { context: params.context } : {}),
    createdAt: now,
    updatedAt: now,
  };

  if (hasCycle(id, blockedBy)) return err("blockedBy would create a dependency cycle", "create");

  tasks.set(id, task);
  markTodoChanged();
  persist();
  updateStatusLine(ctx);

  return ok(`Created #${id}: ${task.subject} (${task.status})`, "create");
}

function handleUpdate(params: TodoParams, ctx: ExtensionContext): AgentToolResult {
  if (!params.id) return err("id is required for update", "update");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "update");
  if (task.status === "deleted") return err(`Cannot update deleted task: ${params.id}`, "update");

  const before = structuredClone(task);

  if (params.status === "in_progress" && task.status !== "in_progress") {
    const active = findActiveTask(task.id);
    if (active) {
      return err(`Task #${active.id} is already in progress; complete or pause it before activating another task`, "update");
    }
  }

  if (params.subject !== undefined) task.subject = params.subject;
  if (params.description !== undefined) task.description = params.description;
  if (params.summary !== undefined) task.summary = params.summary;

  if (params.context !== undefined) {
    if (params.context === "") delete task.context;
    else task.context = params.context;
    task.skillActivation = undefined;
    clearSkillSnapshot(task.id);
  }

  if (params.skills !== undefined) {
    task.skills = params.skills ?? [];
    task.skillActivation = undefined;
    clearSkillSnapshot(task.id);
  }

  if (params.blockedBy !== undefined) {
    for (const depId of params.blockedBy) {
      if (!tasks.has(depId)) return err(`blockedBy references unknown task: ${depId}`, "update");
      if (depId === task.id) return err("Task cannot block itself", "update");
    }
    if (hasCycle(task.id, params.blockedBy)) return err("blockedBy would create a dependency cycle", "update");
    task.blockedBy = params.blockedBy;
  }

  if (params.status !== undefined && params.status !== task.status) {
    if (!isValidTransition(task.status, params.status)) {
      return err(`Invalid status transition: ${task.status} → ${params.status}`, "update");
    }
    task.status = params.status;
    if (params.status !== "in_progress") {
      clearSkillSnapshot(task.id);
      if (params.status === "pending") task.skillActivation = undefined;
    }

    if (params.status === "completed") {
      autoUnblock(task.id, ctx);
    }
  }

  const changed = taskChanged(before, task);
  if (changed) {
    task.updatedAt = Date.now();
    markTodoChanged();
  }
  persist();
  updateStatusLine(ctx);

  if (changed) {
    const statusNote = before.status !== task.status ? ` (${before.status} → ${task.status})` : "";
    return ok(`Updated #${task.id}: ${task.subject}${statusNote}`, "update");
  }
  return ok(`No change: #${task.id}`, "update");
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

  task.status = "deleted";
  task.updatedAt = Date.now();
  markTodoChanged();

  for (const t of tasks.values()) {
    if (t.status !== "deleted" && t.blockedBy.includes(params.id)) {
      t.blockedBy = t.blockedBy.filter((d) => d !== params.id);
      if (t.blockedBy.length === 0 && t.status === "blocked") {
        t.status = "pending";
        t.updatedAt = Date.now();
      }
    }
  }

  persist();
  updateStatusLine(ctx);
  return ok(`Deleted #${task.id}: ${task.subject}`, "delete");
}

function handleClear(ctx: ExtensionContext): AgentToolResult {
  const count = [...tasks.values()].filter((t) => t.status !== "deleted").length;
  tasks.clear();
  markTodoChanged();
  persist();
  updateStatusLine(ctx);
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
    return ok("All tasks completed or no tasks exist.", "next");
  }

  const task = pending[0];
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

  const activation = await requireSkillRuntime().activate(task.skills, task.context ?? "");
  for (const binding of activation.skills) {
    parts.push(`\n<skill_prompt role="${binding.role}">\n${binding.skill.prompt}\n</skill_prompt>`);
  }

  task.status = "in_progress";
  task.skillActivation = {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
  activeSkillSnapshot = { taskId: task.id, activation };
  task.updatedAt = Date.now();
  markTodoChanged();
  persist();
  updateStatusLine(ctx);

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
    ...(task.skillActivation
      ? {
          skillActivation: {
            ...task.skillActivation,
            bindings: task.skillActivation.bindings.map(cloneActivationBinding),
          },
        }
      : {}),
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

function autoUnblock(completedId: string, ctx: ExtensionContext): void {
  for (const t of tasks.values()) {
    if (t.status === "deleted") continue;
    if (!t.blockedBy.includes(completedId)) continue;
    t.blockedBy = t.blockedBy.filter((d) => d !== completedId);
    if (t.blockedBy.length === 0 && t.status === "blocked") {
      t.status = "pending";
      t.updatedAt = Date.now();
    }
  }
  updateStatusLine(ctx);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(): void {
  extensionApi?.appendEntry?.(TODO_STATE_ENTRY_TYPE, {
    version: TODO_STATE_VERSION,
    tasks: Object.fromEntries(tasks),
  });
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
  return loaded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateStatusLine(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }): void {
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
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
    JSON.stringify(before.skills) !== JSON.stringify(after.skills)
  );
}

function requireSkillRuntime(): SkillRuntime {
  if (!skillRuntime) throw new Error("todo skill runtime is not initialized");
  return skillRuntime;
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
    task.skillActivation = nextMetadata;
    markTodoChanged();
    persist();
  }
  activeSkillSnapshot = { taskId: task.id, activation };
  return activation;
}

function clearSkillSnapshot(taskId?: string): void {
  if (!taskId || activeSkillSnapshot?.taskId === taskId) activeSkillSnapshot = undefined;
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
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
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
