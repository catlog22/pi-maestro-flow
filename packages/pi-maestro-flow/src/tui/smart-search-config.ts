import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  SMART_SEARCH_CONFIG_KEYS,
  SmartSearchConfigStore,
  displaySmartSearchConfigValue,
  isSmartSearchSecretKey,
  maskSmartSearchSecret,
  type SmartSearchConfig,
} from "../tools/smart-search-config.ts";
interface SmartSearchConfigTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface SmartSearchConfigStoreLike {
  load(): Promise<SmartSearchConfig>;
  save(patch: Record<string, unknown | undefined>): Promise<SmartSearchConfig>;
}

export interface SmartSearchConfigOverlayParams {
  config: SmartSearchConfig;
  store: SmartSearchConfigStoreLike;
  theme: SmartSearchConfigTheme;
  requestRender: () => void;
  close: () => void;
  initialKey?: string;
}

type OverlayMode = "list" | "edit";
type StatusTone = "dim" | "success" | "error";

const CTRL_U = "\x15";
const MAX_VISIBLE_ITEMS = 10;

export class SmartSearchConfigOverlay implements Component, Focusable {
  focused = false;
  private config: SmartSearchConfig;
  private readonly keys: string[];
  private selected = 0;
  private mode: OverlayMode = "list";
  private draft = "";
  private unsetDraft = false;
  private saving = false;
  private status = "";
  private statusTone: StatusTone = "dim";
  private lastWidth = 80;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly params: SmartSearchConfigOverlayParams) {
    this.config = { ...params.config };
    const known = new Set<string>(SMART_SEARCH_CONFIG_KEYS);
    const unknown = Object.keys(this.config).filter((key) => !known.has(key)).sort();
    this.keys = [...SMART_SEARCH_CONFIG_KEYS, ...unknown];
    if (params.initialKey) {
      const index = this.keys.indexOf(params.initialKey);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.lastWidth = safeWidth;
    if (safeWidth < 20) {
      const action = this.mode === "edit" ? "Esc back" : "Esc close";
      return [truncateToWidth(`Smart Search · ${action}`, safeWidth, "…")];
    }

    const inner = Math.max(1, safeWidth - 2);
    const key = this.currentKey();
    const rows = [
      truncateToWidth(this.params.theme.bold("Smart Search configuration"), inner, "…"),
      this.params.theme.fg("dim", "─".repeat(inner)),
    ];
    if (this.mode === "edit") {
      const secret = isSmartSearchSecretKey(key);
      const renderedDraft = this.unsetDraft
        ? this.params.theme.fg("warning", "unset key on save")
        : secret && this.draft ? maskSmartSearchSecret(this.draft) : this.draft;
      rows.push(truncateToWidth(this.params.theme.fg("accent", key), inner, "…"));
      rows.push(truncateToWidth(`> ${renderedDraft || this.params.theme.fg("dim", secret ? "type replacement secret" : "empty value")}`, inner, "…"));
      rows.push(truncateToWidth(
        this.params.theme.fg("dim", this.saving ? "Saving…" : "Enter save · Esc back · Ctrl+U clear · Backspace delete"),
        inner,
        "…",
      ));
    } else {
      const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_VISIBLE_ITEMS / 2), this.keys.length - MAX_VISIBLE_ITEMS));
      const visibleKeys = this.keys.slice(start, start + MAX_VISIBLE_ITEMS);
      for (let offset = 0; offset < visibleKeys.length; offset++) {
        const itemKey = visibleKeys[offset];
        const marker = start + offset === this.selected ? "›" : " ";
        const value = displaySmartSearchConfigValue(itemKey, this.config[itemKey]);
        const line = `${marker} ${itemKey} = ${value}`;
        rows.push(truncateToWidth(
          start + offset === this.selected ? this.params.theme.fg("accent", line) : line,
          inner,
          "…",
        ));
      }
      rows.push(truncateToWidth(this.params.theme.fg("dim", "Esc close · Enter edit · ↑↓ select"), inner, "…"));
    }
    if (this.status) rows.push(truncateToWidth(this.params.theme.fg(this.statusTone, this.status), inner, "…"));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.saving) return;
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    for (const token of this.pasteDecoder.feed(data)) this.dispatchDecodedToken(token);
    if (this.pasteDecoder.hasPending()) {
      this.pasteFlushTimer = setTimeout(() => {
        this.pasteFlushTimer = undefined;
        for (const token of this.pasteDecoder.flushPending()) this.dispatchDecodedToken(token);
        this.params.requestRender();
      }, 16);
    }
    this.params.requestRender();
  }

  private dispatchDecodedToken(token: DecodedInputToken): void {
    if (token.kind === "paste") {
      if (this.mode !== "edit" || this.lastWidth < 20) return;
      this.draft += token.text;
      this.unsetDraft = false;
      this.status = "";
      return;
    }
    this.handleDecodedInput(token.text);
  }

  private handleDecodedInput(data: string): void {
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape)) this.escape();
      return;
    }
    if (this.mode === "edit") {
      this.handleEditInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.params.close();
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = wrapIndex(this.selected - 1, this.keys.length);
    else if (matchesKey(data, Key.down)) this.selected = wrapIndex(this.selected + 1, this.keys.length);
    else if (matchesKey(data, Key.enter)) this.beginEdit();
    else return;
    this.status = "";
  }

  private handleEditInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "list";
      this.draft = "";
      this.unsetDraft = false;
      this.status = "";
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.saveDraft();
      return;
    }
    if (data === CTRL_U) {
      this.draft = "";
      this.unsetDraft = true;
      this.status = `Unset ${this.currentKey()} on save`;
      this.statusTone = "dim";
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b") this.draft = removeLastGrapheme(this.draft);
    else {
      const printable = sanitizeSingleLineInput(data);
      if (!printable) return;
      this.draft += printable;
      this.unsetDraft = false;
    }
    this.status = "";
  }

  private beginEdit(): void {
    const key = this.currentKey();
    const current = this.config[key];
    this.mode = "edit";
    this.draft = isSmartSearchSecretKey(key) ? "" : current === undefined || current === null ? "" : String(current);
    this.unsetDraft = false;
  }

  private async saveDraft(): Promise<void> {
    const key = this.currentKey();
    if (isSmartSearchSecretKey(key) && !this.draft && !this.unsetDraft) {
      this.mode = "list";
      this.status = "Secret unchanged";
      this.statusTone = "dim";
      this.params.requestRender();
      return;
    }
    this.saving = true;
    this.status = `Saving ${key}…`;
    this.statusTone = "dim";
    this.params.requestRender();
    try {
      this.config = await this.params.store.save({ [key]: this.unsetDraft ? undefined : this.draft });
      this.saving = false;
      this.mode = "list";
      this.draft = "";
      this.unsetDraft = false;
      this.status = `Saved · ${key}`;
      this.statusTone = "success";
    } catch (error) {
      this.saving = false;
      this.status = `Save failed · ${errorMessage(error)}`;
      this.statusTone = "error";
    }
    this.params.requestRender();
  }

  private currentKey(): string {
    return this.keys[this.selected] ?? SMART_SEARCH_CONFIG_KEYS[0];
  }

  private escape(): void {
    if (this.mode === "edit") {
      this.mode = "list";
      this.draft = "";
      this.unsetDraft = false;
      this.status = "";
      this.params.requestRender();
    } else {
      this.params.close();
    }
  }
}

