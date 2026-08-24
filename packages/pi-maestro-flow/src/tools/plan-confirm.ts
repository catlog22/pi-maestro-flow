import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  PlanExecutionBackend,
  PlanExecutionChoice,
  PlanExecutionContextMode,
  PlanWorkflowTarget,
} from "./plan-store.ts";

export type PlanConfirmationAction =
  | "execute"
  | "modify"
  | "continue"
  | "review"
  | "apply-feedback"
  | "exit-plan"
  | "close";

export interface PlanConfirmationDecision {
  action: PlanConfirmationAction;
  execution?: PlanExecutionChoice;
}

export interface PlanWorkflowConfirmationTarget {
  sessionId: string;
  intent: string;
  available: boolean;
  reason?: string;
}

export interface PlanWorkflowConfirmationOptions {
  current?: PlanWorkflowConfirmationTarget;
  allowNew: boolean;
}

export interface PlanConfirmationOptions {
  markdown: string;
  pathLabel?: string;
  canCompactContext?: boolean;
  contextPercent?: number;
  defaultExecution?: PlanExecutionChoice;
  workflow?: PlanWorkflowConfirmationOptions;
  /** Markdown review reports for the current Plan revision (oldest first); shown in their own preview panel, never in the Plan. */
  reviewReports?: string[];
}

interface ActionItem {
  action: Exclude<PlanConfirmationAction, "close">;
  label: string;
  description: string;
}

type SelectionRow =
  | { kind: "backend" }
  | { kind: "target" }
  | { kind: "context" }
  | { kind: "action"; item: ActionItem };

type PreviewMode = "plan" | "report";

const CTRL_ENTER_SEQUENCES = new Set([
  "\x1b[13;5u",
  "\x1b[13;5~",
  "\x1b[27;5;13~",
]);

