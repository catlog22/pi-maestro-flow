/**
 * Review & Refine — general role-based plan refinement.
 *
 * Replaces the single-purpose AI review with a multi-role panel: each role
 * (reviewer / decomposer / optimizer / brainstormer) runs a read-only teammate
 * subagent over the current Plan draft, and the user can iterate with free-form
 * input and switch roles/models in one continuous session. Apply and Discard
 * are handled in this panel before returning to Plan confirmation.
 *
 * `plan-review.ts` remains the home of the reviewer prompt and the reusable
 * model picker (`pickReviewModel`, `listAvailableReviewModels`,
 * `FOLLOW_SESSION_LABEL`); this module reuses them and adds the remaining
 * roles plus the orchestrating session UI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/v1/execution";
import {
  FOLLOW_SESSION_LABEL,
  listAvailableReviewModels,
  pickReviewModel,
  buildReviewPrompt,
} from "./plan-review.ts";
import { createDirectTeammateRunOptions } from "./direct-teammate.ts";

const DEFAULT_REFINE_TIMEOUT_MS = 180_000;
/** Cap each prior turn injected into the next role prompt. */
const REFINE_HISTORY_REPORT_BUDGET = 2000;

export type RefineRole = "reviewer" | "decomposer" | "optimizer" | "brainstormer";

/** How a role's output is applied when the user picks "Apply refine result". */
export type RefineAppliesAs = "feedback" | "draft";

export interface RefineTurn {
  role: RefineRole;
  modelLabel: string;
  /** User instruction for this run; empty for a bare first pass. */
  userInput: string;
  /** Markdown output returned by the role subagent. */
  output: string;
  createdAt: string;
}

export interface RefineSession {
  turns: RefineTurn[];
  currentRole: RefineRole;
  currentModel: { model: string; label: string };
}

export interface RefineRoleSpec {
  role: RefineRole;
  label: string;
  description: string;
  taskType: "analysis" | "planning";
  appliesAs: RefineAppliesAs;
  buildPrompt: (plan: string, history: RefineTurn[], userInput: string) => string;
}

