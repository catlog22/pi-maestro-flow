/**
 * Maestro Agent Extension Entry Point
 *
 * Registers three tools:
 *   - maestro: Main tool with action-based dispatch (explore, delegate, moa)
 *   - maestro-wait: Block until background maestro runs finish
 *   - maestro-status: Inspect active/completed runs
 *
 * Also registers dynamic LLM providers from cli-tools.json at startup.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import {
  MaestroParams,
  MaestroWaitParams,
  MaestroStatusParams,
} from "./schemas.ts";
import { executeExplore, type ExploreParams } from "../tools/explore.ts";
import { executeDelegate, type DelegateParams } from "../tools/delegate.ts";
import { executeMoa, type MoaParams } from "../tools/moa.ts";
import { executeMaestroWait } from "../tools/wait.ts";
import { executeMaestroStatus } from "../tools/status.ts";
import { registerMaestroProviders } from "../providers/provider-registry.ts";

interface MaestroState {
  baseCwd: string;
  activeRuns: Map<
    string,
    {
      action: string;
      startedAt: number;
      correlationId: string;
    }
  >;
}

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  const state: MaestroState = {
    baseCwd: "",
    activeRuns: new Map(),
  };

  // Register dynamic providers from cli-tools.json
  try {
    registerMaestroProviders(pi);
  } catch (error) {
    // Provider registration failures should not block extension load
    console.error(
      `[maestro] Provider registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // === Main Tool: maestro ===
  const maestroTool: ToolDefinition<typeof MaestroParams> = {
    name: "maestro",
    label: "Maestro",
    description: `Maestro flow command tool with three actions:

- **explore**: Parallel code search via teammate agents. Each prompt spawns an independent search agent.
  { action: "explore", prompts: ["FIND: auth middleware\\nSCOPE: src/"], model: "..." }

- **delegate**: Delegate a task to a specific model/provider for analysis or implementation.
  { action: "delegate", prompt: "Analyze the auth flow", tool: "gemini", mode: "analysis" }

- **moa**: Mixture-of-Agents — parallel reference analysis across models, then aggregator synthesis.
  { action: "moa", prompts: ["Compare auth strategies"], preset: "deep" }`,

    parameters: MaestroParams,

    async execute(
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate:
        | ((result: AgentToolResult) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      const action = params.action as string;

      // Track run
      state.activeRuns.set(id, {
        action,
        startedAt: Date.now(),
        correlationId: id,
      });

      try {
        switch (action) {
          case "explore":
            return await executeExplore(
              params as unknown as ExploreParams,
              signal,
              ctx,
            );

          case "delegate":
            return await executeDelegate(
              params as unknown as DelegateParams,
              signal,
              ctx,
            );

          case "moa":
            return await executeMoa(
              params as unknown as MoaParams,
              signal,
              ctx,
            );

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action "${action}". Valid actions: explore, delegate, moa`,
                },
              ],
              isError: true,
            };
        }
      } finally {
        state.activeRuns.delete(id);
      }
    },

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      const asyncLabel =
        args.async === true ? theme.fg("warning", " [async]") : "";

      let detail = "";
      if (action === "explore") {
        const prompts = args.prompts as string[] | undefined;
        detail = prompts
          ? ` (${prompts.length} prompt${prompts.length !== 1 ? "s" : ""})`
          : "";
      } else if (action === "delegate") {
        const tool = (args.tool as string) ?? "";
        detail = tool ? ` ${theme.fg("accent", tool)}` : "";
      } else if (action === "moa") {
        detail = "";
      }

      return new Text(
        `${theme.fg("toolTitle", theme.bold("maestro "))}${action}${detail}${asyncLabel}`,
        0,
        0,
      );
    },
  };

  pi.registerTool(maestroTool);

  // === Auxiliary Tool: maestro-wait ===
  const waitTool: ToolDefinition<typeof MaestroWaitParams> = {
    name: "maestro-wait",
    label: "Maestro Wait",
    description: `Block until background (async) maestro runs finish.

- { } — wait for first active run to finish (default)
- { all: true } — wait for all active runs to finish
- { id: "..." } — wait for a specific run
- { timeoutMs: 600000 } — timeout after N ms (runs continue regardless)`,

    parameters: MaestroWaitParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      return executeMaestroWait(
        params as { id?: string; all?: boolean; timeoutMs?: number },
        signal,
        state,
      );
    },
  };

  pi.registerTool(waitTool);

  // === Auxiliary Tool: maestro-status ===
  const statusTool: ToolDefinition<typeof MaestroStatusParams> = {
    name: "maestro-status",
    label: "Maestro Status",
    description: `Inspect maestro run status.

- { } — fleet overview of all active runs
- { id: "..." } — details for a specific run
- { view: "transcript" } — tail the latest run transcript`,

    parameters: MaestroStatusParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult> {
      return executeMaestroStatus(
        params as { id?: string; view?: "fleet" | "transcript" },
        state,
      );
    },
  };

  pi.registerTool(statusTool);

  // Session lifecycle
  pi.on("session_start", (_event, ctx) => {
    state.baseCwd = ctx.cwd;
  });

  pi.on("session_shutdown", () => {
    state.activeRuns.clear();
  });
}
