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
import {
  STATUS_PRESENTATION,
  effectiveDisplayStatus,
  idleSeconds,
} from "../shared/agent-status.ts";
import type { AgentProgressSnapshot, ChildAgentCallSnapshot, Details, SingleResult } from "../shared/types.ts";
import { extractDependencies } from "../runs/execution.ts";
import { isQuietMode, quietStatusMark } from "../quiet-state.ts";
import {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  progressDurationMs,
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

/**
 * Result components live in the message stream forever, and every unrelated
 * `requestRender` re-runs their build callback. Memoize per width so an
 * unchanged result never re-wraps its body.
 */
function memoizedComponent(build: (width: number) => string[]): Component {
  let cachedWidth: number | undefined;
  let cached: string[] = [];
  return {
    render(w: number) {
      if (cachedWidth !== w) {
        cached = build(w);
        cachedWidth = w;
      }
      return [...cached];
    },
    invalidate() {
      cachedWidth = undefined;
    },
  };
}

/**
 * Upper bound on wrapped lines emitted for a single result body. A message can
 * be up to `transcriptMessageBytes` (64KB); wrapping all of it every frame is
 * pure waste since the viewport shows a fraction of it.
 */
const MAX_MESSAGE_LINES = 200;

function appendWrappedMessage(
  lines: string[],
  content: string,
  width: number,
  theme: Theme,
  maxLines = MAX_MESSAGE_LINES,
): void {
  const wrapWidth = Math.max(1, width);
  let emitted = 0;
  let truncated = false;
  for (const rawLine of content.split("\n")) {
    if (emitted >= maxLines) {
      truncated = true;
      break;
    }
    // Bound the wrap input too: one raw line can be the whole 64KB message.
    const budget = (maxLines - emitted + 1) * wrapWidth * 2;
    const source = rawLine.length > budget ? rawLine.slice(0, budget) : rawLine;
    if (source.length < rawLine.length) truncated = true;
    const wrapped = wrapTextWithAnsi(source, wrapWidth);
    if (wrapped.length === 0) {
      lines.push(theme.fg("dim", "│"));
      emitted++;
      continue;
    }
    for (const line of wrapped) {
      if (emitted >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(theme.fg("dim", `│ ${line}`));
      emitted++;
    }
  }
  if (truncated) lines.push(theme.fg("dim", "│ …"));
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
  prompt?: string;
}

export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
  context?: { expanded?: boolean },
): Component {
  if (isQuietMode()) return renderQuietTeammateCall(args, theme);
  const tasks = (args.tasks as Array<Omit<TaskArg, "agent"> & { agent?: string }> | undefined)
    ?.map((task) => ({ ...task, agent: task.agent ?? (args.agent as string | undefined) ?? "general" }));
  const isBg = args.background === true;

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
  const hasDeps = tasks.some((t) => extractDependencies(t.prompt, taskNames).length > 0);

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

  const indexByName = new Map<string, number>();
  tasks.forEach((task, index) => {
    if (task.name) indexByName.set(task.name, index);
  });
  const dependenciesByIndex = tasks.map((task) =>
    extractDependencies(task.prompt, taskNames)
      .map((name) => indexByName.get(name))
      .filter((dependency): dependency is number => dependency !== undefined)
  );

  const header = `${theme.fg("success", "■")} ${theme.bold(`${tasks.length}${topoLabel} ${modeWord} agents launched`)}${hint}`;
  if (expanded) {
    const progress: AgentProgressSnapshot[] = tasks.map((task, index) => ({
      agent: task.agent,
      ...(task.name ? { name: task.name } : {}),
      correlationId: `preview-${index + 1}`,
      taskIndex: index,
      dependencies: dependenciesByIndex[index],
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
  // 结果组件（前台流式 progress / 后台 ack 的 progress 快照）紧随调用行渲染，
  // 已包含同一任务拓扑、依赖边与实时状态（后台还带 correlation id）。
  // collapsed 调用仅保留启动摘要，避免相邻组件重复显示任务行。
  // DAG 细节仍可在 expanded 调用视图与结果 progress 树中查看。
  return dynamicComponent((w) => [
    truncateToWidth(header, Math.max(1, w), "…"),
  ]);
}

function isLinearChain(tasks: TaskArg[], taskNames: Set<string>): boolean {
  for (let i = 0; i < tasks.length; i++) {
    const deps = extractDependencies(tasks[i].prompt, taskNames);
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
  if (isQuietMode()) return renderQuietTeammateResult(result, theme);
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

function childStateText(child: ChildAgentCallSnapshot): string {
  const activityAt = child.lastActivityAt ?? child.startedAt;
  const display = effectiveDisplayStatus(child.status, child.resultReadyAt, activityAt);
  if (display === "result-ready") return "result ready; confirming terminal";
  if (display === "stalled") return `stalled ${idleSeconds(activityAt)}s`;
  return STATUS_PRESENTATION[display].text;
}

function formatChildLine(child: ChildAgentCallSnapshot, theme: Theme): string {
  const presentation = STATUS_PRESENTATION[child.status];
  const icon = theme.fg(presentation.tone, presentation.icon);
  const activeTool = child.recentTools?.find((tool) => tool.status === "running");
  const activity = activeTool ? ` · using ${activeTool.name}` : child.lastMessage ? " · streaming" : "";
  const tokens = child.inputTokens !== undefined || child.outputTokens !== undefined
    ? ` · in ${child.inputTokens ?? 0} · out ${child.outputTokens ?? 0}`
    : "";
  const durationMs = child.status === "running" && child.startedAt
    ? Math.max(child.durationMs ?? 0, Date.now() - child.startedAt)
    : child.durationMs;
  const duration = durationMs !== undefined
    ? ` · ${elapsed(Math.max(0, Math.floor(durationMs / 1000)))}`
    : "";
  return `${icon} ${theme.fg("accent", `@${child.name ?? child.agent}`)} ${theme.fg("dim", `child agent · ${childStateText(child)}${duration}${activity}${tokens}`)}`;
}

function renderChildSubtree(
  children: ChildAgentCallSnapshot[],
  childrenByParent: Map<string, ChildAgentCallSnapshot[]>,
  prefix: string,
  theme: Theme,
  out: string[],
): void {
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    out.push(`${prefix}${theme.fg("dim", isLast ? "└─ " : "├─ ")}${formatChildLine(child, theme)}`);
    const grandchildren = childrenByParent.get(child.correlationId);
    if (grandchildren?.length) {
      renderChildSubtree(grandchildren, childrenByParent, prefix + theme.fg("dim", isLast ? "   " : "│  "), theme, out);
    }
  });
}

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
      // Retrying counts as in-flight: a backing-off agent is not a success.
      const running = entries.filter((entry) => entry.status === "running" || entry.status === "retrying").length;
      const failed = entries.filter((entry) => entry.status === "failed").length;
      const runningChildren = childCalls.filter((child) => child.status === "running" || child.status === "retrying").length;
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
    const retrying = entries.filter((entry) => entry.status === "retrying").length;
    const pending = entries.filter((entry) => entry.status === "pending").length;
    const completed = entries.filter((entry) => entry.status === "completed").length;
    const failed = entries.filter((entry) => entry.status === "failed").length;
    const runningChildren = childCalls.filter((child) => child.status === "running").length;
    const retryingChildren = childCalls.filter((child) => child.status === "retrying").length;
    const failedChildren = childCalls.filter((child) => child.status === "failed").length;
    const focus = focusTaskIndex(entries);
    const focused = entries.find((entry) => entry.taskIndex === focus) ?? entries[0];
    const idleMs = focused?.lastActivityAt ? Date.now() - focused.lastActivityAt : 0;
    const focusedDisplay = focused
      ? effectiveDisplayStatus(focused.status, focused.resultReadyAt, focused.lastActivityAt)
      : undefined;
    const resultReady = focusedDisplay === "result-ready";
    const stalled = focusedDisplay === "stalled";
    const focusedDurationMs = focused ? progressDurationMs(focused) : undefined;
    const focusedTokens = focused && (focused.inputTokens !== undefined || focused.outputTokens !== undefined)
      ? `in ${formatTokens(focused.inputTokens ?? 0)} · out ${formatTokens(focused.outputTokens ?? 0)}`
      : focused?.tokens
        ? `${formatTokens(focused.tokens)} tokens`
        : "";
    const treeRows = buildProgressTree(entries, palette);
    const entryByTaskIndex = new Map<number, AgentProgressSnapshot>();
    for (const entry of entries) entryByTaskIndex.set(entry.taskIndex, entry);
    const childrenByParent = new Map<string, ChildAgentCallSnapshot[]>();
    for (const child of childCalls) {
      const key = child.parentCorrelationId ?? "";
      const bucket = childrenByParent.get(key);
      if (bucket) bucket.push(child);
      else childrenByParent.set(key, [child]);
    }
    const taskCids = new Set(entries.map((entry) => entry.correlationId).filter(Boolean));
    const childCids = new Set(childCalls.map((child) => child.correlationId));
    const mode = details?.mode ?? "single";
    const stateText = entries.length === 0
      ? `${runningChildren || childCalls.length} child agent${childCalls.length === 1 ? "" : "s"}`
      : failed > 0
      ? `${failed} failed`
      : running > 0
        ? `${running} running`
        : retrying > 0
          ? `${retrying} retrying`
          : `${completed}/${entries.length} completed`;
    // A retrying agent is still in flight; it must never read as a green success.
    const headerIcon = failed > 0 || failedChildren > 0
      ? theme.fg("error", "!")
      : running > 0 || runningChildren > 0 || retrying > 0 || retryingChildren > 0
        ? theme.fg("warning", "■")
        : theme.fg("success", "✓");
    // The header (line 0) carries only transition-based fields. Per-second metrics
    // (duration/tokens/stalled) are rendered near the bottom so a tall component does
    // not change a line above the viewport and force a full redraw (page jump) each tick.
    const lines: string[] = [
      `${headerIcon} ${theme.bold(stateText)}  ${statusMeta([mode, pending ? `${pending} pending` : "", entries.length ? `agents ${treeRows.length}` : "", runningChildren ? `${runningChildren} delegated` : "", resultReady ? theme.fg("success", "result ready; confirming terminal") : ""], theme)}`,
    ];
    // Nest each child agent under its parent task row, recursively, with no folding.
    for (const row of treeRows) {
      lines.push(row.text);
      const cid = entryByTaskIndex.get(row.taskIndex)?.correlationId;
      if (cid) renderChildSubtree(childrenByParent.get(cid) ?? [], childrenByParent, "  ", theme, lines);
    }
    // Child agents whose parent is outside this view render as top-level roots.
    const rootOrphans = childCalls.filter((child) => {
      const parent = child.parentCorrelationId;
      return !parent || (!taskCids.has(parent) && !childCids.has(parent));
    });
    renderChildSubtree(rootOrphans, childrenByParent, "", theme, lines);

    if (focused) {
      const recentTools = focused.recentTools ?? [];
      const activeTool = recentTools.find((tool) => tool.status === "running")
        ?? recentTools[recentTools.length - 1];
      const liveMeta = statusMeta([
        focusedDurationMs !== undefined ? formatDuration(focusedDurationMs) : "",
        focusedTokens,
        stalled ? theme.fg("error", `stalled ${Math.floor(idleMs / 1000)}s`) : "",
      ], theme);
      if (activeTool) {
        const toolIcon = activeTool.status === "running" ? theme.fg("warning", "■") : theme.fg("dim", "✓");
        lines.push(`${theme.fg("dim", "»")} ${theme.fg("accent", String(focused.taskIndex + 1))} ${toolIcon} ${activeTool.name}${liveMeta ? `  ${liveMeta}` : ""}`);
      } else if (liveMeta) {
        lines.push(`${theme.fg("dim", "»")} ${theme.fg("accent", String(focused.taskIndex + 1))}  ${liveMeta}`);
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

  // Completed results never change; memoize so unrelated redraws cost nothing.
  return memoizedComponent((w) => {
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

  // Completed results never change; memoize so unrelated redraws cost nothing.
  return memoizedComponent((w) => {
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

// ---------------------------------------------------------------------------
// Quiet mode — preserve agent structure while suppressing message bodies
// ---------------------------------------------------------------------------
//
// Quiet mode removes streamed/completed agent message bodies. Agent identity,
// dependency topology, child nesting, status, and telemetry remain visible.

function qLine(theme: Theme, markedGlyph: string, name: string, rest: string): string {
  const parts = [
    theme.fg("toolTitle", theme.bold ? theme.bold(name) : name),
    rest ? theme.fg("muted", rest) : "",
  ].filter(Boolean);
  return `  ${markedGlyph} ${parts.join(" ")}`;
}

export function renderQuietTeammateAux(
  name: "teammate-send" | "teammate-wait" | "teammate-watch" | "teammate-started",
  rest: string,
  status: "running" | "success" | "failure",
  theme: Theme,
): Component | undefined {
  if (!isQuietMode()) return undefined;
  const tone = status === "failure" ? "error" : status === "success" ? "success" : "warning";
  const glyph = theme.fg(tone, quietStatusMark(status));
  return dynamicComponent((w) => [truncateToWidth(qLine(theme, glyph, name, rest), Math.max(1, w), "…")]);
}

function quietFirstError(r: SingleResult): string {
  const text = r.messages[r.messages.length - 1]?.content ?? "";
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  if (!line) return "failed";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function quietTopoLabel(tasks: TaskArg[]): string {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  if (!tasks.some((t) => extractDependencies(t.prompt, taskNames).length > 0)) return "";
  return isLinearChain(tasks, taskNames) ? "chain" : "graph";
}

function quietPalette(theme: Theme): ProgressPalette {
  return {
    dim: (text) => theme.fg("dim", text),
    accent: (text) => theme.fg("accent", text),
    running: (text) => theme.fg("warning", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    bold: (text) => theme.bold(text),
  };
}

function appendQuietAgentTree(
  lines: string[],
  entries: AgentProgressSnapshot[],
  childCalls: ChildAgentCallSnapshot[],
  theme: Theme,
): void {
  const entryByTaskIndex = new Map(entries.map((entry) => [entry.taskIndex, entry]));
  const childrenByParent = new Map<string, ChildAgentCallSnapshot[]>();
  for (const child of childCalls) {
    const key = child.parentCorrelationId ?? "";
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(child);
    else childrenByParent.set(key, [child]);
  }

  const taskCids = new Set(entries.map((entry) => entry.correlationId).filter(Boolean));
  const childCids = new Set(childCalls.map((child) => child.correlationId));
  for (const row of buildProgressTree(entries, quietPalette(theme))) {
    lines.push(row.text);
    const cid = entryByTaskIndex.get(row.taskIndex)?.correlationId;
    if (cid) renderChildSubtree(childrenByParent.get(cid) ?? [], childrenByParent, "  ", theme, lines);
  }

  const rootOrphans = childCalls.filter((child) => {
    const parent = child.parentCorrelationId;
    return !parent || (!taskCids.has(parent) && !childCids.has(parent));
  });
  renderChildSubtree(rootOrphans, childrenByParent, "", theme, lines);
}

function renderQuietTeammateCall(args: Record<string, unknown>, theme: Theme): Component {
  const glyph = theme.fg("warning", quietStatusMark("running"));
  const tasks = (args.tasks as Array<Omit<TaskArg, "agent"> & { agent?: string }> | undefined)
    ?.map((task) => ({ ...task, agent: task.agent ?? (args.agent as string | undefined) ?? "general" }));
  if (tasks?.length) {
    const topo = quietTopoLabel(tasks);
    const rest = `${tasks.length} agents${topo ? ` ${topo}` : ""}`;
    return dynamicComponent((w) => [truncateToWidth(qLine(theme, glyph, "teammate", rest), Math.max(1, w), "…")]);
  }
  const agent = (args.agent as string | undefined) ?? "general";
  const name = args.name as string | undefined;
  const rest = name ? `@${name} (${agent})` : agent;
  return dynamicComponent((w) => [truncateToWidth(qLine(theme, glyph, "teammate", rest), Math.max(1, w), "…")]);
}

function renderQuietTeammateResult(result: AgentToolResult<Details>, theme: Theme): Component {
  const details = result.details;
  const isError = (result as { isError?: boolean }).isError === true;

  if (details && details.results.length > 0) {
    const results = details.results;
    const ok = results.filter((r) => r.exitCode === 0).length;
    const total = results.length;
    const failed = total - ok;
    const totalTokens = results.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.outputTokens, 0);
    const firstFailed = results.find((r) => r.exitCode !== 0);
    const hasFailure = failed > 0 || isError;
    const rest = hasFailure
      ? `${failed || 1}/${total} failed · ${firstFailed ? quietFirstError(firstFailed) : "failed"}`
      : `${ok}/${total} done${totalTokens > 0 ? ` · ${formatTokens(totalTokens)} tokens` : ""}`;
    const glyph = theme.fg(hasFailure ? "error" : "success", quietStatusMark(hasFailure ? "failure" : "success"));

    return dynamicComponent((w) => {
      const lines = [qLine(theme, glyph, "teammate", rest)];
      if (details.progress?.length) {
        appendQuietAgentTree(lines, details.progress, details.childCalls ?? [], theme);
      } else {
        results.forEach((entry, index) => {
          const icon = entry.exitCode === 0
            ? theme.fg("success", quietStatusMark("success"))
            : theme.fg("error", quietStatusMark("failure"));
          const meta = statusMeta([
            formatDuration(entry.durationMs),
            `${formatTokens(entry.usage.inputTokens + entry.usage.outputTokens)} tokens`,
          ], theme);
          lines.push(`${theme.fg("dim", index === results.length - 1 ? "└" : "├")} ${icon} ${theme.bold(entry.agent)}${meta ? ` · ${meta}` : ""}`);
        });
      }
      return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
    });
  }

  const entries = details?.progress ?? [];
  const childCalls = details?.childCalls ?? [];
  const running = entries.filter((e) => e.status === "running" || e.status === "retrying").length
    + childCalls.filter((c) => c.status === "running" || c.status === "retrying").length;
  const failed = entries.filter((e) => e.status === "failed").length
    + childCalls.filter((c) => c.status === "failed").length;
  const completed = entries.filter((e) => e.status === "completed").length;
  const glyph = failed > 0
    ? theme.fg("error", quietStatusMark("failure"))
    : running > 0
      ? theme.fg("warning", quietStatusMark("running"))
      : theme.fg("success", quietStatusMark("success"));
  const stateText = entries.length === 0
    ? `${running || childCalls.length} child agent${(running || childCalls.length) === 1 ? "" : "s"}`
    : failed > 0
      ? `${failed}/${entries.length} failed`
      : running > 0
        ? `${running}/${entries.length} running`
        : `${completed}/${entries.length} done`;

  return dynamicComponent((w) => {
    const lines = [qLine(theme, glyph, "teammate", stateText)];
    appendQuietAgentTree(lines, entries, childCalls, theme);
    const focus = entries.find((entry) => entry.taskIndex === focusTaskIndex(entries));
    const activeTool = focus?.recentTools?.find((tool) => tool.status === "running");
    if (focus && activeTool) {
      lines.push(`${theme.fg("dim", "»")} ${theme.fg("accent", String(focus.taskIndex + 1))} ${theme.fg("warning", "■")} using ${activeTool.name}`);
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
  });
}
