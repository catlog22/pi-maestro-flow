import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { startCuratorServer, type CuratorServerHandle } from "./curator-server.ts";
import { nativeSearch } from "./search-router.ts";
import { isPerplexityAvailable } from "./perplexity.ts";
import { isOpenAISearchAvailable } from "./openai-search.ts";
import { isBraveAvailable } from "./brave.ts";
import { isParallelAvailable } from "./parallel.ts";
import { isTavilyAvailable } from "./tavily.ts";
import { isSerpdiveAvailable } from "./serpdive.ts";
import { isSearXNGAvailable } from "./searxng.ts";
import { isExaAvailable } from "./exa.ts";
import { isGeminiApiAvailable } from "./gemini-api.ts";
import { isGeminiWebAvailable } from "./gemini-web.ts";
import { isAnySearchAvailable } from "./anysearch.ts";
import { buildDeterministicSummary } from "./summary-review.ts";
import type { QueryResultData } from "./storage.ts";

let activeCurator: CuratorServerHandle | undefined;

export async function openCurator(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  query?: string,
): Promise<void> {
  if (activeCurator) {
    activeCurator.close();
    activeCurator = undefined;
  }
  const [openai, geminiWeb] = await Promise.all([
    isOpenAISearchAvailable(),
    isGeminiWebAvailable(),
  ]);
  const handle = await startCuratorServer(
    {
      queries: query ? [query] : [],
      sessionToken: randomUUID(),
      timeout: 120,
      availableProviders: {
        openai,
        brave: isBraveAvailable(),
        parallel: isParallelAvailable(),
        tavily: isTavilyAvailable(),
        serpdive: isSerpdiveAvailable(),
        searxng: isSearXNGAvailable(),
        perplexity: isPerplexityAvailable(),
        exa: isExaAvailable(),
        gemini: isGeminiApiAvailable() || geminiWeb !== null,
        anysearch: isAnySearchAvailable(),
      },
      defaultProvider: "auto",
      searchProvider: "auto",
      summaryModels: [],
      defaultSummaryModel: null,
    },
    {
      onSubmit: () => { /* consumed by the caller via the handle */ },
      onCancel: () => { /* cleanup handled by close */ },
      onProviderChange: () => { /* no-op */ },
      onAddSearch: async (searchQuery: string, _queryIndex: number, provider?: string) => {
        const result = await nativeSearch({ query: searchQuery, provider });
        return {
          answer: result.answer ?? "",
          results: result.results.map((r) => ({
            title: r.title,
            url: r.url,
            domain: safeDomain(r.url),
          })),
          provider: result.provider,
        };
      },
      onSummarize: async (selectedQueryIndices: number[], _signal: AbortSignal, _model?: string) => {
        const queryResults: QueryResultData[] = selectedQueryIndices.map((i) => ({
          query: query ?? `Query ${i + 1}`,
          answer: "",
          results: [],
          error: null,
        }));
        return buildDeterministicSummary(queryResults);
      },
      onRewriteQuery: async (rewriteQuery: string) => rewriteQuery,
    },
  );
  activeCurator = handle;
  if (ctx.hasUI) {
    ctx.ui.notify(`Curator opened at ${handle.url}`, "info");
  }
}

export function closeCurator(): void {
  if (activeCurator) {
    activeCurator.close();
    activeCurator = undefined;
  }
}

export function registerCuratorCommands(pi: ExtensionAPI): void {
  pi.registerCommand("websearch", {
    description: "Open the web search curator UI",
    async handler(args, ctx) {
      await openCurator(ctx, args.trim() || undefined);
    },
  });
  pi.registerCommand("curator", {
    description: "Toggle or configure the curator workflow (on/off)",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        closeCurator();
        ctx.ui.notify("Curator closed", "info");
      } else if (action === "on" || action === "") {
        await openCurator(ctx);
      } else {
        ctx.ui.notify("Usage: /curator [on|off]", "warning");
      }
    },
  });
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
