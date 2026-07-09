import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "deleted";

interface InjectionPayload {
  skillRef?: string;
  goalContext?: string;
  stepContext?: string;
  boundaryContract?: string;
  deferredReads?: string[];
}

interface LoadSpec {
  type: "file" | "skill" | "text";
  source: string;
  label?: string;
}

interface CompletionRecord {
  completionStatus: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_RETRY";
  summary: string;
  evidence?: string;
  decisions?: string;
  caveats?: string;
  deferred?: string;
  concerns?: string;
}

export interface TodoTask {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  owner?: string;
  metadata: Record<string, unknown>;
  injection?: InjectionPayload;
  load?: LoadSpec;
  completion?: CompletionRecord;
  decision?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TodoParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear" | "next";
  subject?: string;
  description?: string;
  status?: TaskStatus;
  blockedBy?: string[];
  owner?: string;
  injection?: InjectionPayload;
  load?: LoadSpec;
  completion?: CompletionRecord;
  decision?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  filter?: { status?: TaskStatus; owner?: string };
}

export interface InjectableContent {
  taskId: string;
  subject: string;
  description?: string;
  skillRef?: string;
  goalContext?: string;
  stepContext?: string;
  boundaryContract?: string;
  deferredReads?: string[];
  loadedContent?: string;
  metadata: Record<string, unknown>;
}

export interface TodoResultDetails {
  action: string;
  tasks: TodoTask[];
  error?: string;
}

interface TodoContext {
  cwd: string;
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
  };
  sessionManager?: unknown;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const TODO_STATE_ENTRY_TYPE = "todo-state";
const STATUS_KEY = "todo";

let tasks: Map<string, TodoTask> = new Map();
let extensionApi: ExtensionAPI | undefined;
let baseCwd = "";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

export function onSessionStart(ctx: TodoContext): void {
  baseCwd = ctx.cwd;
  tasks = loadTasksFromSession(ctx);
  updateStatusLine(ctx);
}

