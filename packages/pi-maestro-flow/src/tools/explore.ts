/**
 * Explore action — parallel code search via teammate sub-agents.
 *
 * For each prompt, spawns a teammate agent (explorer profile) that
 * searches the codebase using read/grep/find/ls tools.
 * Results are collected and merged into a unified exploration output.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/src/runs/execution.ts";
import type { SingleResult } from "pi-maestro-teammate/src/shared/types.ts";

export interface ExploreParams {
  prompts?: string[];
  endpoint?: string;
  all?: boolean;
  maxTurns?: number;
  concurrency?: number;
  model?: string;
  cwd?: string;
}

export interface ExploreResult {
  prompt: string;
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
): Promise<AgentToolResult> {
  const prompts = params.prompts ?? [];

  if (prompts.length === 0) {
    return {
      content: [{ type: "text", text: "No prompts provided for explore action." }],
      isError: true,
    };
  }

  const concurrency = params.concurrency ?? 4;
  const results: ExploreResult[] = [];
  const errors: string[] = [];

  // Process prompts with concurrency limit
  const queue = [...prompts];
  const running: Promise<void>[] = [];

  const processPrompt = async (prompt: string): Promise<void> => {
    if (signal.aborted) return;

    try {
      const result = await runTeammate(
        {
          agent: "explorer",
          task: prompt,
          model: params.model ?? params.endpoint,
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

      results.push({
        prompt,
        agent: result.agent,
        model: result.model,
        content: lastMessage,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (error) {
      errors.push(
        `Prompt "${prompt.slice(0, 50)}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Dispatch with concurrency control
  for (const prompt of queue) {
    if (signal.aborted) break;

    const task = processPrompt(prompt);
    running.push(task);

    if (running.length >= concurrency) {
      await Promise.race(running);
      // Remove completed tasks
      for (let i = running.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          running[i].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) running.splice(i, 1);
      }
    }
  }

  // Wait for remaining
  await Promise.allSettled(running);

  // Build output
  const outputParts: string[] = [];
  for (const result of results) {
    outputParts.push(
      `## Prompt: ${result.prompt.slice(0, 80)}\n**Model**: ${result.model} | **Duration**: ${result.durationMs}ms\n\n${result.content}\n`,
    );
  }

  if (errors.length > 0) {
    outputParts.push(`## Errors\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }

  return {
    content: [{ type: "text", text: outputParts.join("\n---\n\n") }],
    isError: results.length === 0 && errors.length > 0,
  };
}
