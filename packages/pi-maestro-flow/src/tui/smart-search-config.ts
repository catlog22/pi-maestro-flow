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
} from "@earendil-works/pi-tui";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
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
interface SmartSearchConfigTheme extends FrameTheme {}

export interface SmartSearchConfigStoreLike {
  load(): Promise<SmartSearchConfig>;
  save(patch: Record<string, unknown | undefined>): Promise<SmartSearchConfig>;
}

const CATALOGS = {
  en: {
    "appName": "Smart Search",
    "title": "Smart Search configuration",
    "group.custom": "Custom",
    "source.smartSearch": "Smart Search",
    "source.webAccess": "web-access",
    "state.saving": "Saving…",
    "edit.unsetHint": "unset key on save",
    "edit.envVar": "(env var)",
    "edit.shellCommand": "(shell command)",
    "edit.secretPlaceholder": "type replacement secret",
    "edit.emptyPlaceholder": "empty value",
    "filter.line": "Filter: {query} · {count}/{total} · {source}",
    "filter.allKeys": "all keys",
    "footer.escBack": "Esc back",
    "footer.escClose": "Esc close",
    "footer.editHelp": "Enter save · Esc back · Ctrl+U clear · Backspace delete",
    "footer.listHelp": "Type provider/capability/key · PgUp/PgDn · Enter edit · Tab source · Ctrl+S sync · Esc",
    "notice.noMatchKeys": "No matching configuration keys",
    "notice.noMatchKey": "No matching configuration key",
    "notice.filterCleared": "Filter cleared",
    "notice.source": "Source: {name}",
    "notice.sourceSmartSearch": "Smart Search config",
    "notice.sourceWebSearch": "web-search.json",
    "notice.unsetOnSave": "Unset {key} on save",
    "notice.secretUnchanged": "Secret unchanged",
    "notice.savingKey": "Saving {key}…",
    "notice.saved": "Saved · {key}",
    "notice.saveFailed": "Save failed",
    "notice.syncUnavailable": "Sync not available",
    "notice.synced": "Synced Smart Search → web-search.json",
    "notice.syncFailed": "Sync failed",
    "sync.synced": "✓ synced",
    "sync.conflict": "⚠ conflict",
    "sync.smartOnly": "→ smart-only",
    "sync.webOnly": "← web-only",
    "sync.unmapped": "",
  },
  "zh-CN": {
    "appName": "Smart Search",
    "title": "Smart Search 配置",
    "group.custom": "自定义",
    "source.smartSearch": "Smart Search",
    "source.webAccess": "web-access",
    "state.saving": "… 正在保存",
    "edit.unsetHint": "保存时移除该键",
    "edit.envVar": "(环境变量)",
    "edit.shellCommand": "(Shell 命令)",
    "edit.secretPlaceholder": "输入替换密钥",
    "edit.emptyPlaceholder": "空值",
    "filter.line": "筛选：{query} · {count}/{total} · {source}",
    "filter.allKeys": "全部键",
    "footer.escBack": "Esc 返回",
    "footer.escClose": "Esc 关闭",
    "footer.editHelp": "Enter 保存 · Esc 返回 · Ctrl+U 清空 · Backspace 删除",
    "footer.listHelp": "输入 provider/能力/键 · PgUp/PgDn · Enter 编辑 · Tab 切换来源 · Ctrl+S 同步 · Esc",
    "notice.noMatchKeys": "没有匹配的配置键",
    "notice.noMatchKey": "没有匹配的配置键",
    "notice.filterCleared": "已清除筛选",
    "notice.source": "来源：{name}",
    "notice.sourceSmartSearch": "Smart Search 配置",
    "notice.sourceWebSearch": "web-search.json",
    "notice.unsetOnSave": "保存时移除 {key}",
    "notice.secretUnchanged": "密钥未变更",
    "notice.savingKey": "正在保存 {key}…",
    "notice.saved": "已保存 · {key}",
    "notice.saveFailed": "保存失败",
    "notice.syncUnavailable": "同步不可用",
    "notice.synced": "已同步 Smart Search → web-search.json",
    "notice.syncFailed": "同步失败",
    "sync.synced": "✓ 已同步",
    "sync.conflict": "⚠ 冲突",
    "sync.smartOnly": "→ 仅 Smart Search",
    "sync.webOnly": "← 仅 web-search",
    "sync.unmapped": "",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["zh-CN"];

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

// 同步状态标签走目录文案（glyph + 文本，规范 ui-conventions-004：状态 MUST 同时
// 使用稳定 glyph 与文本，颜色只能增强语义）；不用裸 ✓/⚠，避免被误认成可勾选的复选框。
const SYNC_STATUS_KEY: Record<SyncStatus, CatalogKey> = {
  synced: "sync.synced",
  conflict: "sync.conflict",
  "smart-only": "sync.smartOnly",
  "web-only": "sync.webOnly",
  unmapped: "sync.unmapped",
};

const SYNC_STATUS_TONE: Record<SyncStatus, StatusTone> = {
  synced: "success",
  conflict: "warning",
  "smart-only": "dim",
  "web-only": "dim",
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
  /** UI language; defaults to en. */
  locale?: SupportedSettingsLocale;
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
  private readonly locale: SupportedSettingsLocale;
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
    this.locale = params.locale ?? "en";
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

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const catalog = CATALOGS[this.locale] ?? CATALOGS["en"];
    const template: unknown = catalog[key];
    const text = typeof template === "string" ? template : CATALOGS["en"][key] as string;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.lastWidth = safeWidth;
    if (safeWidth < 20) {
      const action = this.mode === "edit" ? this.t("footer.escBack") : this.t("footer.escClose");
      return [fit(`${this.t("appName")} · ${action}`, safeWidth)];
    }

    const inner = Math.max(1, safeWidth - 2);
    const key = this.currentKey() ?? "";
    const rows = [
      headerLine(this.params.theme, this.t("title"), [], inner),
      rule(inner),
    ];
    if (this.mode === "edit") {
      const secret = isSmartSearchSecretKey(key);
      const credentialHint = this.credentialSourceHint(this.draft);
      const renderedDraft = this.unsetDraft
        ? this.params.theme.fg("warning", this.t("edit.unsetHint"))
        : credentialHint
          ? this.params.theme.fg("accent", this.draft) + " " + this.params.theme.fg("dim", credentialHint)
          : secret && this.draft ? maskSmartSearchSecret(this.draft) : this.draft;
      rows.push(fit(this.params.theme.fg("accent", key), inner));
      rows.push(fit(`> ${renderedDraft || this.params.theme.fg("dim", secret ? this.t("edit.secretPlaceholder") : this.t("edit.emptyPlaceholder"))}`, inner));
      rows.push(helpLine(this.params.theme, this.saving ? this.t("state.saving") : this.t("footer.editHelp"), inner));
    } else {
      const filteredKeys = this.filteredKeys();
      const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_VISIBLE_ITEMS / 2), filteredKeys.length - MAX_VISIBLE_ITEMS));
      const visibleKeys = filteredKeys.slice(start, start + MAX_VISIBLE_ITEMS);
      const sourceLabel = this.configSource === "smart-search" ? this.t("source.smartSearch") : this.t("source.webAccess");
      rows.push(helpLine(this.params.theme, this.t("filter.line", {
        query: this.query || this.t("filter.allKeys"),
        count: filteredKeys.length,
        total: this.keys.length,
        source: sourceLabel,
      }), inner));
      if (visibleKeys.length === 0) {
        rows.push(this.params.theme.fg("warning", fit(this.t("notice.noMatchKeys"), inner)));
      }
      for (let offset = 0; offset < visibleKeys.length; offset++) {
        const itemKey = visibleKeys[offset];
        const marker = start + offset === this.selected ? "›" : " ";
        const group = configGroupForKey(itemKey);
        const syncTag = this.renderSyncTag(itemKey);
        const value = this.configSource === "web-access" && this.sync
          ? displaySmartSearchConfigValue(itemKey, this.sync.webValueForKey(itemKey))
          : displaySmartSearchConfigValue(itemKey, this.config[itemKey]);
        const line = `${marker} [${group?.label ?? this.t("group.custom")}] ${itemKey} = ${value}${syncTag}`;
        rows.push(fit(
          start + offset === this.selected ? this.params.theme.fg("accent", line) : line,
          inner,
        ));
      }
      rows.push(helpLine(this.params.theme, this.t("footer.listHelp"), inner));
    }
    if (this.status) rows.push(fit(this.params.theme.fg(this.statusTone, this.status), inner));
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
        this.status = this.t("notice.filterCleared");
        this.statusTone = "dim";
        return;
      }
      this.params.close();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.configSource = this.configSource === "smart-search" ? "web-access" : "smart-search";
      this.status = this.t("notice.source", {
        name: this.configSource === "smart-search" ? this.t("notice.sourceSmartSearch") : this.t("notice.sourceWebSearch"),
      });
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
      this.status = this.t("notice.unsetOnSave", { key: this.currentKey() });
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
      this.status = this.t("notice.noMatchKey");
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
      this.status = this.t("notice.secretUnchanged");
      this.statusTone = "dim";
      this.params.requestRender();
      return;
    }
    this.saving = true;
    this.status = this.t("notice.savingKey", { key });
    this.statusTone = "dim";
    this.params.requestRender();
    try {
      this.config = await this.params.store.save({ [key]: this.unsetDraft ? undefined : this.draft });
      this.saving = false;
      this.mode = "list";
      this.draft = "";
      this.unsetDraft = false;
      this.status = this.t("notice.saved", { key });
      this.statusTone = "success";
    } catch (error) {
      this.saving = false;
      this.status = `${this.t("notice.saveFailed")} · ${errorMessage(error)}`;
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
    const label = this.t(SYNC_STATUS_KEY[status]);
    const tone = SYNC_STATUS_TONE[status];
    return ` ${this.params.theme.fg(tone, label)}`;
  }

  private credentialSourceHint(value: string): string | undefined {
    if (!value) return undefined;
    if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return this.t("edit.envVar");
    if (value.startsWith("!")) return this.t("edit.shellCommand");
    return undefined;
  }

  private performSync(): void {
    if (!this.sync) {
      this.status = this.t("notice.syncUnavailable");
      this.statusTone = "warning";
      return;
    }
    try {
      this.sync.pushToWebConfig(this.config);
      this.status = this.t("notice.synced");
      this.statusTone = "success";
    } catch (error) {
      this.status = `${this.t("notice.syncFailed")} · ${errorMessage(error)}`;
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
