/** Versioned, dependency-free Todo prompt context provider contract. */

export const TODO_PROMPT_CONTEXT_VERSION = 1 as const;
export const TODO_PROMPT_CONTEXT_TIMEOUT_MS = 5_000;
export const MAX_TODO_PROMPT_CONTEXT_BYTES = 32 * 1024;
export const MAX_TODO_PROMPT_CONTEXT_TODOS = 16;
export const MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES = 16 * 1024;
export const MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES = 5;
export const MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES = 1024;

const MAX_TODO_PROMPT_CONTEXT_ID_BYTES = 1024;
const MAX_TODO_PROMPT_CONTEXT_TEXT_BYTES = 16 * 1024;
const MAX_TODO_PROMPT_CONTEXT_WARNING_BYTES = 512;
const REGISTRY_KEY = Symbol.for("pi-maestro.todo-prompt-context-provider.v1");

export interface TodoPromptContextRequest {
  version: typeof TODO_PROMPT_CONTEXT_VERSION;
  correlationId: string;
  cwd: string;
  /** Opaque Todo ids in dispatch priority order. */
  todoIds: readonly string[];
  signal: AbortSignal;
}

export interface TodoPromptContextPreviousSummary {
  todoId: string;
  subject: string;
  summary: string;
}

export interface TodoPromptContextProjectionItem {
  todoId: string;
  subject: string;
  description?: string;
  context?: string;
  previousSummaries?: readonly TodoPromptContextPreviousSummary[];
}

/** Compatibility-friendly short name for one provider projection item. */
export type TodoPromptContextItem = TodoPromptContextProjectionItem;

export type TodoPromptContextProvider = (
  request: TodoPromptContextRequest,
) => readonly TodoPromptContextProjectionItem[]
  | Promise<readonly TodoPromptContextProjectionItem[]>;

export interface ResolvedTodoPromptContext {
  /** Frozen bytes appended only to the initial user task prompt. */
  fragment: string;
  /** Bounded advisory diagnostics safe to expose on the public result. */
  warnings: readonly string[];
}

interface TodoPromptContextRegistry {
  provider?: TodoPromptContextProvider;
}

const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function registry(): TodoPromptContextRegistry {
  const existing = globals[REGISTRY_KEY];
  if (existing && typeof existing === "object") return existing as TodoPromptContextRegistry;
  const created: TodoPromptContextRegistry = {};
  globals[REGISTRY_KEY] = created;
  return created;
}

/** Register the process-local provider. Disposing an old registration cannot remove its replacement. */
export function registerTodoPromptContextProvider(provider: TodoPromptContextProvider): () => void {
  if (typeof provider !== "function") {
    throw new TypeError("Todo prompt context provider must be a function.");
  }
  registry().provider = provider;
  return () => {
    if (registry().provider === provider) registry().provider = undefined;
  };
}

export function getTodoPromptContextProvider(): TodoPromptContextProvider | undefined {
  return registry().provider;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedWarning(message: string): string {
  if (utf8Bytes(message) <= MAX_TODO_PROMPT_CONTEXT_WARNING_BYTES) return message;
  let end = message.length;
  while (end > 0 && utf8Bytes(`${message.slice(0, end)}...`) > MAX_TODO_PROMPT_CONTEXT_WARNING_BYTES) end--;
  return `${message.slice(0, end)}...`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u007F-\u009F\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function render(items: readonly Record<string, unknown>[]): string {
  return `<untrusted_todo_context>\n${safeJson({
    version: TODO_PROMPT_CONTEXT_VERSION,
    items,
  })}\n</untrusted_todo_context>`;
}

function normalizedTodoIds(todoIds: readonly string[]): { ids: string[]; truncated: boolean; malformed: boolean } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let malformed = false;
  for (const value of todoIds) {
    if (typeof value !== "string") {
      malformed = true;
      continue;
    }
    const trimmed = value.trim();
    const id = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    if (!id || utf8Bytes(id) > MAX_TODO_PROMPT_CONTEXT_ID_BYTES) {
      malformed = true;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (ids.length < MAX_TODO_PROMPT_CONTEXT_TODOS) ids.push(id);
  }
  return {
    ids,
    truncated: seen.size > MAX_TODO_PROMPT_CONTEXT_TODOS,
    malformed,
  };
}

function idOnly(ids: readonly string[], warning: string): ResolvedTodoPromptContext {
  let retained = [...ids];
  let fragment = render(retained.map((todoId) => ({ todoId })));
  while (retained.length > 0 && utf8Bytes(fragment) > MAX_TODO_PROMPT_CONTEXT_BYTES) {
    retained = retained.slice(0, -1);
    fragment = render(retained.map((todoId) => ({ todoId })));
  }
  return {
    fragment,
    warnings: [boundedWarning(warning)],
  };
}

function validText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.trim().length > 0)
    && utf8Bytes(value) <= maxBytes;
}

