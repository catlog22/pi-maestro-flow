/** Versioned, dependency-free Todo prompt context provider contract. */
export declare const TODO_PROMPT_CONTEXT_VERSION: 1;
export declare const TODO_PROMPT_CONTEXT_TIMEOUT_MS = 5000;
export declare const MAX_TODO_PROMPT_CONTEXT_BYTES: number;
export declare const MAX_TODO_PROMPT_CONTEXT_TODOS = 16;
export declare const MAX_TODO_PROMPT_CONTEXT_ITEM_CONTEXT_BYTES: number;
export declare const MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES = 5;
export declare const MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES = 1024;
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
export type TodoPromptContextProvider = (request: TodoPromptContextRequest) => readonly TodoPromptContextProjectionItem[] | Promise<readonly TodoPromptContextProjectionItem[]>;
export interface ResolvedTodoPromptContext {
    /** Frozen bytes appended only to the initial user task prompt. */
    fragment: string;
    /** Bounded advisory diagnostics safe to expose on the public result. */
    warnings: readonly string[];
}
/** Register the process-local provider. Disposing an old registration cannot remove its replacement. */
export declare function registerTodoPromptContextProvider(provider: TodoPromptContextProvider): () => void;
export declare function getTodoPromptContextProvider(): TodoPromptContextProvider | undefined;
export interface ResolveTodoPromptContextOptions {
    /** Test seam; production callers use the fixed five-second upper bound. */
    timeoutMs?: number;
}
/** Resolve, validate, render, and freeze one dispatch's untrusted Todo context. */
export declare function resolveTodoPromptContext(input: Omit<TodoPromptContextRequest, "version" | "signal"> & {
    signal?: AbortSignal;
}, options?: ResolveTodoPromptContextOptions): Promise<ResolvedTodoPromptContext>;
/** Append frozen context bytes to the initial user prompt exactly once. */
export declare function appendTodoPromptContext(prompt: string, context: ResolvedTodoPromptContext): string;
