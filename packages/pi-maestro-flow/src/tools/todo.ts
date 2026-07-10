import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getActiveGoal } from "./goal.ts";
import {
  TodoSkillLoader,
  type LoadedTodoSkill,
  type TodoSkillConfig,
} from "../skills/skill-loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "deleted";

export interface TodoSkillLoadRecord {
  loadedAt: string;
  filePath: string;
  requiredFiles: string[];
  deferredFiles: string[];
  totalBytes: number;
}

export interface TodoTask {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  context?: string;
  skill?: TodoSkillConfig;
  skillLoad?: TodoSkillLoadRecord;
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
  skill?: TodoSkillConfig | null;
  summary?: string;
  id?: string;
  filter?: { status?: TaskStatus };
}

export interface InjectableContent {
  taskId: string;
  subject: string;
  description?: string;
  goalContext?: string;
  context?: string;
  skill?: LoadedTodoSkill;
  blocks: Array<{ tag: string; content: string }>;
}

export interface TodoResultDetails {
  action: string;
  tasks: TodoTask[];
  error?: string;
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
const TODO_STATE_VERSION = 2;
const STATUS_KEY = "todo";

let tasks: Map<string, TodoTask> = new Map();
let extensionApi: ExtensionAPI | undefined;
let skillLoader: TodoSkillLoader | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

export function onSessionStart(ctx: TodoContext): void {
  skillLoader = ctx.skillLoader ?? new TodoSkillLoader({ cwd: ctx.cwd });
  tasks = loadTasksFromSession(ctx);
  updateStatusLine(ctx);
}

export function onSessionShutdown(ctx: TodoContext): void {
  tasks.clear();
  skillLoader = undefined;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function getVisibleTasks(): TodoTask[] {
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
  visible.sort((a, b) => a.createdAt - b.createdAt);
  return visible;
}

export async function getInjectableContent(taskId: string): Promise<InjectableContent | null> {
  const task = tasks.get(taskId);
  if (!task) return null;

  const loader = requireSkillLoader();
  await loader.validateContext(task.context ?? "");
  const loadedSkill = task.skill ? await loader.load(task.skill, task.context ?? "") : undefined;
  const blocks: Array<{ tag: string; content: string }> = [];
  if (task.context) blocks.push({ tag: "context", content: task.context });
  if (loadedSkill) blocks.push({ tag: "skill_prompt", content: loadedSkill.prompt });

  return {
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    goalContext: getActiveGoal()?.text,
    context: task.context,
    skill: loadedSkill,
    blocks,
  };
}

export async function executeTodo(
  params: TodoParams,
  ctx: ExtensionContext,
): Promise<AgentToolResult> {
  const { action } = params;
  try {
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
    ...(params.context ? { context: params.context } : {}),
    ...(params.skill ? { skill: normalizeSkillConfig(params.skill) } : {}),
    createdAt: now,
    updatedAt: now,
  };

  if (hasCycle(id, blockedBy)) return err("blockedBy would create a dependency cycle", "create");

  tasks.set(id, task);
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

  if (params.subject !== undefined) task.subject = params.subject;
  if (params.description !== undefined) task.description = params.description;
  if (params.summary !== undefined) task.summary = params.summary;

  if (params.context !== undefined) {
    if (params.context === "") delete task.context;
    else task.context = params.context;
    task.skillLoad = undefined;
  }

  if (params.skill !== undefined) {
    if (params.skill === null) delete task.skill;
    else task.skill = normalizeSkillConfig(params.skill);
    task.skillLoad = undefined;
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

    if (params.status === "completed") {
      autoUnblock(task.id, ctx);
    }
  }

  task.updatedAt = Date.now();
  persist();
  updateStatusLine(ctx);

  if (taskChanged(before, task)) {
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
  if (task.skill) {
    lines.push(`Skill: ${task.skill.name}${task.skill.args ? ` ${task.skill.args}` : ""}`);
  }
  if (task.skillLoad) {
    lines.push(`Skill loaded: ${task.skillLoad.loadedAt}`);
    if (task.skillLoad.deferredFiles.length > 0) {
      lines.push(`Deferred reads: ${task.skillLoad.deferredFiles.join(", ")}`);
    }
  }

  return ok(lines.join("\n"), "get");
}

function handleDelete(params: TodoParams, ctx: ExtensionContext): AgentToolResult {
  if (!params.id) return err("id is required for delete", "delete");
  const task = tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "delete");

  task.status = "deleted";
  task.updatedAt = Date.now();

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
  persist();
  updateStatusLine(ctx);
  return ok(`Cleared ${count} task(s).`, "clear");
}

async function handleNext(ctx: ExtensionContext): Promise<AgentToolResult> {
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

  const loader = requireSkillLoader();
  await loader.validateContext(task.context ?? "");
  if (task.context) {
    parts.push(`\n<context>\n${task.context}\n</context>`);
  }

  let loadedSkill: LoadedTodoSkill | undefined;
  if (task.skill) {
    loadedSkill = await loader.load(task.skill, task.context ?? "");
    parts.push(`\n<skill_prompt>\n${loadedSkill.prompt}\n</skill_prompt>`);
  }

  task.status = "in_progress";
  task.skillLoad = loadedSkill ? toSkillLoadRecord(loadedSkill) : undefined;
  task.updatedAt = Date.now();
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
    JSON.stringify(before.skill) !== JSON.stringify(after.skill)
  );
}

function requireSkillLoader(): TodoSkillLoader {
  if (!skillLoader) throw new Error("todo skill loader is not initialized");
  return skillLoader;
}

function normalizeSkillConfig(skill: TodoSkillConfig): TodoSkillConfig {
  const name = skill.name.trim();
  if (!name) throw new Error("skill.name must be non-empty");
  const args = skill.args?.trim();
  return { name, ...(args ? { args } : {}) };
}

function toSkillLoadRecord(skill: LoadedTodoSkill): TodoSkillLoadRecord {
  return {
    loadedAt: skill.loadedAt,
    filePath: skill.filePath,
    requiredFiles: skill.requiredFiles,
    deferredFiles: skill.deferredFiles,
    totalBytes: skill.totalBytes,
  };
}

function normalizeLoadedTask(id: string, raw: unknown): TodoTask {
  const task = asRecord(raw) ?? {};
  const contextParts: string[] = [];
  if (typeof task.context === "string" && task.context) contextParts.push(task.context);

  let skill = readSkillConfig(task.skill);
  const legacyInject = Array.isArray(task.inject) ? task.inject : [];
  for (const item of legacyInject) {
    const entry = asRecord(item);
    if (!entry || typeof entry.source !== "string") continue;
    if (entry.type === "skill" && !skill) {
      skill = { name: entry.source };
    } else if (entry.type === "text") {
      contextParts.push(wrapLegacyBlock(typeof entry.tag === "string" ? entry.tag : "content", entry.source));
    } else if (entry.type === "file") {
      contextParts.push(wrapLegacyBlock("legacy_file_reference", entry.source));
    }
  }

  const legacyInjection = asRecord(task.injection);
  if (legacyInjection) {
    if (!skill && typeof legacyInjection.skillRef === "string") skill = { name: legacyInjection.skillRef };
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
    if (legacyLoad.type === "skill" && !skill) skill = { name: legacyLoad.source };
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
  const skillLoad = readSkillLoadRecord(task.skillLoad);

  return {
    id: typeof task.id === "string" ? task.id : id,
    subject: typeof task.subject === "string" ? task.subject : `Task ${id}`,
    ...(typeof task.description === "string" ? { description: task.description } : {}),
    status,
    blockedBy,
    ...(contextParts.length > 0 ? { context: contextParts.join("\n\n") } : {}),
    ...(skill ? { skill } : {}),
    ...(skillLoad ? { skillLoad } : {}),
    ...(summary ? { summary } : {}),
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
  };
}

function readSkillConfig(value: unknown): TodoSkillConfig | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  return normalizeSkillConfig({
    name: skill.name,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

function readSkillLoadRecord(value: unknown): TodoSkillLoadRecord | undefined {
  const record = asRecord(value);
  if (!record || typeof record.loadedAt !== "string" || typeof record.filePath !== "string") return undefined;
  return {
    loadedAt: record.loadedAt,
    filePath: record.filePath,
    requiredFiles: stringArray(record.requiredFiles),
    deferredFiles: stringArray(record.deferredFiles),
    totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
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