export function onSessionShutdown(ctx: TodoContext): void {
  tasks.clear();
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

  let loadedContent: string | undefined;
  if (task.load) {
    const content = await loadContent(task.load);
    if (content) loadedContent = content;
  }

  return {
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    skillRef: task.injection?.skillRef,
    goalContext: task.injection?.goalContext,
    stepContext: task.injection?.stepContext,
    boundaryContract: task.injection?.boundaryContract,
    deferredReads: task.injection?.deferredReads,
    loadedContent,
    metadata: task.metadata,
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
    owner: params.owner,
    metadata: params.metadata ?? {},
    injection: params.injection,
    load: params.load,
    completion: params.completion,
    decision: params.decision,
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
  if (params.owner !== undefined) task.owner = params.owner;
  if (params.injection !== undefined) task.injection = params.injection;
  if (params.load !== undefined) task.load = params.load;
  if (params.completion !== undefined) task.completion = params.completion;
  if (params.decision !== undefined) task.decision = params.decision;

  if (params.metadata !== undefined) {
    for (const [k, v] of Object.entries(params.metadata)) {
      if (v === null) {
        delete task.metadata[k];
      } else {
        task.metadata[k] = v;
      }
    }
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
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
  let filtered = visible;

  if (params.filter?.status) {
    filtered = filtered.filter((t) => t.status === params.filter!.status);
  }
  if (params.filter?.owner) {
    filtered = filtered.filter((t) => t.owner === params.filter!.owner);
  }

  filtered.sort((a, b) => a.createdAt - b.createdAt);

  if (filtered.length === 0) {
    return ok("No tasks found.", "list");
  }

  const lines = filtered.map((t) => {
    const icon = t.decision ? "◆" : statusIcon(t.status);
    const ownerTag = t.owner ? ` @${t.owner}` : "";
    const depTag = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
    const decTag = t.decision ? ` [decision: ${t.decision}]` : "";
    return `${icon} #${t.id} ${t.subject}${decTag}${ownerTag}${depTag}`;
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
  if (task.owner) lines.push(`Owner: ${task.owner}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(", ")}`);

  const blockers = [...tasks.values()].filter(
    (t) => t.blockedBy.includes(task.id) && t.status !== "deleted",
  );
  if (blockers.length > 0) {
    lines.push(`Blocks: ${blockers.map((b) => `#${b.id}`).join(", ")}`);
  }

  if (task.decision) lines.push(`Decision: ${task.decision}`);

  if (task.completion) {
    lines.push("", "## Completion");
    lines.push(`Status: ${task.completion.completionStatus}`);
    lines.push(`Summary: ${task.completion.summary}`);
    if (task.completion.evidence) lines.push(`Evidence: ${task.completion.evidence}`);
    if (task.completion.decisions) lines.push(`Decisions: ${task.completion.decisions}`);
    if (task.completion.caveats) lines.push(`Caveats: ${task.completion.caveats}`);
    if (task.completion.deferred) lines.push(`Deferred: ${task.completion.deferred}`);
    if (task.completion.concerns) lines.push(`Concerns: ${task.completion.concerns}`);
  }

  if (task.injection) {
    lines.push("", "## Injection");
    if (task.injection.skillRef) lines.push(`Skill: ${task.injection.skillRef}`);
    if (task.injection.goalContext) lines.push(`Goal context: ${task.injection.goalContext}`);
    if (task.injection.stepContext) lines.push(`Step context: ${task.injection.stepContext}`);
    if (task.injection.boundaryContract) lines.push(`Boundary: ${task.injection.boundaryContract}`);
    if (task.injection.deferredReads?.length) {
      lines.push(`Deferred reads: ${task.injection.deferredReads.join(", ")}`);
    }
  }

  if (task.load) {
    lines.push(`Load: [${task.load.type}] ${task.load.source}`);
  }

  if (Object.keys(task.metadata).length > 0) {
    lines.push("", "## Metadata");
    lines.push(JSON.stringify(task.metadata, null, 2));
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
  task.status = "in_progress";
  task.updatedAt = Date.now();
  persist();
  updateStatusLine(ctx);

  const allTasks = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  const taskIndex = allTasks.findIndex((t) => t.id === task.id);
  const totalVisible = allTasks.filter((t) => t.status !== "deleted").length;

  const parts: string[] = [];

  if (task.decision) {
    parts.push(`## Decision Node #${task.id} [${taskIndex + 1}/${totalVisible}]: ${task.subject}`);
    parts.push(`Decision type: ${task.decision}`);
  } else {
    parts.push(`## Task #${task.id} [${taskIndex + 1}/${totalVisible}]: ${task.subject}`);
  }
  if (task.description) parts.push(task.description);

  const prevContext = buildPrevContext(task.id);
  if (prevContext) {
    parts.push(`\n<prev_steps>\n${prevContext}\n</prev_steps>`);
  }

  if (task.injection) {
    if (task.injection.goalContext) {
      parts.push(`\n<goal_context>\n${task.injection.goalContext}\n</goal_context>`);
    }
    if (task.injection.stepContext) {
      parts.push(`\n<step_context>\n${task.injection.stepContext}\n</step_context>`);
    }
    if (task.injection.boundaryContract) {
      parts.push(`\n<boundary_contract>\n${task.injection.boundaryContract}\n</boundary_contract>`);
    }
    if (task.injection.deferredReads?.length) {
      parts.push(`\n<deferred_reads>\n${task.injection.deferredReads.join("\n")}\n</deferred_reads>`);
    }
    if (task.injection.skillRef) {
      parts.push(`\nSkill reference: ${task.injection.skillRef}`);
    }
  }

  if (task.load) {
    const loaded = await loadContent(task.load);
    if (loaded) {
      const tag = task.load.label ?? defaultTag(task.load.type);
      parts.push(`\n<${tag}>\n${loaded}\n</${tag}>`);
    }
  }

  if (Object.keys(task.metadata).length > 0) {
    parts.push(`\n<metadata>\n${JSON.stringify(task.metadata, null, 2)}\n</metadata>`);
  }

  return ok(parts.join("\n"), "next");
}

const PREV_CONTEXT_WINDOW = 5;

function buildPrevContext(currentId: string): string | null {
  const completed = [...tasks.values()]
    .filter((t) => t.status === "completed" && t.id !== currentId && t.completion)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  if (completed.length === 0) return null;

  const recent = completed.slice(-PREV_CONTEXT_WINDOW);
  const lines = recent.map((t) => {
    const parts = [`[#${t.id}] ${t.subject}: ${t.completion!.summary}`];
    if (t.completion!.caveats) parts.push(`  Caveats: ${t.completion!.caveats}`);
    if (t.completion!.deferred) parts.push(`  Deferred: ${t.completion!.deferred}`);
    if (t.completion!.decisions) parts.push(`  Decisions: ${t.completion!.decisions}`);
    return parts.join("\n");
  });

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Content Loader
// ---------------------------------------------------------------------------

async function loadContent(spec: LoadSpec): Promise<string | null> {
  switch (spec.type) {
    case "text":
      return spec.source;

    case "file": {
      const filePath = resolve(baseCwd, spec.source);
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return `[Error: could not read file "${filePath}"]`;
      }
    }

    case "skill": {
      const skillPath = await findSkillFile(spec.source);
      if (!skillPath) return `[Error: skill "${spec.source}" not found]`;
      try {
        return await readFile(skillPath, "utf-8");
      } catch {
        return `[Error: could not read skill file "${skillPath}"]`;
      }
    }

    default:
      return null;
  }
}

function defaultTag(type: LoadSpec["type"]): string {
  switch (type) {
    case "file": return "file_content";
    case "skill": return "skill_prompt";
    case "text": return "content";
  }
}

async function findSkillFile(skillName: string): Promise<string | null> {
  const candidates = [
    join(baseCwd, "skills", skillName, "SKILL.md"),
    join(baseCwd, ".pi", "skills", skillName, "SKILL.md"),
    join(baseCwd, "flow", "skills", skillName, "SKILL.md"),
  ];

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (homeDir) {
    candidates.push(join(homeDir, ".pi", "agent", "packages", "pi-maestro-flow", "skills", skillName, "SKILL.md"));
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
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
  const data = entry?.data as { tasks?: Record<string, TodoTask> } | undefined;
  if (!data?.tasks) return new Map();
  return new Map(Object.entries(data.tasks));
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

function taskChanged(before: TodoTask, after: TodoTask): boolean {
  return (
    before.subject !== after.subject ||
    before.description !== after.description ||
    before.status !== after.status ||
    before.owner !== after.owner ||
    before.decision !== after.decision ||
    JSON.stringify(before.blockedBy) !== JSON.stringify(after.blockedBy) ||
    JSON.stringify(before.metadata) !== JSON.stringify(after.metadata) ||
    JSON.stringify(before.injection) !== JSON.stringify(after.injection) ||
    JSON.stringify(before.load) !== JSON.stringify(after.load) ||
    JSON.stringify(before.completion) !== JSON.stringify(after.completion)
  );
}

function snapshotDetails(action: string, error?: string): TodoResultDetails {
  const visible = [...tasks.values()].filter((t) => t.status !== "deleted");
  visible.sort((a, b) => a.createdAt - b.createdAt);
  return { action, tasks: visible, ...(error ? { error } : {}) };
}

function ok(text: string, action = "unknown"): AgentToolResult {
  return { content: [{ type: "text", text }], details: snapshotDetails(action) };
}

function err(text: string, action = "unknown"): AgentToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true, details: snapshotDetails(action, text) };
}
