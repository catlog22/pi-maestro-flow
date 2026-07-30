import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine } from "../../quiet-render.ts";
import {
  buildResearchArtifact,
  withClaimAssessment,
  storeResearchArtifact,
  type ResearchArtifact,
  type RecencyFilter,
} from "./source-check.ts";
import { nativeSearch } from "./search-router.ts";

const SourceCheckParams = Type.Object({
  claim: Type.String({ minLength: 1, description: "The claim to verify" }),
  recency: Type.Optional(Type.Unsafe<RecencyFilter>({
    type: "string",
    enum: ["day", "week", "month", "year", "any"],
    description: "Recency filter for search results",
  })),
  num_sources: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of sources to check" })),
});

interface SourceCheckDetails {
  claim: string;
  artifact: ResearchArtifact;
}

export function createSourceCheckTool(): ToolDefinition<typeof SourceCheckParams, SourceCheckDetails> {
  return {
    name: "source_check",
    label: "Source Check",
    description: "Verify a claim against web sources and produce a machine-readable research artifact with source quality classification and claim assessment. " +
      "Example: { claim: \"Node 22 supports native TypeScript stripping\", recency: \"month\" }.",
    promptSnippet: "Use source_check to verify factual claims with attributed web evidence.",
    parameters: SourceCheckParams,
    async execute(_id, params, signal): Promise<AgentToolResult<SourceCheckDetails>> {
      const claim = params.claim.trim();
      if (!claim) throw new Error("Claim is required.");
      const searchResult = await nativeSearch({
        query: claim,
        numResults: params.num_sources ?? 8,
        signal,
      });
      let artifact = buildResearchArtifact({
        query: claim,
        provider: searchResult.provider,
        results: searchResult.results.map((r, i) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          rank: i + 1,
        })),
        recency: params.recency as RecencyFilter | undefined,
      });
      artifact = withClaimAssessment(artifact, [claim]);
      storeResearchArtifact(artifact);
      return {
        content: [{ type: "text", text: JSON.stringify(artifact, null, 2) }],
        details: { claim, artifact },
      } as AgentToolResult<SourceCheckDetails>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const claim = String(args.claim ?? "").slice(0, 60);
      return toolCallLine(theme, "source_check", `"${claim}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const isError = (result as { isError?: boolean }).isError === true;
      const details = result.details as SourceCheckDetails | undefined;
      const status = details?.artifact?.claims?.[0]?.status ?? "unknown";
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const claim = String(ctx.args.claim ?? "").slice(0, 60);
      return toolResultLine(theme, {
        name: "source_check",
        ok: !isError,
        arg: `"${claim}"`,
        summary: `claim: ${status}`,
        expanded: opts.expanded,
        detail: text,
      });
    },
  };
}
