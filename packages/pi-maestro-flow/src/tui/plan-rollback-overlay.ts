/**
 * TUI overlay for selecting an archived Plan draft to roll back to.
 *
 * Two-column list (revision + archivedAt + checksum) with a Markdown preview
 * of the selected entry. Enter restores, Esc cancels. Bounded to the drafts
 * supplied by plan-store.listDrafts().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { PlanDraftArchiveEntry } from "../tools/plan-store.ts";

export interface RenderRollbackOverlayOptions {
  drafts: PlanDraftArchiveEntry[];
  readDraft: (path: string) => Promise<string>;
}

export interface RenderRollbackOverlayResult {
  action: "restore" | "cancel";
  selected?: PlanDraftArchiveEntry;
}

type RollbackContext = Pick<ExtensionContext, "hasUI" | "ui">;

const MAX_VISIBLE = 10;
const PREVIEW_VISIBLE = 12;
const WIDE_THRESHOLD = 76;

export async function renderRollbackOverlay(
  ctx: RollbackContext,
  options: RenderRollbackOverlayOptions,
): Promise<RenderRollbackOverlayResult> {
  if (!ctx.hasUI) return { action: "cancel" };
  const drafts = options.drafts;

  const result = await ctx.ui.custom<RenderRollbackOverlayResult>(
    (tui, theme, _keybindings, done) => {
      let selected = 0;
      let preview = "";
      let loadingPreview = false;
      let lastWidth = 80;

      const markdownTheme: MarkdownTheme = {
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

      async function refreshPreview(): Promise<void> {
        const entry = drafts[selected];
        if (!entry) { preview = ""; return; }
        loadingPreview = true;
        try {
          preview = await options.readDraft(entry.path);
        } catch {
          preview = "Unable to read this draft archive.";
        } finally {
          loadingPreview = false;
          tui.requestRender();
        }
      }
      void refreshPreview();

      function visibleStart(): number {
        if (drafts.length <= MAX_VISIBLE) return 0;
        return Math.min(Math.max(0, selected - MAX_VISIBLE + 1), drafts.length - MAX_VISIBLE);
      }

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, Math.min(width, 140));
          lastWidth = safeWidth;
          const inner = Math.max(1, safeWidth - 2);
          const wide = safeWidth >= WIDE_THRESHOLD;
          const terminalRows = process.stdout?.rows ?? 30;
          const overlayMax = Math.max(8, Math.floor(terminalRows * 0.9));
          const listWidth = wide ? Math.min(38, Math.floor(inner * 0.4)) : inner;
          const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;

          const rows: string[] = [
            truncateToWidth(`${theme.bold("Rollback to draft version")} · ${drafts.length} archived`, inner, "…"),
            "─".repeat(inner),
          ];

          if (drafts.length === 0) {
            rows.push(theme.fg("warning", "No archived drafts available for rollback."));
            rows.push("─".repeat(inner));
            rows.push(truncateToWidth("Esc close", inner, "…"));
            return frameBox(rows, safeWidth, theme);
          }

          const start = visibleStart();
          const visibleCount = Math.min(MAX_VISIBLE, overlayMax - 6);
          const listRows = drafts.slice(start, start + visibleCount).map((entry, offset) => {
            const isSelected = start + offset === selected;
            const marker = isSelected ? "›" : " ";
            const label = `r${entry.revision} · ${entry.archivedAt.slice(0, 15)} · ${entry.checksum.slice(0, 8)}`;
            return isSelected
              ? theme.bold(`${marker} ${label}`)
              : `${marker} ${label}`;
          });

          if (wide) {
            const md = new Markdown(preview, 0, 0, markdownTheme);
            const rendered = md.render(previewWidth).slice(0, overlayMax - 6);
            const count = Math.max(listRows.length, rendered.length);
            for (let index = 0; index < count; index++) {
              const left = padToWidth(truncateToWidth(listRows[index] ?? "", listWidth, "…"), listWidth);
              const right = rendered[index] ?? "";
              rows.push(right ? `${left} ${right}` : left);
            }
          } else {
            rows.push(...listRows);
            if (drafts.length > visibleCount) {
              rows.push(theme.fg("dim", truncateToWidth(`↑↓ scroll · ${start + 1}-${Math.min(drafts.length, start + visibleCount)}/${drafts.length}`, inner, "…")));
            }
            rows.push("─".repeat(inner));
            const md = new Markdown(preview, 0, 0, markdownTheme);
            const rendered = md.render(previewWidth).slice(0, Math.max(1, overlayMax - listRows.length - 6));
            rows.push(...rendered);
          }

          rows.push("─".repeat(inner));
          rows.push(theme.fg("dim", truncateToWidth(
            wide ? "↑↓ select · Enter restore · Esc cancel" : "↑↓ select · Enter restore · Esc cancel",
            inner, "…",
          )));
          if (loadingPreview) rows.push(theme.fg("dim", "loading preview…"));
          return frameBox(rows, safeWidth, theme);
        },

        handleInput(data: string): void {
          if (matchesKey(data, Key.up)) {
            selected = Math.max(0, selected - 1);
            void refreshPreview();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down)) {
            selected = Math.min(drafts.length - 1, selected + 1);
            void refreshPreview();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            done({ action: "restore", selected: drafts[selected] });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done({ action: "cancel" });
            return;
          }
          tui.requestRender();
        },

        invalidate(): void {},
        dispose(): void {},
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        minWidth: 40,
        maxHeight: "90%" as const,
        anchor: "center" as const,
      },
    },
  );

  return result ?? { action: "cancel" };
}

function padToWidth(value: string, width: number): string {
  const current = visibleWidth(value);
  return current >= width ? value : `${value}${" ".repeat(width - current)}`;
}

function frameBox(
  rows: string[],
  width: number,
  theme: { fg(name: string, text: string): string },
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
