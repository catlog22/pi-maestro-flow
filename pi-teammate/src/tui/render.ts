/**
 * TUI rendering for the teammate tool.
 *
 * B: Real-time streaming in tool result (onUpdate driven)
 * A: Overlay view via teammate-attach (separate component)
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Details, SingleResult } from "../shared/types.ts";

type Theme = ExtensionContext["ui"]["theme"];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function statusIcon(
  result: AgentToolResult<Details>,
  theme: Theme,
): string {
  if (result.isError) return theme.fg("error", "✗");

  const progress = result.details?.progress;
  if (progress?.some((p) => p.status === "running")) {
    return theme.fg("warning", "⟳");
  }

  return theme.fg("success", "✓");
}

function toolStatusIcon(status: string, theme: Theme): string {
  if (status === "running") return theme.fg("warning", "~");
  if (status === "completed") return theme.fg("success", "✓");
  return theme.fg("dim", "·");
}

function buildUsageLine(result: SingleResult, theme: Theme): string {
  const parts: string[] = [];

  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  if (totalTokens > 0) {
    parts.push(
      `${formatTokens(result.usage.inputTokens)}in/${formatTokens(result.usage.outputTokens)}out`,
    );
  }

  if (result.usage.cost > 0) {
    parts.push(`$${result.usage.cost.toFixed(4)}`);
  }

  if (result.durationMs > 0) {
    parts.push(formatDuration(result.durationMs));
  }

  if (result.usage.turns > 0) {
    parts.push(`${result.usage.turns} turns`);
  }

  return parts.map((p) => theme.fg("dim", p)).join(theme.fg("dim", " | "));
}

/**
 * Render the teammate tool call (shows agent name, mode, name).
 */
export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  const agentName = (args.agent as string) ?? "?";
  const name = args.name ? theme.fg("dim", ` name="${args.name}"`) : "";
  const mode = args.mode === "detach" ? theme.fg("warning", " [detach]") : "";

  return new Text(
    `${theme.fg("toolTitle", theme.bold("teammate "))}${theme.fg("accent", agentName)}${name}${mode}`,
    0,
    0,
  );
}

/**
 * Render the teammate tool result — real-time streaming via onUpdate.
 *
 * During execution (progress has running items):
 *   ⟳ scout  deepseek-v4-pro  12s
 *     ~ Reading src/auth/jwt.ts
 *     ✓ grep "validateToken"
 *     ~ Writing analysis...
 *     2.3kin/1.1kout | 12s | 3 turns
 *
 * After completion:
 *   ✓ scout  deepseek-v4-pro
 *     Find all auth middleware...
 *     2.3kin/1.1kout | $0.0012 | 15s | 5 turns
 */
export function renderTeammateResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const icon = statusIcon(result, theme);
  const details = result.details;

  // No details yet (early update or detach response)
  if (!details || details.results.length === 0) {
    const progress = details?.progress;

    // Live progress view
    if (progress && progress.length > 0) {
      const lines: string[] = [];
      for (const p of progress) {
        const pIcon = p.status === "running"
          ? theme.fg("warning", "⟳")
          : p.status === "completed"
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
        lines.push(`${pIcon} ${theme.bold(p.agent)} ${theme.fg("dim", p.status)}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    }

    // Static text fallback
    const content =
      typeof result.content === "string"
        ? result.content
        : result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");

    const preview = content.split("\n")[0]?.slice(0, 80) ?? "(no output)";
    return new Text(`${icon} ${theme.fg("dim", preview)}`, 0, 0);
  }

  const lines: string[] = [];

  for (const singleResult of details.results) {
    // Header: icon + agent + model + duration
    const dur = singleResult.durationMs > 0 ? ` ${theme.fg("dim", formatDuration(singleResult.durationMs))}` : "";
    const header = `${icon} ${theme.bold(singleResult.agent)} ${theme.fg("dim", singleResult.model)}${dur}`;
    lines.push(header);

    // Live tool activity (from progress)
    const progress = details.progress;
    const agentProgress = progress?.find((p) => p.agent === singleResult.agent);
    if (agentProgress?.status === "running") {
      // Show recent tools as live activity
      const recentTools = (agentProgress as unknown as { recentTools?: Array<{ name: string; status: string }> }).recentTools;
      if (recentTools && recentTools.length > 0) {
        const last5 = recentTools.slice(-5);
        for (const t of last5) {
          const tIcon = toolStatusIcon(t.status, theme);
          lines.push(`  ${tIcon} ${theme.fg("dim", t.name)}`);
        }
      }
    }

    // Task preview (truncated)
    if (singleResult.task && !agentProgress?.status) {
      const taskPreview = singleResult.task.split("\n")[0]?.slice(0, 60) ?? "";
      if (taskPreview) {
        lines.push(`  ${theme.fg("dim", taskPreview)}`);
      }
    }

    // Usage line
    const usageLine = buildUsageLine(singleResult, theme);
    if (usageLine) {
      lines.push(`  ${usageLine}`);
    }

    // Expanded: show last message content
    if (options.expanded) {
      const lastMessage =
        singleResult.messages[singleResult.messages.length - 1];
      if (lastMessage?.content) {
        const contentLines = lastMessage.content.split("\n");
        const maxLines = 20;
        const displayLines = contentLines.slice(0, maxLines);
        for (const line of displayLines) {
          lines.push(`  ${theme.fg("dim", `│ ${line}`)}`);
        }
        if (contentLines.length > maxLines) {
          lines.push(
            `  ${theme.fg("dim", `… ${contentLines.length - maxLines} more lines`)}`,
          );
        }
      }
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}
