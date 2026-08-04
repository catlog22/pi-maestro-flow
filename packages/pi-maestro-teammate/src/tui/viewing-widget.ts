/**
 * Main-TUI viewing mode for a teammate session (claude-code style).
 *
 * Pure rendering + input-routing decisions, no extension context — kept
 * dependency-free so the widget and the input hook share one testable core.
 * The extension wires these into a belowEditor widget and a pi.on("input")
 * hook; switching only touches UI state, never the agent's task, so a running
 * agent (main loop or sub-process) is unaffected by entering/leaving the view.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptRow } from "../shared/transcript.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

export interface ViewingSwitch {
  /** Display label, e.g. @explorer. */
  label: string;
  active: boolean;
}

export interface ViewingWidgetState {
  agentName?: string;
  agentRole: string;
  status: string;
  rows: TranscriptRow[];
  canSend: boolean;
  transcriptSource: "session" | "memory";
  /** Switchable agents — rendered as a highlightable row navigated with ←/→. */
  switches?: ViewingSwitch[];
}

/** How many message rows the belowEditor widget shows (tail-following). */
export const VIEWING_MAX_MESSAGE_LINES = 8;

export function renderViewingWidget(
  state: ViewingWidgetState,
  width: number,
): string[] {
  const w = Math.max(1, Math.min(width, 120));
  const name = state.agentName ?? state.agentRole;
  const statusText = state.status === "running"
    ? yellow("running")
    : state.status === "sleeping"
      ? yellow("sleeping")
      : dim(state.status);
  const header = `${green("●")} Viewing @${name} ${dim("·")} ${statusText} ${dim("· Esc main")}`;
  const lines: string[] = [truncateToWidth(header, w, "…"), dim("─".repeat(Math.max(1, w - 2)))];

  // Agent switcher row: one label per switchable session, active one
  // highlighted. ←/→ moves the highlight (avoiding any ↑/↓ ambiguity).
  const switches = state.switches ?? [];
  if (switches.length > 1) {
    const labels = switches.map((entry) =>
      entry.active
        ? `${green("▸")} ${bold(green(entry.label))}`
        : dim(entry.label),
    );
    lines.push(truncateToWidth(labels.join(dim("  ")), w, "…"));
    lines.push(dim("─".repeat(Math.max(1, w - 2))));
  }

  const tail = state.rows.slice(-VIEWING_MAX_MESSAGE_LINES);
  if (tail.length === 0) {
    lines.push(dim("No messages yet"));
  } else {
    for (const row of tail) {
      lines.push(...renderViewingRow(row, w));
    }
  }
  if (state.transcriptSource === "memory") {
    lines.push(dim("(live activity — no persisted session)"));
  }
  const composer = state.canSend ? "Type in the input box · Enter sends to this agent" : "Read-only · Esc main";
  lines.push(dim(composer));
  return lines;
}

/** One transcript row → display lines (shares the attach-overlay row style). */
export function renderViewingRow(row: TranscriptRow, width: number): string[] {
  const contentWidth = Math.max(1, width - 3);
  // Widget lines must never contain a raw newline (breaks the fixed-height
  // layout) — collapse multi-line text to its first line.
  const flat = (text: string): string => text.split("\n", 1)[0] ?? "";
  const text = flat(row.text).trim();
  switch (row.kind) {
    case "user":
      return [`${green("❯")} ${truncateToWidth(text || "(image)", contentWidth, "…")}`];
    case "assistant":
      return [`${dim("·")} ${truncateToWidth(text, contentWidth, "…")}`];
    case "tool":
      return [`${dim("▸")} ${green(row.toolName ?? "tool")} ${truncateToWidth(text, contentWidth - visibleWidth(`▸ ${row.toolName ?? "tool"} `), "…")}`.trimEnd()];
    case "tool_result":
      return [`${row.isError ? red("✗") : dim("·")} ${truncateToWidth(text, contentWidth, "…")}`];
    case "thinking": {
      const preview = text;
      const suffix = row.text.trim().split("\n").length > 1 ? dim(" …") : "";
      return [`${dim("…")} ${dim(truncateToWidth(preview, contentWidth, "…"))}${suffix}`];
    }
    case "meta":
    case "system":
    default:
      return [dim(`─ ${truncateToWidth(text, contentWidth, "…")}`)];
  }
}

/**
 * Where a submitted main-editor line goes while viewing a teammate.
 *
 * - not viewing → main conversation handles it (`continue`)
 * - `/`-commands → main conversation (pi processes them)
 * - viewing a read-only agent (no writable stdin) → swallow (`handled`)
 * - otherwise → forward to the agent as a follow-up (`forward`)
 */
export type ViewingInputAction =
  | { action: "continue" }
  | { action: "handled" }
  | { action: "forward"; text: string };

export function decideViewingInput(
  text: string,
  opts: { viewing: boolean; canSend: boolean },
): ViewingInputAction {
  if (!opts.viewing) return { action: "continue" };
  if (text.startsWith("/")) return { action: "continue" };
  if (!opts.canSend) return { action: "handled" };
  return { action: "forward", text };
}
