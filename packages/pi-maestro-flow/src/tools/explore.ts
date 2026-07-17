/**
 * Explore action — parallel code search via teammate sub-agents.
 *
 * For each prompt, spawns a teammate agent (explorer profile) that
 * searches the codebase using read/grep/find/ls tools.
 * Results are collected and merged into a unified exploration output.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/v1/execution";
import { createDirectTeammateRunOptions } from "./direct-teammate.ts";

export interface ExploreParams {
  prompts?: string[];
  endpoint?: string;
  all?: boolean;
  maxTurns?: number;
  concurrency?: number;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExploreResult {
  prompt: string;
  name: string;
  agent: string;
  model: string;
  content: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Execute explore action: spawn parallel teammate agents for code search.
 */
export async function executeExplore(
  params: ExploreParams,
  signal: AbortSignal,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<AgentToolResult> {
  const prompts = params.prompts ?? [];

  if (prompts.length === 0) {
    return {
      content: [{ type: "text", text: "No prompts provided for explore action." }],
      isError: true,
    };
  }

  const concurrency = Math.max(1, Math.floor(params.concurrency ?? 4));
  const results: Array<ExploreResult | undefined> = new Array(prompts.length);
  const errors: Array<string | undefined> = new Array(prompts.length);

  const processPrompt = async (prompt: string, index: number): Promise<void> => {
    if (signal.aborted) return;
    const name = `explore-${String(index + 1).padStart(2, "0")}`;

    try {
      const result = await runTeammate(
        {
          agent: "explorer",
          task: prompt,
          name,
          model: params.model ?? params.endpoint,
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
          background: false,
          reply_to: "caller",
          lifecycle: "ephemeral",
        },
        createDirectTeammateRunOptions(pi, ctx, { baseCwd: ctx.cwd, signal }),
      );

      const lastMessage =
        result.messages[result.messages.length - 1]?.content ?? "(no output)";

      results[index] = {
        prompt,
        name,
        agent: result.agent,
        model: result.model,
        content: lastMessage,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
    } catch (error) {
      errors[index] =
        `Prompt "${prompt.slice(0, 50)}": ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = nextIndex++;
      if (index >= prompts.length) return;
      await processPrompt(prompts[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, prompts.length) }, () => worker()),
  );

  // Build output
  const outputParts: string[] = [];
  for (const result of results) {
    if (!result) continue;
    outputParts.push(
      `## Prompt: ${result.prompt.slice(0, 80)}\n**Task**: @${result.name} | **Model**: ${result.model} | **Duration**: ${result.durationMs}ms\n\n${result.content}\n`,
    );
  }

  const reportedErrors = errors.filter((error): error is string => Boolean(error));
  if (reportedErrors.length > 0) {
    outputParts.push(`## Errors\n${reportedErrors.map((e) => `- ${e}`).join("\n")}`);
  }

  const completedResults = results.filter((result): result is ExploreResult => Boolean(result));

  return {
    content: [{ type: "text", text: outputParts.join("\n---\n\n") }],
    isError: completedResults.length === 0 && reportedErrors.length > 0,
  };
}
