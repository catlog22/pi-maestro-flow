/**
 * TUI rendering for the teammate tool.
 *
 * renderCall: intentionally empty; result rendering owns the lifecycle surface
 * renderResult: real-time streaming for foreground, compact status for completed
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box, Text, type Component,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  STATUS_PRESENTATION,
  effectiveDisplayStatus,
  idleSeconds,
} from "../shared/agent-status.ts";
import type { AgentProgressSnapshot, AgentProgressStatus, ChildAgentCallSnapshot, Details, SingleResult, Usage } from "../shared/types.ts";
import { isQuietMode, quietStatusMark } from "../quiet-state.ts";
import {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  progressDurationMs,
  type ProgressPalette,
} from "./progress-tree.ts";
import { getTuiLocale, translateStatusText, tuiT } from "./locale.ts";

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
  let cachedLocale = getTuiLocale();
  let cached: string[] = [];
  return {
    render(w: number) {
      const locale = getTuiLocale();
      if (cachedWidth !== w || cachedLocale !== locale) {
        cached = build(w);
        cachedWidth = w;
        cachedLocale = locale;
      }
      return [...cached];
    },
    invalidate() {
      cachedWidth = undefined;
    },
  };
}

function memoizedSnapshotComponent<T>(
  getSnapshot: () => T,
  build: (width: number, snapshot: T) => string[],
): Component {
  let cachedWidth: number | undefined;
  let cachedLocale = getTuiLocale();
  let cachedSnapshot: T;
  let cached: string[] = [];
  let hasCache = false;
  return {
    render(w: number) {
      const snapshot = getSnapshot();
      const locale = getTuiLocale();
      if (!hasCache || cachedWidth !== w || cachedSnapshot !== snapshot || cachedLocale !== locale) {
        cached = build(w, snapshot);
        cachedWidth = w;
        cachedLocale = locale;
        cachedSnapshot = snapshot;
        hasCache = true;
      }
      return [...cached];
    },
    invalidate() {
      hasCache = false;
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

/**
 * Cache telemetry for final and quiet summaries: read/write counters plus the
 * read hit ratio over all processed input tokens. Only emitted when the
 * provider reported cache activity, so cache-free summaries stay unchanged.
 */
function cacheUsageParts(
  usage: Pick<Usage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  format: (count: number) => string,
): string[] {
  const parts: string[] = [];
  if (usage.cacheReadTokens > 0) parts.push(tuiT("metrics.cacheRead", { count: format(usage.cacheReadTokens) }));
  if (usage.cacheWriteTokens > 0) parts.push(tuiT("metrics.cacheWrite", { count: format(usage.cacheWriteTokens) }));
  const processed = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (usage.cacheReadTokens > 0 && processed > 0) {
    parts.push(tuiT("metrics.cacheHit", {
      percent: Math.round((usage.cacheReadTokens / processed) * 100),
    }));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// renderCall — how the tool invocation appears in conversation
// ---------------------------------------------------------------------------

function renderSafeText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isExpertRenderArgs(args: Record<string, unknown> | undefined): boolean {
  return args?.mode === "expert";
}

function expertObjective(args: Record<string, unknown>): string {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  const first = tasks[0];
  if (!first || typeof first !== "object") return "";
  return renderSafeText((first as Record<string, unknown>).prompt);
}

function expertResultState(
  result: AgentToolResult<Details>,
  details: Details | undefined,
): { glyph: string; tone: "warning" | "success" | "error"; label: string; delegated: number } {
  const entries = details?.progress ?? [];
  const children = details?.childCalls ?? [];
  const failed = (result as { isError?: boolean }).isError === true
    || details?.results.some((entry) => entry.exitCode !== 0) === true
    || entries.some((entry) => entry.status === "failed" || entry.status === "terminated")
    || children.some((entry) => entry.status === "failed" || entry.status === "terminated");
  const finished = (details?.results.length ?? 0) > 0;
  const coordinating = entries.some((entry) => entry.status === "running" || entry.status === "retrying")
    || children.some((entry) => entry.status === "running" || entry.status === "retrying");
  if (failed) return { glyph: "✗", tone: "error", label: "completed with issues", delegated: children.length };
  if (finished) return { glyph: "✓", tone: "success", label: "synthesized", delegated: children.length };
  if (coordinating || children.length > 0) {
    return { glyph: "■", tone: "warning", label: "coordinating", delegated: children.length };
  }
  return { glyph: "■", tone: "warning", label: "preparing delegation", delegated: 0 };
}

function frameExpertResult(
  body: Component,
  result: AgentToolResult<Details>,
  details: Details | undefined,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const state = expertResultState(result, details);
      const meta = statusMeta([
        state.delegated > 0 ? `${state.delegated} delegated` : "",
      ], theme);
      const header = `${theme.fg(state.tone, state.glyph)} ${theme.bold("Leader")} ${theme.fg("accent", state.label)}${meta ? `  ${meta}` : ""}`;
      return [header, ...body.render(width)].map((line) =>
        truncateToWidth(line, Math.max(1, width), "…")
      );
    },
    invalidate(): void {
      body.invalidate();
    },
  };
}

