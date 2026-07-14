import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildToolSearchIndex,
  searchTools,
  toDiscoverableTool,
} from "./tool-discovery.ts";

const DEFAULT_LIMIT = 8;

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

export function createSearchToolBm25(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">): ToolDefinition<typeof SearchToolBm25Params, SearchToolBm25Details> {
  return {
    name: "search_tool_bm25",
    label: "Search Tools",
    description: "Search all registered tools by name, description, and parameter names using weighted BM25 ranking. Matching inactive tools are activated for subsequent calls.",
    promptSnippet: "Use search_tool_bm25 when you need to discover a registered tool by capability.",
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
        const activated = ranked.map((result) => result.tool.name).filter((name) => !activeSet.has(name));
        if (activated.length > 0) pi.setActiveTools([...active, ...activated]);

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
  };
}

export function registerSearchToolBm25(pi: ExtensionAPI): void {
  pi.registerTool(createSearchToolBm25(pi));
}

function abortError(): Error {
  const error = new Error("Tool execution aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
