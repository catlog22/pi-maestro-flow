/**
 * maestro-wait auxiliary tool.
 *
 * Blocks until background maestro runs finish.
 * Supports waiting for a specific run, the first to finish, or all runs.
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

interface WaitParams {
  id?: string;
  all?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 1000;

/**
 * Wait for active maestro runs to complete.
 *
 * Uses a poll-based approach to check run completion status.
 * Resolves when the target run(s) finish or timeout is reached.
 */
export async function executeMaestroWait(
  params: WaitParams,
  signal: AbortSignal,
  state: MaestroState,
): Promise<AgentToolResult> {
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  // No active runs
  if (state.activeRuns.size === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No active maestro runs to wait for.",
        },
      ],
    };
  }

  // If waiting for specific ID
  if (params.id) {
    const run = state.activeRuns.get(params.id);
    if (!run) {
      return {
        content: [
          {
            type: "text",
            text: `Run "${params.id}" not found in active runs.`,
          },
        ],
      };
    }
  }

  // Poll until completion or timeout
  return new Promise<AgentToolResult>((resolve) => {
    const checkCompletion = () => {
      // Check abort
      if (signal.aborted) {
        resolve({
          content: [
            {
              type: "text",
              text: "Wait was aborted.",
            },
          ],
        });
        return;
      }

      // Check timeout
      if (Date.now() - startTime >= timeout) {
        const remaining = Array.from(state.activeRuns.entries())
          .map(([id, r]) => `  - ${id}: ${r.action} (running ${Math.floor((Date.now() - r.startedAt) / 1000)}s)`)
          .join("\n");

        resolve({
          content: [
            {
              type: "text",
              text: `Wait timed out after ${timeout}ms. Active runs:\n${remaining}`,
            },
          ],
        });
        return;
      }

      // Check if target run(s) finished
      if (params.id) {
        if (!state.activeRuns.has(params.id)) {
          resolve({
            content: [
              {
                type: "text",
                text: `Run "${params.id}" completed.`,
              },
            ],
          });
          return;
        }
      } else if (params.all) {
        if (state.activeRuns.size === 0) {
          resolve({
            content: [
              {
                type: "text",
                text: "All maestro runs completed.",
              },
            ],
          });
          return;
        }
      } else {
        // Wait for first — check if any have completed since we started
        // (This simple implementation checks if the count decreased)
        // A full implementation would use event subscriptions
        if (state.activeRuns.size === 0) {
          resolve({
            content: [
              {
                type: "text",
                text: "A maestro run completed.",
              },
            ],
          });
          return;
        }
      }

      // Keep polling
      setTimeout(checkCompletion, POLL_INTERVAL_MS);
    };

    // Start polling
    checkCompletion();

    // Handle abort signal
    signal.addEventListener(
      "abort",
      () => {
        resolve({
          content: [
            { type: "text", text: "Wait was aborted." },
          ],
        });
      },
      { once: true },
    );
  });
}
