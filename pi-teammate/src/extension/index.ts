/**
 * Teammate Extension Entry Point
 *
 * Registers the 'teammate' tool with pi via ExtensionAPI.
 * Handles session lifecycle (start, shutdown) and dispatches
 * to the execution engine. Supports single, parallel, and chain modes.
 */

import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { TeammateParams } from "./schemas.ts";
import {
  runTeammate,
  runParallel,
  runChain,
  type RunTeammateParams,
} from "../runs/execution.ts";
import {
  renderTeammateCall,
  renderTeammateResult,
} from "../tui/render.ts";
import type {
  Details,
  TeammateState,
  AgentProgress,
} from "../shared/types.ts";
import {
  TEAMMATE_COMPLETE_EVENT,
  TEAMMATE_STARTED_EVENT,
} from "../shared/types.ts";

export default function registerTeammateExtension(pi: ExtensionAPI): void {
  if (process.env.PI_TEAMMATE_CHILD === "1") {
    return;
  }

  const state: TeammateState = {
    baseCwd: "",
    currentSessionId: null,
    activeRuns: new Map(),
  };

  const tool: ToolDefinition<typeof TeammateParams, Details> = {
    name: "teammate",
    label: "Teammate",
    description: `Dispatch tasks to teammate agents. Teammates run as pi subprocesses with their own tools and context.

Modes:
  - Single: { agent: "delegate", task: "..." }
  - Parallel: { tasks: [{ agent: "scout", task: "..." }, { agent: "reviewer", task: "..." }] }
  - Chain: { chain: [{ agent: "scout", task: "Find auth code" }, { agent: "delegate", task: "Fix: {previous}" }] }

Three-axis control:
  - name: Optional addressable name for cross-agent routing
  - reply_to: Result routing — "caller" (direct return) or "main" (broadcast to parent session)
  - lifecycle: "ephemeral" (default, one-shot) or "resident" (persistent)

Structured output:
  - outputSchema: JSON Schema to validate and parse child output as structured data`,

    parameters: TeammateParams,

    async execute(
      id: string,
      params: RunTeammateParams,
      signal: AbortSignal,
      onUpdate:
        | ((result: AgentToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Details>> {
      const correlationId = randomUUID();

      const abortController = new AbortController();
      state.activeRuns.set(correlationId, {
        agent: params.agent ?? "parallel",
        correlationId,
        startedAt: Date.now(),
        abortController,
      });

      pi.events.emit(TEAMMATE_STARTED_EVENT, {
        id,
        agent: params.agent ?? "parallel",
        correlationId,
      });

      const abortForward = () => abortController.abort();
      signal.addEventListener("abort", abortForward, { once: true });

      const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;

      const makeOptions = () => ({
        baseCwd: state.baseCwd || ctx.cwd,
        signal: abortController.signal,
        parentSessionFile,
        onProgress: (data: AgentProgress) => {
          if (!onUpdate) return;
          onUpdate({
            content: [{
              type: "text",
              text: `[${data.agent}] ${data.status} | tools: ${data.toolCount} | tokens: ${data.tokens}`,
            }],
            details: {
              mode: "single",
              results: [],
              progress: [{
                agent: data.agent,
                status: data.status,
                startedAt: new Date(data.startedAt).toISOString(),
                ...(data.status !== "running"
                  ? { completedAt: new Date().toISOString() }
                  : {}),
              }],
            },
          });
        },
      });

      try {
        // --- PARALLEL MODE ---
        if (params.tasks && params.tasks.length > 0) {
          const concurrency = params.concurrency ?? 4;
          const results = await runParallel(
            params.tasks,
            concurrency,
            makeOptions(),
          );

          const hasError = results.some((r) => r.exitCode !== 0);
          const summaries = results
            .map((r) => `[${r.agent}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.messages[r.messages.length - 1]?.content ?? "(no output)"}`)
            .join("\n\n");

          pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
            id,
            agent: "parallel",
            correlationId,
            exitCode: hasError ? 1 : 0,
            durationMs: Math.max(...results.map((r) => r.durationMs)),
          });

          return {
            content: [{ type: "text", text: summaries }],
            isError: hasError,
            details: { mode: "parallel", results },
          };
        }

        // --- CHAIN MODE ---
        if (params.chain && params.chain.length > 0) {
          const results = await runChain(
            params.chain,
            params.task ?? "",
            makeOptions(),
          );

          const lastResult = results[results.length - 1];
          const hasError = results.some((r) => r.exitCode !== 0);
          const lastMessage = lastResult?.messages[lastResult.messages.length - 1]?.content ?? "(no output)";

          pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
            id,
            agent: "chain",
            correlationId,
            exitCode: hasError ? 1 : 0,
            durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
          });

          return {
            content: [{ type: "text", text: lastMessage }],
            isError: hasError,
            details: { mode: "chain", results },
          };
        }

        // --- SINGLE MODE ---
        const result = await runTeammate(params, makeOptions());

        const lastMessage =
          result.messages[result.messages.length - 1]?.content ?? "(no output)";

        const toolResult: AgentToolResult<Details> = {
          content: [{ type: "text", text: lastMessage }],
          isError: result.exitCode !== 0,
          details: { mode: "single", results: [result] },
        };

        if (result.structuredOutput !== undefined) {
          toolResult.details!.structuredOutput = result.structuredOutput;
        }

        pi.events.emit(TEAMMATE_COMPLETE_EVENT, {
          id,
          agent: params.agent,
          correlationId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        return toolResult;
      } finally {
        state.activeRuns.delete(correlationId);
        signal.removeEventListener("abort", abortForward);
      }
    },

    renderCall(args, theme) {
      return renderTeammateCall(args, theme);
    },

    renderResult(result, options, theme) {
      return renderTeammateResult(result, options, theme);
    },
  };

  pi.registerTool(tool);

  pi.on("session_start", (_event, ctx) => {
    state.baseCwd = ctx.cwd;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
  });

  pi.on("session_shutdown", () => {
    for (const run of state.activeRuns.values()) {
      run.abortController.abort();
    }
    state.activeRuns.clear();
    state.currentSessionId = null;
  });
}
