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
import { sanitizeTerminalText } from "./markdown-review-overlay.ts";

export type SessionArtifactSource = "plan" | "review" | "knowledge";

export interface SessionArtifactItem {
  id: string;
  source: SessionArtifactSource;
  title: string;
  detail: string;
  markdown: string;
  createdAt?: string;
}

export type SessionArtifactOverlayAction =
  | { kind: "close"; selectedId?: string }
  | { kind: "copy"; selectedId: string }
  | { kind: "export"; selectedId: string };

export interface SessionArtifactOverlayParams {
  sessionLabel: string;
  artifacts: readonly SessionArtifactItem[];
  initialSelectedId?: string;
  theme: {
    fg(name: string, text: string): string;
    bold(text: string): string;
  };
  requestRender: () => void;
  done: (action: SessionArtifactOverlayAction) => void;
}

const MAX_LIST_VISIBLE = 12;
const WIDE_THRESHOLD = 76;

export class SessionArtifactOverlay implements Component, Focusable {
  focused = false;
  private selected: number;
  private previewScroll = 0;
  private previewMode = false;
  private lastWide = true;
  private readonly artifacts: SessionArtifactItem[];
  private readonly markdownTheme: MarkdownTheme;

  constructor(private readonly params: SessionArtifactOverlayParams) {
    this.artifacts = params.artifacts.map((artifact) => ({
      ...artifact,
      title: sanitizeTerminalText(artifact.title),
      detail: sanitizeTerminalText(artifact.detail),
      markdown: sanitizeTerminalText(artifact.markdown),
    }));
    const selected = params.initialSelectedId
      ? this.artifacts.findIndex((artifact) => artifact.id === params.initialSelectedId)
      : -1;
    this.selected = selected >= 0 ? selected : 0;
    this.markdownTheme = artifactMarkdownTheme(params.theme);
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const inner = Math.max(1, safeWidth - 2);
    const wide = safeWidth >= WIDE_THRESHOLD;
    this.lastWide = wide;
    const terminalRows = process.stdout?.rows ?? 30;
    const overlayMax = Math.max(8, Math.floor(terminalRows * 0.9));
    const contentBudget = Math.max(1, overlayMax - 5);
    const listWidth = wide ? Math.min(42, Math.floor(inner * 0.42)) : inner;
    const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;

    const rows: string[] = [
      truncateToWidth(`${this.params.theme.bold("Artifacts")} · ${this.params.sessionLabel} · ${this.artifacts.length}`, inner, "…"),
      "─".repeat(inner),
    ];
    if (this.artifacts.length === 0) {
      rows.push(this.params.theme.fg("warning", "No session Artifacts are available."));
      rows.push("─".repeat(inner));
      rows.push(this.params.theme.fg("dim", "Esc close"));
      return frameBox(rows, safeWidth, this.params.theme);
    }

    if (!wide && this.previewMode) {
      rows.push(...this.renderPreview(this.artifacts[this.selected]!, previewWidth, contentBudget));
    } else {
      const visibleCount = Math.max(1, Math.min(MAX_LIST_VISIBLE, contentBudget));
      const start = visibleStart(this.selected, this.artifacts.length, visibleCount);
      const listRows = this.artifacts.slice(start, start + visibleCount).map((artifact, offset) => {
        const active = start + offset === this.selected;
        const marker = active ? this.params.theme.fg("accent", "›") : " ";
        const source = artifact.source === "knowledge" ? "K" : artifact.source === "review" ? "R" : "P";
        const label = `[${source}] ${artifact.title}`;
        return `${marker} ${active ? this.params.theme.bold(label) : label}`;
      });
      if (wide) {
        const previewRows = this.renderPreview(this.artifacts[this.selected]!, previewWidth, contentBudget);
        const count = Math.max(listRows.length, previewRows.length);
        for (let index = 0; index < count; index++) {
          const left = padToWidth(truncateToWidth(listRows[index] ?? "", listWidth, "…"), listWidth);
          const right = previewRows[index] ?? "";
          rows.push(right ? `${left} ${right}` : left);
        }
      } else {
        rows.push(...listRows);
        if (this.artifacts.length > visibleCount) {
          rows.push(this.params.theme.fg("dim", `显示 ${start + 1}-${Math.min(this.artifacts.length, start + visibleCount)}/${this.artifacts.length}`));
        }
      }
    }

    rows.push("─".repeat(inner));
    const footer = !wide && this.previewMode
      ? "Esc 返回 · c 复制 · e 导出 · ↑↓/PgUp/PgDn 滚动"
      : wide
        ? "↑↓ 选择 · PgUp/PgDn 滚动 · c 复制 · e 导出 · Esc 关闭"
        : "↑↓ 选择 · Enter 预览 · c 复制 · e 导出 · Esc 关闭";
    rows.push(this.params.theme.fg("dim", truncateToWidth(footer, inner, "…")));
    return frameBox(rows, safeWidth, this.params.theme);
  }