// The result component owns ordinary teammate presentation for every lifecycle
// phase. Expert mode adds a persistent call header so the Leader strategy is
// distinguishable from a direct single-agent dispatch.
export function renderTeammateCall(
  args: Record<string, unknown>,
  theme: Theme,
  _context?: { expanded?: boolean; isPartial?: boolean },
): Component {
  if (!isExpertRenderArgs(args)) return dynamicComponent(() => []);
  const objective = expertObjective(args);
  return dynamicComponent((width) => {
    const header = `${theme.fg("accent", "◆")} ${theme.bold("EXPERT")}`;
    if (isQuietMode() || !objective || width < 28) {
      return [truncateToWidth(header, Math.max(1, width), "…")];
    }
    const objectiveLine = `${theme.fg("dim", "└ objective")} ${objective}`;
    return [header, objectiveLine].map((line) =>
      truncateToWidth(line, Math.max(1, width), "…")
    );
  });
}

export function renderTeammateListCall(
  args: Record<string, unknown>,
  theme: Theme,
  context?: { isPartial?: boolean },
): Component {
  if (context?.isPartial === false) return new Text("", 0, 0);
  const view = typeof args.view === "string" ? args.view : "active";
  return new Text(`  ${theme.fg("warning", "…")} ${theme.bold("teammate-list")} ${theme.fg("dim", view)}`, 0, 0);
}

export function renderTeammateListResult(
  result: AgentToolResult<{ agents: unknown[] }>,
  options: { isPartial?: boolean },
  theme: Theme,
): Component {
  if (options.isPartial) return new Text("", 0, 0);
  const text = typeof result.content === "string"
    ? result.content
    : result.content
      .map((entry) => entry.type === "text" ? entry.text : "")
      .filter(Boolean)
      .join("\n");
  return dynamicComponent((width) => text.split("\n").map((line) =>
    truncateToWidth(line, Math.max(1, width), theme.fg("dim", "…"))
  ));
}


// ---------------------------------------------------------------------------
// renderResult — how the tool result appears in conversation
// ---------------------------------------------------------------------------

export function renderTeammateResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
  args?: Record<string, unknown>,
): Component {
  const details = result.details;
  const expert = isExpertRenderArgs(args);
  let body: Component;
  if (isQuietMode()) {
    body = renderQuietTeammateResult(result, theme);
  } else if (!details || details.results.length === 0) {
    // No results yet — streaming progress or background ack.
    body = renderProgress(result, details, options, theme, expert);
  } else if (details.results.length === 1) {
    body = renderSingleResult(details.results[0], options, theme);
  } else {
    body = renderMultiResult(details, options, theme);
  }
  return expert
    ? frameExpertResult(body, result, details, theme)
    : body;
}

// ---------------------------------------------------------------------------
// Streaming progress (foreground real-time display)
// ---------------------------------------------------------------------------

function childStateText(child: ChildAgentCallSnapshot): string {
  const activityAt = child.lastActivityAt ?? child.startedAt;
  const display = effectiveDisplayStatus(child.status, child.resultReadyAt, activityAt, Date.now(), child.phase);
  if (display === "result-ready") return tuiT("status.resultReadyConfirming");
  if (display === "stalled") return tuiT("status.stalled", { seconds: idleSeconds(activityAt) });
  return translateStatusText(STATUS_PRESENTATION[display].text);
}

