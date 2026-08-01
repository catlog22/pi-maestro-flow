import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TodoSkillConfig } from "../skills/skill-loader.ts";
import {
  composeSkillBindings,
  type TodoSkillBinding,
  type TodoSkillRole,
} from "../skills/skill-composer.ts";
import type {
  AnySkillActivation,
  DegradedSkillActivation,
  SkillActivation,
  SkillActivationBindingMetadata,
  SkillActivationMetadata,
  SkillRuntime,
} from "../skills/skill-runtime.ts";
import type { TodoParams, TodoTask } from "./todo.ts";

export interface ContextInjectionAnchor {
  index: number;
  previousMessage?: AgentMessage;
  previousFingerprint?: string;
}

export type RunSkillInjection = {
  taskId: string;
  stackRevision: string;
  channel: "system";
} | {
  taskId: string;
  stackRevision: string;
  channel: "context";
  anchor: ContextInjectionAnchor;
};

export interface TodoSkillEngineContext {
  getSkillRuntime: () => SkillRuntime | undefined;
  getActiveSkillSnapshots: () => Map<string, SkillActivation>;
  getRunSkillInjection: () => RunSkillInjection | undefined;
  setRunSkillInjection: (injection: RunSkillInjection | undefined) => void;
}

let skillEngineContext: TodoSkillEngineContext | undefined;

export function configureTodoSkillEngine(context: TodoSkillEngineContext): void {
  skillEngineContext = context;
}

function requireSkillEngineContext(): TodoSkillEngineContext {
  if (!skillEngineContext) throw new Error("todo skill engine context is not initialized");
  return skillEngineContext;
}

export function requireSkillRuntime(): SkillRuntime {
  const runtime = requireSkillEngineContext().getSkillRuntime();
  if (!runtime) throw new Error("todo skill runtime is not initialized");
  return runtime;
}

export function activateTask(task: TodoTask): Promise<SkillActivation> {
  return requireSkillRuntime().activate(task.skills, task.context ?? "");
}

export function activationMetadata(activation: SkillActivation): SkillActivationMetadata {
  return {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(cloneActivationBinding),
  };
}

export function clearSkillSnapshot(taskId?: string): void {
  const context = requireSkillEngineContext();
  const activeSkillSnapshots = context.getActiveSkillSnapshots();
  if (taskId) activeSkillSnapshots.delete(taskId);
  else activeSkillSnapshots.clear();
  const runSkillInjection = context.getRunSkillInjection();
  if (!taskId || runSkillInjection?.taskId === taskId) context.setRunSkillInjection(undefined);
}

export function clearCommittedSkillSnapshots(taskIds: ReadonlySet<string>): void {
  if (taskIds.size === 0) return;
  const context = requireSkillEngineContext();
  const activeSkillSnapshots = context.getActiveSkillSnapshots();
  for (const taskId of taskIds) activeSkillSnapshots.delete(taskId);
  const runSkillInjection = context.getRunSkillInjection();
  if (runSkillInjection && taskIds.has(runSkillInjection.taskId)) context.setRunSkillInjection(undefined);
}

export function createActiveSkillMessage(task: TodoTask, activation: AnySkillActivation): AgentMessage {
  return {
    role: "custom",
    customType: "todo-active-skill",
    content: renderActivationPrompt(task, activation),
    // Skill prompts are injection noise, but a degraded stack is a failure the user
    // needs to see — todo.ts has no notify channel of its own (TodoContext.ui only
    // carries setStatus), and this message is already on its way to the transcript.
    display: activation.state === "degraded",
    details: {
      taskId: task.id,
      activationId: activation.activationId,
      stackRevision: activation.stackRevision,
    },
    timestamp: activation.activatedAt,
  } as AgentMessage;
}

export function createContextInjectionAnchor(messages: AgentMessage[]): ContextInjectionAnchor {
  const previousMessage = messages.at(-1);
  return {
    index: messages.length,
    ...(previousMessage ? {
      previousMessage,
      previousFingerprint: contextMessageFingerprint(previousMessage),
    } : {}),
  };
}

export function resolveContextInjectionAnchor(
  messages: AgentMessage[],
  anchor: ContextInjectionAnchor,
): ContextInjectionAnchor {
  if (anchor.index === 0) return anchor;
  const previousMessage = messages[anchor.index - 1];
  if (previousMessage === anchor.previousMessage
    || (previousMessage && contextMessageFingerprint(previousMessage) === anchor.previousFingerprint)) return anchor;
  return createContextInjectionAnchor(messages);
}

