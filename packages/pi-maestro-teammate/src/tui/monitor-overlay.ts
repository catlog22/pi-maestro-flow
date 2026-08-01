/**
 * MonitorOverlay — TUI form for configuring monitor bindings.
 *
 * Opened via /monitor command. Shows active sessions, allows selecting
 * which to monitor, choosing auto/custom mode, and entering a custom prompt.
 *
 * Pattern: follows TeammateControlCenter (ctx.ui.custom + Component).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "../extension/monitor.ts";
import type { MonitorSupervisionMode } from "../extension/monitor.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorSessionRow {
  correlationId: string;
  displayName: string;
  agentRole: string;
  status: string;
  idleSeconds: number;
  /** Session/owner source; "local" for the current root process. */
  source?: string;
  /** Whether this session already has a monitor binding. */
  bound: boolean;
}

export interface MonitorOverlayResult {
  /** Selected session correlationIds. */
  selected: string[];
  mode: MonitorSupervisionMode;
  customPrompt?: string;
}

interface OverlayCallbacks {
  getSessions: () => MonitorSessionRow[];
  close: (result: MonitorOverlayResult | null) => void;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

export class MonitorOverlay {
  private sessions: MonitorSessionRow[] = [];
  private cursor = 0;
  private selected: Set<string> = new Set();
  private mode: MonitorSupervisionMode = "auto";
  private customPrompt = "";
  private editingPrompt = false;
  private statusText = "";
  private requestRender: () => void = () => {};

  constructor(private readonly cb: OverlayCallbacks) {
    this.sessions = cb.getSessions();
    // Pre-select already-bound sessions
    for (const s of this.sessions) {
      if (s.bound) this.selected.add(s.correlationId);
    }
  }

  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  // --- Rendering ---

  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    const lines: string[] = [];
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
    const accent = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

    // Title
    lines.push(dim(`╭${"─".repeat(inner)}╮`));
    lines.push(this.frameLine(bold(" Monitor — Select Sessions"), inner, dim));

    // Session list
    const maxVisible = Math.min(this.sessions.length, 10);
    const scrollStart = Math.max(0, Math.min(this.cursor - 4, this.sessions.length - maxVisible));

    for (let i = scrollStart; i < scrollStart + maxVisible && i < this.sessions.length; i++) {
      const s = this.sessions[i];
      const isCursor = i === this.cursor;
      const isSelected = this.selected.has(s.correlationId);

      const pointer = isCursor ? accent("▸") : " ";
      const check = isSelected ? green("✓") : dim("○");
      const icon = statusIcon(s.status);
      const idle = s.status === "running" ? `${s.idleSeconds}s` : "—";
      const boundTag = s.bound ? dim(" [MON]") : "";
      const sourceTag = s.source && s.source !== "local" ? dim(` [${s.source}]`) : "";

      const row = ` ${pointer} ${check} ${icon} ${s.displayName}  ${dim(s.status)}  ${dim(idle)}  ${dim(s.agentRole)}${sourceTag}${boundTag}`;
      lines.push(this.frameLine(isCursor ? accent(row) : row, inner, dim));
    }

    if (this.sessions.length === 0) {
      lines.push(this.frameLine(dim("  No active sessions"), inner, dim));
    }

    lines.push(this.frameLine("", inner, dim));

    // Mode selection
    const autoLabel = this.mode === "auto" ? accent("● Auto") : dim("○ Auto");
    const customLabel = this.mode === "custom" ? accent("● Custom") : dim("○ Custom");
    lines.push(this.frameLine(` Mode: ${autoLabel}  ${customLabel}  ${dim("(Tab)")}`, inner, dim));

    // Custom prompt (only in custom mode)
    if (this.mode === "custom") {
      const promptDisplay = this.editingPrompt
        ? ` > ${this.customPrompt}\x1b[7m \x1b[0m`
        : ` > ${this.customPrompt || dim("(press Enter to edit)")}`;
      lines.push(this.frameLine(promptDisplay, inner, dim));
    }

    // Status
    if (this.statusText) {
      lines.push(this.frameLine(dim(` ${this.statusText}`), inner, dim));
    }

