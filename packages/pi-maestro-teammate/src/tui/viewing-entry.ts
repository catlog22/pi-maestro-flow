/**
 * Main-TUI viewing mode for a teammate session — conversation-embedded
 * streaming entry.
 *
 * `/teammate-session` no longer renders a below-editor widget: it appends a
 * custom entry into the main conversation, and the entry renderer streams the
 * viewed agent's working status live, conversation-style. The body uses the
 * exact same Markdown component + theme as Pi's built-in assistant message
 * renderer, so sub-agent output is presented identically to the main agent's
 * messages. Custom entries never participate in LLM context, so streaming
 * telemetry cannot pollute the main agent's prompt.
 *
 * Pure rendering + state projection, no extension context — kept dependency-
 * free so the renderer and the state builder share one testable core. The
 * extension wires this into `registerEntryRenderer` and a pi.on("input") hook;
 * switching only touches UI state, never the agent's task, so a running agent
 * (main loop or sub-process) is unaffected by entering/leaving the view.
 */

import { Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  displayStatusPresentation,
  effectiveDisplayStatus,
  type StatusPresentation,
} from "../shared/agent-status.ts";
import type { AgentStatus } from "../shared/types.ts";
import { toneText, type ProgressPalette } from "./progress-tree.ts";

/** Custom-entry type for the live viewing block. Entries bypass LLM context. */
export const TEAMMATE_VIEW_CUSTOM_TYPE = "pi-teammate-view";