function formatChildLine(
  child: ChildAgentCallSnapshot,
  theme: Theme,
  hideActivity = false,
  stableInFlightRow = false,
): string {
  const presentation = STATUS_PRESENTATION[child.status];
  const icon = theme.fg(presentation.tone, presentation.icon);
  const inFlight = child.status === "running" || child.status === "retrying";
  const stable = stableInFlightRow && inFlight;
  const activeTool = child.recentTools?.find((tool) => tool.status === "running");
  const activity = hideActivity
    ? ""
    : activeTool
      ? ` · ${tuiT("progress.using", { tool: activeTool.name })}`
      : child.lastMessage ? ` · ${tuiT("progress.streaming")}` : "";
  const childCacheRead = child.cacheReadTokens ?? 0;
  const childCacheWrite = child.cacheWriteTokens ?? 0;
  const tokens = stable
    ? ""
    : child.inputTokens !== undefined || child.outputTokens !== undefined
      ? ` · ${tuiT("metrics.in", { count: child.inputTokens ?? 0 })} · ${tuiT("metrics.out", { count: child.outputTokens ?? 0 })}`
        + (childCacheRead > 0 || childCacheWrite > 0
          ? ` · ${tuiT("metrics.cache", { read: childCacheRead, write: childCacheWrite })}`
          : "")
      : "";
  const durationMs = stable
    ? undefined
    : child.status === "running" && child.startedAt
      ? Math.max(child.durationMs ?? 0, Date.now() - child.startedAt)
      : child.durationMs;
  const duration = durationMs !== undefined
    ? ` · ${elapsed(Math.max(0, Math.floor(durationMs / 1000)))}`
    : "";
  const state = stable
    ? translateStatusText(presentation.text)
    : childStateText(child);
  return `${icon} ${theme.fg("accent", `@${child.name ?? child.agent}`)} ${theme.fg("dim", `${tuiT("progress.childLabel")} · ${state}${duration}${activity}${tokens}`)}`;
}

function renderChildSubtree(
  children: ChildAgentCallSnapshot[],
  childrenByParent: Map<string, ChildAgentCallSnapshot[]>,
  prefix: string,
  theme: Theme,
  out: string[],
  hideActivity = false,
  stableInFlightRows = false,
): void {
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    out.push(`${prefix}${theme.fg("dim", isLast ? "└─ " : "├─ ")}${formatChildLine(child, theme, hideActivity, stableInFlightRows)}`);
    const grandchildren = childrenByParent.get(child.correlationId);
    if (grandchildren?.length) {
      renderChildSubtree(
        grandchildren,
        childrenByParent,
        prefix + theme.fg("dim", isLast ? "   " : "│  "),
        theme,
        out,
        hideActivity,
        stableInFlightRows,
      );
    }
  });
}

