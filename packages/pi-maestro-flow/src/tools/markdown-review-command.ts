import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { formatBytes } from "../session/session-export.ts";
import {
  assembleReviewMarkdown,
  collectReviewTurns,
  exportReviewDocument,
  parseReviewArgs,
  resolveReviewOutputPath,
  resolveSelectedTurns,
  REVIEW_EXPORT_FORMAT_LABELS,
  REVIEW_USAGE,
  type ReviewExportFormat,
  type ReviewTurn,
} from "../session/markdown-review.ts";
import {
  MarkdownReviewOverlay,
  type MarkdownReviewOverlayAction,
  type MarkdownReviewTurnItem,
} from "../tui/markdown-review-overlay.ts";

function collectTurnsFromSession(ctx: ExtensionCommandContext): ReviewTurn[] {
  const manager = ctx.sessionManager as {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  return collectReviewTurns(entries);
}

function turnItems(turns: readonly ReviewTurn[]): MarkdownReviewTurnItem[] {
  return turns.map((turn) => {
    const firstLine = turn.text.split("\n").find((line) => line.trim().length > 0) ?? "";
    const preview = firstLine.replace(/^#+\s*/, "").slice(0, 60);
    return { index: turn.index, role: turn.role, preview, text: turn.text };
  });
}

async function pickTurnsInteractive(
  ctx: ExtensionCommandContext,
  turns: readonly ReviewTurn[],
): Promise<number[] | undefined> {
  const items = turnItems(turns);
  if (items.length === 1) return [items[0]!.index];
  const result = await ctx.ui.custom<MarkdownReviewOverlayAction | undefined>(
    (tui, theme, _keybindings, done) =>
      new MarkdownReviewOverlay({
        turns: items,
        theme: theme as unknown as {
          fg(name: string, text: string): string;
          bold(text: string): string;
        },
        requestRender: () => tui.requestRender(),
        done: (action) => done(action),
      }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    },
  );
  if (!result) return undefined;
  if (result.kind === "close") return undefined;
  return result.turnIndexes;
}

async function pickExportFormat(ctx: ExtensionCommandContext): Promise<ReviewExportFormat | undefined> {
  const labels = Object.values(REVIEW_EXPORT_FORMAT_LABELS);
  const choice = await ctx.ui.select("导出格式", labels);
  if (choice === undefined) return undefined;
  const format = Object.keys(REVIEW_EXPORT_FORMAT_LABELS).find(
    (key) => REVIEW_EXPORT_FORMAT_LABELS[key as ReviewExportFormat] === choice,
  ) as ReviewExportFormat | undefined;
  return format;
}

async function exportSelectedTurns(
  ctx: ExtensionCommandContext,
  turns: readonly ReviewTurn[],
  indexes: number[],
  format: ReviewExportFormat,
  output?: string,
): Promise<boolean> {
  const selected = resolveSelectedTurns(turns, indexes);
  if (!selected.ok) {
    ctx.ui.notify(selected.message, "warning");
    return false;
  }
  const markdown = assembleReviewMarkdown(selected.turns);
  const cwd = ctx.cwd ?? process.cwd();
  const outputPath = await resolveReviewOutputPath(format, cwd, output);
  try {
    ctx.ui.notify(`正在导出 ${format.toUpperCase()}...`, "info");
    await exportReviewDocument(markdown, format, outputPath);
    const info = await stat(outputPath);
    ctx.ui.notify(
      `已导出 ${selected.turns.length} 个 turn → ${outputPath} (${formatBytes(info.size)})`,
      "info",
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`导出失败：${message}`, "error");
    return false;
  }
}

export async function executeMarkdownReviewCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseReviewArgs(args);
  if (parsed.kind === "help") {
    ctx.ui.notify(REVIEW_USAGE, "info");
    return;
  }
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "error");
    return;
  }

  // 生成进行中时 branch 可能缺少最后一条 in-flight 消息 — 先等 idle 再收集。
  await ctx.waitForIdle?.();

  const turns = collectTurnsFromSession(ctx);
  if (turns.length === 0) {
    ctx.ui.notify("当前会话没有 user/assistant 消息可供 Review。", "warning");
    return;
  }

  if (parsed.kind === "interactive") {
    const indexes = await pickTurnsInteractive(ctx, turns);
    if (!indexes || indexes.length === 0) return;
    const format = await pickExportFormat(ctx);
    if (!format) return;
    await exportSelectedTurns(ctx, turns, indexes, format);
    return;
  }

  // CLI 参数模式
  const selection = resolveSelectedTurns(turns, parsed.turns);
  if (!selection.ok) {
    ctx.ui.notify(selection.message, "warning");
    return;
  }
  await exportSelectedTurns(
    ctx,
    turns,
    selection.turns.map((turn) => turn.index),
    parsed.format,
    parsed.output,
  );
}

export function registerMarkdownReviewCommand(pi: ExtensionAPI): void {
  const handler = (args: string, ctx: ExtensionCommandContext): Promise<void> =>
    executeMarkdownReviewCommand(args, ctx);
  pi.registerCommand("markdown-review", {
    description: "Markdown Review：选择会话 turn 并导出 Markdown/Word/PDF（--turn/--format/--output 参数化）",
    handler,
  });
  pi.registerCommand("markdownreview", {
    description: "Markdown Review 别名：/markdown-review",
    handler,
  });
}
