import {
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

export interface MarkdownReviewTurnItem {
  /** 1-based turn 序号。 */
  index: number;
  role: "user" | "assistant";
  /** 列表预览行（首行非空文本）。 */
  preview: string;
  /** 完整 markdown 文本（右侧预览渲染用）。 */
  text: string;
}

export type MarkdownReviewOverlayAction =
  | { kind: "close" }
  | { kind: "export"; turnIndexes: number[] };

export interface MarkdownReviewOverlayParams {
  turns: readonly MarkdownReviewTurnItem[];
  theme: {
    fg(name: string, text: string): string;
    bold(text: string): string;
  };
  requestRender: () => void;
  done: (action: MarkdownReviewOverlayAction) => void;
}

const MAX_LIST_VISIBLE = 10;
const PREVIEW_VISIBLE = 14;

/** 与 plan-confirm 的 markdownTheme 同构，避免依赖未导出的内部函数。 */
export function reviewMarkdownTheme(theme: MarkdownReviewOverlayParams["theme"]): MarkdownTheme {
  return {
    heading: (text) => theme.fg("accent", theme.bold(text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => text,
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: (text) => text,
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => text,
  };
}

/**
 * 多选 turn 列表 + 右侧 Markdown 预览。所有 turn 默认全选；
 * Space 勾选/取消，a 全选，n 清空，e 导出，Esc 关闭。
 */
export class MarkdownReviewOverlay implements Component, Focusable {
  focused = false;
  private selected = 0;
  private selectedIndexes = new Set<number>();
  private previewScroll = 0;

  constructor(private readonly params: MarkdownReviewOverlayParams) {
    for (const turn of params.turns) this.selectedIndexes.add(turn.index);
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const inner = safeWidth - 2;
    const hasPreview = safeWidth >= 76;
    const listWidth = hasPreview ? Math.min(38, Math.floor(inner * 0.4)) : inner;
    const previewWidth = hasPreview ? inner - listWidth - 1 : 0;

    const entries = this.params.turns;
    const start = visibleStart(this.selected, entries.length, MAX_LIST_VISIBLE);
    const listRows = entries.slice(start, start + MAX_LIST_VISIBLE).map((turn, offset) => {
      const isSelectedRow = start + offset === this.selected;
      const cursor = isSelectedRow ? this.params.theme.fg("accent", "›") : " ";
      const checked = this.selectedIndexes.has(turn.index) ? "✓" : " ";
      const role = turn.role === "user" ? "U" : "A";
      const label = isSelectedRow
        ? this.params.theme.bold(`#${turn.index} ${role} ${turn.preview}`)
        : `#${turn.index} ${role} ${turn.preview}`;
      return fitLine(`${cursor} [${checked}] ${label}`, listWidth);
    });

    const rows: string[] = [
      fitLine(`${this.params.theme.bold("Markdown Review")} · ${entries.length} turns · ${this.selectedIndexes.size} 已选`, inner),
      rule(inner),
    ];

    if (entries.length === 0) {
      rows.push(this.params.theme.fg("warning", fitLine("没有可 Review 的 turn", inner)));
    } else {
      if (hasPreview) {
        rows.push(...listRows);
      } else {
        rows.push(...listRows);
      }
      if (entries.length > MAX_LIST_VISIBLE) {
        rows.push(this.params.theme.fg("dim", fitLine(`↑↓ 滚动 · 显示 ${start + 1}-${Math.min(entries.length, start + MAX_LIST_VISIBLE)}/${entries.length}`, inner)));
      }
    }

    if (hasPreview && entries.length > 0) {
      const previewTurn = entries[this.selected];
      rows.push(rule(inner));
      rows.push(...this.renderPreviewPane(previewTurn!, previewWidth));
    }

    rows.push(rule(inner));
    rows.push(fitLine("Space 勾选 · a 全选 · n 清空 · e 导出 · ↑↓ 选择 · Esc 关闭", inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  private renderPreviewPane(turn: MarkdownReviewTurnItem, width: number): string[] {
    const inner = Math.max(1, width);
    const header = fitLine(`${this.params.theme.bold(`预览 · Turn ${turn.index} ${turn.role === "user" ? "User" : "Assistant"}`)}`, inner);
    const markdown = new Markdown(turn.text, 0, 0, reviewMarkdownTheme(this.params.theme));
    const rendered = markdown.render(inner);
    const maxScroll = Math.max(0, rendered.length - PREVIEW_VISIBLE);
    this.previewScroll = Math.min(Math.max(0, this.previewScroll), maxScroll);
    const end = Math.min(rendered.length, this.previewScroll + PREVIEW_VISIBLE);
    const body = rendered.slice(this.previewScroll, end).map((line) => fitLine(line, inner));
    while (body.length < PREVIEW_VISIBLE) body.push("");
    const footer = rendered.length > PREVIEW_VISIBLE
      ? this.params.theme.fg("dim", fitLine(`行 ${this.previewScroll + 1}-${end}/${rendered.length} · PgUp/PgDn 滚动`, inner))
      : this.params.theme.fg("dim", fitLine(`${rendered.length} 行`, inner));
    return [header, ...body, footer];
  }

  handleInput(data: string): void {
    const entries = this.params.turns;
    if (entries.length === 0) {
      if (matchesKey(data, Key.escape)) this.finishClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = wrapIndex(this.selected - 1, entries.length);
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.down)) {
      this.selected = wrapIndex(this.selected + 1, entries.length);
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.pageUp)) {
      this.previewScroll = Math.max(0, this.previewScroll - PREVIEW_VISIBLE);
    } else if (matchesKey(data, Key.pageDown)) {
      this.previewScroll += PREVIEW_VISIBLE;
    } else if (data === " " || data === "\u0020") {
      this.toggleSelected(entries[this.selected]!.index);
    } else if (data === "a" || data === "A") {
      for (const turn of entries) this.selectedIndexes.add(turn.index);
    } else if (data === "n" || data === "N") {
      this.selectedIndexes.clear();
    } else if (data === "e" || data === "E") {
      this.finishExport();
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.finishClose();
      return;
    }
    this.params.requestRender();
  }

  private toggleSelected(index: number): void {
    if (this.selectedIndexes.has(index)) this.selectedIndexes.delete(index);
    else this.selectedIndexes.add(index);
  }

  private finishExport(): void {
    const indexes = [...this.selectedIndexes].sort((a, b) => a - b);
    const turnIndexes = indexes.length > 0
      ? indexes
      : [this.params.turns[this.selected]?.index].filter((index): index is number => index !== undefined);
    this.params.done({ kind: "export", turnIndexes });
  }

  private finishClose(): void {
    this.params.done({ kind: "close" });
  }
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index % length + length) % length;
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme: MarkdownReviewOverlayParams["theme"]): string[] {
  if (width < 2) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    theme.fg("dim", `┌${"─".repeat(inner)}┐`),
    ...rows.map((row) => {
      const fitted = fitLine(row, inner);
      return `${theme.fg("dim", "│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${theme.fg("dim", "│")}`;
    }),
    theme.fg("dim", `└${'─'.repeat(inner)}┘`),
  ];
}