export function contextMessageFingerprint(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

/**
 * Stand-in activation for a task whose skills can no longer be loaded.
 *
 * Fail-open, because the only caller that matters runs inside the `context` hook on
 * every turn — failing closed there wedges the session. But fail-open silently would
 * drop the skill's constraints without the model ever knowing, so the whole payload is
 * a warning block telling it exactly that.
 *
 * Deliberately not cached and not persisted: `stackRevision` is per-task and constant,
 * so it never collides with a real revision, and the next turn re-attempts the real
 * load.
 */
export function degradedActivation(task: TodoTask, error: unknown): DegradedSkillActivation {
  const now = Date.now();
  return {
    activationId: task.skillActivation?.activationId ?? `degraded-${task.id}`,
    stackRevision: `degraded:${task.id}`,
    activatedAt: now,
    validatedAt: now,
    state: "degraded",
    bindings: [],
    skills: [],
    prompt: renderDegradedPrompt(task, error),
  };
}

export function renderDegradedPrompt(task: TodoTask, error: unknown): string {
  const names = task.skills.map((binding) => binding.name).join(", ") || "(none)";
  return [
    "<active_skill_stack_unavailable>",
    `Todo task #${task.id} declares skills (${names}) but they could not be loaded: ${errorText(error)}`,
    "Their instructions are NOT in effect. Do not assume any skill constraint, checklist, or workflow applies.",
    "Fix the skill files, or move the task back to pending and re-activate it, before relying on skill-scoped behavior.",
    "</active_skill_stack_unavailable>",
  ].join("\n");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderActivationPrompt(task: TodoTask, activation: AnySkillActivation): string {
  if (activation.state === "active" || activation.state === "degraded") return activation.prompt;
  return [
    "<active_skill_stack_stale>",
    `Todo task #${task.id} skill files changed after activation.`,
    "Do not continue the previous skill workflow until the task is moved back to pending and activated again.",
    "</active_skill_stack_stale>",
  ].join("\n");
}

export function assertActiveSkillStack(task: TodoTask, activation: AnySkillActivation): void {
  if (activation.state === "active") return;
  // A degraded stack already carries its own warning block in the injected content.
  // Throwing here would defeat the fallback that produced it.
  if (activation.state === "degraded") return;
  throw new Error(
    `Todo task #${task.id} skill activation is stale. Move the task back to pending and reactivate it before continuing the Run.`,
  );
}

export function cloneActivationBinding(
  binding: SkillActivationBindingMetadata,
): SkillActivationBindingMetadata {
  return {
    ...binding,
    requiredFiles: [...binding.requiredFiles],
    deferredFiles: [...binding.deferredFiles],
  };
}

export function normalizeSkillConfig(skill: TodoSkillConfig): TodoSkillConfig {
  const name = skill.name.trim();
  if (!name) throw new Error("skill.name must be non-empty");
  const args = skill.args?.trim();
  return { name, ...(args ? { args } : {}) };
}

export function normalizeSkillBinding(skill: TodoSkillBinding): TodoSkillBinding {
  if (!isSkillRole(skill.role)) throw new Error(`Invalid skill role: ${String(skill.role)}`);
  return { ...normalizeSkillConfig(skill), role: skill.role };
}

export function normalizeSkillBindings(skills: readonly TodoSkillBinding[]): TodoSkillBinding[] {
  return composeSkillBindings(skills.map(normalizeSkillBinding));
}

type TodoParamsInput = TodoParams & {
  /** Legacy single-skill input accepted only at the tool normalization boundary. */
  skill?: TodoSkillConfig | null;
};

export function normalizeTodoParams(input: TodoParamsInput): TodoParams {
  const { skill: legacySkill, ...params } = input;
  if (params.id) params.id = params.id.replace(/^#+/, "");
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

export function formatSkillBinding(binding: TodoSkillBinding): string {
  return `${binding.role}:${binding.name}${binding.args ? ` ${binding.args}` : ""}`;
}

function isSkillRole(value: unknown): value is TodoSkillRole {
  return ["primary", "guard", "support"].includes(String(value));
}