/** Persisted entry payload — the agent's identity plus a frozen snapshot. */
export interface ViewingEntryData {
  correlationId: string;
  agent: string;
  name?: string;
  status: string;
  streamingText?: string;
  toolLines?: ViewingToolLine[];
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/** One tool-activity line rendered under the body. */
export interface ViewingToolLine {
  name: string;
  status: "running" | "completed" | "failed";
}

/**
 * Live view data supplied while viewing mode is active on this agent. When
 * absent, the entry renders its frozen snapshot (viewing exited or restarted).
 */
export interface ViewingEntryLive {
  status: string;
  resultReadyAt?: number;
  lastActivityAt?: number;
  startedAt?: number;
  streamingText?: string;
  toolLines?: ViewingToolLine[];
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Switchable agent labels, active one at `activeIndex`. */
  switches?: string[];
  activeIndex?: number;
  canSend: boolean;
}

/** Everything the renderer needs for one frame. */
export interface ViewingRenderState {
  agent: string;
  name?: string;
  /** Whether viewing mode is live on this agent right now. */
  active: boolean;
  status: string;
  presentation: StatusPresentation;
  durationMs?: number;
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  bodyText: string;
  toolLines: ViewingToolLine[];
  switches?: string[];
  activeIndex?: number;
  canSend: boolean;
}

export interface ViewingEntryContext {
  data: ViewingEntryData;
  live?: ViewingEntryLive;
}

/** Upper bound on the markdown body so a 64KB message cannot flood the entry. */
export const VIEWING_BODY_MAX_CHARS = 2000;
/** Upper bound on rendered tool-activity lines. */
export const VIEWING_TOOL_MAX_LINES = 6;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function resolvePresentation(
  status: string,
  resultReadyAt?: number,
  lastActivityAt?: number,
): StatusPresentation {
  try {
    return displayStatusPresentation(
      effectiveDisplayStatus(status as AgentStatus, resultReadyAt, lastActivityAt),
    );
  } catch {
    return { icon: "•", text: status, tone: "dim" };
  }
}

/**
 * Project (data, live) into the render state. Live data wins while the agent
 * is being viewed; otherwise the frozen snapshot renders so the entry survives
 * process restarts as a static record.
 */
export function buildViewingRenderState(ctx: ViewingEntryContext): ViewingRenderState {
  const { data, live } = ctx;
  const active = live !== undefined;
  const durationMs = active
    ? live.startedAt !== undefined && live.startedAt > 0
      ? Math.max(0, Date.now() - live.startedAt)
      : data.durationMs
    : data.durationMs;
  const bodyText = active
    ? (live.streamingText ?? data.streamingText ?? "")
    : (data.streamingText ?? "");
  return {
    agent: data.agent,
    name: data.name,
    active,
    status: active ? live.status : data.status,
    presentation: resolvePresentation(
      active ? live.status : data.status,
      active ? live.resultReadyAt : undefined,
      active ? live.lastActivityAt : undefined,
    ),
    durationMs,
    toolCount: active ? live.toolCount ?? data.toolCount : data.toolCount,
    inputTokens: active ? live.inputTokens ?? data.inputTokens : data.inputTokens,
    outputTokens: active ? live.outputTokens ?? data.outputTokens : data.outputTokens,
    bodyText: bodyText.trim().slice(0, VIEWING_BODY_MAX_CHARS),
    toolLines: active
      ? (live.toolLines ?? data.toolLines ?? []).slice(0, VIEWING_TOOL_MAX_LINES)
      : (data.toolLines ?? []).slice(0, VIEWING_TOOL_MAX_LINES),
    switches: active ? live.switches : undefined,
    activeIndex: active ? live.activeIndex : undefined,
    canSend: active ? live.canSend : false,
  };
}

/**
 * Render the viewing entry as conversation lines.
 *
 * Header/status/tools/footer are auxiliary dim lines; the body is rendered
 * with the identical `Markdown` + `getMarkdownTheme()` combo the built-in
 * AssistantMessageComponent uses — same colors, padding, and no background —
 * so a sub-agent's streaming output reads exactly like a main-agent message.
 */
export function renderViewingEntry(
  state: ViewingRenderState,
  width: number,
  palette: ProgressPalette,
): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];

  const name = state.name ?? state.agent;
  const role = state.agent !== name ? `(${state.agent})` : "";
  const statusText = toneText(palette, state.presentation.tone, state.presentation.text);
  const metaParts = [
    state.durationMs !== undefined ? formatDuration(state.durationMs) : "",
    state.toolCount ? `${state.toolCount} tools` : "",
    state.inputTokens !== undefined || state.outputTokens !== undefined
      ? `in ${formatTokens(state.inputTokens ?? 0)}/out ${formatTokens(state.outputTokens ?? 0)}`
      : "",
  ].filter(Boolean);
  const headerParts = [
    `${toneText(palette, state.presentation.tone, state.presentation.icon)} ${palette.bold(`@${name}`)}`,
    role ? palette.dim(role) : "",
    statusText,
    ...metaParts.map((part) => palette.dim(part)),
  ];
  lines.push(truncateToWidth(headerParts.join(palette.dim(" · ")), w, "…"));

  // Agent switcher row — only while live; ↑/↓ and ←/→ move the highlight.
  const switches = state.switches ?? [];
  if (state.active && switches.length > 1) {
    const labels = switches.map((label, i) =>
      i === state.activeIndex
        ? `${palette.accent("▸")} ${palette.bold(palette.accent(label))}`
        : palette.dim(label),
    );
    lines.push(truncateToWidth(labels.join(palette.dim("  ")), w, "…"));
  }

  // Body — identical styling to the built-in assistant message renderer.
  if (state.bodyText) {
    lines.push(...new Markdown(state.bodyText, 1, 0, getMarkdownTheme()).render(w));
  } else if (state.active) {
    lines.push(palette.dim("No output yet"));
  }

  for (const tool of state.toolLines) {
    const marker = tool.status === "running"
      ? palette.running("→")
      : tool.status === "failed"
        ? palette.error("✗")
        : palette.success("✓");
    lines.push(truncateToWidth(`  ${marker} ${palette.dim(tool.name)}`, w, "…"));
  }

  if (state.active) {
    const hint = state.canSend
      ? "↑/↓ switch agent · type & Enter sends · Esc main"
      : "↑/↓ switch agent · read-only · Esc main";
    lines.push(truncateToWidth(palette.dim(hint), w, "…"));
  }

  return lines;
}

/**
 * Component wrapper for `registerEntryRenderer`: re-reads the live state on
 * every frame, so the conversation block streams without re-appending.
 */
export function createViewingEntryComponent(
  getState: () => ViewingRenderState,
  palette: ProgressPalette,
): Component {
  return {
    render: (width: number) => renderViewingEntry(getState(), width, palette),
    invalidate() {},
  };
}
