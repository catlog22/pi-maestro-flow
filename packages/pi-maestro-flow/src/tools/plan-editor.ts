import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type PlanEditorContext = Pick<ExtensionContext, "hasUI" | "ui">;

export interface PlanEditorOptions {
  markdown: string;
  revision: number;
  allowConfirm: boolean;
  pathLabel?: string;
  onSave(markdown: string, expectedRevision: number): Promise<number>;
  onConfirm(markdown: string, expectedRevision: number): Promise<void>;
}

export interface PlanEditorResult {
  action: "cancelled" | "approved";
  markdown: string;
  revision: number;
}

const CTRL_S = "\x13";
const CTRL_ENTER_SEQUENCES = new Set(["\x1b[13;5u", "\x1b[13;5~"]);

export async function openPlanEditor(
  ctx: PlanEditorContext,
  options: PlanEditorOptions,
): Promise<PlanEditorResult> {
  if (!ctx.hasUI) {
    return { action: "cancelled", markdown: options.markdown, revision: options.revision };
  }

  const result = await ctx.ui.custom<PlanEditorResult>(
    (tui, theme, _keybindings, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const editor = new Editor(tui, editorTheme);
      editor.disableSubmit = true;
      editor.setText(options.markdown);

      let savedText = options.markdown;
      let revision = options.revision;
      let verticalOffset = 0;
      let horizontalOffset = 0;
      let busy = false;
      let status = "";

      editor.onChange = () => {
        status = "";
        tui.requestRender();
      };

      function isDirty(): boolean {
        return editor.getText() !== savedText;
      }

      async function save(): Promise<void> {
        if (busy) return;
        busy = true;
        status = "saving…";
        tui.requestRender();
        try {
          const markdown = editor.getText();
          revision = await options.onSave(markdown, revision);
          savedText = markdown;
          status = `saved r${revision}`;
        } catch (error) {
          status = `save failed: ${errorMessage(error)}`;
        } finally {
          busy = false;
          tui.requestRender();
        }
      }

      async function confirm(): Promise<void> {
        if (busy || !options.allowConfirm) return;
        busy = true;
        status = "approving…";
        tui.requestRender();
        const markdown = editor.getText();
        try {
          await options.onConfirm(markdown, revision);
          savedText = markdown;
          done({ action: "approved", markdown, revision: revision + 1 });
        } catch (error) {
          if (isPersistedApprovalError(error)) {
            revision = error.revision;
            savedText = markdown;
          }
          status = `approval failed: ${errorMessage(error)}`;
          busy = false;
          tui.requestRender();
        }
      }

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          if (safeWidth < 20) {
            const action = options.allowConfirm ? "Ctrl+Enter approve" : "Ctrl+S save";
            return [truncateToWidth(`Plan · ${action} · Esc close`, safeWidth, "…")];
          }

          const lines = editor.getLines();
          const cursor = editor.getCursor();
          const digits = Math.max(2, String(Math.max(1, lines.length)).length);
          const gutterWidth = digits + 5;
          const contentWidth = Math.max(1, safeWidth - gutterWidth);
          const terminalRows = process.stdout?.rows ?? 30;
          const viewportHeight = Math.max(4, terminalRows - 5);

          if (cursor.line < verticalOffset) verticalOffset = cursor.line;
          if (cursor.line >= verticalOffset + viewportHeight) {
            verticalOffset = cursor.line - viewportHeight + 1;
          }

          const cursorVisualColumn = visibleWidth((lines[cursor.line] ?? "").slice(0, cursor.col));
          if (cursorVisualColumn < horizontalOffset) horizontalOffset = cursorVisualColumn;
          if (cursorVisualColumn >= horizontalOffset + contentWidth) {
            horizontalOffset = cursorVisualColumn - contentWidth + 1;
          }

          const dirty = isDirty() ? "modified" : "saved";
          const header = ` Plan · ${options.pathLabel ?? "current.md"} · ${dirty} · r${revision}`;
          const output = [truncateToWidth(theme.bold(header), safeWidth, "…")];

          for (let row = 0; row < viewportHeight; row++) {
            const lineIndex = verticalOffset + row;
            const isCurrent = lineIndex === cursor.line;
            const marker = isCurrent ? ">" : " ";
            const number = lineIndex < lines.length ? String(lineIndex + 1).padStart(digits, " ") : " ".repeat(digits);
            const gutter = `${marker} ${number} │ `;
            const rawLine = lines[lineIndex] ?? "";
            const content = isCurrent
              ? renderCursorLine(rawLine, cursor.col, cursorVisualColumn, horizontalOffset, contentWidth)
              : slicePlainByWidth(rawLine, horizontalOffset, contentWidth);
            const padded = truncateToWidth(content, contentWidth, "", true);
            output.push(`${theme.fg("dim", gutter)}${isCurrent ? theme.bg("selectedBg", padded) : padded}`);
          }

          const location = `Ln ${cursor.line + 1}, Col ${cursor.col + 1} · ${lines.length} lines`;
          const actions = options.allowConfirm
            ? "Ctrl+S save · Ctrl+Enter confirm · Esc cancel"
            : "Ctrl+S save · Esc close";
          const footer = status ? `${location} · ${status} · ${actions}` : `${location} · ${actions}`;
          output.push(truncateToWidth(theme.fg(status.includes("failed") ? "error" : "dim", footer), safeWidth, "…"));
          return output;
        },

        handleInput(data: string): void {
          if (busy) return;
          if (data === CTRL_S) {
            void save();
            return;
          }
          if (CTRL_ENTER_SEQUENCES.has(data)) {
            void confirm();
            return;
          }
          if (data === "\x1b") {
            done({ action: "cancelled", markdown: editor.getText(), revision });
            return;
          }
          editor.handleInput(data);
          tui.requestRender();
        },

        invalidate(): void {
          editor.invalidate();
        },

        dispose(): void {},
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left" as const,
        margin: 0,
      },
    },
  );

  return result ?? { action: "cancelled", markdown: options.markdown, revision: options.revision };
}

function renderCursorLine(
  line: string,
  cursorColumn: number,
  cursorVisualColumn: number,
  horizontalOffset: number,
  width: number,
): string {
  const relative = Math.max(0, cursorVisualColumn - horizontalOffset);
  const before = slicePlainByWidth(line.slice(0, cursorColumn), horizontalOffset, Math.min(relative, width));
  const cursorTail = line.slice(cursorColumn);
  const cell = relative < width ? Array.from(cursorTail)[0] ?? " " : "";
  const remaining = Math.max(0, width - visibleWidth(before) - visibleWidth(cell));
  const after = slicePlainByWidth(cursorTail.slice(cell.length), 0, remaining);
  return `${before}\x1b[7m${cell}\x1b[27m${after}`;
}

function slicePlainByWidth(text: string, start: number, width: number): string {
  if (width <= 0) return "";
  let offset = 0;
  let used = 0;
  let output = "";
  for (const segment of Array.from(text)) {
    const segmentWidth = visibleWidth(segment);
    if (offset + segmentWidth <= start) {
      offset += segmentWidth;
      continue;
    }
    if (used + segmentWidth > width) break;
    output += segment;
    used += segmentWidth;
    offset += segmentWidth;
  }
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPersistedApprovalError(error: unknown): error is { revision: number; draftPersisted: true } {
  return typeof error === "object"
    && error !== null
    && "revision" in error
    && typeof error.revision === "number"
    && "draftPersisted" in error
    && error.draftPersisted === true;
}