function renderProgress(
  result: AgentToolResult<Details>,
  details: Details | undefined,
  options: { expanded: boolean },
  theme: Theme,
  stableInFlightRows = false,
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

  return memoizedSnapshotComponent(() => result.details ?? details, (w, snapshot) => {
    const entries = snapshot?.progress ?? [];
    const childCalls = snapshot?.childCalls ?? [];
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
      const childCount = runningChildren || childCalls.length;
      const label = entries.length === 0
        ? tuiT(childCount === 1 ? "progress.child.one" : "progress.child.many", { count: childCount })
        : entries.length === 1
        ? progressLabel(entries[0])
        : failed > 0
          ? tuiT("progress.summary.failed", { count: failed, total: entries.length })
          : tuiT("progress.summary.running", { count: running, total: entries.length });
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
      ? effectiveDisplayStatus(focused.status, focused.resultReadyAt, focused.lastActivityAt, Date.now(), focused.phase)
      : undefined;
    const resultReady = focusedDisplay === "result-ready";
    const stalled = focusedDisplay === "stalled";
    const focusedDurationMs = focused ? progressDurationMs(focused) : undefined;
    const focusedCacheRead = focused?.cacheReadTokens ?? 0;
    const focusedCacheWrite = focused?.cacheWriteTokens ?? 0;
    const focusedTokens = focused && (focused.inputTokens !== undefined || focused.outputTokens !== undefined)
      ? `${tuiT("metrics.in", { count: formatTokens(focused.inputTokens ?? 0) })} · ${tuiT("metrics.out", { count: formatTokens(focused.outputTokens ?? 0) })}`
        + (focusedCacheRead > 0 || focusedCacheWrite > 0
          ? ` · ${tuiT("metrics.cache", { read: formatTokens(focusedCacheRead), write: formatTokens(focusedCacheWrite) })}`
          : "")
      : focused?.tokens
        ? tuiT("metrics.tokens", { count: formatTokens(focused.tokens) })
        : "";
    const treeRows = buildProgressTree(
      entries,
      palette,
      Date.now(),
      undefined,
      { stableInFlightRows },
    );
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
    const mode = snapshot?.mode ?? "single";
    const childCount = runningChildren || childCalls.length;
    const stateText = entries.length === 0
      ? tuiT(childCount === 1 ? "progress.child.one" : "progress.child.many", { count: childCount })
      : failed > 0
      ? tuiT("progress.summary.failedCount", { count: failed })
      : running > 0
        ? tuiT("progress.summary.runningCount", { count: running })
        : retrying > 0
          ? tuiT("progress.summary.retrying", { count: retrying })
          : tuiT("progress.summary.completedCount", { count: completed, total: entries.length });
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
      `${headerIcon} ${theme.bold(stateText)}  ${statusMeta([
        mode,
        pending ? tuiT("progress.header.pending", { count: pending }) : "",
        entries.length ? tuiT("progress.header.agents", { count: treeRows.length }) : "",
        runningChildren ? tuiT("progress.header.delegated", { count: runningChildren }) : "",
        resultReady ? theme.fg("success", tuiT("status.resultReadyConfirming")) : "",
      ], theme)}`,
    ];
    // Nest each child agent under its parent task row, recursively, with no folding.
    for (const row of treeRows) {
      lines.push(row.text);
      const cid = entryByTaskIndex.get(row.taskIndex)?.correlationId;
      if (cid) {
        renderChildSubtree(
          childrenByParent.get(cid) ?? [],
          childrenByParent,
          "  ",
          theme,
          lines,
          false,
          stableInFlightRows,
        );
      }
    }
    // Child agents whose parent is outside this view render as top-level roots.
    const rootOrphans = childCalls.filter((child) => {
      const parent = child.parentCorrelationId;
      return !parent || (!taskCids.has(parent) && !childCids.has(parent));
    });
    renderChildSubtree(rootOrphans, childrenByParent, "", theme, lines, false, stableInFlightRows);

    if (focused) {
      const recentTools = focused.recentTools ?? [];
      const activeTool = recentTools.find((tool) => tool.status === "running")
        ?? recentTools[recentTools.length - 1];
      const liveMeta = statusMeta([
        focusedDurationMs !== undefined ? formatDuration(focusedDurationMs) : "",
        focusedTokens,
        stalled ? theme.fg("error", tuiT("status.stalled", { seconds: Math.floor(idleMs / 1000) })) : "",
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
    if (entries.length > 1) {
      lines.push(theme.fg("dim", tuiT("progress.footer", { max: Math.min(9, entries.length) })));
    }
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
  const header = (): string => {
    const totalTokens = r.usage.inputTokens + r.usage.outputTokens;
    const meta = statusMeta([
      formatDuration(r.durationMs),
      totalTokens > 0 ? tuiT("metrics.tokens", { count: formatTokens(totalTokens) }) : "",
      r.usage.cost > 0 ? `$${r.usage.cost.toFixed(4)}` : "",
    ], theme);
    return `${icon} ${theme.bold(r.agent)}  ${meta}`;
  };

  if (!options.expanded) {
    return dynamicComponent((w) => [truncateToWidth(`${header()}  ${theme.fg("dim", tuiT("progress.expand"))}`, Math.max(1, w), "…")]);
  }

  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const box = new Box(1, 0);
  box.addChild(proxy);

  // Completed results never change; memoize so unrelated redraws cost nothing.
  return memoizedComponent((w) => {
    const contentWidth = Math.max(1, w - 2);
    const messageWidth = Math.max(1, contentWidth - 2);
    const lines: string[] = [truncateToWidth(header(), contentWidth, "…")];

    const usageParts: string[] = [];
    if (r.usage.inputTokens > 0) usageParts.push(tuiT("metrics.inCompact", { count: formatTokens(r.usage.inputTokens) }));
    if (r.usage.outputTokens > 0) usageParts.push(tuiT("metrics.outCompact", { count: formatTokens(r.usage.outputTokens) }));
    usageParts.push(...cacheUsageParts(r.usage, formatTokens));
    if (r.usage.turns > 0) usageParts.push(tuiT("metrics.turns", { count: r.usage.turns }));
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
  const header = (): string => {
    const meta = statusMeta([details.mode, formatDuration(Math.max(...results.map((r) => r.durationMs), 0))], theme);
    return `${icon} ${theme.bold(tuiT("progress.summary.completed", { count: okCount, total }))}  ${meta}`;
  };

  if (!options.expanded) {
    return dynamicComponent((w) => [truncateToWidth(`${header()}  ${theme.fg("dim", tuiT("progress.expand"))}`, Math.max(1, w), "…")]);
  }

  const proxy = { lines: [] as string[], invalidate() {}, render() { return this.lines; } };
  const box = new Box(1, 0);
  box.addChild(proxy);

  // Completed results never change; memoize so unrelated redraws cost nothing.
  return memoizedComponent((w) => {
    const contentWidth = Math.max(1, w - 2);
    const previewWidth = Math.max(1, contentWidth - 3);
    const messageWidth = Math.max(1, previewWidth - 2);
    const lines = [truncateToWidth(header(), contentWidth, "…")];

    if (details.progress?.length === results.length) {
      const palette: ProgressPalette = {
        dim: (text) => theme.fg("dim", text),
        accent: (text) => theme.fg("accent", text),
        running: (text) => theme.fg("warning", text),
        success: (text) => theme.fg("success", text),
        error: (text) => theme.fg("error", text),
        bold: (text) => theme.bold(text),
      };
      for (const row of buildProgressTree(settleProgressFromResults(details.progress, results), palette)) {
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

/**
 * Published results outrank progress snapshots in terminal views. Lifecycle
 * confirmation lags result publication, and both dispatch paths keep
 * lifecycle-pending tasks "running" for the live admission gate; rows rendered
 * from a final snapshot would otherwise rewrite completed tasks back to a
 * running mark under a header that already counts them as completed.
 */
function settleProgressFromResults(
  entries: AgentProgressSnapshot[],
  results: SingleResult[],
): AgentProgressSnapshot[] {
  if (results.length === 0) return entries;
  return entries.map((entry) => {
    const result = results[entry.taskIndex];
    if (!result) return entry;
    const status: AgentProgressStatus = result.exitCode === 0 ? "completed" : "failed";
    return entry.status === status ? entry : { ...entry, status };
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

export interface CompletionOutboxRenderDetails {
  replayed: boolean;
  resources: readonly string[];
}

export function renderCompletionOutboxMessage(
  content: string,
  details: CompletionOutboxRenderDetails,
  expanded: boolean,
  theme: Theme,
): Component {
  if (expanded) return new Text(theme.fg("toolOutput", content), 0, 0);
  const firstLine = content.split("\n").find((line) => line.trim())?.trim() ?? "completed";
  const publicationCount = details.resources.length;
  const state = details.replayed ? "replayed" : "completed";
  const rest = `${state} · ${publicationCount} publication${publicationCount === 1 ? "" : "s"} · ${firstLine}`;
  const tone = details.replayed ? "warning" : "success";
  const glyph = theme.fg(tone, details.replayed ? "↻" : "✓");
  return dynamicComponent((width) => [truncateToWidth(qLine(theme, glyph, "teammate-complete", rest), Math.max(1, width), "…")]);
}

export function renderQuietTeammateAux(
  name: "teammate-send" | "teammate-wait" | "teammate-watch" | "teammate-started" | "teammate-monitor" | "observe",
  rest: string,
  status: "running" | "success" | "failure",
  theme: Theme,
): Component | undefined {
  if (!isQuietMode()) return undefined;
  const tone = status === "failure" ? "error" : status === "success" ? "success" : "warning";
  const glyph = theme.fg(tone, quietStatusMark(status));
  return dynamicComponent((w) => [truncateToWidth(qLine(theme, glyph, name, rest), Math.max(1, w), "…")]);
}

/**
 * Host-contract fallbacks for auxiliary tool renderers when quiet mode is off.
 * pi's ToolExecutionComponent addChild()s whatever renderCall/renderResult
 * return and only guards against throws, so renderQuietTeammateAux's quiet-only
 * undefined must never leak into a tool slot — Box.render would call
 * child.render on undefined and kill pi with an uncaughtException. This is the
 * exact state every /resume history render sees: pi renders resumed history
 * before session_start, while the Cockpit-driven quiet mirror is still false.
 * The fallbacks mirror the host's own default call/result rendering.
 */
export function auxToolCallFallback(name: string, theme: Theme): Component {
  return new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
}

export function auxToolResultFallback(result: AgentToolResult<unknown>, theme: Theme): Component {
  const text = typeof result.content === "string"
    ? result.content
    : result.content
      .map((entry) => entry.type === "text" ? entry.text : "")
      .filter(Boolean)
      .join("\n");
  return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
}

function quietFirstError(r: SingleResult): string {
  const text = r.messages[r.messages.length - 1]?.content ?? "";
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  if (!line) return tuiT("progress.quiet.failed");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
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
  results: SingleResult[] = [],
): void {
  const effectiveEntries = settleProgressFromResults(entries, results);
  const entryByTaskIndex = new Map(effectiveEntries.map((entry) => [entry.taskIndex, entry]));
  const childrenByParent = new Map<string, ChildAgentCallSnapshot[]>();
  for (const child of childCalls) {
    const key = child.parentCorrelationId ?? "";
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(child);
    else childrenByParent.set(key, [child]);
  }

  const taskCids = new Set(entries.map((entry) => entry.correlationId).filter(Boolean));
  const childCids = new Set(childCalls.map((child) => child.correlationId));
  for (const row of buildProgressTree(effectiveEntries, quietPalette(theme))) {
    const result = results[row.taskIndex];
    const failure = result && result.exitCode !== 0
      ? theme.fg("error", ` · ${quietFirstError(result)}`)
      : "";
    lines.push(`${row.text}${failure}`);
    const cid = entryByTaskIndex.get(row.taskIndex)?.correlationId;
    if (cid) renderChildSubtree(childrenByParent.get(cid) ?? [], childrenByParent, "  ", theme, lines, true);
  }

  const rootOrphans = childCalls.filter((child) => {
    const parent = child.parentCorrelationId;
    return !parent || (!taskCids.has(parent) && !childCids.has(parent));
  });
  renderChildSubtree(rootOrphans, childrenByParent, "", theme, lines, true);
}

function quietResultLine(result: SingleResult, theme: Theme, fallbackName?: string): string {
  const failed = result.exitCode !== 0;
  const glyph = theme.fg(failed ? "error" : "success", quietStatusMark(failed ? "failure" : "success"));
  const displayName = result.name ?? fallbackName ?? result.agent;
  const label = result.name || fallbackName ? `@${displayName}` : displayName;
  const role = displayName === result.agent ? "" : `(${result.agent})`;
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  const state = failed
    ? `${tuiT("progress.quiet.failed")} · ${quietFirstError(result)}`
    : tuiT("progress.quiet.done");
  const rest = statusMeta([
    role,
    state,
    formatDuration(result.durationMs),
    totalTokens > 0 ? tuiT("metrics.tokens", { count: formatTokens(totalTokens) }) : "",
    ...cacheUsageParts(result.usage, formatTokens),
  ], theme);
  return qLine(theme, glyph, label, rest);
}

function renderQuietTeammateResult(result: AgentToolResult<Details>, theme: Theme): Component {
  const details = result.details;

  if (details && details.results.length > 0) {
    const results = details.results;
    return dynamicComponent((w) => {
      const lines: string[] = [];
      if (details.progress?.length) {
        appendQuietAgentTree(lines, details.progress, details.childCalls ?? [], theme, results);
      } else {
        results.forEach((entry) => lines.push(quietResultLine(entry, theme)));
      }
      return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
    });
  }

  const entries = details?.progress ?? [];
  const childCalls = details?.childCalls ?? [];

  // No topology at all: a single background ack, a detach, or a rejected
  // dispatch. Mirror the non-quiet content preview — the mark must reflect the
  // ack or error, never a completion the dispatch has not earned (the old
  // fallback printed a success glyph plus "0 child agents" for both a running
  // background agent and an isError budget rejection).
  if (entries.length === 0 && childCalls.length === 0) {
    const content = typeof result.content === "string"
      ? result.content
      : result.content
        .map((entry) => entry.type === "text" ? entry.text : "")
        .filter(Boolean)
        .join("\n");
    const isError = (result as { isError?: boolean }).isError === true;
    const glyph = theme.fg(
      isError ? "error" : "warning",
      quietStatusMark(isError ? "failure" : "running"),
    );
    const preview = (content.split("\n")[0] ?? "").replace(/^■\s*/, "");
    return dynamicComponent((w) => [truncateToWidth(qLine(theme, glyph, "teammate", preview), Math.max(1, w), "…")]);
  }

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
  const childCount = running || childCalls.length;
  const stateText = entries.length === 0
    ? tuiT(childCount === 1 ? "progress.child.one" : "progress.child.many", { count: childCount })
    : failed > 0
      ? tuiT("progress.summary.failed", { count: failed, total: entries.length })
      : running > 0
        ? tuiT("progress.summary.running", { count: running, total: entries.length })
        : tuiT("progress.summary.done", { count: completed, total: entries.length });

  return dynamicComponent((w) => {
    const lines = [qLine(theme, glyph, "teammate", stateText)];
    appendQuietAgentTree(lines, entries, childCalls, theme);
    return lines.map((line) => truncateToWidth(line, Math.max(1, w), "…"));
  });
}
