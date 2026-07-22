/**
 * TUI rendering for the teammate tool.
 *
 * renderCall: compact one-line launch summary for single/chain/graph
 * renderResult: real-time streaming for foreground, compact status for completed
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box, type Component,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentProgressSnapshot, Details, SingleResult } from "../shared/types.ts";
import { extractDependencies } from "../runs/execution.ts";
import {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  selectPriorityProgressRows,
  selectProgressWindow,
  type ProgressPalette,
} from "./progress-tree.ts";

type Theme = ExtensionContext["ui"]["theme"];

function statusMeta(parts: string[], theme: Theme): string {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? theme.fg("dim", filtered.join(" · ")) : "";
}

function elapsed(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function dynamicComponent(build: (width: number) => string[]): Component {
  return { render: (w: number) => build(w), invalidate() {} };
}

function appendWrappedMessage(
  lines: string[],
  content: string,
  width: number,
  theme: Theme,
): void {
  for (const rawLine of content.split("\n")) {
    const wrapped = wrapTextWithAnsi(rawLine, Math.max(1, width));
    if (wrapped.length === 0) {
      lines.push(theme.fg("dim", "│"));
      continue;
    }
    for (const line of wrapped) {
      lines.push(theme.fg("dim", `│ ${line}`));
    }
  }
}

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

// ---------------------------------------------------------------------------
// renderCall — how the tool invocation appears in conversation
// ---------------------------------------------------------------------------

interface TaskArg {
  agent: string;
  name?: string;
  task?: string;
}

export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
  context?: { expanded?: boolean },
): Component {
  const tasks = args.tasks as TaskArg[] | undefined;
  const isBg = args.background !== false;

  // Multi-task: tree with dependency topology
  if (tasks?.length) {
    return renderMultiTaskCall(tasks, isBg, args, theme, context?.expanded ?? false);
  }

  // Single agent
  const agent = args.agent as string ?? "?";
  const name = args.name as string | undefined;
  const nameLabel = name ? `${theme.fg("accent", `@${name}`)} ` : "";
  const agentLabel = name
    ? theme.fg("dim", `(${agent})`)
    : theme.fg("accent", agent);
  const modeHint = isBg
    ? theme.fg("dim", " [bg]")
    : theme.fg("dim", " (Alt+B to detach)");

  const header = `${theme.fg("success", "■")} ${nameLabel}${agentLabel}${modeHint}`;
  return dynamicComponent((w) => [truncateToWidth(header, Math.max(1, w), "…")]);
}

function renderMultiTaskCall(
  tasks: TaskArg[],
  isBg: boolean,
  args: Record<string, unknown>,
  theme: Theme,
  expanded: boolean,
): Component {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const hasDeps = tasks.some((t) => extractDependencies(t.task, taskNames).length > 0);

  const modeWord = isBg ? "background" : "foreground";
  const hint = isBg
    ? theme.fg("dim", " (Alt+R to manage)")
    : theme.fg("dim", " (Alt+B to detach)");

  // Detect topology type
  let topoLabel = "";
  if (hasDeps) {
    const allLinear = isLinearChain(tasks, taskNames);
    topoLabel = allLinear ? " result chain" : " result graph";
  }

  const header = `${theme.fg("success", "■")} ${theme.bold(`${tasks.length}${topoLabel} ${modeWord} agents launched`)}${hint}`;
  if (expanded) {
    const indexByName = new Map<string, number>();
    tasks.forEach((task, index) => {
      if (task.name) indexByName.set(task.name, index);
    });
    const progress: AgentProgressSnapshot[] = tasks.map((task, index) => ({
      agent: task.agent,
      ...(task.name ? { name: task.name } : {}),
      correlationId: `preview-${index + 1}`,
      taskIndex: index,
      dependencies: extractDependencies(task.task, taskNames)
        .map((name) => indexByName.get(name))
        .filter((dependency): dependency is number => dependency !== undefined),
      status: "pending",
    }));
    const palette: ProgressPalette = {
      dim: (text) => theme.fg("dim", text),
      accent: (text) => theme.fg("accent", text),
      running: (text) => theme.fg("warning", text),
      success: (text) => theme.fg("success", text),
      error: (text) => theme.fg("error", text),
      bold: (text) => theme.bold(text),
    };
    const tree = buildProgressTree(progress, palette);
    return dynamicComponent((w) => [header, ...tree.map((row) => row.text)]
      .map((line) => truncateToWidth(line, Math.max(1, w), "…")));
  }
  return dynamicComponent((w) => [truncateToWidth(header, Math.max(1, w), "…")]);
}

function isLinearChain(tasks: TaskArg[], taskNames: Set<string>): boolean {
  for (let i = 0; i < tasks.length; i++) {
    const deps = extractDependencies(tasks[i].task, taskNames);
    if (deps.length > 1) return false;
    if (deps.length === 1 && i > 0 && deps[0] !== tasks[i - 1].name) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// renderResult — how the tool result appears in conversation
// ---------------------------------------------------------------------------

export function renderTeammateResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = result.details;

  // No results yet — streaming progress or background ack
  if (!details || details.results.length === 0) {
    return renderProgress(result, details, options, theme);
  }

  // Single result
  if (details.results.length === 1) {
    return renderSingleResult(details.results[0], options, theme);
  }

  // Multi-result
  return renderMultiResult(details, options, theme);
}

// ---------------------------------------------------------------------------
// Streaming progress (foreground real-time display)
// ---------------------------------------------------------------------------

function renderProgress(
  result: AgentToolResult<Details>,
  details: Details | undefined,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const progress = details?.progress;
  const childCalls = details?.childCalls ?? [];

  if (!progress?.length && childCalls.length === 0) {
    const content = typeof result.content === "string"
      ? result.content
      : result.content
        .map((content) => content.type === "text" ? content.text : "")
        .filter(Boolean)
        .join("\n");
    return dynamicComponent((w) => {
      const preview = truncateToWidth(content.split("\n")[0] ?? "", Math.max(1, w - 4), "…");
      const icon = (result as { isError?: boolean }).isError ? theme.fg("error", "✗") : theme.fg("success", "■");
      return [truncateToWidth(`${icon} ${theme.fg("dim", preview)}`, Math.max(1, w), "…")];
    });
  }

  return dynamicComponent((w) => {
    const entries = progress ?? [];
    if (w < 20) {
      const running = entries.filter((entry) => entry.status === "running").length;
      const failed = entries.filter((entry) => entry.status === "failed").length;
      const runningChildren = childCalls.filter((child) => child.status === "running").length;
      const failedChildren = childCalls.filter((child) => child.status === "failed").length;
      const icon = failed > 0 || failedChildren > 0
        ? theme.fg("error", "✗")
        : running > 0 || runningChildren > 0
          ? theme.fg("warning", "■")
          : theme.fg("success", "✓");
      const label = entries.length === 0
        ? `${runningChildren || childCalls.length} child agent${childCalls.length === 1 ? "" : "s"}`
        : entries.length === 1
        ? progressLabel(entries[0])
        : failed > 0
          ? `${failed}/${entries.length} failed`
          : `${running}/${entries.length} running`;
      return [truncateToWidth(`${icon} ${label}`, Math.max(1, w), "…")];
    }

    const palette: ProgressPalette = {
      dim: (text) => theme.fg("dim", text),
      accent: (text) => theme.fg("accent", text),
      running: (text) => theme.fg("warning", text),
      success: (text) => theme.fg("success", text),
      error: (text) => theme.fg("error", text),
      bold: (text) => theme.bold(text),
    };
    const running = entries.filter((entry) => entry.status === "running").length;
    const pending = entries.filter((entry) => entry.status === "pending").length;
    const completed = entries.filter((entry) => entry.status === "completed").length;
    const failed = entries.filter((entry) => entry.status === "failed").length;
    const runningChildren = childCalls.filter((child) => child.status === "running").length;
    const failedChildren = childCalls.filter((child) => child.status === "failed").length;
    const focus = focusTaskIndex(entries);
    const focused = entries.find((entry) => entry.taskIndex === focus) ?? entries[0];
    const idleMs = focused?.lastActivityAt ? Date.now() - focused.lastActivityAt : 0;
    const stalled = focused?.status === "running" && idleMs >= 30_000;
    const treeRows = buildProgressTree(entries, palette);
    const maxTreeRows = options.expanded ? 8 : 5;
    const failedIndexes = entries.filter((entry) => entry.status === "failed").map((entry) => entry.taskIndex);
    const treeWindow = failedIndexes.length > 0
      ? selectPriorityProgressRows(treeRows, maxTreeRows, focus, failedIndexes)
      : selectProgressWindow(treeRows, maxTreeRows, focus);
    const range = "hidden" in treeWindow && treeWindow.hidden > 0
      ? `${treeWindow.rows.length}/${treeWindow.total} shown`
      : "start" in treeWindow && treeWindow.total > treeWindow.rows.length
        ? `${treeWindow.start + 1}-${treeWindow.start + treeWindow.rows.length}/${treeWindow.total}`
        : `${treeWindow.total}`;
    const mode = details?.mode ?? "single";
    const stateText = entries.length === 0
      ? `${runningChildren || childCalls.length} child agent${childCalls.length === 1 ? "" : "s"}`
      : failed > 0
      ? `${failed} failed`
      : running > 0
        ? `${running} running`
        : `${completed}/${entries.length} completed`;
    const headerIcon = failed > 0 || failedChildren > 0
      ? theme.fg("error", "!")
      : running > 0 || runningChildren > 0
        ? theme.fg("warning", "■")
        : theme.fg("success", "✓");
    const lines: string[] = [
      `${headerIcon} ${theme.bold(stateText)}  ${statusMeta([mode, pending ? `${pending} pending` : "", entries.length ? `agents ${range}` : "", runningChildren ? `${runningChildren} delegated` : "", stalled ? theme.fg("error", `stalled ${Math.floor(idleMs / 1000)}s`) : ""], theme)}`,
      ...treeWindow.rows.map((row) => row.text),
    ];

    for (const child of childCalls.slice(0, options.expanded ? 4 : 2)) {
      const childIcon = child.status === "running"
        ? theme.fg("warning", "■")
        : child.status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const parent = child.parentName ? ` · called by @${child.parentName}` : "";
      const activeTool = child.recentTools?.find((tool) => tool.status === "running");
      const activity = activeTool ? ` · using ${activeTool.name}` : child.lastMessage ? " · streaming" : "";
      const tokens = child.inputTokens !== undefined || child.outputTokens !== undefined
        ? ` · in ${child.inputTokens ?? 0} · out ${child.outputTokens ?? 0}`
        : "";
      const duration = child.startedAt ? ` · ${elapsed(Math.max(0, Math.floor((Date.now() - child.startedAt) / 1000)))}` : "";
      lines.push(`${theme.fg("dim", "↳")} ${childIcon} ${theme.fg("accent", `@${child.name ?? child.agent}`)} ${theme.fg("dim", `child agent · ${child.status}${duration}${activity}${tokens}${parent}`)}`);
    }
    if (childCalls.length > (options.expanded ? 4 : 2)) {
      lines.push(theme.fg("dim", `↳ … ${childCalls.length - (options.expanded ? 4 : 2)} more child agents`));
    }

    if (focused) {
      const recentTools = focused.recentTools ?? [];
      const activeTool = recentTools.find((tool) => tool.status === "running")
        ?? recentTools[recentTools.length - 1];
      if (activeTool) {
        const toolIcon = activeTool.status === "running" ? theme.fg("warning", "■") : theme.fg("dim", "✓");
        lines.push(`${theme.fg("dim", "»")} ${theme.fg("accent", String(focused.taskIndex + 1))} ${toolIcon} ${activeTool.name}`);
      }
      const maxStreamLines = options.expanded ? 12 : 6;
      const tail = focused.lastMessage?.split("\n").filter((line) => line.trim()).slice(-maxStreamLines) ?? [];
      for (const line of tail) {
        for (const wrappedLine of wrapTextWithAnsi(line, Math.max(1, w - 3))) {
          lines.push(`${theme.fg("dim", "│")} ${theme.fg("dim", wrappedLine)}`);
        }
      }
    }
    if (entries.length > 1) lines.push(theme.fg("dim", `Alt+R details · 1-${Math.min(9, entries.length)} view · 0 overview`));
    return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
  });
}

// ---------------------------------------------------------------------------
// Completed results
// ---------------------------------------------------------------------------

function renderSingleResult(
  r: SingleResult,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const totalTokens = r.usage.inputTokens + r.usage.outputTokens;
  const meta = statusMeta([
    formatDuration(r.durationMs),
    totalTokens > 0 ? `${formatTokens(totalTokens)} tokens` : "",
    r.usage.cost > 0 ? `$${r.usage.cost.toFixed(4)}` : "",
  ], theme);
  const header = `${icon} ${theme.bold(r.agent)}  ${meta}`;

  if (!options.expanded) {
    return dynamicComponent((w) => [truncateToWidth(`${header}  ${theme.fg("dim", "Alt+R details")}`, Math.max(1, w), "…")]);
  }

  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const box = new Box(1, 0);
  box.addChild(proxy);

  return dynamicComponent((w) => {
    const contentWidth = Math.max(1, w - 2);
    const messageWidth = Math.max(1, contentWidth - 2);
    const lines: string[] = [truncateToWidth(header, contentWidth, "…")];

    const usageParts: string[] = [];
    if (r.usage.inputTokens > 0) usageParts.push(`${formatTokens(r.usage.inputTokens)}in`);
    if (r.usage.outputTokens > 0) usageParts.push(`${formatTokens(r.usage.outputTokens)}out`);
    if (r.usage.turns > 0) usageParts.push(`${r.usage.turns} turns`);
    if (usageParts.length > 0) {
      lines.push(truncateToWidth(theme.fg("dim", usageParts.join(" · ")), contentWidth, "…"));
    }

    const lastMsg = r.messages[r.messages.length - 1]?.content;
    if (lastMsg) {
      appendWrappedMessage(lines, lastMsg, messageWidth, theme);
    }

    if (w < 32) return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
    proxy.lines = lines;
    return [...box.render(w)];
  });
}

function renderMultiResult(
  details: Details,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const results = details.results;
  const okCount = results.filter((r) => r.exitCode === 0).length;
  const total = results.length;
  const allOk = okCount === total;
  const icon = allOk ? theme.fg("success", "✓") : theme.fg("warning", "!");
  const meta = statusMeta([details.mode, formatDuration(Math.max(...results.map((r) => r.durationMs), 0))], theme);
  const header = `${icon} ${theme.bold(`${okCount}/${total} completed`)}  ${meta}`;

  if (!options.expanded) {
    return dynamicComponent((w) => [truncateToWidth(`${header}  ${theme.fg("dim", "Alt+R details")}`, Math.max(1, w), "…")]);
  }

  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const box = new Box(1, 0);
  box.addChild(proxy);

  return dynamicComponent((w) => {
    const contentWidth = Math.max(1, w - 2);
    const previewWidth = Math.max(1, contentWidth - 3);
    const messageWidth = Math.max(1, previewWidth - 2);
    const lines = [truncateToWidth(header, contentWidth, "…")];

    if (details.progress?.length === results.length) {
      const palette: ProgressPalette = {
        dim: (text) => theme.fg("dim", text),
        accent: (text) => theme.fg("accent", text),
        running: (text) => theme.fg("warning", text),
        success: (text) => theme.fg("success", text),
        error: (text) => theme.fg("error", text),
        bold: (text) => theme.bold(text),
      };
      for (const row of buildProgressTree(details.progress, palette)) {
        lines.push(truncateToWidth(row.text, contentWidth, "…"));
        const result = results[row.taskIndex];
        const message = result?.messages[result.messages.length - 1]?.content ?? "";
        if (message) {
          appendWrappedMessage(lines, message, messageWidth, theme);
        }
      }
    } else {
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const connector = i === results.length - 1 ? "└" : "├";
        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const rMeta = statusMeta([formatDuration(r.durationMs), formatTokens(r.usage.inputTokens + r.usage.outputTokens)], theme);
        lines.push(truncateToWidth(
          `${theme.fg("dim", connector)} ${rIcon} ${r.agent}  ${rMeta}`,
          contentWidth,
          "…",
        ));
        const message = r.messages[r.messages.length - 1]?.content ?? "";
        if (message) {
          appendWrappedMessage(lines, message, messageWidth, theme);
        }
      }
    }

    if (w < 32) return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
    proxy.lines = lines;
    return [...box.render(w)];
  });
}
