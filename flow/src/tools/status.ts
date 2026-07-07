/**
 * maestro-status auxiliary tool.
 *
 * Inspects active and completed maestro runs.
 * Supports fleet view (overview) and transcript view (tail logs).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

interface MaestroState {
  activeRuns: Map<
    string,
    {
      action: string;
      startedAt: number;
      correlationId: string;
    }
  >;
}

interface StatusParams {
  id?: string;
  view?: "fleet" | "transcript";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

/**
 * Get status of maestro runs.
 */
export async function executeMaestroStatus(
  params: StatusParams,
  state: MaestroState,
): Promise<AgentToolResult> {
  const now = Date.now();

  // Specific run by ID
  if (params.id) {
    const run = state.activeRuns.get(params.id);
    if (!run) {
      return {
        content: [
          {
            type: "text",
            text: `Run "${params.id}" not found. It may have completed.`,
          },
        ],
      };
    }

    const elapsed = formatDuration(now - run.startedAt);
    return {
      content: [
        {
          type: "text",
          text: [
            `## Run: ${params.id}`,
            `- **Action**: ${run.action}`,
            `- **Status**: running`,
            `- **Elapsed**: ${elapsed}`,
            `- **Correlation ID**: ${run.correlationId}`,
          ].join("\n"),
        },
      ],
    };
  }

  // Fleet view (default)
  if (state.activeRuns.size === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No active maestro runs.",
        },
      ],
    };
  }

  const lines: string[] = ["## Maestro Fleet Status", ""];

  for (const [id, run] of state.activeRuns) {
    const elapsed = formatDuration(now - run.startedAt);
    lines.push(`- **${id}**: ${run.action} (${elapsed})`);
  }

  lines.push("", `Total: ${state.activeRuns.size} active run(s)`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
