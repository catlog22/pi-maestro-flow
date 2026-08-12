import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine } from "../quiet-render.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildToolSearchIndex,
  searchTools,
  toDiscoverableTool,
} from "./tool-discovery.ts";

const DEFAULT_LIMIT = 8;
const deferredSessionsKey = Symbol.for("pi-maestro.tool-search.deferred-sessions");

interface DeferredSessionRegistry {
  sessions: Map<string, Set<string>>;
}

function deferredSessionRegistry(): DeferredSessionRegistry {
  const host = globalThis as Record<symbol, DeferredSessionRegistry | undefined>;
  let registry = host[deferredSessionsKey];
  if (!registry) {
    registry = { sessions: new Map() };
    host[deferredSessionsKey] = registry;
  }
  return registry;
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Low-frequency tools whose full schemas are loaded only after discovery.
 * Keep workflow, filesystem, shell, MCP, and resource tools eager because they
 * are common control/data paths and should never require a search round-trip.
 */
export const DEFAULT_DEFERRED_TOOL_NAMES = new Set([
  "browser",
  "conflict",
  "loop",
  "lsp",
  "model-availability",
  "smart_search",
  "source_check",
]);

export const SearchToolBm25Params = Type.Object({
  query: Type.String({ minLength: 1, description: "Natural-language tool search query" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum matches" })),
});

export interface SearchToolBm25Details {
  query: string;
  limit: number;
  total_tools: number;
  activated_tools: string[];
  tools: Array<{
    name: string;
    label: string;
    summary: string;
    description: string;
    schema_keys: string[];
    score: number;
  }>;
}

export function createSearchToolBm25(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
  options: {
    canActivate?: (name: string) => boolean;
    onActivated?: (names: readonly string[]) => void;
  } = {},
): ToolDefinition<typeof SearchToolBm25Params, SearchToolBm25Details> {
  return {
    name: "search_tool_bm25",
    label: "Search Tools",
    description: "Search all registered tools by name, description, and parameter names using weighted BM25 ranking. Matching inactive tools are activated for subsequent calls.",
    promptSnippet: "Use search_tool_bm25 when a capability may exist but its tool is not currently available. Search by capability; matching tools become callable on the next request.",
    parameters: SearchToolBm25Params,
    async execute(_id, params, signal): Promise<AgentToolResult<SearchToolBm25Details>> {
      if (signal?.aborted) throw abortError();
      const query = params.query.trim();
      if (!query) throw new Error("Query is required and must not be empty.");

      const limit = params.limit ?? DEFAULT_LIMIT;
      try {
        const catalog = pi.getAllTools().map(toDiscoverableTool);
        const ranked = searchTools(buildToolSearchIndex(catalog), query, limit);
        if (signal?.aborted) throw abortError();

        const active = pi.getActiveTools();
        const activeSet = new Set(active);
        const activated = ranked
          .map((result) => result.tool.name)
          .filter((name) => !activeSet.has(name) && (options.canActivate?.(name) ?? true));
        if (activated.length > 0) {
          pi.setActiveTools([...active, ...activated]);
          options.onActivated?.(activated);
        }

        const details: SearchToolBm25Details = {
          query,
          limit,
          total_tools: catalog.length,
          activated_tools: activated,
          tools: ranked.map(({ tool, score }) => ({
            name: tool.name,
            label: tool.label,
            summary: tool.summary,
            description: tool.description,
            schema_keys: tool.schemaKeys,
            score: Number(score.toFixed(6)),
          })),
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              activated_tools: activated,
              match_count: details.tools.length,
              total_tools: catalog.length,
              tools: details.tools,
            }),
          }],
          details,
        } as AgentToolResult<SearchToolBm25Details>;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw abortError();
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "search_tools", `"${String(args.query ?? "").slice(0, 50)}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as { tools?: Array<{ name: string }> } | undefined;
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      return toolResultLine(theme, {
        name: "search_tools",
        ok: true,
        arg: `"${String(ctx.args.query ?? "").slice(0, 50)}"`,
        summary: `${details?.tools?.length ?? 0} matches`,
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}

export function deferLowFrequencyTools(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  deferredNames: ReadonlySet<string> = DEFAULT_DEFERRED_TOOL_NAMES,
): string[] {
  const active = pi.getActiveTools();
  const next = active.filter((name) => !deferredNames.has(name));
  if (next.length !== active.length) pi.setActiveTools(next);
  return active.filter((name) => deferredNames.has(name));
}

export function registerSearchToolBm25(pi: ExtensionAPI): void {
  let deferredThisSession = new Set<string>();
  let activeSessionId: string | undefined;
  const registry = deferredSessionRegistry();
  pi.registerTool(createSearchToolBm25(pi, {
    canActivate: (name) => deferredThisSession.has(name),
    onActivated: (names) => {
      for (const name of names) deferredThisSession.delete(name);
    },
  }));
  pi.on("session_start", (event, ctx) => {
    activeSessionId = sessionIdOf(ctx);
    if (event.reason === "reload" && activeSessionId) {
      const restored = registry.sessions.get(activeSessionId);
      if (restored) {
        deferredThisSession = restored;
        return;
      }
    }
    deferredThisSession = new Set(deferLowFrequencyTools(pi));
    if (activeSessionId) registry.sessions.set(activeSessionId, deferredThisSession);
  });
  pi.on("session_shutdown", (event, ctx) => {
    const sessionId = sessionIdOf(ctx) ?? activeSessionId;
    if (event.reason !== "reload" && sessionId) registry.sessions.delete(sessionId);
    activeSessionId = undefined;
  });
}

function abortError(): Error {
  const error = new Error("Tool execution aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
