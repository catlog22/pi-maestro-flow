import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { INSTALL_ITEMS, STATUS_GLYPH, resolveInstallItems, readInstallDoc, type ResolvedInstallItem } from "./install-items.ts";

/** Register the `/install` command: interactive picker → inject AI setup doc. */
export function registerInstallCommand(pi: ExtensionAPI): void {
  pi.registerCommand("install", {
    description:
      "交互式安装引导：选择可选安装项，注入 AI 安装文档自主执行。用法: /install [list|<id>]",
    async handler(args, ctx) {
      const trimmed = args.trim();
      const items = resolveInstallItems();

      if (trimmed === "list") {
        ctx.ui.notify(formatList(items), "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("安装引导需要 TUI 环境；用 /install list 查看可选项。", "error");
        return;
      }

      const choice = trimmed
        ? items.find((item) => item.id === trimmed)
        : await pickInstallItem(ctx, items);

      if (!choice) {
        if (trimmed) ctx.ui.notify(`未找到安装项「${trimmed}」。用 /install list 查看可选项。`, "warning");
        return;
      }

      const doc = readInstallDoc(choice.docFile);
      if (!doc) {
        ctx.ui.notify(`安装文档 ${choice.docFile} 未随包发布，无法注入。`, "error");
        return;
      }

      const message = composeInstallMessage(choice, doc);
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify(`已注入「${choice.title}」安装文档，AI 将自主执行。`, "info");
    },
  });
}

async function pickInstallItem(ctx: ExtensionCommandContext, items: readonly ResolvedInstallItem[]): Promise<ResolvedInstallItem | undefined> {
  const labels = items.map((item) => `${STATUS_GLYPH[item.status]}  ${item.title}`);
  const idx = await ctx.ui.select("选择要安装的项（✓已装 ○部分 ·未装 ?未知）", labels);
  if (idx === undefined) return undefined;
  return items[Number(idx)] ?? items.find((item) => `${STATUS_GLYPH[item.status]}  ${item.title}` === idx);
}

function composeInstallMessage(item: ResolvedInstallItem, doc: string): string {
  return [
    item.promptIntro,
    "",
    "请阅读以下安装文档并自主执行全部步骤。遇到 INTERACTIVE INPUTS 章节必须用 ctx.ui 交互式询问用户，不得臆测或使用默认值。执行完毕后运行 VERIFY 章节确认，并向用户报告结果（成功/失败 + 关键校验点）。",
    "",
    "## 安装文档",
    doc,
  ].join("\n");
}

/** Test-only export of the message composer (no ctx dependency). */
export function composeInstallMessageForTest(item: ResolvedInstallItem, doc: string): string {
  return composeInstallMessage(item, doc);
}

function formatList(items: readonly ResolvedInstallItem[]): string {
  const lines = ["可安装项（✓已装 ○部分 ·未装 ?未知）：", ""];
  for (const item of items) {
    lines.push(`${STATUS_GLYPH[item.status]}  ${item.title}  —  ${item.description}`);
    lines.push(`     /install ${item.id}`);
  }
  lines.push("", "用 /install <id> 直接安装某项，或 /install 交互式选择。");
  return lines.join("\n");
}
