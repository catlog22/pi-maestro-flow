import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * A tool result that also carries the `isError` flag the TUI reads.
 *
 * pi's agent loop derives its own error state purely from whether `execute()`
 * threw — a returned `isError` never reaches `ToolResultMessage.isError`
 * (`agent-loop.js`: `return { result, isError: false }`), and the SDK type has
 * never declared the field. The flag still matters: `finalizeExecutedToolCall`
 * spreads the returned object, so `isError` rides along to
 * `ToolExecutionComponent`, which uses it to pick the error background and to
 * fill `ToolRenderContext.isError`. Renderers across src/tools/ read it back.
 *
 * Declaring it here keeps that real contract visible instead of scattering
 * `as { isError?: boolean }` casts at every call site.
 */
export type FlowToolResult<T = unknown> = AgentToolResult<T> & { isError?: boolean };
