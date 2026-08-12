import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGoalById } from "./goal.ts";
import type { TodoSkillConfig } from "../skills/skill-loader.ts";
import type { TodoSkillBinding } from "../skills/skill-composer.ts";
import type {
  SkillActivationBindingMetadata,
  SkillActivationMetadata,
} from "../skills/skill-runtime.ts";
import type { TodoTaskOrigin } from "../session/types.ts";
import type {
  TaskStatus,
  TodoActorRef,
  TodoContext,
  TodoParams,
  TodoTask,
} from "./todo.ts";
import {
  isSkillRole,
  normalizeSkillBinding,
  normalizeSkillConfig,
} from "./todo-skill-engine.ts";

export { isSkillRole };

export const TODO_STATE_ENTRY_TYPE = "todo-state";
export const TODO_STATE_VERSION = 5;

export interface TodoSerializationContext {
  getExtensionApi: () => ExtensionAPI | undefined;
  getTasks: () => Map<string, TodoTask>;
  getTodoGeneration: () => number;
  rootActor: TodoActorRef;
}

let serializationContext: TodoSerializationContext | undefined;

export function configureTodoSerialization(context: TodoSerializationContext): void {
  serializationContext = context;
}

function requireSerializationContext(): TodoSerializationContext {
  if (!serializationContext) throw new Error("todo serialization context is not initialized");
  return serializationContext;
}

export function persist(
  state: Map<string, TodoTask> = requireSerializationContext().getTasks(),
): void {
  requireSerializationContext().getExtensionApi()?.appendEntry?.(TODO_STATE_ENTRY_TYPE, {
    version: TODO_STATE_VERSION,
    tasks: Object.fromEntries(state),
  });
}

export function loadTasksFromSession(ctx: TodoContext): Map<string, TodoTask> {
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
  normalizeLoadedGoalBindings(loaded);
  return loaded;
}

/**
 * Drop bindings to Goals that no longer exist, at the session-load boundary.
 *
 * Mirrors {@link normalizeLoadedDependencies}, which does the same for `blockedBy`. Goal state
 * is session-scoped (it clears its registry when the persisted sessionId does not match, and on
 * new/fork), while Todo state is not, so a fork or resume can bring every task back carrying a
 * goalId whose Goal is gone. Nothing validates goalId on the write path either, so a task can
 * also be created against an id that never existed.
 *
 * Safe to resolve Goals here: goalSessionStart runs before todoSessionStart (extension/index.ts),
 * so the registry is already populated.
 */
export function normalizeLoadedGoalBindings(state: Map<string, TodoTask>): void {
  for (const task of state.values()) {
    if (!task.goalId) continue;
    if (getGoalById(task.goalId)) continue;
    delete task.goalId;
  }
}

export function normalizeLoadedDependencies(state: Map<string, TodoTask>): void {
  for (const task of state.values()) {
    const seen = new Set<string>();
    task.blockedBy = task.blockedBy.filter((depId) => {
      if (seen.has(depId)) return false;
      seen.add(depId);
      const dependency = state.get(depId);
      return dependency?.status !== "completed" && dependency?.status !== "deleted";
    });
    if (task.status === "pending" || task.status === "blocked") {
      task.status = task.blockedBy.length > 0 ? "blocked" : "pending";
    }
  }
}

export function isTodoMutation(action: TodoParams["action"]): boolean {
  return action !== "list" && action !== "get";
}

export function assertTodoGeneration(generation: number): void {
  if (generation !== requireSerializationContext().getTodoGeneration()) {
    throw new Error("Todo session changed while the mutation was pending; retry against the active session.");
  }
}

export function normalizeLoadedTask(id: string, raw: unknown): TodoTask {
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
  const rootActor = requireSerializationContext().rootActor;
  const createdBy = readTodoActor(task.createdBy) ?? { ...rootActor };
  const assignee = readTodoActor(task.assignee) ?? { ...rootActor };

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
    ...(typeof task.goalId === "string" ? { goalId: task.goalId } : {}),
    createdBy,
    assignee,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
  };
}

export function readTodoOrigin(value: unknown): TodoTaskOrigin | undefined {
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

export function readTodoActor(value: unknown): TodoActorRef | undefined {
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

export function readSkillBindings(value: unknown): TodoSkillBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: TodoSkillBinding[] = [];
  for (const item of value) {
    const binding = readSkillBinding(item);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

export function readSkillBinding(value: unknown): TodoSkillBinding | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  if (!isSkillRole(skill.role)) return undefined;
  return normalizeSkillBinding({
    name: skill.name,
    role: skill.role,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

export function readSkillConfig(value: unknown): TodoSkillConfig | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  return normalizeSkillConfig({
    name: skill.name,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

export function appendLegacySkill(bindings: TodoSkillBinding[], value: unknown): void {
  const skill = readSkillConfig(value);
  if (skill) bindings.push({ ...skill, role: "primary" });
}

export function readSkillActivation(value: unknown): SkillActivationMetadata | undefined {
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

export function readActivationBindings(value: unknown): SkillActivationBindingMetadata[] {
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
      ...(Array.isArray(record.requiredReadingContentHashes)
        ? { requiredReadingContentHashes: stringArray(record.requiredReadingContentHashes) }
        : {}),
      compiledKey: typeof record.compiledKey === "string" ? record.compiledKey : "",
      requiredFiles: stringArray(record.requiredFiles),
      deferredFiles: stringArray(record.deferredFiles),
      totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    });
  }
  return bindings;
}

export function readLegacySkillActivation(
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

export function appendLegacyValue(parts: string[], tag: string, value: unknown): void {
  if (typeof value === "string" && value) parts.push(wrapLegacyBlock(tag, value));
}

export function wrapLegacyBlock(tag: string, value: string): string {
  return `<${tag}>\n${value}\n</${tag}>`;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return ["pending", "in_progress", "completed", "blocked", "deleted"].includes(String(value));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
