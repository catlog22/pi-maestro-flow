import {
  MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES,
  MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES,
  MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES,
  MAX_TODO_PROMPT_CONTEXT_TODOS,
  registerTodoPromptContextProvider,
  type TodoPromptContextProjectionItem,
  type TodoPromptContextProvider,
} from "pi-maestro-teammate/v1/todo-context";
import { getVisibleTasks, type TodoTask } from "../tools/todo.ts";

export const TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES = 512;
export const TODO_PROMPT_CONTEXT_MAX_DESCRIPTION_BYTES = MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES;
export const TODO_PROMPT_CONTEXT_MAX_CONTEXT_BYTES = MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES;

export interface FlowTodoPromptContextProviderOptions {
  getTasks?: () => TodoTask[];
  registerProvider?: (provider: TodoPromptContextProvider) => () => void;
}

/** Register the Flow-owned projection at Teammate's runtime inversion boundary. */
export function registerFlowTodoPromptContextProvider(
  options: FlowTodoPromptContextProviderOptions = {},
): () => void {
  const getTasks = options.getTasks ?? getVisibleTasks;
  const registerProvider = options.registerProvider ?? registerTodoPromptContextProvider;
  return registerProvider((request) => projectTodoPromptContext(request.todoIds, getTasks()));
}

/**
 * Project durable Todo state into bounded prompt context. Requested ids retain
 * caller priority; missing and deleted tasks are omitted.
 */
export function projectTodoPromptContext(
  requestedTodoIds: readonly string[],
  tasks: readonly TodoTask[],
): TodoPromptContextProjectionItem[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const requested = uniqueRequestedIds(requestedTodoIds);

  return requested.flatMap((todoId) => {
    const task = taskById.get(todoId);
    if (!task || task.status === "deleted") return [];

    const previousSummaries = task.planHandoffKey
      ? tasks
        .filter((candidate) => isRelatedCompletedTask(candidate, task))
        .sort(compareRecentTasks)
        .slice(0, MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES)
        .map((candidate) => ({
          todoId: candidate.id,
          subject: boundUtf8(candidate.subject, TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES),
          summary: boundUtf8(candidate.summary!, MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES),
        }))
      : [];

    return [{
      todoId: task.id,
      subject: boundUtf8(task.subject, TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES),
      ...optionalBoundText("description", task.description, TODO_PROMPT_CONTEXT_MAX_DESCRIPTION_BYTES),
      ...optionalBoundText("context", task.context, TODO_PROMPT_CONTEXT_MAX_CONTEXT_BYTES),
      ...(previousSummaries.length > 0 ? { previousSummaries } : {}),
    }];
  });
}

function uniqueRequestedIds(requestedTodoIds: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawId of requestedTodoIds) {
    const trimmed = rawId.trim();
    const id = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_TODO_PROMPT_CONTEXT_TODOS) break;
  }
  return ids;
}

function isRelatedCompletedTask(candidate: TodoTask, current: TodoTask): boolean {
  return candidate.id !== current.id
    && candidate.status === "completed"
    && candidate.planHandoffKey === current.planHandoffKey
    && typeof candidate.summary === "string"
    && candidate.summary.trim().length > 0;
}

function compareRecentTasks(left: TodoTask, right: TodoTask): number {
  const timeOrder = right.updatedAt - left.updatedAt || right.createdAt - left.createdAt;
  if (timeOrder !== 0) return timeOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function optionalBoundText<Key extends "description" | "context">(
  key: Key,
  value: string | undefined,
  maxBytes: number,
): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: boundUtf8(value, maxBytes) } as Record<Key, string>;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
