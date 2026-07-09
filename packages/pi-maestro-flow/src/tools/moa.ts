/**
 * MOA (Mixture-of-Agents) action — multi-model synthesis.
 *
 * Phase 1: Spawn parallel teammate agents (reference profile) across
 *          different models/endpoints for independent analysis.
 * Phase 2: Spawn aggregator teammate with all reference outputs as
 *          context to synthesize a unified result.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/src/runs/execution.ts";
import type { SingleResult } from "pi-maestro-teammate/src/shared/types.ts";

export interface MoaParams {
  prompts?: string[];
  preset?: string;
  maxTurns?: number;
  model?: string;
  cwd?: string;
}

interface ReferenceOutput {
  model: string;
  content: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Get available models from registered providers.
 * Falls back to a default set if provider registry is not available.
 */
function getAvailableModels(preset?: string): string[] {
  // Default models for MOA — the provider registry will override these
  // when fully connected. For now, use a reasonable default set.
  return [
    "anthropic/claude-sonnet-4",
    "google/gemini-2.5-pro",
    "openai/gpt-4.1",
  ];
}

/**
 * Execute MOA action: parallel reference analysis + aggregator synthesis.
 */
export async function executeMoa(
  params: MoaParams,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<AgentToolResult> {
  const prompts = params.prompts ?? [];
  const primaryPrompt = prompts[0];

  if (!primaryPrompt) {
    return {
      content: [
        { type: "text", text: "No prompts provided for MOA action." },
      ],
      isError: true,
    };
  }

  const models = getAvailableModels(params.preset);

  // Phase 1: Spawn parallel reference agents across different models
  const referenceOutputs: ReferenceOutput[] = [];
  const referencePromises: Promise<void>[] = [];

  for (const model of models) {
    if (signal.aborted) break;

    const promise = (async () => {
      try {
        const result = await runTeammate(
          {
            agent: "reference",
            task: primaryPrompt,
            model,
            cwd: params.cwd,
            reply_to: "caller",
            lifecycle: "ephemeral",
          },
          {
            baseCwd: ctx.cwd,
            signal,
          },
        );

        const lastMessage =
          result.messages[result.messages.length - 1]?.content ?? "(no output)";

        referenceOutputs.push({
          model: result.model,
          content: lastMessage,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
      } catch (error) {
        referenceOutputs.push({
          model,
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 1,
          durationMs: 0,
        });
      }
    })();

    referencePromises.push(promise);
  }

  // Wait for all reference agents
  await Promise.allSettled(referencePromises);

  if (signal.aborted) {
    return {
      content: [{ type: "text", text: "MOA operation was aborted." }],
      isError: true,
    };
  }

  const successfulOutputs = referenceOutputs.filter((r) => r.exitCode === 0);

  if (successfulOutputs.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `All reference agents failed.\n\n${referenceOutputs.map((r) => `${r.model}: ${r.content}`).join("\n\n")}`,
        },
      ],
      isError: true,
    };
  }

  // Phase 2: Aggregator synthesizes all reference outputs
  const aggregationPrompt = buildAggregationPrompt(
    primaryPrompt,
    successfulOutputs,
  );

  try {
    const aggregatorResult = await runTeammate(
      {
        agent: "aggregator",
        task: aggregationPrompt,
        model: params.model,
        cwd: params.cwd,
        reply_to: "caller",
        lifecycle: "ephemeral",
      },
      {
        baseCwd: ctx.cwd,
        signal,
      },
    );

    const lastMessage =
      aggregatorResult.messages[aggregatorResult.messages.length - 1]
        ?.content ?? "(no output)";

    return {
      content: [{ type: "text", text: lastMessage }],
      isError: aggregatorResult.exitCode !== 0,
    };
  } catch (error) {
    // Fallback: return raw reference outputs if aggregation fails
    const fallbackOutput = successfulOutputs
      .map((r) => `## ${r.model}\n\n${r.content}`)
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Aggregation failed, returning raw reference outputs:\n\n${fallbackOutput}`,
        },
      ],
      isError: false,
    };
  }
}

function buildAggregationPrompt(
  originalPrompt: string,
  referenceOutputs: ReferenceOutput[],
): string {
  const referenceSections = referenceOutputs
    .map(
      (r, i) =>
        `### Reference ${i + 1} (${r.model})\n\n${r.content}`,
    )
    .join("\n\n---\n\n");

  return `You are synthesizing multiple independent analyses into a unified, high-quality response.

## Original Question/Task

${originalPrompt}

## Independent Reference Analyses

${referenceSections}

## Your Task

Synthesize these reference analyses into a single, comprehensive response:
1. Identify areas of consensus across references
2. Note any conflicts or divergent perspectives
3. Produce a unified analysis that incorporates the strongest points from each reference
4. Where references disagree, evaluate the evidence and make a reasoned judgment
5. Ensure the final output is coherent, well-structured, and directly addresses the original question`;
}