export async function openPlanConfirmation(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  options: PlanConfirmationOptions,
): Promise<PlanConfirmationDecision> {
  if (!ctx.hasUI) return { action: "close" };

  const result = await ctx.ui.custom<PlanConfirmationDecision>(
    (tui, theme, _keybindings, done) => {
      const currentTargetAvailable = options.workflow?.current?.available === true;
      const workflowAvailable = currentTargetAvailable || options.workflow?.allowNew === true;
      let backend: PlanExecutionBackend = options.defaultExecution?.backend === "workflow" && workflowAvailable
        ? "workflow"
        : "standalone";
      let workflowTarget: PlanWorkflowTarget = preferredWorkflowTarget(options, currentTargetAvailable);
      let contextMode: PlanExecutionContextMode = options.defaultExecution?.context === "compact"
        && options.canCompactContext !== false
        ? "compact"
        : "current";
      const actions: ActionItem[] = [
        { action: "execute", label: "Execute", description: "Approve with the selected execution settings" },
        { action: "modify", label: "View / modify Plan", description: "Open the full-screen Markdown editor" },
        { action: "continue", label: "Continue discussion", description: "Enter feedback or a question" },
        { action: "exit-plan", label: "Exit Plan mode", description: "Keep the draft without approval" },
        { action: "review", label: "Review with AI subagent", description: "Spawn a read-only subagent to audit the Plan; the report opens in its own panel" },
        ...(options.reviewReports?.length
          ? [{ action: "apply-feedback" as const, label: "Apply review feedback", description: "Send the latest AI review report back to the main agent to revise the Plan" }]
          : []),
      ];
      const reportCount = options.reviewReports?.length ?? 0;
      let reportIndex = reportCount > 0 ? reportCount - 1 : 0;
      let previewMode: PreviewMode = reportCount > 0 ? "report" : "plan";
      let markdown = new Markdown(currentPreviewSource(), 0, 0, markdownTheme(theme));
      let selected = 0;
      let previewOffset = 0;
      let previewMaxOffset = 0;
      let status = reportCount > 0
        ? `AI review report attached — R switches Plan/Report${reportCount > 1 ? ", [ ] cycles history" : ""}, PgUp/PgDn scrolls`
        : "";
      let lastWidth = 80;

      function currentPreviewSource(): string {
        if (previewMode === "report" && reportCount > 0) {
          return options.reviewReports?.[reportIndex] ?? "";
        }
        return options.markdown;
      }

      const rows = (): SelectionRow[] => [
        { kind: "backend" },
        ...(backend === "workflow" ? [{ kind: "target" } as const] : []),
        { kind: "context" },
        ...actions.map((item): SelectionRow => ({ kind: "action", item })),
      ];

      function actionFooter(width: number, segments: string[]): string {
        let value = "";
        for (const segment of segments) {
          const next = value ? `${value} · ${segment}` : segment;
          if (visibleWidth(next) <= width) value = next;
        }
        return value || segments[0] || "";
      }

      function executionChoice(): PlanExecutionChoice {
        return backend === "workflow"
          ? { backend, context: contextMode, workflowTarget }
          : { backend, context: contextMode };
      }

      function complete(action: PlanConfirmationAction): void {
        done(action === "execute"
          ? { action, execution: executionChoice() }
          : { action });
      }

      function changeControl(row: SelectionRow, direction: -1 | 1): void {
        status = "";
        if (row.kind === "backend") {
          if (!workflowAvailable && backend === "standalone") {
            status = workflowUnavailableMessage(options);
            return;
          }
          backend = backend === "standalone" ? "workflow" : "standalone";
          return;
        }
        if (row.kind === "target") {
          const available = availableWorkflowTargets(options);
          if (available.length < 2) {
            status = available[0] === "current"
              ? "Only the current Workflow Session is available."
              : "Only creating a new Workflow Session is available.";
            return;
          }
          const index = available.indexOf(workflowTarget);
          workflowTarget = available[(index + direction + available.length) % available.length] ?? available[0]!;
          return;
        }
        if (row.kind === "context") {
          if (options.canCompactContext === false) {
            status = "Context compaction is unavailable for this confirmation path.";
            return;
          }
          contextMode = contextMode === "current" ? "compact" : "current";
          return;
        }
      }

      function choose(row = rows()[selected]): void {
        if (!row) return;
        if (row.kind === "action") {
          complete(row.item.action);
          return;
        }
        changeControl(row, 1);
        tui.requestRender();
      }

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          lastWidth = safeWidth;
          const selectionRows = rows();
          selected = Math.min(selected, selectionRows.length - 1);
          const selectedRow = selectionRows[selected] ?? selectionRows[0]!;
          if (safeWidth < 24) {
            return [
              truncateToWidth(`Plan confirm · ${selected + 1}/${selectionRows.length} ${rowLabel(selectedRow, actions, options, backend, workflowTarget, contextMode)}`, safeWidth, "…"),
              truncateToWidth(actionFooter(safeWidth, ["Esc exit", "Enter choose", "↑↓ navigate"]), safeWidth, "…"),
            ];
          }

          const innerWidth = Math.max(1, safeWidth - 2);
          const terminalRows = process.stdout?.rows ?? 30;
          // A transient status line renders under the key hints; shrink the preview
          // by one row so the overlay stays within maxHeight.
          const hasStatusLine = Boolean(status);
          const previewHeight = Math.max(4, Math.min(14, terminalRows - 13) - Math.max(0, selectionRows.length - 6) - (hasStatusLine ? 1 : 0));
          const renderedPlan = markdown.render(Math.max(1, innerWidth - 2));
          const maxOffset = Math.max(0, renderedPlan.length - previewHeight);
          previewMaxOffset = maxOffset;
          previewOffset = Math.min(previewOffset, maxOffset);
          const preview = renderedPlan.slice(previewOffset, previewOffset + previewHeight);
          const range = renderedPlan.length > previewHeight
            ? `${previewOffset + 1}-${Math.min(renderedPlan.length, previewOffset + previewHeight)}/${renderedPlan.length}`
            : `${renderedPlan.length}`;
          // Key hints are always visible; a transient status line is rendered below
          // them instead of replacing them, so report/plan navigation stays discoverable.
          const footer = actionFooter(innerWidth, [
            "Esc close",
            "Enter choose",
            "←→ change mode",
            "↑↓ navigate",
            "Ctrl+Enter execute",
            ...(reportCount > 0 ? [previewMode === "report" ? "R: back to Plan" : "R: view report"] : []),
            ...(reportCount > 1 && previewMode === "report" ? ["[ ] history"] : []),
            "PgUp/PgDn scroll",
          ]);
          const rendered = [
            `${theme.bold("Plan confirmation")}  ${theme.fg("dim", options.pathLabel ?? "current.md")}`,
            theme.fg("dim", "─".repeat(innerWidth)),
            ...preview.map((line) => ` ${line}`),
          ];
          while (rendered.length < previewHeight + 2) rendered.push("");
          const modeLabel = previewMode === "report" && reportCount > 0
            ? (reportCount > 1 ? `Review report ${reportIndex + 1}/${reportCount}` : "Review report")
            : "Plan";
          const toggleHint = reportCount > 0
            ? `   R: ${previewMode === "report" ? "back to Plan" : "view review report"}`
            : "";
          rendered.push(theme.fg("dim", `${modeLabel} ${range}${toggleHint}`));
          rendered.push(theme.fg("dim", "─".repeat(innerWidth)));
          for (let index = 0; index < selectionRows.length; index++) {
            const row = selectionRows[index]!;
            const marker = index === selected ? "›" : " ";
            const label = rowLabel(row, actions, options, backend, workflowTarget, contextMode);
            const description = innerWidth >= 76 ? `  ${theme.fg("dim", `— ${rowDescription(row, options)}`)}` : "";
            const line = `${marker} ${label}${description}`;
            rendered.push(index === selected
              ? theme.fg("accent", theme.bold(line))
              : theme.fg("text", line));
          }
          rendered.push(theme.fg("dim", footer));
          if (status) rendered.push(theme.fg("warning", status));
          return renderFrame(rendered, safeWidth, theme);
        },

        handleInput(data: string): void {
          if (lastWidth < 20) {
            if (matchesKey(data, Key.escape)) complete("close");
            return;
          }
          const selectionRows = rows();
          if (matchesKey(data, Key.up)) {
            if (previewOffset >= previewMaxOffset) {
              if (selected > 0) selected -= 1;
              else previewOffset = Math.max(0, previewOffset - 1);
            } else previewOffset = Math.max(0, previewOffset - 1);
          } else if (matchesKey(data, Key.down)) {
            if (previewOffset >= previewMaxOffset) selected = Math.min(selectionRows.length - 1, selected + 1);
            else previewOffset = Math.min(previewMaxOffset, previewOffset + 1);
          } else if (matchesKey(data, Key.left)) {
            const row = selectionRows[selected];
            if (row && row.kind !== "action") changeControl(row, -1);
          } else if (matchesKey(data, Key.right)) {
            const row = selectionRows[selected];
            if (row && row.kind !== "action") changeControl(row, 1);
          } else if (matchesKey(data, Key.pageUp)) {
            previewOffset = Math.max(0, previewOffset - 5);
          } else if (matchesKey(data, Key.pageDown)) {
            previewOffset = Math.min(previewMaxOffset, previewOffset + 5);
          } else if (reportCount > 0 && /^[rR]$/.test(data)) {
            previewMode = previewMode === "report" ? "plan" : "report";
            if (previewMode === "report") reportIndex = reportCount - 1;
            markdown = new Markdown(currentPreviewSource(), 0, 0, markdownTheme(theme));
            previewOffset = 0;
            previewMaxOffset = 0;
            status = previewMode === "report"
              ? (reportCount > 1 ? `Viewing review report ${reportIndex + 1}/${reportCount} — R returns to Plan, [ ] cycles history` : "Viewing the review report — R returns to the Plan preview")
              : "Viewing the Plan — R opens the review report";
          } else if (reportCount > 1 && previewMode === "report" && /^(\[|\])$/.test(data)) {
            const direction = data === "]" ? 1 : -1;
            reportIndex = (reportIndex + direction + reportCount) % reportCount;
            markdown = new Markdown(currentPreviewSource(), 0, 0, markdownTheme(theme));
            previewOffset = 0;
            previewMaxOffset = 0;
            status = `Viewing review report ${reportIndex + 1}/${reportCount} — [ ] cycles history`;
          } else if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1;
            if (index < actions.length) {
              complete(actions[index]!.action);
              return;
            }
          } else if (matchesKey(data, Key.enter)) {
            choose();
            return;
          } else if (matchesKey(data, Key.ctrl("enter")) || CTRL_ENTER_SEQUENCES.has(data)) {
            complete("execute");
            return;
          } else if (matchesKey(data, Key.escape)) {
            complete("close");
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

  return result ?? { action: "close" };
}

function availableWorkflowTargets(options: PlanConfirmationOptions): PlanWorkflowTarget[] {
  return [
    ...(options.workflow?.current?.available ? ["current" as const] : []),
    ...(options.workflow?.allowNew ? ["new" as const] : []),
  ];
}

function preferredWorkflowTarget(
  options: PlanConfirmationOptions,
  currentAvailable: boolean,
): PlanWorkflowTarget {
  const preferred = options.defaultExecution?.workflowTarget;
  if (preferred === "current" && currentAvailable) return preferred;
  if (preferred === "new" && options.workflow?.allowNew) return preferred;
  return currentAvailable ? "current" : "new";
}

function workflowUnavailableMessage(options: PlanConfirmationOptions): string {
  return options.workflow?.current?.reason
    ?? "Workflow execution is unavailable because no writable Workflow Session target exists.";
}

function rowLabel(
  row: SelectionRow,
  actions: ActionItem[],
  options: PlanConfirmationOptions,
  backend: PlanExecutionBackend,
  target: PlanWorkflowTarget,
  context: PlanExecutionContextMode,
): string {
  if (row.kind === "backend") return `Execution  [${backend === "standalone" ? "Standalone" : "Workflow"}]`;
  if (row.kind === "target") {
    if (target === "new") return "Workflow target  [Create new Session]";
    const id = options.workflow?.current?.sessionId ?? "current";
    return `Workflow target  [Current: ${id}]`;
  }
  if (row.kind === "context") return `Context  [${context === "compact" ? "Compact current" : "Current"}]`;
  const number = actions.findIndex((item) => item.action === row.item.action);
  const prefix = number >= 0 ? `${number + 1}. ` : "";
  return `${prefix}${row.item.label}`;
}

function rowDescription(row: SelectionRow, options: PlanConfirmationOptions): string {
  if (row.kind === "backend") return "Choose local Todo/Goal execution or canonical Workflow Session/Run execution";
  if (row.kind === "target") {
    return options.workflow?.current?.intent
      ? `Current intent: ${options.workflow.current.intent}`
      : "Select the canonical Workflow Session target";
  }
  if (row.kind === "context") return "Keep this Pi session; compaction only replaces model context";
  return row.item.description;
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