function validateProjection(
  value: unknown,
  todoIds: readonly string[],
): readonly TodoPromptContextProjectionItem[] | undefined {
  if (!Array.isArray(value) || value.length > todoIds.length) return undefined;
  const requested = new Set(todoIds);
  const byId = new Map<string, TodoPromptContextProjectionItem>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const item = candidate as Record<string, unknown>;
    if (!validText(item.todoId, MAX_TODO_PROMPT_CONTEXT_ID_BYTES)
      || !requested.has(item.todoId)
      || byId.has(item.todoId)
      || !validText(item.subject, MAX_TODO_PROMPT_CONTEXT_TEXT_BYTES)) return undefined;
    if (item.description !== undefined
      && !validText(item.description, MAX_TODO_PROMPT_CONTEXT_TEXT_BYTES, true)) return undefined;
    if (item.context !== undefined
      && !validText(item.context, MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES, true)) return undefined;

    let previousSummaries: TodoPromptContextPreviousSummary[] | undefined;
    if (item.previousSummaries !== undefined) {
      if (!Array.isArray(item.previousSummaries)
        || item.previousSummaries.length > MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES) return undefined;
      previousSummaries = [];
      for (const rawSummary of item.previousSummaries) {
        if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary)) return undefined;
        const summary = rawSummary as Record<string, unknown>;
        if (!validText(summary.todoId, MAX_TODO_PROMPT_CONTEXT_ID_BYTES)
          || !validText(summary.subject, MAX_TODO_PROMPT_CONTEXT_TEXT_BYTES)
          || !validText(summary.summary, MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES)) return undefined;
        previousSummaries.push({
          todoId: summary.todoId,
          subject: summary.subject,
          summary: summary.summary,
        });
      }
    }

    byId.set(item.todoId, {
      todoId: item.todoId,
      subject: item.subject,
      ...(item.description === undefined ? {} : { description: item.description as string }),
      ...(item.context === undefined ? {} : { context: item.context as string }),
      ...(previousSummaries === undefined ? {} : { previousSummaries }),
    });
  }
  return todoIds.flatMap((todoId) => {
    const item = byId.get(todoId);
    return item ? [item] : [];
  });
}

export interface ResolveTodoPromptContextOptions {
  /** Test seam; production callers use the fixed five-second upper bound. */
  timeoutMs?: number;
}

/** Resolve, validate, render, and freeze one dispatch's untrusted Todo context. */
export async function resolveTodoPromptContext(
  input: Omit<TodoPromptContextRequest, "version" | "signal"> & { signal?: AbortSignal },
  options: ResolveTodoPromptContextOptions = {},
): Promise<ResolvedTodoPromptContext> {
  const normalized = normalizedTodoIds(input.todoIds);
  const ids = normalized.ids;
  if (ids.length === 0) {
    return idOnly(ids, "Todo prompt context ids were invalid; injected an empty ID-only context.");
  }
  if (normalized.malformed || normalized.truncated) {
    return idOnly(
      ids,
      `Todo prompt context binding exceeded the ${MAX_TODO_PROMPT_CONTEXT_TODOS}-Todo request budget; injected bounded Todo IDs only.`,
    );
  }

  const provider = getTodoPromptContextProvider();
  if (!provider) {
    return idOnly(ids, "Todo prompt context provider is unavailable; injected Todo IDs only.");
  }

  const timeoutMs = Math.max(1, Math.min(
    TODO_PROMPT_CONTEXT_TIMEOUT_MS,
    Math.floor(options.timeoutMs ?? TODO_PROMPT_CONTEXT_TIMEOUT_MS),
  ));
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (input.signal?.aborted) abortFromCaller();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const providerOutcome = Promise.resolve().then(() => provider({
      version: TODO_PROMPT_CONTEXT_VERSION,
      correlationId: input.correlationId,
      cwd: input.cwd,
      todoIds: Object.freeze([...ids]),
      signal: controller.signal,
    })).then(
      (value) => ({ kind: "value" as const, value }),
      () => ({ kind: "error" as const }),
    );
    const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("Todo prompt context provider timed out."));
        resolve({ kind: "timeout" });
      }, timeoutMs);
      timeout.unref?.();
    });
    const callerAbort = new Promise<{ kind: "aborted" }>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        if (input.signal?.aborted) resolve({ kind: "aborted" });
      }, { once: true });
      if (input.signal?.aborted) resolve({ kind: "aborted" });
    });
    const outcome = await Promise.race([providerOutcome, deadline, callerAbort]);
    if (outcome.kind === "timeout") {
      return idOnly(ids, `Todo prompt context provider timed out after ${timeoutMs}ms; injected Todo IDs only.`);
    }
    if (outcome.kind === "aborted") {
      return idOnly(ids, "Todo prompt context resolution was cancelled; injected Todo IDs only.");
    }
    if (outcome.kind === "error") {
      return idOnly(ids, "Todo prompt context provider failed; injected Todo IDs only.");
    }
    const projection = validateProjection(outcome.value, ids);
    if (!projection) {
      return idOnly(ids, "Todo prompt context provider returned empty or malformed content; injected Todo IDs only.");
    }
    const fragment = render(projection as unknown as readonly Record<string, unknown>[]);
    if (utf8Bytes(fragment) > MAX_TODO_PROMPT_CONTEXT_BYTES) {
      return idOnly(ids, `Todo prompt context exceeded the ${MAX_TODO_PROMPT_CONTEXT_BYTES}-byte budget; injected Todo IDs only.`);
    }
    return { fragment, warnings: [] };
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Append frozen context bytes to the initial user prompt exactly once. */
export function appendTodoPromptContext(prompt: string, context: ResolvedTodoPromptContext): string {
  return `${prompt}\n\n${context.fragment}`;
}