export async function showSmartSearchConfigOverlay(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  store: SmartSearchConfigStoreLike = new SmartSearchConfigStore(),
): Promise<void> {
  if (!ctx.hasUI) return;
  const config = await store.load();
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const overlay = new SmartSearchConfigOverlay({
      config,
      store,
      theme,
      requestRender: () => tui.requestRender(),
      close: () => done(undefined),
    });
    return overlay;
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
  });
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

function frame(rows: string[], width: number, theme: SmartSearchConfigTheme): string[] {
  const inner = Math.max(0, width - 2);
  const border = (value: string) => theme.fg("dim", value);
  return [
    border(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => {
      const content = truncateToWidth(row, inner, "…");
      return `${border("│")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border("│")}`;
    }),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DecodedInputToken {
  kind: "input" | "paste";
  text: string;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_PASTE_CHARS = 1_048_576;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function removeLastGrapheme(value: string): string {
  const parts = graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : Array.from(value);
  parts.pop();
  return parts.join("");
}

function sanitizeSingleLineInput(value: string): string {
  return value.normalize("NFC").replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

class BracketedPasteDecoder {
  private pasting = false;
  private buffer = "";
  private pending = "";

  feed(data: string): DecodedInputToken[] {
    const tokens: DecodedInputToken[] = [];
    let rest = this.pending + data;
    this.pending = "";
    while (rest) {
      if (!this.pasting) {
        const start = rest.indexOf(PASTE_START);
        if (start < 0) {
          const partial = partialMarkerSuffix(rest, PASTE_START);
          const input = rest.slice(0, rest.length - partial.length);
          if (input) tokens.push({ kind: "input", text: input });
          this.pending = partial;
          break;
        }
        if (start > 0) tokens.push({ kind: "input", text: rest.slice(0, start) });
        this.pasting = true;
        rest = rest.slice(start + PASTE_START.length);
        continue;
      }
      const end = rest.indexOf(PASTE_END);
      if (end < 0) {
        const partial = partialMarkerSuffix(rest, PASTE_END);
        this.appendPaste(rest.slice(0, rest.length - partial.length));
        this.pending = partial;
        break;
      }
      this.appendPaste(rest.slice(0, end));
      tokens.push({ kind: "paste", text: sanitizeSingleLineInput(this.buffer) });
      this.buffer = "";
      this.pasting = false;
      rest = rest.slice(end + PASTE_END.length);
    }
    return tokens;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  flushPending(): DecodedInputToken[] {
    if (!this.pending) return [];
    const pending = this.pending;
    this.pending = "";
    if (this.pasting) {
      this.appendPaste(pending);
      return [];
    }
    return [{ kind: "input", text: pending }];
  }

  private appendPaste(value: string): void {
    const remaining = MAX_PASTE_CHARS - this.buffer.length;
    if (remaining > 0) this.buffer += value.slice(0, remaining);
  }
}

function partialMarkerSuffix(value: string, marker: string): string {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length >= 1; length--) {
    const suffix = value.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}
