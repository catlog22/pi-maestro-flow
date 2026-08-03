import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  type Component,
  type Focusable,
  type KeyId,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ALL_CONFIG_KEYS,
  SMART_SEARCH_CONFIG_KEYS,
  SmartSearchConfigStore,
  WEB_ACCESS_SYNC_MAPPINGS,
  configGroupForKey,
  displaySmartSearchConfigValue,
  isSmartSearchSecretKey,
  maskSmartSearchSecret,
  smartSearchConfigGroupForKey,
  syncMappingForSmartSearchKey,
  type SmartSearchConfig,
  type WebAccessSyncMapping,
} from "../tools/smart-search-config.ts";
import { invalidateWebConfigCaches } from "../tools/web-access/web-config-cache.ts";
interface SmartSearchConfigTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface SmartSearchConfigStoreLike {
  load(): Promise<SmartSearchConfig>;
  save(patch: Record<string, unknown | undefined>): Promise<SmartSearchConfig>;
}

// ---------------------------------------------------------------------------
// Web Access config sync — bridges ~/.pi/web-search.json ↔ Smart Search config
// ---------------------------------------------------------------------------

export type SyncStatus = "synced" | "conflict" | "smart-only" | "web-only" | "unmapped";

export interface WebAccessConfigSyncLike {
  loadWebConfig(): Record<string, unknown>;
  syncStatusForKey(smartSearchKey: string, smartSearchValue: unknown): SyncStatus;
  webValueForKey(smartSearchKey: string): unknown;
  pushToWebConfig(smartSearchConfig: SmartSearchConfig): void;
}

function resolveWebSearchJsonPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const base = envDir
    ?? (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
  return join(base, "web-search.json");
}