  private renderPreview(artifact: SessionArtifactItem, width: number, budget: number): string[] {
    const safeWidth = Math.max(1, width);
    if (budget < 3) return [];
    const markdown = new Markdown(artifact.markdown, 0, 0, this.markdownTheme);
    const rendered = markdown.render(safeWidth);
    const visible = Math.max(1, budget - 3);
    const maxScroll = Math.max(0, rendered.length - visible);
    this.previewScroll = Math.min(Math.max(0, this.previewScroll), maxScroll);
    const end = Math.min(rendered.length, this.previewScroll + visible);
    const body = rendered.slice(this.previewScroll, end).map((line) => truncateToWidth(line, safeWidth, "…"));
    while (body.length < visible) body.push("");
    const range = rendered.length > visible
      ? `${this.previewScroll + 1}-${end}/${rendered.length}`
      : `${rendered.length} 行`;
    return [
      truncateToWidth(this.params.theme.bold(artifact.title), safeWidth, "…"),
      this.params.theme.fg("dim", truncateToWidth(artifact.detail, safeWidth, "…")),
      ...body,
      this.params.theme.fg("dim", truncateToWidth(range, safeWidth, "…")),
    ];
  }

  handleInput(data: string): void {
    if (this.artifacts.length === 0) {
      if (matchesKey(data, Key.escape)) this.params.done({ kind: "close" });
      return;
    }
    const selected = () => this.artifacts[this.selected]!;
    if (!this.lastWide && this.previewMode) {
      if (matchesKey(data, Key.escape)) {
        this.previewMode = false;
        this.previewScroll = 0;
      } else if (matchesKey(data, Key.up)) {
        this.previewScroll = Math.max(0, this.previewScroll - 1);
      } else if (matchesKey(data, Key.down)) {
        this.previewScroll += 1;
      } else if (matchesKey(data, Key.pageUp)) {
        this.previewScroll = Math.max(0, this.previewScroll - 8);
      } else if (matchesKey(data, Key.pageDown)) {
        this.previewScroll += 8;
      } else if (data === "c" || data === "C") {
        this.params.done({ kind: "copy", selectedId: selected().id });
        return;
      } else if (data === "e" || data === "E") {
        this.params.done({ kind: "export", selectedId: selected().id });
        return;
      }
      this.params.requestRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selected = wrapIndex(this.selected - 1, this.artifacts.length);
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.down)) {
      this.selected = wrapIndex(this.selected + 1, this.artifacts.length);
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.pageUp)) {
      this.previewScroll = Math.max(0, this.previewScroll - 8);
    } else if (matchesKey(data, Key.pageDown)) {
      this.previewScroll += 8;
    } else if (matchesKey(data, Key.enter) && !this.lastWide) {
      this.previewMode = true;
      this.previewScroll = 0;
    } else if (data === "c" || data === "C") {
      this.params.done({ kind: "copy", selectedId: selected().id });
      return;
    } else if (data === "e" || data === "E") {
      this.params.done({ kind: "export", selectedId: selected().id });
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.params.done({ kind: "close", selectedId: selected().id });
      return;
    }
    this.params.requestRender();
  }
}

function artifactMarkdownTheme(theme: SessionArtifactOverlayParams["theme"]): MarkdownTheme {
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

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function wrapIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index % length + length) % length;
}

function padToWidth(value: string, width: number): string {
  const current = visibleWidth(value);
  return current >= width ? value : `${value}${" ".repeat(width - current)}`;
}

function frameBox(
  rows: string[],
  width: number,
  theme: SessionArtifactOverlayParams["theme"],
): string[] {
  const inner = Math.max(0, width - 2);
  const border = (text: string) => theme.fg("dim", text);
  return [
    border(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => {
      const content = truncateToWidth(row, inner, "…");
      return `${border("│")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border("│")}`;
    }),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}
