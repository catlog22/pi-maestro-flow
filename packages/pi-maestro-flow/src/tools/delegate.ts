/**
 * Delegate action — task delegation to a specific model/provider.
 *
 * Spawns a single teammate agent (general profile) with the specified
 * model override from registered providers, passing the prompt as task
 * with analysis or write mode.
 */

import type { FlowToolResult } from "./tool-result.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/v1/execution";
import { createDirectTeammateRunOptions } from "./direct-teammate.ts";

export interface DelegateParams {
  prompt?: string;
  tool?: string;
  mode?: "analysis" | "write";
  name?: string;
  model?: string;
  rule?: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Execute delegate action: spawn a teammate with specified model override.
 */
export async function executeDelegate(
  params: DelegateParams,
  signal: AbortSignal,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<FlowToolResult> {
  if (!params.prompt) {
    return {
      content: [
        { type: "text", text: "No prompt provided for delegate action." },
      ],
      isError: true,
      details: {},
    };
  }

  // Build task with mode context
  let task = params.prompt;
  if (params.mode) {
    task = `MODE: ${params.mode}\n\n${task}`;
  }
  if (params.rule) {
    task = `RULE: ${params.rule}\n\n${task}`;
  }

  // Resolve model from tool name or explicit model
  const model = params.model ?? params.tool;

  try {
    const [result] = await runTeammate(
      {
        tasks: [{
          agent: "general",
          prompt: task,
          name: params.name,
          model,
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
          context: "fresh",
        }],
        background: false,
        reply_to: "caller",
      },
      createDirectTeammateRunOptions(pi, ctx, { baseCwd: ctx.cwd, signal }),
    );
    if (!result) throw new Error("Delegate returned no teammate result");

    const lastMessage =
      result.messages[result.messages.length - 1]?.content ?? "(no output)";

    return {
      content: [{ type: "text", text: lastMessage }],
      isError: result.exitCode !== 0,
      details: {},
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Delegate failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
      details: {},
    };
  }
}
