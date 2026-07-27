import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { singleLine, textBlock } from "../../tui/components.ts";
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
    description: "Verify a claim against web sources and produce a machine-readable research artifact with source quality classification and claim assessment.",
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
    renderCall(args, theme) {
      const claim = String(args.claim ?? "").slice(0, 60);
      return singleLine(`${theme.fg("toolTitle", theme.bold("source_check "))}${theme.fg("accent", `"${claim}"`)}`);
    },
    renderResult(result, opts, theme) {
      const isError = (result as { isError?: boolean }).isError === true;
      if (isError) {
        const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
        if (opts.expanded) return textBlock(text);
        return singleLine(theme.fg("error", `✗ ${text.split("\n")[0]?.slice(0, 120)}`));
      }
      if (opts.expanded) {
        const block = result.content.find((item) => item.type === "text");
        return textBlock(block && "text" in block ? block.text : "");
      }
      const details = result.details as SourceCheckDetails | undefined;
      const status = details?.artifact?.claims?.[0]?.status ?? "unknown";
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", `claim: ${status}`)}`);
    },
  };
}
