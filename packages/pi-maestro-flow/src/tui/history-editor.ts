/**
 * Editor with cross-session prompt history.
 *
 * Pi's built-in editor keeps its own in-memory history list, which dies with the
 * session. This subclass takes that list over entirely: `addToHistory` feeds a
 * persistent store instead of the base list, so the base list stays empty and its
 * own up/down navigation is inert — there is exactly one history, and it survives
 * `/new` and process restarts.
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, type EditorTheme, type TUI, getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Cursor state when the user is typing rather than browsing history. */
const NOT_BROWSING = -1;
/** Keep custom double-Esc behavior consistent with Pi's native session-tree shortcut. */
const DOUBLE_ESCAPE_WINDOW_MS = 500;

export interface HistoryEditorRouteTarget {
  label: string;
  sigil?: "@" | "#";
  paint: (text: string) => string;
}

export interface HistoryEditorParams {
  /** Newest first. Read on every keystroke so the store stays the single source of truth. */
  getEntries: () => readonly string[];
  /** Called for every submitted prompt, including slash commands and `!` bash lines. */
  record: (text: string) => void;
  /** Immutable route prefix painted inside the editor, never included in text. */
  getRouteTarget?: () => HistoryEditorRouteTarget | undefined;
}

interface EditorRenderState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface EditorWithRenderState {
  state: EditorRenderState;
}

export class HistoryEditor extends CustomEditor {
  private index = NOT_BROWSING;
  /** What the user had typed before browsing started, restored on the way back down. */
  private draft = "";
  /** First Esc while a draft is present; empty-editor Esc stays owned by Pi. */
  private lastNonEmptyEscapeAt = 0;

  /** Repaint after a cross-extension input-target change. */
  refreshRouteTarget(): void {
    this.tui.requestRender();
  }

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly params: HistoryEditorParams,
  ) {
    super(tui, theme, keybindings);
  }

  /** Submitted prompts go to the persistent store, never to the base in-memory list. */
  override addToHistory(text: string): void {
    this.params.record(text);
  }

  /** Programmatic writes (submit clears, `ui.setEditorText`) end history browsing. */
  override setText(text: string): void {
    this.index = NOT_BROWSING;
    this.lastNonEmptyEscapeAt = 0;
    super.setText(text);
  }

  override handleInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, Key.escape) && !this.isShowingAutocomplete() && this.getText().trim()) {
      const now = Date.now();
      if (now - this.lastNonEmptyEscapeAt < DOUBLE_ESCAPE_WINDOW_MS) {
        this.setText("");
        return;
      }
      this.lastNonEmptyEscapeAt = now;
      // Preserve Pi's higher-priority Escape actions such as stopping a stream.
      super.handleInput(data);
      return;
    }
    this.lastNonEmptyEscapeAt = 0;
    if (keys.matches(data, "tui.editor.cursorUp") && this.canBrowseOlder()) {
      this.step(1);
      return;
    }
    if (keys.matches(data, "tui.editor.cursorDown") && this.canBrowseNewer()) {
      this.step(-1);
      return;
    }
    super.handleInput(data);
    // Editing the recalled text means the user left history behind.
    if (this.browsing() && this.getText() !== this.params.getEntries()[this.index]) {
      this.index = NOT_BROWSING;
    }
  }

  override render(width: number): string[] {
    const target = this.params.getRouteTarget?.();
    const lines = target ? this.renderWithRouteTarget(width, target) : super.render(width);
    const total = this.params.getEntries().length;
    if (!this.browsing() || total === 0) return lines;
    // Put the compact position label below the editor so it does not compete with its border.
    return [...lines, historyBanner(this.index + 1, total, width, this.getPaddingX(), this.borderColor)];
  }

  private renderWithRouteTarget(width: number, target: HistoryEditorRouteTarget): string[] {
    const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
    const token = truncateToWidth(`${target.sigil ?? "@"}${target.label}:`, Math.max(1, layoutWidth - 1), "…");
    const injected = `${token}${visibleWidth(token) < layoutWidth ? " " : ""}`;

    // Editor has no render-prefix API. Temporarily project the immutable target
    // into its layout state so native wrapping and cursor placement stay correct,
    // then restore the real editable state before returning.
    const state = (this as unknown as EditorWithRenderState).state;
    const originalLines = state.lines;
    const originalCursorCol = state.cursorCol;
    state.lines = [`${injected}${originalLines[0] ?? ""}`, ...originalLines.slice(1)];
    if (state.cursorLine === 0) state.cursorCol += injected.length;
    try {
      const rendered = super.render(width);
      const routeLine = rendered.findIndex((line) => line.includes(token));
      if (routeLine >= 0) {
        rendered[routeLine] = rendered[routeLine]!.replace(token, target.paint(token));
      }
      return rendered.map((line) => truncateToWidth(line, Math.max(1, width), ""));
    } finally {
      state.lines = originalLines;
      state.cursorCol = originalCursorCol;
    }
  }

  private browsing(): boolean {
    return this.index > NOT_BROWSING;
  }

  /**
   * Mirrors the base editor's own gating: on the first line, and either already
   * browsing or with the cursor at the very start (which includes an empty editor) —
   * anywhere else Up is a plain cursor move. The base tracks the first *visual* line,
   * which it does not expose; the first logical line is the closest public equivalent.
   */
  private canBrowseOlder(): boolean {
    if (this.isShowingAutocomplete() || this.getCursor().line !== 0) return false;
    return this.browsing() || this.getCursor().col === 0;
  }

  private canBrowseNewer(): boolean {
    if (!this.browsing() || this.isShowingAutocomplete()) return false;
    return this.getCursor().line === this.getLines().length - 1;
  }

  private step(delta: number): void {
    const entries = this.params.getEntries();
    const next = this.index + delta;
    if (next < NOT_BROWSING || next >= entries.length) return;
    if (!this.browsing()) this.draft = this.getText();
    // super.setText, so the index we are about to record survives.
    super.setText(next === NOT_BROWSING ? this.draft : entries[next] ?? "");
    this.index = next;
  }
}

/** Compact `History 3/100` position label, indented to the editor's content. */
export function historyBanner(
  position: number,
  total: number,
  width: number,
  paddingX: number,
  paint: (value: string) => string,
): string {
  const indent = " ".repeat(Math.max(0, paddingX));
  const inner = Math.max(1, width - indent.length * 2);
  const label = `History ${position}/${total}`;
  return indent + paint(truncateToWidth(label, inner, "…"));
}
