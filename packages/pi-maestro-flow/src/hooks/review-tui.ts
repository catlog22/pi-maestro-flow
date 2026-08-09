import {
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
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
import { getTuiLocale } from "../tui/locale.ts";
import { sanitizeHookDisplayText, type HookReviewEntry } from "./review.ts";

export type HookReviewActionKind = "close" | "toggle" | "toggle-trust" | "install";

export interface HookReviewUiState {
  query: string;
  selectedId?: string;
}

export interface HookReviewAction {
  kind: HookReviewActionKind;
  hookId?: string;
  uiState: HookReviewUiState;
}

export interface HookReviewOverlayParams {
  entries: readonly HookReviewEntry[];
  trusted: boolean;
  configPath: string;
  hash: string;
  theme: FrameTheme;
  notice?: string;
  initialState?: Partial<HookReviewUiState>;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
  requestRender: () => void;
  done: (action: HookReviewAction) => void;
}

const MAX_VISIBLE = 10;
const DETAIL_VISIBLE = 12;

const CATALOGS = {
  en: {
    "title": "Hook Review",
    "state.trusted": "● Trusted",
    "state.untrusted": "○ Untrusted",
    "state.enabledCount": "enabled",
    "state.enabled": "● Enabled",
    "state.disabled": "○ Disabled",
    "entry.unsupported": "△ Unsupported",
    "entry.noMatch": "○ No matching Hooks",
    "filter.active": "Filtering: {query} · Esc cancel",
    "filter.placeholder": "type an event, matcher or command",
    "filter.inactive": "Filter: press / and type keywords",
    "filter.showCount": "showing {count}",
    "footer.main": "Esc close · ↑↓ select · Enter detail · / filter · Space toggle · T trust/revoke · I install",
    "footer.detail": "Esc back · ↑↓/PgUp/PgDn scroll",
    "detail.title": "Hook Command Detail",
    "detail.lines": "Lines {start}-{end}/{total}",
    "detail.empty": "Esc · Hook · nothing to review",
    "detail.emptyCommand": "(empty command)",
    "detail.truncatedHint": "Command truncated · Enter to view all",
    "compact.prefix": "Esc · Hook {state} · {entry}",
    "compact.state.trusted": "Trusted",
    "compact.state.untrusted": "Untrusted",
    "compact.entryOn": "On",
    "compact.entryOff": "Off",
    "compact.noEntry": "no Hooks",
  },
  "zh-CN": {
    "title": "Hook 审查",
    "state.trusted": "● 已信任",
    "state.untrusted": "○ 未信任",
    "state.enabledCount": "启用",
    "state.enabled": "● 启用",
    "state.disabled": "○ 停用",
    "entry.unsupported": "△ 不支持",
    "entry.noMatch": "○ 没有匹配的 Hook",
    "filter.active": "筛选中：{query} · Esc 取消",
    "filter.placeholder": "输入事件、匹配器或命令",
    "filter.inactive": "筛选：按 / 输入关键词",
    "filter.showCount": "显示 {count} 个",
    "footer.main": "Esc 关闭 · ↑↓ 选择 · Enter 详情 · / 筛选 · Space 开关 · T 信任/撤销 · I 安装",
    "footer.detail": "Esc 返回 · ↑↓/PgUp/PgDn 滚动",
    "detail.title": "Hook 命令详情",
    "detail.lines": "行 {start}-{end}/{total}",
    "detail.empty": "Esc · Hook · 没有可审查项",
    "detail.emptyCommand": "(empty command)",
    "detail.truncatedHint": "命令未完整显示 · Enter 查看全部",
    "compact.prefix": "Esc · Hook {state} · {entry}",
    "compact.state.trusted": "已信任",
    "compact.state.untrusted": "未信任",
    "compact.entryOn": "开",
    "compact.entryOff": "关",
    "compact.noEntry": "没有 Hook",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

export class HookReviewOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private query: string;
  private selected = 0;
  private filterActive = false;
  private detailMode = false;
  private detailScroll = 0;
  private detailLineCount = 0;
  private detailVisibleCount = DETAIL_VISIBLE;

  constructor(private readonly params: HookReviewOverlayParams) {
    this.locale = getTuiLocale(params.locale);
    this.query = params.initialState?.query ?? "";
    const selectedId = params.initialState?.selectedId;
    if (selectedId) {
      const index = this.filteredEntries().findIndex((entry) => entry.id === selectedId);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const catalog = CATALOGS[this.locale] ?? CATALOGS.en;
    const template: unknown = catalog[key];
    const text = typeof template === "string" ? template : CATALOGS.en[key] as string;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.selected = clampIndex(this.selected, this.filteredEntries().length);
    if (this.detailMode) return this.renderDetail(safeWidth);
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];

    const inner = safeWidth - 2;
    const entries = this.filteredEntries();
    const enabled = this.params.entries.filter((entry) => entry.enabled).length;
    const rows = [
      headerLine(this.params.theme, this.t("title"), [
        this.params.trusted ? this.t("state.trusted") : this.t("state.untrusted"),
        `${enabled}/${this.params.entries.length} ${this.t("state.enabledCount")}`,
      ], inner),
      rule(inner),
      ...this.entryRows(entries, inner),
      this.filterLine(inner, entries.length),
    ];
    const selected = this.selectedEntry();
    if (selected) {
      rows.push(rule(inner));
      rows.push(helpLine(this.params.theme,
        `${selected.event}${selected.matcher ? ` [${selected.matcher}]` : ""} · ${selected.type}${selected.timeout ? ` · ${selected.timeout}s` : ""}`,
        inner,
      ));
      rows.push(fit(selected.command, inner));
      if (visibleWidth(selected.command) > inner) {
        rows.push(helpLine(this.params.theme, this.t("detail.truncatedHint"), inner));
      }
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fit(this.t("footer.main"), inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.detailMode) {
      if (matchesKey(data, Key.escape)) {
        this.detailMode = false;
        this.detailScroll = 0;
        this.params.requestRender();
        return;
      }
      if (matchesKey(data, Key.up)) return this.moveDetail(-1);
      if (matchesKey(data, Key.down)) return this.moveDetail(1);
      if (matchesKey(data, Key.pageUp)) return this.moveDetail(-this.detailVisibleCount);
      if (matchesKey(data, Key.pageDown)) return this.moveDetail(this.detailVisibleCount);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.filterActive) {
        this.filterActive = false;
        this.query = "";
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      this.finish("close");
      return;
    }
    if (this.filterActive) {
      if (matchesKey(data, Key.up)) return this.move(-1);
      if (matchesKey(data, Key.down)) return this.move(1);
      if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE);
      if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE);
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
        this.query = removeLastGrapheme(this.query);
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      // 忽略导航/功能键，避免转义序列残渣混入筛选文本。
      if (data.startsWith("\x1b")) return;
      const printable = sanitizeSingleLineInput(data);
      if (!printable) return;
      this.query += printable;
      this.selected = 0;
      this.params.requestRender();
      return;
    }

    if (data === "/") {
      this.filterActive = true;
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE);
    if (data === "q" || data === "Q") return this.finish("close");
    if (data === "i" || data === "I") return this.finish("install");
    if (data === "t" || data === "T") {
      return this.finish("toggle-trust");
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (this.selectedEntry()) {
        this.detailMode = true;
        this.detailScroll = 0;
        this.params.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") {
      const selected = this.selectedEntry();
      if (selected?.supported) this.finish("toggle");
    }
  }

  private renderDetail(width: number): string[] {
    const selected = this.selectedEntry();
    if (!selected) {
      this.detailMode = false;
      return [fit(this.t("detail.empty"), width)];
    }
    const framed = width >= 2;
    const inner = framed ? width - 2 : width;
    const commandLines = wrapTextWithAnsi(selected.command || this.t("detail.emptyCommand"), Math.max(1, inner));
    this.detailVisibleCount = width < 20 ? 1 : DETAIL_VISIBLE;
    this.detailLineCount = commandLines.length;
    const maxScroll = Math.max(0, this.detailLineCount - this.detailVisibleCount);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);
    const end = Math.min(this.detailLineCount, this.detailScroll + this.detailVisibleCount);
    const rows = [
      headerLine(this.params.theme, this.t("detail.title"), [
        selected.event,
        selected.enabled ? this.t("state.enabled") : this.t("state.disabled"),
      ], inner),
      helpLine(this.params.theme, this.t("detail.lines", {
        start: this.detailScroll + 1,
        end,
        total: this.detailLineCount,
      }), inner),
      rule(inner),
      ...commandLines.slice(this.detailScroll, end).map((line) => fit(line, inner)),
      rule(inner),
      fit(this.t("footer.detail"), inner),
    ];
    return framed ? frame(rows, width, this.params.theme) : rows.map((row) => fit(row, width));
  }

  private renderCompact(width: number): string {
    const selected = this.selectedEntry() ?? this.filteredEntries()[0];
    const state = this.params.trusted ? this.t("compact.state.trusted") : this.t("compact.state.untrusted");
    const entry = selected
      ? `${selected.enabled ? this.t("compact.entryOn") : this.t("compact.entryOff")} · ${selected.event} · ${selected.command}`
      : this.t("compact.noEntry");
    return fit(this.t("compact.prefix", { state, entry }), width);
  }

  private entryRows(entries: readonly HookReviewEntry[], width: number): string[] {
    if (entries.length === 0) return [this.params.theme.fg("warning", fit(this.t("entry.noMatch"), width))];
    const start = visibleStart(this.selected, entries.length, MAX_VISIBLE);
    return entries.slice(start, start + MAX_VISIBLE).map((entry, offset) => {
      const selected = start + offset === this.selected;
      const cursor = selected ? this.params.theme.fg("accent", "›") : " ";
      const state = !entry.supported
        ? this.params.theme.fg("warning", this.t("entry.unsupported"))
        : entry.enabled
          ? this.params.theme.fg("success", this.t("state.enabled"))
          : this.params.theme.fg("dim", this.t("state.disabled"));
      const event = selected ? this.params.theme.bold(entry.event) : entry.event;
      return fit(`${cursor} ${state} · ${event}${entry.matcher ? ` [${entry.matcher}]` : ""} · ${entry.command}`, width);
    });
  }

  private filterLine(width: number, count: number): string {
    const text = this.filterActive
      ? this.t("filter.active", { query: this.query || this.t("filter.placeholder") })
      : this.t("filter.inactive");
    return helpLine(this.params.theme, `${text} · ${this.t("filter.showCount", { count })}`, width);
  }

  private styledNotice(notice: string, width: number): string {
    const safeNotice = sanitizeHookDisplayText(notice);
    const role = /(失败|错误|failed|error)/i.test(safeNotice) ? "error"
      : /^(已信任|已撤销|已启用|已停用|Trusted|Revoked|Enabled|Disabled)/i.test(safeNotice) ? "success"
      : "warning";
    return this.params.theme.fg(role, fit(safeNotice, width));
  }

  private moveDetail(delta: number): void {
    const maxScroll = Math.max(0, this.detailLineCount - this.detailVisibleCount);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll + delta), maxScroll);
    this.params.requestRender();
  }

  private move(delta: number): void {
    this.selected = wrapIndex(this.selected + delta, this.filteredEntries().length);
    this.params.requestRender();
  }

  private filteredEntries(): HookReviewEntry[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...this.params.entries];
    return this.params.entries.filter((entry) => {
      const haystack = [entry.event, entry.matcher ?? "", entry.type, entry.command].join(" ").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private selectedEntry(): HookReviewEntry | undefined {
    return this.filteredEntries()[this.selected];
  }

  private finish(kind: HookReviewActionKind): void {
    const selected = this.selectedEntry();
    this.params.done({
      kind,
      ...(selected ? { hookId: selected.id } : {}),
      uiState: {
        query: this.query,
        ...(selected ? { selectedId: selected.id } : {}),
      },
    });
  }
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index % length + length) % length;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function removeLastGrapheme(value: string): string {
  const segments = graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : [...value];
  segments.pop();
  return segments.join("");
}

function sanitizeSingleLineInput(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t\x00-\x08\x0b-\x1f\x7f]/g, "");
}
