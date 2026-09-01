/**
 * Plan-confirm AI review support.
 *
 * The review action in plan-confirm spawns a teammate subagent to audit the
 * Plan draft (read-only analysis), reporting findings back so the main agent
 * can revise the Plan. The review model is chosen per review via a one-shot
 * search picker (`pickReviewModel`); the selection is never persisted. Prior
 * review reports for the current Plan revision are kept in memory as history,
 * injected into the next reviewer prompt and switchable in the confirm panel.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  SelectList,
  type SelectListTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { runTeammate } from "pi-maestro-teammate/v1/execution";
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
import { createDirectTeammateRunOptions } from "./direct-teammate.ts";

const DEFAULT_REVIEW_TIMEOUT_MS = 180_000;
/** Cap each prior review report injected into the next reviewer prompt. */
const REVIEW_HISTORY_REPORT_BUDGET = 2000;

/** Sentinel option shown in the review-model picker. */
export const FOLLOW_SESSION_LABEL = "Follow session model";

export interface ReviewHistoryEntry {
  report: string;
  modelLabel: string;
}

export interface PlanReviewResult {
  ok: boolean;
  report?: string;
  error?: string;
}

export interface RunPlanReviewOptions {
  markdown: string;
  model: string;
  /** Prior review reports for the current Plan revision, oldest first. */
  history?: ReviewHistoryEntry[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Structural context subset satisfied by both ExtensionContext and PlanContext. */
type PlanReviewContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "model" | "modelRegistry" | "isProjectTrusted"
>;

interface ReviewModelChoice {
  /** provider/model reference passed to the review subagent. */
  model: string;
  /** Display label for the progress overlay. */
  label: string;
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * List available teammate model references (provider/model, sorted) for the
 * review-model picker. Refreshes the registry only when the cached snapshot
 * is empty so opening the picker stays cheap.
 */
export async function listAvailableReviewModels(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<string[]> {
  const registry = ctx.modelRegistry;
  const available = registry?.getAvailable?.() ?? [];
  if (available.length === 0) {
    await refreshModelRegistry(ctx);
  }
  return (ctx.modelRegistry?.getAvailable?.() ?? [])
    .map((entry) => modelKey(entry))
    .filter((key): key is string => Boolean(key))
    .sort();
}

/**
 * Resolve the model used by the review subagent when the confirm TUI picker
 * is unavailable (no UI): fall back to the session model. Interactive
 * selection lives in `pickReviewModel`.
 */
function resolveReviewModelFallback(ctx: Pick<ExtensionContext, "model" | "ui">): ReviewModelChoice | undefined {
  const sessionKey = modelKey(ctx.model);
  if (!sessionKey) {
    ctx.ui.notify("AI review unavailable: no session model is set.", "warning");
    return undefined;
  }
  return { model: sessionKey, label: FOLLOW_SESSION_LABEL };
}

/**
 * One-shot review-model picker with prefix search. Shows a search Input above
 * a SelectList of [Follow session model, ...available provider/model refs];
 * typing filters the list by prefix (case-insensitive). Enter confirms the
 * highlighted option, Esc cancels. Returns the resolved model or undefined.
 */
export async function pickReviewModel(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "model">,
  models: string[],
  signal?: AbortSignal,
): Promise<ReviewModelChoice | undefined> {
  if (signal?.aborted) return undefined;
  if (!ctx.hasUI) return resolveReviewModelFallback(ctx);
  const options = [FOLLOW_SESSION_LABEL, ...models];
  const items = options.map((value) => ({ value, label: value }));
  const result = await ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => {
      const listTheme: SelectListTheme = {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: () => "",
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      };
      const input = new Input();
      const maxVisible = Math.min(options.length, 10);
      const list = new SelectList(items, maxVisible, listTheme);
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        done(value);
      };
      const onAbort = (): void => finish(undefined);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(undefined);
      const syncFilter = () => list.setFilter(input.getValue());
      syncFilter();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      return {
        render(width: number): string[] {
          const inner = Math.max(1, width - 2);
          const border = (text: string) => theme.fg("dim", text);
          const header = theme.bold("Plan review model");
          const searchLabel = theme.fg("dim", "Search:");
          const searchInputWidth = Math.max(1, inner - visibleWidth("Search: "));
          const searchLine = `${searchLabel} ${input.render(searchInputWidth).join("")}`;
          const renderedList = list.render(inner);
          const footer = theme.fg("dim", "Type to filter (prefix) · ↑↓ navigate · Enter select · Esc cancel");
          const rows = [header, "", searchLine, "", ...renderedList, "", footer];
          return [
            border(`╭${"─".repeat(inner)}╮`),
            ...rows.map((row) => {
              const content = truncateToWidth(row, inner, "…");
              return `${border("│")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border("│")}`;
            }),
            border(`╰${"─".repeat(inner)}╯`),
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish(undefined);
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const selected = list.getSelectedItem();
            finish(selected?.value);
            return;
          }
          if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
            list.handleInput(data);
            return;
          }
          // Printable characters and editing keys go to the search input.
          input.handleInput(data);
          syncFilter();
        },
        invalidate(): void {
          input.invalidate();
          list.invalidate();
        },
        dispose(): void {
          finish(undefined);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "60%",
        minWidth: 40,
        maxHeight: 20,
        anchor: "center" as const,
      },
    },
  );
  if (result === undefined) return undefined;
  if (result === FOLLOW_SESSION_LABEL) {
    const sessionKey = modelKey(ctx.model);
    if (!sessionKey) {
      ctx.ui.notify("AI review unavailable: no session model is set.", "warning");
      return undefined;
    }
    return { model: sessionKey, label: FOLLOW_SESSION_LABEL };
  }
  return { model: result, label: result };
}

function truncateReport(report: string, budget: number): string {
  if (report.length <= budget) return report;
  return `${report.slice(0, budget)}…`;
}

export function buildReviewPrompt(markdown: string, history: ReviewHistoryEntry[]): string {
  const lines: string[] = [
    "MODE: analysis",
    "",
    "你是 Pi Plan 模式的独立 AI 审核官（reviewer）。审查下面的实施计划，找出可能导致执行失败、范围偏差或返工的问题。",
    "你可以只读浏览当前工作区以核实计划与仓库现状的一致性，但不得修改任何文件。",
  ];
  if (history.length > 0) {
    lines.push(
      "",
      `## 前次 review 报告（共 ${history.length} 份，供参考，避免重复已指出的问题，聚焦新发现）`,
    );
    history.forEach((entry, index) => {
      lines.push(
        `### 前次报告 ${index + 1}（model: ${entry.modelLabel}）`,
        truncateReport(entry.report, REVIEW_HISTORY_REPORT_BUDGET),
        "",
      );
    });
  }
  lines.push(
    "",
    "请按以下维度审查，并输出一份 Markdown 审核报告：",
    "1. ## 总体结论 — 建议 批准 / 修订 / 重写，一句话说明理由。",
    "2. ## 问题清单 — 按 P0（阻塞执行）/ P1（重要）/ P2（建议）分级；每条问题给出在计划中的位置或行内引用，以及影响。",
    "3. ## 目标与范围 — 目标是否明确、范围是否蔓延或收缩、是否遗漏了用户需求或隐含约束。",
    "4. ## 可执行性与依赖 — 步骤是否可落地、依赖顺序是否正确、是否缺少前置条件或回滚路径。",
    "5. ## 验收标准 — 是否可验证、可量化；对缺失或模糊处给出具体补充建议。",
    "6. ## 风险与边界 — 未识别的风险、失败后的恢复与止损方式。",
    "7. ## 修改建议 — 针对每个 P0/P1 问题给出可直接采纳的修改建议。",
    "",
    "输出语言与计划主体语言一致；若计划为中文则用中文报告。只输出审核报告本身，不要客套、不要复述计划内容。",
    "",
    "<plan>",
    markdown,
    "</plan>",
  );
  return lines.join("\n");
}

/**
 * Spawn a teammate subagent (read-only analysis) to review the Plan draft with
 * the requested model and return its Markdown report.
 */
export async function runPlanReview(
  pi: ExtensionAPI,
  ctx: PlanReviewContext,
  options: RunPlanReviewOptions,
): Promise<PlanReviewResult> {
  try {
    const [result] = await runTeammate(
      {
        tasks: [{
          agent: "general",
          prompt: buildReviewPrompt(options.markdown, options.history ?? []),
          taskType: "analysis",
          model: options.model,
          context: "fresh",
          timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
        }],
        background: false,
        reply_to: "caller",
      },
      await createDirectTeammateRunOptions(pi, ctx as unknown as ExtensionContext, {
        baseCwd: ctx.cwd,
        signal: options.signal,
      }),
    );
    if (!result) return { ok: false, error: "Review agent returned no result." };
    const lastMessage = result.messages[result.messages.length - 1]?.content ?? "";
    if (result.exitCode !== 0 || !lastMessage.trim()) {
      return {
        ok: false,
        error: lastMessage.trim() || `Review agent exited with code ${result.exitCode}.`,
      };
    }
    return { ok: true, report: lastMessage.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
