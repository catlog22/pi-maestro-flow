/**
 * TUI rendering for the teammate tool.
 *
 * - Single: header + live output stream + tool activity + usage
 * - Parallel: multi-column agent status with per-agent progress
 * - Chain: sequential pipeline view with step progression
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Details, SingleResult } from "../shared/types.ts";

type Theme = ExtensionContext["ui"]["theme"];
type ProgressItem = NonNullable<Details["progress"]>[number];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function statusIcon(isError: boolean, isRunning: boolean, theme: Theme): string {
  if (isError) return theme.fg("error", "✗");
  if (isRunning) return theme.fg("warning", "⟳");
  return theme.fg("success", "✓");
}

function toolIcon(status: string, theme: Theme): string {
  return status === "running" ? theme.fg("warning", "~") : theme.fg("success", "✓");
}

function usageLine(r: SingleResult, theme: Theme): string {
  const parts: string[] = [];
  const total = r.usage.inputTokens + r.usage.outputTokens;
  if (total > 0) parts.push(`${formatTokens(r.usage.inputTokens)}in/${formatTokens(r.usage.outputTokens)}out`);
  if (r.usage.cost > 0) parts.push(`$${r.usage.cost.toFixed(4)}`);
  if (r.durationMs > 0) parts.push(formatDuration(r.durationMs));
  if (r.usage.turns > 0) parts.push(`${r.usage.turns} turns`);
  return parts.map((p) => theme.fg("dim", p)).join(theme.fg("dim", " | "));
}

// ─── Render call ─────────────────────────────────────────────────────────────

export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  const agent = (args.agent as string) ?? "?";
  const name = args.name ? theme.fg("dim", ` name="${args.name}"`) : "";
  const bg = args.background === false ? "" : theme.fg("dim", " [bg]");
  const mode = args.tasks ? theme.fg("accent", " parallel") : args.chain ? theme.fg("accent", " chain") : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("teammate "))}${theme.fg("accent", agent)}${name}${mode}${bg}`,
    0, 0,
  );
}

// ─── Render result ───────────────────────────────────────────────────────────

export function renderTeammateResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = result.details;
  const progress = details?.progress;
  const isRunning = progress?.some((p) => p.status === "running") ?? false;
  const icon = statusIcon(result.isError, isRunning, theme);

  // ── Live progress (no results yet) ──
  if (!details || details.results.length === 0) {
    if (progress && progress.length > 0) {
      if (progress.length === 1) {
        return new Text(renderSingleProgress(progress[0], icon, theme).join("\n"), 0, 0);
      }
      return new Text(renderParallelProgress(progress, theme).join("\n"), 0, 0);
    }
    // Background dispatch message
    const text = typeof result.content === "string"
      ? result.content
      : result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return new Text(`${icon} ${theme.fg("dim", text.split("\n")[0]?.slice(0, 80) ?? "(no output)")}`, 0, 0);
  }

  // ── Completed results ──
  const mode = details.mode;
  if (mode === "parallel") return new Text(renderParallelResults(details.results, icon, options, theme).join("\n"), 0, 0);
  if (mode === "chain") return new Text(renderChainResults(details.results, icon, options, theme).join("\n"), 0, 0);
  return new Text(renderSingleResult(details.results[0], icon, details.progress?.[0], options, theme).join("\n"), 0, 0);
}

// ─── Single agent ────────────────────────────────────────────────────────────

const FIXED_HEIGHT = 12;

function renderSingleProgress(p: ProgressItem, icon: string, theme: Theme): string[] {
  const lines: string[] = [];
  const tokens = p.tokens ? ` ${formatTokens(p.tokens)}` : "";
  const tools = p.toolCount ? ` ${p.toolCount}t` : "";
  lines.push(`${icon} ${theme.bold(p.agent)}${theme.fg("dim", `${tokens}${tools}`)}`);

  // Tool activity (last 2)
  if (p.recentTools && p.recentTools.length > 0) {
    for (const t of p.recentTools.slice(-2)) {
      lines.push(`  ${toolIcon(t.status, theme)} ${theme.fg("dim", t.name)}`);
    }
  }

  // Live output (fill remaining height)
  if (p.lastMessage) {
    const remaining = FIXED_HEIGHT - lines.length - 1;
    const msgLines = p.lastMessage.split("\n");
    const show = msgLines.slice(-Math.max(remaining, 3));
    for (const line of show) {
      lines.push(`  ${theme.fg("dim", `│ ${line.slice(0, 76)}`)}`);
    }
  }

  // Pad to fixed height
  while (lines.length < FIXED_HEIGHT) lines.push("");

  return lines;
}

function renderSingleResult(
  r: SingleResult, icon: string, p: ProgressItem | undefined,
  options: { expanded: boolean }, theme: Theme,
): string[] {
  const lines: string[] = [];
  const dur = r.durationMs > 0 ? ` ${formatDuration(r.durationMs)}` : "";
  lines.push(`${icon} ${theme.bold(r.agent)} ${theme.fg("dim", r.model)}${theme.fg("dim", dur)}`);

  // Live tools
  if (p?.status === "running" && p.recentTools?.length) {
    for (const t of p.recentTools.slice(-3)) {
      lines.push(`  ${toolIcon(t.status, theme)} ${theme.fg("dim", t.name)}`);
    }
  }

  // Live output (fixed window)
  if (p?.lastMessage) {
    const remaining = FIXED_HEIGHT - lines.length - 1;
    const msgLines = p.lastMessage.split("\n").slice(-Math.max(remaining, 3));
    for (const line of msgLines) {
      lines.push(`  ${theme.fg("dim", `│ ${line.slice(0, 76)}`)}`);
    }
  }

  // Usage
  const u = usageLine(r, theme);
  if (u) lines.push(`  ${u}`);

  // Expanded: full last message
  if (options.expanded && !p?.lastMessage) {
    const last = r.messages[r.messages.length - 1];
    if (last?.content) {
      const contentLines = last.content.split("\n");
      const max = 20;
      for (const line of contentLines.slice(0, max)) {
        lines.push(`  ${theme.fg("dim", `│ ${line}`)}`);
      }
      if (contentLines.length > max) {
        lines.push(`  ${theme.fg("dim", `… ${contentLines.length - max} more lines`)}`);
      }
    }
  }

  return lines;
}

// ─── Parallel ────────────────────────────────────────────────────────────────

function renderParallelProgress(progress: ProgressItem[], theme: Theme): string[] {
  const lines: string[] = [];
  const running = progress.filter((p) => p.status === "running").length;
  const done = progress.filter((p) => p.status !== "running").length;
  lines.push(theme.fg("accent", `▸ parallel`) + theme.fg("dim", ` ${done}/${progress.length} done`));
  lines.push("");

  for (const p of progress) {
    const pIcon = p.status === "running"
      ? theme.fg("warning", "⟳")
      : p.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const tokens = p.tokens ? ` ${formatTokens(p.tokens)}` : "";
    const tools = p.toolCount ? ` ${p.toolCount}t` : "";
    lines.push(`  ${pIcon} ${theme.bold(p.agent)}${theme.fg("dim", `${tokens}${tools}`)}`);

    // Last tool for running agents
    if (p.status === "running" && p.recentTools?.length) {
      const last = p.recentTools[p.recentTools.length - 1];
      lines.push(`    ${toolIcon(last.status, theme)} ${theme.fg("dim", last.name)}`);
    }

    // Last output line
    if (p.lastMessage) {
      const lastLine = p.lastMessage.split("\n").filter(l => l.trim()).pop() ?? "";
      if (lastLine) {
        lines.push(`    ${theme.fg("dim", `│ ${lastLine.slice(0, 60)}`)}`);
      }
    }
  }

  return lines;
}

function renderParallelResults(
  results: SingleResult[], icon: string,
  options: { expanded: boolean }, theme: Theme,
): string[] {
  const lines: string[] = [];
  const failed = results.filter((r) => r.exitCode !== 0).length;
  lines.push(`${icon} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `${results.length} agents`)}${failed > 0 ? theme.fg("error", ` ${failed} failed`) : ""}`);
  lines.push("");

  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const dur = r.durationMs > 0 ? ` ${formatDuration(r.durationMs)}` : "";
    lines.push(`  ${rIcon} ${theme.bold(r.agent)} ${theme.fg("dim", r.model)}${theme.fg("dim", dur)}`);

    const last = r.messages[r.messages.length - 1]?.content ?? "";
    const preview = last.split("\n")[0]?.slice(0, 60) ?? "";
    if (preview) lines.push(`    ${theme.fg("dim", preview)}`);

    if (options.expanded) {
      const u = usageLine(r, theme);
      if (u) lines.push(`    ${u}`);
    }
  }

  return lines;
}

// ─── Chain ───────────────────────────────────────────────────────────────────

function renderChainResults(
  results: SingleResult[], icon: string,
  options: { expanded: boolean }, theme: Theme,
): string[] {
  const lines: string[] = [];
  const failed = results.filter((r) => r.exitCode !== 0).length;
  const totalDur = results.reduce((s, r) => s + r.durationMs, 0);
  lines.push(`${icon} ${theme.fg("accent", "chain")} ${theme.fg("dim", `${results.length} steps ${formatDuration(totalDur)}`)}${failed > 0 ? theme.fg("error", ` ${failed} failed`) : ""}`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const connector = i < results.length - 1 ? theme.fg("dim", " →") : "";
    lines.push(`  ${theme.fg("dim", `${i + 1}.`)} ${rIcon} ${theme.bold(r.agent)} ${theme.fg("dim", formatDuration(r.durationMs))}${connector}`);

    const last = r.messages[r.messages.length - 1]?.content ?? "";
    const preview = last.split("\n")[0]?.slice(0, 60) ?? "";
    if (preview) lines.push(`     ${theme.fg("dim", preview)}`);

    if (options.expanded) {
      const u = usageLine(r, theme);
      if (u) lines.push(`     ${u}`);
    }
  }

  return lines;
}