function getNestedValue(obj: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === null || current[part] === undefined || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export class WebAccessConfigSync implements WebAccessConfigSyncLike {
  private webConfig: Record<string, unknown> | undefined;
  private readonly webSearchJsonPath: string;

  constructor(webSearchJsonPath?: string) {
    this.webSearchJsonPath = webSearchJsonPath ?? resolveWebSearchJsonPath();
  }

  loadWebConfig(): Record<string, unknown> {
    if (this.webConfig) return this.webConfig;
    try {
      if (!existsSync(this.webSearchJsonPath)) {
        this.webConfig = {};
        return this.webConfig;
      }
      const parsed: unknown = JSON.parse(readFileSync(this.webSearchJsonPath, "utf-8"));
      this.webConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      this.webConfig = {};
    }
    return this.webConfig;
  }

  syncStatusForKey(smartSearchKey: string, smartSearchValue: unknown): SyncStatus {
    const mapping = syncMappingForSmartSearchKey(smartSearchKey);
    if (!mapping) return "unmapped";
    const webValue = getNestedValue(this.loadWebConfig(), mapping.webSearchJsonKey);
    const smartEmpty = smartSearchValue === undefined || smartSearchValue === null || smartSearchValue === "";
    const webEmpty = webValue === undefined || webValue === null || webValue === "";
    if (smartEmpty && webEmpty) return "synced";
    if (smartEmpty && !webEmpty) return "web-only";
    if (!smartEmpty && webEmpty) return "smart-only";
    return String(smartSearchValue) === String(webValue) ? "synced" : "conflict";
  }

  webValueForKey(smartSearchKey: string): unknown {
    const mapping = syncMappingForSmartSearchKey(smartSearchKey);
    if (!mapping) return undefined;
    return getNestedValue(this.loadWebConfig(), mapping.webSearchJsonKey);
  }

  pushToWebConfig(smartSearchConfig: SmartSearchConfig): void {
    const web = { ...this.loadWebConfig() };
    for (const mapping of WEB_ACCESS_SYNC_MAPPINGS) {
      const value = smartSearchConfig[mapping.smartSearchKey];
      if (value !== undefined && value !== null && value !== "") {
        setNestedValue(web, mapping.webSearchJsonKey, value);
      }
    }
    const dir = dirname(this.webSearchJsonPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temporaryPath = join(dir, `.web-search.json.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, JSON.stringify(web, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.webSearchJsonPath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
    this.webConfig = web;
    // Drop every memoized provider view of web-search.json so the next tool
    // call resolves credentials/endpoints from the file we just wrote.
    invalidateWebConfigCaches();
  }
}

// 同步状态标签：glyph + 文本（规范 ui-conventions-004：状态 MUST 同时使用稳定
// glyph 与文本，颜色只能增强语义）。不用裸 ✓/⚠，避免被误认成可勾选的复选框。
const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  synced: "✓ synced",
  conflict: "⚠ conflict",
  "smart-only": "→ smart-only",
  "web-only": "← web-only",
  unmapped: "",
};

const SYNC_STATUS_TONE: Record<SyncStatus, string> = {
  synced: "success",
  conflict: "warning",
  "smart-only": "dim",
  "web-only": "accent",
  unmapped: "dim",
};

export interface SmartSearchConfigOverlayParams {
  config: SmartSearchConfig;
  store: SmartSearchConfigStoreLike;
  theme: SmartSearchConfigTheme;
  requestRender: () => void;
  close: () => void;
  initialKey?: string;
  sync?: WebAccessConfigSyncLike;
}

type OverlayMode = "list" | "edit";
type StatusTone = "dim" | "success" | "warning" | "error";

const CTRL_U = "\x15";
const CTRL_S = "\x13";
const MAX_VISIBLE_ITEMS = 10;

// 编辑模式下忽略的导航/编辑/功能键：其转义序列（如 `\x1b[A`）若被当作文本追加，
// sanitize 后会把 `[A`、`[3~` 之类残渣混入输入（例如编辑文本字段按方向键出现乱码）。
const IGNORED_EDIT_KEYS: readonly KeyId[] = [
  Key.up, Key.down, Key.left, Key.right,
  Key.home, Key.end, Key.pageUp, Key.pageDown,
  Key.delete, Key.insert, Key.clear,
  Key.f1, Key.f2, Key.f3, Key.f4, Key.f5, Key.f6,
  Key.f7, Key.f8, Key.f9, Key.f10, Key.f11, Key.f12,
];

type ConfigSource = "smart-search" | "web-access";

export class SmartSearchConfigOverlay implements Component, Focusable {
  focused = false;
  private config: SmartSearchConfig;
  private readonly keys: string[];
  private selected = 0;
  private query = "";
  private mode: OverlayMode = "list";
  private draft = "";
  private unsetDraft = false;
  private saving = false;
  private status = "";
  private statusTone: StatusTone = "dim";
  private lastWidth = 80;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private configSource: ConfigSource = "smart-search";
  private readonly sync: WebAccessConfigSyncLike | undefined;

  constructor(private readonly params: SmartSearchConfigOverlayParams) {
    this.config = { ...params.config };
    this.sync = params.sync;
    const known = new Set<string>(ALL_CONFIG_KEYS);
    const unknown = Object.keys(this.config).filter((key) => !known.has(key)).sort();
    this.keys = [...ALL_CONFIG_KEYS, ...unknown];
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
    const key = this.currentKey() ?? "";
    const rows = [
      truncateToWidth(this.params.theme.bold("Smart Search configuration"), inner, "…"),
      this.params.theme.fg("dim", "─".repeat(inner)),
    ];
    if (this.mode === "edit") {
      const secret = isSmartSearchSecretKey(key);
      const credentialHint = credentialSourceHint(this.draft);
      const renderedDraft = this.unsetDraft
        ? this.params.theme.fg("warning", "unset key on save")
        : credentialHint
          ? this.params.theme.fg("accent", this.draft) + " " + this.params.theme.fg("dim", credentialHint)
          : secret && this.draft ? maskSmartSearchSecret(this.draft) : this.draft;
      rows.push(truncateToWidth(this.params.theme.fg("accent", key), inner, "…"));
      rows.push(truncateToWidth(`> ${renderedDraft || this.params.theme.fg("dim", secret ? "type replacement secret" : "empty value")}`, inner, "…"));
      rows.push(truncateToWidth(
        this.params.theme.fg("dim", this.saving ? "Saving…" : "Enter save · Esc back · Ctrl+U clear · Backspace delete"),
        inner,
        "…",
      ));
    } else {
      const filteredKeys = this.filteredKeys();
      const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_VISIBLE_ITEMS / 2), filteredKeys.length - MAX_VISIBLE_ITEMS));
      const visibleKeys = filteredKeys.slice(start, start + MAX_VISIBLE_ITEMS);
      const sourceLabel = this.configSource === "smart-search" ? "Smart Search" : "web-access";
      rows.push(truncateToWidth(
        this.params.theme.fg("dim", `Filter: ${this.query || "all keys"} · ${filteredKeys.length}/${this.keys.length} · ${sourceLabel}`),
        inner,
        "…",
      ));
      if (visibleKeys.length === 0) {
        rows.push(truncateToWidth(this.params.theme.fg("warning", "No matching configuration keys"), inner, "…"));
      }
      for (let offset = 0; offset < visibleKeys.length; offset++) {
        const itemKey = visibleKeys[offset];
        const marker = start + offset === this.selected ? "›" : " ";
        const group = configGroupForKey(itemKey);
        const syncTag = this.renderSyncTag(itemKey);
        const value = this.configSource === "web-access" && this.sync
          ? displaySmartSearchConfigValue(itemKey, this.sync.webValueForKey(itemKey))
          : displaySmartSearchConfigValue(itemKey, this.config[itemKey]);
        const line = `${marker} [${group?.label ?? "Custom"}] ${itemKey} = ${value}${syncTag}`;
        rows.push(truncateToWidth(
          start + offset === this.selected ? this.params.theme.fg("accent", line) : line,
          inner,
          "…",
        ));
      }
      rows.push(truncateToWidth(
        this.params.theme.fg("dim", "Type provider/capability/key · PgUp/PgDn · Enter edit · Tab source · Ctrl+S sync · Esc"),
        inner,
        "…",
      ));
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
      if (this.lastWidth < 20) return;
      if (this.mode === "edit") {
        this.draft += token.text;
        this.unsetDraft = false;
      } else {
        this.query += token.text;
        this.selected = 0;
      }
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
      if (this.query) {
        this.query = "";
        this.selected = 0;
        this.status = "Filter cleared";
        this.statusTone = "dim";
        return;
      }
      this.params.close();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.configSource = this.configSource === "smart-search" ? "web-access" : "smart-search";
      this.status = `Source: ${this.configSource === "smart-search" ? "Smart Search config" : "web-search.json"}`;
      this.statusTone = "dim";
      return;
    }
    if (data === CTRL_S) {
      this.performSync();
      return;
    }
    const length = this.filteredKeys().length;
    if (matchesKey(data, Key.up)) this.selected = wrapIndex(this.selected - 1, length);
    else if (matchesKey(data, Key.down)) this.selected = wrapIndex(this.selected + 1, length);
    else if (matchesKey(data, Key.pageUp)) this.selected = clampIndex(this.selected - MAX_VISIBLE_ITEMS, length);
    else if (matchesKey(data, Key.pageDown)) this.selected = clampIndex(this.selected + MAX_VISIBLE_ITEMS, length);
    else if (isHomeKey(data)) this.selected = 0;
    else if (isEndKey(data)) this.selected = Math.max(0, length - 1);
    else if (matchesKey(data, Key.enter)) this.beginEdit();
    else if (matchesKey(data, Key.backspace) || data === "\b") {
      this.query = removeLastGrapheme(this.query);
      this.selected = 0;
    } else if (data === CTRL_U) {
      this.query = "";
      this.selected = 0;
    } else if (!data.startsWith("\x1b")) {
      // 忽略导航/功能键转义序列，避免残渣混入筛选文本。
      const printable = sanitizeSingleLineInput(data);
      if (!printable) return;
      this.query += printable;
      this.selected = 0;
    }
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
    if (matchesKey(data, Key.backspace) || data === "\b") {
      this.draft = removeLastGrapheme(this.draft);
      this.status = "";
      return;
    }
    // 忽略导航/功能键，避免转义序列残渣混入文本。
    if (IGNORED_EDIT_KEYS.some((key) => matchesKey(data, key))) return;
    // 兜底：丢弃以 ESC 开头的未识别序列（拆分到达的 CSI/SS3 残渣）。
    if (data.startsWith("\x1b")) return;
    const printable = sanitizeSingleLineInput(data);
    if (!printable) return;
    this.draft += printable;
    this.unsetDraft = false;
    this.status = "";
  }

  private beginEdit(): void {
    const key = this.currentKey();
    if (!key) {
      this.status = "No matching configuration key";
      this.statusTone = "warning";
      return;
    }
    const current = this.config[key];
    this.mode = "edit";
    this.draft = isSmartSearchSecretKey(key) ? "" : current === undefined || current === null ? "" : String(current);
    this.unsetDraft = false;
  }

  private async saveDraft(): Promise<void> {
    const key = this.currentKey();
    if (!key) return;
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

  private filteredKeys(): string[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.keys;
    return this.keys.filter((key) => {
      const group = configGroupForKey(key);
      const haystack = [key, group?.id, group?.label, group?.capability, ...(group?.aliases ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private renderSyncTag(key: string): string {
    if (!this.sync) return "";
    const status = this.sync.syncStatusForKey(key, this.config[key]);
    if (status === "unmapped") return "";
    const label = SYNC_STATUS_LABEL[status];
    const tone = SYNC_STATUS_TONE[status];
    return ` ${this.params.theme.fg(tone, label)}`;
  }

  private performSync(): void {
    if (!this.sync) {
      this.status = "Sync not available";
      this.statusTone = "warning";
      return;
    }
    try {
      this.sync.pushToWebConfig(this.config);
      this.status = "Synced Smart Search → web-search.json";
      this.statusTone = "success";
    } catch (error) {
      this.status = `Sync failed · ${errorMessage(error)}`;
      this.statusTone = "error";
    }
  }

  private currentKey(): string | undefined {
    return this.filteredKeys()[this.selected];
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
  sync?: WebAccessConfigSyncLike,
): Promise<void> {
  if (!ctx.hasUI) return;
  const config = await store.load();
  const resolvedSync = sync ?? new WebAccessConfigSync();
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const overlay = new SmartSearchConfigOverlay({
      config,
      store,
      theme,
      requestRender: () => tui.requestRender(),
      close: () => done(undefined),
      sync: resolvedSync,
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

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function isHomeKey(data: string): boolean {
  return data === "\x1b[H" || data === "\x1bOH" || data === "\x1b[1~";
}

function isEndKey(data: string): boolean {
  return data === "\x1b[F" || data === "\x1bOF" || data === "\x1b[4~";
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

function credentialSourceHint(value: string): string | undefined {
  if (!value) return undefined;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return "(env var)";
  if (value.startsWith("!")) return "(shell command)";
  return undefined;
}
