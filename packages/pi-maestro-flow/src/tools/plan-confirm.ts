import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type PlanConfirmationAction =
  | "execute"
  | "execute-clear"
  | "execute-compact"
  | "modify"
  | "cancel";

export interface PlanConfirmationOptions {
  markdown: string;
  pathLabel?: string;
  canClearContext: boolean;
}

interface ConfirmationItem {
  action: PlanConfirmationAction;
  label: string;
  description: string;
  enabled: boolean;
}

const CTRL_ENTER_SEQUENCES = new Set([
  "\x1b[13;5u",
  "\x1b[13;5~",
  "\x1b[27;5;13~",
]);

export async function openPlanConfirmation(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  options: PlanConfirmationOptions,
): Promise<PlanConfirmationAction> {
  if (!ctx.hasUI) return "cancel";

  const result = await ctx.ui.custom<PlanConfirmationAction>(
    (tui, theme, _keybindings, done) => {
      const items: ConfirmationItem[] = [
        { action: "execute", label: "Execute", description: "Keep the current context", enabled: true },
        {
          action: "execute-clear",
          label: "Execute in new session",
          description: options.canClearContext ? "Start with a clean context" : "Available from /plan approve",
          enabled: options.canClearContext,
        },
        { action: "execute-compact", label: "Compact then execute", description: "Preserve this Plan in the checkpoint", enabled: true },
        { action: "modify", label: "Modify Plan", description: "Open the full-screen Markdown editor", enabled: true },
        { action: "cancel", label: "Exit Plan mode", description: "Keep the draft without approval", enabled: true },
      ];
      const markdown = new Markdown(options.markdown, 0, 0, markdownTheme(theme));
      let selected = 0;
      let previewOffset = 0;
      let status = "";
      let lastWidth = 80;

      function actionFooter(width: number, segments: string[]): string {
        let value = "";
        for (const segment of segments) {
          const next = value ? `${value} · ${segment}` : segment;
          if (visibleWidth(next) <= width) value = next;
        }
        return value || segments[0] || "";
      }

      function choose(action = items[selected]?.action): void {
        const item = items.find((candidate) => candidate.action === action);
        if (!item) return;
        if (!item.enabled) {
          status = "Use /plan approve to start execution in a new session.";
          tui.requestRender();
          return;
        }
        done(item.action);
      }

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          lastWidth = safeWidth;
          const selectedItem = items[selected] ?? items[0];
          if (safeWidth < 24) {
            return [
              truncateToWidth(`Plan confirm · ${selected + 1}/${items.length} ${selectedItem.label}`, safeWidth, "…"),
              truncateToWidth(actionFooter(safeWidth, ["Esc exit", "Enter choose", "↑↓ select"]), safeWidth, "…"),
            ];
          }

          const innerWidth = Math.max(1, safeWidth - 2);
          const terminalRows = process.stdout?.rows ?? 30;
          const previewHeight = Math.max(4, Math.min(16, terminalRows - 10));
          const renderedPlan = markdown.render(Math.max(1, innerWidth - 2));
          const maxOffset = Math.max(0, renderedPlan.length - previewHeight);
          previewOffset = Math.min(previewOffset, maxOffset);
          const preview = renderedPlan.slice(previewOffset, previewOffset + previewHeight);
          const range = renderedPlan.length > previewHeight
            ? `${previewOffset + 1}-${Math.min(renderedPlan.length, previewOffset + previewHeight)}/${renderedPlan.length}`
            : `${renderedPlan.length}`;
          const footer = status || actionFooter(innerWidth, [
            "Esc close",
            "Enter choose",
            "1-5 choose",
            "↑↓ action",
            "Ctrl+Enter execute",
            "PgUp/PgDn plan",
          ]);
          const rows = [
            `${theme.bold("Plan confirmation")}  ${theme.fg("dim", options.pathLabel ?? "current.md")}`,
            theme.fg("dim", "─".repeat(innerWidth)),
            ...preview.map((line) => ` ${line}`),
          ];
          while (rows.length < previewHeight + 2) rows.push("");
          rows.push(theme.fg("dim", `Plan ${range}`));
          rows.push(theme.fg("dim", "─".repeat(innerWidth)));
          for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const marker = index === selected ? "›" : " ";
            const label = item.enabled ? item.label : `${item.label} (unavailable)`;
            const description = innerWidth >= 68 ? `  ${theme.fg("dim", `— ${item.description}`)}` : "";
            const line = `${marker} ${index + 1}. ${label}${description}`;
            rows.push(index === selected
              ? theme.fg(item.enabled ? "accent" : "warning", theme.bold(line))
              : theme.fg(item.enabled ? "text" : "dim", line));
          }
          rows.push(theme.fg(status ? "warning" : "dim", footer));
          return renderFrame(rows, safeWidth, theme);
        },

        handleInput(data: string): void {
          if (lastWidth < 20) {
            if (matchesKey(data, Key.escape)) choose("cancel");
            return;
          }
          if (matchesKey(data, Key.up)) {
            selected = (selected - 1 + items.length) % items.length;
            status = "";
          } else if (matchesKey(data, Key.down)) {
            selected = (selected + 1) % items.length;
            status = "";
          } else if (matchesKey(data, Key.pageUp)) {
            previewOffset = Math.max(0, previewOffset - 5);
          } else if (matchesKey(data, Key.pageDown)) {
            previewOffset += 5;
          } else if (/^[1-5]$/.test(data)) {
            selected = Number(data) - 1;
            choose();
            return;
          } else if (matchesKey(data, Key.enter)) {
            choose();
            return;
          } else if (matchesKey(data, Key.ctrl("enter")) || CTRL_ENTER_SEQUENCES.has(data)) {
            choose("execute");
            return;
          } else if (matchesKey(data, Key.escape)) {
            choose("cancel");
            return;
          }
          tui.requestRender();
        },

        invalidate(): void {
          markdown.invalidate();
        },

        dispose(): void {},
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        minWidth: 24,
        maxHeight: 28,
        anchor: "center" as const,
      },
    },
  );

  return result ?? "cancel";
}

function renderFrame(
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

function markdownTheme(theme: {
  fg(name: string, text: string): string;
  bold(text: string): string;
}): MarkdownTheme {
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
