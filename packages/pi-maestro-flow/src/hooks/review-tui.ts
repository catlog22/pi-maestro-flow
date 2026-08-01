import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
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

interface HookReviewTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface HookReviewOverlayParams {
  entries: readonly HookReviewEntry[];
  trusted: boolean;
  configPath: string;
  hash: string;
  theme: HookReviewTheme;
  notice?: string;
  initialState?: Partial<HookReviewUiState>;
  requestRender: () => void;
  done: (action: HookReviewAction) => void;
}

const MAX_VISIBLE = 10;
const DETAIL_VISIBLE = 12;

export class HookReviewOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private selected = 0;
  private filterActive = false;
  private detailMode = false;
  private detailScroll = 0;
  private detailLineCount = 0;
  private detailVisibleCount = DETAIL_VISIBLE;

  constructor(private readonly params: HookReviewOverlayParams) {
    this.query = params.initialState?.query ?? "";
    const selectedId = params.initialState?.selectedId;
    if (selectedId) {
      const index = this.filteredEntries().findIndex((entry) => entry.id === selectedId);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.selected = clampIndex(this.selected, this.filteredEntries().length);
    if (this.detailMode) return this.renderDetail(safeWidth);
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];

    const inner = safeWidth - 2;
    const entries = this.filteredEntries();
    const enabled = this.params.entries.filter((entry) => entry.enabled).length;
    const rows = [
      fitLine(`${this.params.theme.bold("Hook 审查")} · ${this.params.trusted ? "● 已信任" : "○ 未信任"} · ${enabled}/${this.params.entries.length} 启用`, inner),
      rule(inner),
      ...this.entryRows(entries, inner),
      this.filterLine(inner, entries.length),
    ];
    const selected = this.selectedEntry();
    if (selected) {
      rows.push(rule(inner));
      rows.push(this.params.theme.fg("dim", fitLine(
        `${selected.event}${selected.matcher ? ` [${selected.matcher}]` : ""} · ${selected.type}${selected.timeout ? ` · ${selected.timeout}s` : ""}`,
        inner,
      )));
      rows.push(fitLine(selected.command, inner));
      if (visibleWidth(selected.command) > inner) {
        rows.push(this.params.theme.fg("dim", fitLine("命令未完整显示 · Enter 查看全部", inner)));
      }
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitLine("Esc 关闭 · ↑↓ 选择 · Enter 详情 · / 筛选 · Space 开关 · T 信任/撤销 · I 安装", inner));
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
      return [fitLine("Esc · Hook · 没有可审查项", width)];
    }
    const framed = width >= 2;
    const inner = framed ? width - 2 : width;
    const commandLines = wrapTextWithAnsi(selected.command || "(empty command)", Math.max(1, inner));
    this.detailVisibleCount = width < 20 ? 1 : DETAIL_VISIBLE;
    this.detailLineCount = commandLines.length;
    const maxScroll = Math.max(0, this.detailLineCount - this.detailVisibleCount);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);
    const end = Math.min(this.detailLineCount, this.detailScroll + this.detailVisibleCount);
    const rows = [
      fitLine(`${this.params.theme.bold("Hook 命令详情")} · ${selected.event} · ${selected.enabled ? "● 启用" : "○ 停用"}`, inner),
      this.params.theme.fg("dim", fitLine(`行 ${this.detailScroll + 1}-${end}/${this.detailLineCount}`, inner)),
      rule(inner),
      ...commandLines.slice(this.detailScroll, end).map((line) => fitLine(line, inner)),
      rule(inner),
      fitLine("Esc 返回 · ↑↓/PgUp/PgDn 滚动", inner),
    ];
    return framed ? frame(rows, width, this.params.theme) : rows.map((row) => fitLine(row, width));
  }

  private renderCompact(width: number): string {
    const selected = this.selectedEntry() ?? this.filteredEntries()[0];
    const state = this.params.trusted ? "已信任" : "未信任";
    const entry = selected
      ? `${selected.enabled ? "开" : "关"} · ${selected.event} · ${selected.command}`
      : "没有 Hook";
    return fitLine(`Esc · Hook ${state} · ${entry}`, width);
  }

  private entryRows(entries: readonly HookReviewEntry[], width: number): string[] {
    if (entries.length === 0) return [this.params.theme.fg("warning", fitLine("○ 没有匹配的 Hook", width))];
    const start = visibleStart(this.selected, entries.length, MAX_VISIBLE);
    return entries.slice(start, start + MAX_VISIBLE).map((entry, offset) => {
      const selected = start + offset === this.selected;
      const cursor = selected ? this.params.theme.fg("accent", "›") : " ";
      const state = !entry.supported
        ? this.params.theme.fg("warning", "△ 不支持")
        : entry.enabled
          ? this.params.theme.fg("success", "● 启用")
          : this.params.theme.fg("dim", "○ 停用");
      const event = selected ? this.params.theme.bold(entry.event) : entry.event;
      return fitLine(`${cursor} ${state} · ${event}${entry.matcher ? ` [${entry.matcher}]` : ""} · ${entry.command}`, width);
    });
  }

  private filterLine(width: number, count: number): string {
    const text = this.filterActive
      ? `筛选中：${this.query || "输入事件、匹配器或命令"} · Esc 取消`
      : "筛选：按 / 输入关键词";
    return this.params.theme.fg("dim", fitLine(`${text} · 显示 ${count} 个`, width));
  }

  private styledNotice(notice: string, width: number): string {
    const safeNotice = sanitizeHookDisplayText(notice);
    const role = /(失败|错误|failed|error)/i.test(safeNotice) ? "error"
      : /^(已信任|已撤销|已启用|已停用)/.test(safeNotice) ? "success"
      : "warning";
    return this.params.theme.fg(role, fitLine(safeNotice, width));
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

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme: HookReviewTheme): string[] {
  if (width < 2) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    theme.fg("dim", `┌${"─".repeat(inner)}┐`),
    ...rows.map((row) => {
      const fitted = fitLine(row, inner);
      return `${theme.fg("dim", "│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${theme.fg("dim", "│")}`;
    }),
    theme.fg("dim", `└${"─".repeat(inner)}┘`),
  ];
}