    // Footer
    lines.push(this.frameLine("", inner, dim));
    lines.push(this.frameLine(
      dim(" Space select · Tab mode · Enter confirm · Esc cancel · ↑↓ navigate"),
      inner, dim,
    ));
    lines.push(dim(`╰${"─".repeat(inner)}╯`));

    return lines;
  }

  private frameLine(content: string, inner: number, dim: (s: string) => string): string {
    const truncated = truncateToWidth(content, inner, "…");
    const pad = Math.max(0, inner - visibleLen(truncated));
    return `${dim("│")} ${truncated}${" ".repeat(pad)} ${dim("│")}`;
  }

  // --- Input ---

  handleInput(data: string): void {
    // Editing custom prompt
    if (this.editingPrompt) {
      if (data === "\x1b" || data === "\r" || data === "\n") {
        this.editingPrompt = false;
        this.statusText = this.customPrompt ? `Prompt: ${this.customPrompt.slice(0, 40)}` : "";
      } else if (data === "\x7f" || data === "\b") {
        this.customPrompt = this.customPrompt.slice(0, -1);
      } else if (!data.startsWith("\x1b") && data >= " " && data.length <= 2) {
        // 拒绝以 ESC 开头的序列（方向键 / 功能键），避免 `[A` 等残渣混入文本。
        this.customPrompt += data;
      }
      this.requestRender();
      return;
    }

    switch (data) {
      case "\x1b": // Esc
        this.cb.close(null);
        return;

      case "\r": case "\n": // Enter
        if (this.mode === "custom" && !this.customPrompt) {
          this.editingPrompt = true;
          this.statusText = "Type management prompt, Enter to confirm";
        } else {
          this.confirm();
        }
        break;

      case "\t": // Tab — toggle mode
        this.mode = this.mode === "auto" ? "custom" : "auto";
        this.statusText = "";
        break;

      case " ": // Space — toggle selection
        if (this.sessions.length > 0) {
          const s = this.sessions[this.cursor];
          if (this.selected.has(s.correlationId)) {
            this.selected.delete(s.correlationId);
          } else {
            this.selected.add(s.correlationId);
          }
        }
        break;

      case "\x1b[A": case "k": // Up
        this.cursor = Math.max(0, this.cursor - 1);
        break;

      case "\x1b[B": case "j": // Down
        this.cursor = Math.min(this.sessions.length - 1, this.cursor + 1);
        break;

      default:
        // Number keys for quick select
        if (/^[1-9]$/.test(data)) {
          const idx = Number(data) - 1;
          if (idx < this.sessions.length) {
            this.cursor = idx;
            const s = this.sessions[idx];
            if (this.selected.has(s.correlationId)) this.selected.delete(s.correlationId);
            else this.selected.add(s.correlationId);
          }
        }
        break;
    }
    this.requestRender();
  }

  private confirm(): void {
    const selected = [...this.selected];
    if (selected.length === 0) {
      this.statusText = "Select at least one session (Space)";
      this.requestRender();
      return;
    }
    if (this.mode === "custom" && !this.customPrompt.trim()) {
      this.editingPrompt = true;
      this.statusText = "Enter a management prompt first";
      this.requestRender();
      return;
    }
    this.cb.close({
      selected,
      mode: this.mode,
      customPrompt: this.mode === "custom" ? this.customPrompt.trim() : undefined,
    });
  }

  invalidate(): void {}
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough visible length (strips ANSI escapes). */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ---------------------------------------------------------------------------
// Opening helper
// ---------------------------------------------------------------------------

export interface MonitorOverlayDeps {
  getSessions: () => MonitorSessionRow[];
}

/**
 * Opens the monitor overlay and returns the user's selection.
 * Returns null if cancelled.
 */
export async function showMonitorOverlay(
  ctx: { ui: { custom: <T>(factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void; dispose: () => void }, options: Record<string, unknown>) => Promise<T> } },
  deps: MonitorOverlayDeps,
): Promise<MonitorOverlayResult | null> {
  return ctx.ui.custom<MonitorOverlayResult | null>(
    (tui, _theme, _keybindings, done) => {
      const overlay = new MonitorOverlay({
        getSessions: deps.getSessions,
        close: done,
      });
      overlay.setRequestRender(() => tui.requestRender());
      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => overlay.handleInput(data),
        invalidate: () => overlay.invalidate(),
        dispose: () => overlay.dispose(),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" } },
  );
}