export interface RefineRunResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface RunRefineOptions {
  prompt: string;
  model: string;
  taskType: "analysis" | "planning";
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OpenRefinePanelOptions {
  markdown: string;
  initialRole?: RefineRole;
  session?: RefineSession;
  signal?: AbortSignal;
}

export interface RefinePanelResult {
  action: "apply" | "discard" | "cancel";
  session: RefineSession;
  latestOutput?: string;
  latestRole?: RefineRole;
  latestAppliesAs?: RefineAppliesAs;
}

type PlanRefineContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "model" | "modelRegistry" | "isProjectTrusted"
>;

const REFINE_ROLE_ORDER: RefineRole[] = ["reviewer", "decomposer", "optimizer", "brainstormer"];

export const REFINE_ROLES: Record<RefineRole, RefineRoleSpec> = {
  reviewer: {
    role: "reviewer",
    label: "审核官 Reviewer",
    description: "只读审计：分级问题清单 + 修改建议",
    taskType: "analysis",
    appliesAs: "feedback",
    buildPrompt: (plan, history, userInput) => buildReviewPrompt(plan, refineHistoryToReviewHistory(history, "reviewer")) + refineUserInputSuffix(userInput),
  },
  decomposer: {
    role: "decomposer",
    label: "拆解官 Decomposer",
    description: "拆为可执行步骤图 + 依赖与风险标注",
    taskType: "analysis",
    appliesAs: "feedback",
    buildPrompt: buildDecomposerPrompt,
  },
  optimizer: {
    role: "optimizer",
    label: "优化官 Optimizer",
    description: "针对结构/清晰度/可验收性给出可采纳改写",
    taskType: "planning",
    appliesAs: "draft",
    buildPrompt: buildOptimizerPrompt,
  },
  brainstormer: {
    role: "brainstormer",
    label: "脑暴官 Brainstormer",
    description: "发散补充遗漏目标/边界/方案，列出开放问题",
    taskType: "analysis",
    appliesAs: "feedback",
    buildPrompt: buildBrainstormerPrompt,
  },
};

function refineUserInputSuffix(userInput: string): string {
  const trimmed = userInput.trim();
  if (!trimmed) return "";
  return `\n\n## 本次用户指令\n${trimmed}`;
}

function refineHistoryToReviewHistory(history: RefineTurn[], role: RefineRole): { report: string; modelLabel: string }[] {
  return history
    .filter((turn) => turn.role === role)
    .map((turn) => ({ report: turn.output, modelLabel: turn.modelLabel }));
}

function truncateOutput(output: string, budget: number): string {
  if (output.length <= budget) return output;
  return `${output.slice(0, budget)}…`;
}

function buildHistorySection(history: RefineTurn[], role: RefineRole): string {
  const prior = history.filter((turn) => turn.role === role);
  if (prior.length === 0) return "";
  const lines: string[] = [
    "",
    `## 前次 refine 输出（共 ${prior.length} 份，同角色，供参考，避免重复已指出的问题，聚焦新发现）`,
  ];
  prior.forEach((turn, index) => {
    lines.push(
      `### 前次输出 ${index + 1}（model: ${turn.modelLabel}）`,
      truncateOutput(turn.output, REFINE_HISTORY_REPORT_BUDGET),
      "",
    );
  });
  return lines.join("\n");
}

function buildRolePreamble(role: RefineRole, instruction: string): string {
  return [
    "MODE: analysis",
    "",
    instruction,
    "你可以只读浏览当前工作区以核实计划与仓库现状的一致性，但不得修改任何文件。",
  ].join("\n");
}

export function buildDecomposerPrompt(plan: string, history: RefineTurn[], userInput: string): string {
  return [
    buildRolePreamble("decomposer", "你是 Pi Plan 模式的「拆解官」。把下面的实施计划拆解为可执行的步骤图，标注依赖顺序与风险。"),
    buildHistorySection(history, "decomposer"),
    "",
    "请按以下维度输出 Markdown：",
    "1. ## 总体结论 — 一句话说明计划是否已具备可执行性。",
    "2. ## 步骤图 — 有序步骤列表，每步给出：目标、前置依赖、产出物、验收点。",
    "3. ## 关键路径与并行 — 标注关键路径与可并行步骤。",
    "4. ## 风险与前置条件 — 阻塞执行的依赖缺口、环境前提、回滚路径。",
    "5. ## 建议补强 — 针对缺失步骤或顺序错误给出可直接采纳的修正。",
    "",
    "输出语言与计划主体语言一致；只输出拆解结果，不要复述计划内容。",
    refineUserInputSuffix(userInput),
    "",
    "<plan>",
    plan,
    "</plan>",
  ].filter(Boolean).join("\n");
}

export function buildOptimizerPrompt(plan: string, history: RefineTurn[], userInput: string): string {
  return [
    "MODE: analysis",
    "",
    "你是 Pi Plan 模式的「优化官」。针对下面实施计划的结构、清晰度与可验收性，给出一份可直接采纳的改写草稿（完整 Markdown），而非建议清单。",
    "你可以只读浏览当前工作区以核实一致性，但不得修改任何文件。",
    buildHistorySection(history, "optimizer"),
    "",
    "要求：",
    "- 保留原计划的有效决策与范围边界，不引入未经验证的新假设。",
    "- 修正模糊、缺失验收标准、依赖错位或结构混乱之处。",
    "- 输出一份完整的、可直接作为 current.md 的 Markdown 计划草稿，不附加说明性前言。",
    refineUserInputSuffix(userInput),
    "",
    "<plan>",
    plan,
    "</plan>",
  ].filter(Boolean).join("\n");
}

export function buildBrainstormerPrompt(plan: string, history: RefineTurn[], userInput: string): string {
  return [
    buildRolePreamble("brainstormer", "你是 Pi Plan 模式的「脑暴官」。发散补充计划可能遗漏的目标、边界与替代方案，并列出需要用户决策的开放问题。"),
    buildHistorySection(history, "brainstormer"),
    "",
    "请按以下维度输出 Markdown：",
    "1. ## 遗漏目标 — 用户需求或隐含目标中未被计划覆盖的部分。",
    "2. ## 边界与约束 — 计划未声明的非目标、兼容性约束、失败止损边界。",
    "3. ## 替代方案 — 关键决策点的备选路径及权衡。",
    "4. ## 开放问题 — 需要用户决策的问题清单，按优先级排列。",
    "",
    "输出语言与计划主体语言一致；聚焦发散与补充，不要复述计划内容。",
    refineUserInputSuffix(userInput),
    "",
    "<plan>",
    plan,
    "</plan>",
  ].filter(Boolean).join("\n");
}

/**
 * Spawn a read-only teammate subagent for a refine role and return its output.
 * Shared by the reviewer path (kept compatible via plan-review.runPlanReview)
 * and the new roles.
 */
export async function runRefineSubagent(
  pi: ExtensionAPI,
  ctx: PlanRefineContext,
  options: RunRefineOptions,
): Promise<RefineRunResult> {
  try {
    const [result] = await runTeammate(
      {
        tasks: [{
          agent: "general",
          prompt: options.prompt,
          taskType: options.taskType,
          model: options.model,
          context: "fresh",
          timeoutMs: options.timeoutMs ?? DEFAULT_REFINE_TIMEOUT_MS,
        }],
        background: false,
        reply_to: "caller",
      },
      await createDirectTeammateRunOptions(pi, ctx as unknown as ExtensionContext, {
        baseCwd: ctx.cwd,
        signal: options.signal,
      }),
    );
    if (!result) return { ok: false, error: "Refine agent returned no result." };
    const lastMessage = result.messages[result.messages.length - 1]?.content ?? "";
    if (result.exitCode !== 0 || !lastMessage.trim()) {
      return {
        ok: false,
        error: lastMessage.trim() || `Refine agent exited with code ${result.exitCode}.`,
      };
    }
    return { ok: true, output: lastMessage.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Build a fresh session defaulting to the reviewer role and the session model. */
export function createRefineSession(initialRole: RefineRole, sessionModelLabel: string): RefineSession {
  return {
    turns: [],
    currentRole: initialRole,
    currentModel: { model: "", label: sessionModelLabel || FOLLOW_SESSION_LABEL },
  };
}

/** Cycle to the next/previous refine role. */
export function cycleRole(role: RefineRole, direction: 1 | -1): RefineRole {
  const index = REFINE_ROLE_ORDER.indexOf(role);
  const next = (index + direction + REFINE_ROLE_ORDER.length) % REFINE_ROLE_ORDER.length;
  return REFINE_ROLE_ORDER[next]!;
}

/**
 * Drive the Review & Refine panel. Delegates the TUI rendering/interaction to
 * `tui/plan-refine-overlay.ts` while owning the model picker and the run loop.
 * Returns the final session, selected action, and latest output metadata.
 */
export async function openRefinePanel(
  pi: ExtensionAPI,
  ctx: PlanRefineContext,
  options: OpenRefinePanelOptions,
): Promise<RefinePanelResult> {
  const initialRole = options.initialRole ?? "reviewer";
  const sessionModelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : FOLLOW_SESSION_LABEL;
  const session: RefineSession = options.session
    ? { ...options.session, turns: [...options.session.turns] }
    : createRefineSession(initialRole, sessionModelLabel);
  if (!session.currentModel.model) session.currentModel = { model: resolveSessionModelKey(ctx), label: sessionModelLabel };

  const { renderRefineOverlay } = await import("../tui/plan-refine-overlay.ts");
  const result = await renderRefineOverlay(ctx, {
    markdown: options.markdown,
    session,
    roles: REFINE_ROLES,
    pickModel: async () => {
      const models = await listAvailableReviewModels(ctx);
      const picked = await pickReviewModel(ctx, models);
      if (!picked) return undefined;
      return picked;
    },
    run: async (role, model, label, userInput, signal) => {
      const spec = REFINE_ROLES[role];
      const prompt = spec.buildPrompt(options.markdown, session.turns, userInput);
      return runRefineSubagent(pi, ctx, { prompt, model, taskType: spec.taskType, signal });
    },
    signal: options.signal,
  });

  return result;
}

function resolveSessionModelKey(ctx: PlanRefineContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
}
