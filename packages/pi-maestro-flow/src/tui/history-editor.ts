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
import { type EditorTheme, type TUI, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

/** Cursor state when the user is typing rather than browsing history. */
const NOT_BROWSING = -1;
/** Dashes drawn left of the `History n/N` label. */
const BANNER_LEAD = 2;

export interface HistoryEditorParams {
  /** Newest first. Read on every keystroke so the store stays the single source of truth. */
  getEntries: () => readonly string[];
  /** Called for every submitted prompt, including slash commands and `!` bash lines. */
  record: (text: string) => void;
}

export class HistoryEditor extends CustomEditor {
  private index = NOT_BROWSING;
  /** What the user had typed before browsing started, restored on the way back down. */
  private draft = "";

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
    super.setText(text);
  }

  override handleInput(data: string): void {
    const keys = getKeybindings();
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
    const lines = super.render(width);
    const total = this.params.getEntries().length;
    if (!this.browsing() || total === 0) return lines;
    return [historyBanner(this.index + 1, total, width, this.getPaddingX(), this.borderColor), ...lines];
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

/** `── History 3/100 ───────` sized to the editor box, indented past its padding. */
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
  if (inner < label.length + BANNER_LEAD + 2) {
    return indent + paint(truncateToWidth(label, inner, "…"));
  }
  const trail = inner - BANNER_LEAD - label.length - 2;
  return indent + paint(`${"─".repeat(BANNER_LEAD)} ${label} ${"─".repeat(trail)}`);
}
