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
const WIDE_THRESHOLD = 76;

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
 * 清除终端控制序列与危险控制字符（保留 \n \t），防止会话内容篡改终端渲染。
 */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC 序列
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI 序列
    .replace(/\x1b[()][0-9A-Za-z]/g, "") // 其他单字符转义
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // C0 控制（保留 \t\n）
    .replace(/\r/g, "");
}

/**
 * 多选 turn 列表 + 预览。宽屏（≥76）列表与预览并排；窄屏 Enter 切换全宽预览。
 * 所有 turn 默认全选；Space 勾选/取消，a 全选，n 清空，e 导出，Esc 关闭/返回。
 */
export class MarkdownReviewOverlay implements Component, Focusable {
  focused = false;
  private selected = 0;
  private selectedIndexes = new Set<number>();
  private previewScroll = 0;
  private previewMode = false;
  private status = "";
  /** handleInput 使用最近一次 render 的宽/窄状态，避免与终端列宽来源不一致。 */
  private lastWide = true;
  private readonly turns: MarkdownReviewTurnItem[];

  constructor(private readonly params: MarkdownReviewOverlayParams) {
    this.turns = params.turns.map((turn) => ({
      ...turn,
      preview: sanitizeTerminalText(turn.preview),
      text: sanitizeTerminalText(turn.text),
    }));
    for (const turn of this.turns) this.selectedIndexes.add(turn.index);
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const inner = safeWidth - 2;
    const wide = safeWidth >= WIDE_THRESHOLD;
    this.lastWide = wide;

    // 总行数预算：overlay maxHeight 90%，含边框/头部/规则/页脚/滚动指示/状态。
    const terminalRows = process.stdout?.rows ?? 30;
    const overlayMax = Math.max(8, Math.floor(terminalRows * 0.9));
    const scrollInfo = !wide && !this.previewMode && this.turns.length > MAX_LIST_VISIBLE;
    const fixedChrome = 2 + 2 + 1 + 1 + (scrollInfo ? 1 : 0) + (this.status ? 1 : 0); // 边框2 + 头部+首规则2 + 次规则+页脚2
    const contentBudget = Math.max(1, overlayMax - fixedChrome);
    const visibleCount = Math.max(1, Math.min(MAX_LIST_VISIBLE, contentBudget));

    const listWidth = wide ? Math.min(36, Math.floor(inner * 0.4)) : inner;
    const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;

    const entries = this.turns;
    const start = visibleStart(this.selected, entries.length, visibleCount);
    const listRows = entries.slice(start, start + visibleCount).map((turn, offset) => {
      const isSelectedRow = start + offset === this.selected;
      const cursor = isSelectedRow ? this.params.theme.fg("accent", "›") : " ";
      const checked = this.selectedIndexes.has(turn.index) ? "✓" : " ";
      const role = turn.role === "user" ? "U" : "A";
      const label = isSelectedRow
        ? this.params.theme.bold(`#${turn.index} ${role} ${turn.preview}`)
        : `#${turn.index} ${role} ${turn.preview}`;
      return `${cursor} [${checked}] ${label}`;
    });

    const rows: string[] = [
      fitLine(`${this.params.theme.bold("Markdown Review")} · ${entries.length} turns · ${this.selectedIndexes.size} 已选`, inner),
      rule(inner),
    ];

    if (entries.length === 0) {
      rows.push(this.params.theme.fg("warning", fitLine("没有可 Review 的 turn", inner)));
    } else if (wide) {
      const previewRows = this.renderPreviewPane(entries[this.selected]!, previewWidth, contentBudget);
      const count = Math.max(listRows.length, previewRows.length);
      for (let index = 0; index < count; index++) {
        const left = padToWidth(fitLine(listRows[index] ?? "", listWidth), listWidth);
        const right = previewRows[index] ?? "";
        rows.push(right ? `${left} ${right}` : left);
      }
    } else if (this.previewMode) {
      rows.push(...this.renderPreviewPane(entries[this.selected]!, previewWidth, contentBudget));
    } else {
      rows.push(...listRows);
      if (scrollInfo) {
        rows.push(this.params.theme.fg("dim", fitLine(`↑↓ 滚动 · 显示 ${start + 1}-${Math.min(entries.length, start + visibleCount)}/${entries.length}`, inner)));
      }
    }

    rows.push(rule(inner));
    if (this.status) {
      rows.push(this.params.theme.fg("warning", fitLine(this.status, inner)));
    }
    const keys = wide
      ? "Space 勾选 · a 全选 · n 清空 · e 导出 · ↑↓ 选择 · Esc 关闭"
      : this.previewMode
        ? "Esc 返回 · ↑↓/PgUp/PgDn 滚动"
        : inner >= 46
          ? "Space 勾选 · a 全选 · n 清空 · Enter 预览 · e 导出 · Esc"
          : "Space 勾选 · a 全选 · n 清空 · e 导出 · Esc";
    rows.push(fitLine(keys, inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  private renderPreviewPane(turn: MarkdownReviewTurnItem, width: number, contentBudget: number): string[] {
    const inner = Math.max(1, width);
    const markdown = new Markdown(turn.text, 0, 0, reviewMarkdownTheme(this.params.theme));
    const rendered = markdown.render(inner);
    if (contentBudget < 3) {
      // 预算不足：省略头部/页脚，只显示正文行。
      return rendered.slice(0, contentBudget).map((line) => fitLine(line, inner));
    }
    const visible = Math.max(1, Math.min(PREVIEW_VISIBLE, contentBudget - 2));
    const maxScroll = Math.max(0, rendered.length - visible);
    this.previewScroll = Math.min(Math.max(0, this.previewScroll), maxScroll);
    const end = Math.min(rendered.length, this.previewScroll + visible);
    const body = rendered.slice(this.previewScroll, end).map((line) => fitLine(line, inner));
    while (body.length < visible) body.push("");
    const header = fitLine(`${this.params.theme.bold(`预览 · Turn ${turn.index} ${turn.role === "user" ? "User" : "Assistant"}`)}`, inner);
    const footer = rendered.length > visible
      ? this.params.theme.fg("dim", fitLine(`行 ${this.previewScroll + 1}-${end}/${rendered.length} · PgUp/PgDn 滚动`, inner))
      : this.params.theme.fg("dim", fitLine(`${rendered.length} 行`, inner));
    return [header, ...body, footer];
  }

  handleInput(data: string): void {
    const entries = this.turns;
    if (entries.length === 0) {
      if (matchesKey(data, Key.escape)) this.finishClose();
      return;
    }
    this.status = "";

    if (this.previewMode && !this.lastWide) {
      if (matchesKey(data, Key.escape)) {
        this.previewMode = false;
        this.previewScroll = 0;
        this.params.requestRender();
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.previewScroll = Math.max(0, this.previewScroll - 1);
      } else if (matchesKey(data, Key.down)) {
        this.previewScroll += 1;
      } else if (matchesKey(data, Key.pageUp)) {
        this.previewScroll = Math.max(0, this.previewScroll - PREVIEW_VISIBLE);
      } else if (matchesKey(data, Key.pageDown)) {
        this.previewScroll += PREVIEW_VISIBLE;
      }
      this.params.requestRender();
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
    } else if (matchesKey(data, Key.enter) && !this.lastWide) {
      this.previewMode = true;
      this.previewScroll = 0;
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
    if (this.selectedIndexes.size === 0) {
      this.status = "未选择任何 turn · 按 a 全选或 Space 勾选后再导出";
      this.params.requestRender();
      return;
    }
    const turnIndexes = [...this.selectedIndexes].sort((a, b) => a - b);
    this.params.done({ kind: "export", turnIndexes });
  }

  private finishClose(): void {
    this.params.done({ kind: "close" });
  }
}

/** handleInput 依据 render 记录的 lastWide，不再读取 process.stdout 列宽。 */
function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index % length + length) % length;
}

function padToWidth(value: string, width: number): string {
  const current = visibleWidth(value);
  return current >= width ? value : `${value}${" ".repeat(width - current)}`;
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
    theme.fg("dim", `└${"─".repeat(inner)}┘`),
  ];
}
