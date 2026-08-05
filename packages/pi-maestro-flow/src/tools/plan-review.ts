/**
 * Plan-confirm AI review support.
 *
 * The review action in plan-confirm spawns a teammate subagent to audit the
 * Plan draft (read-only analysis), reporting findings back so the main agent
 * can revise the Plan. The review model is user-configurable: the first
 * selection is persisted to `.pi/settings.local.json` under `plan.review.model`
 * (mirroring `plan.model` for the Plan-mode model), and `/plan-review-model`
 * changes it later.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTeammate } from "pi-maestro-teammate/v1/execution";
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
import { lockSettingsResource } from "../settings/resource-lock.ts";
import { createDirectTeammateRunOptions } from "./direct-teammate.ts";
import { resolvePlanModelSettingsPaths } from "./plan-model.ts";

const DEFAULT_REVIEW_TIMEOUT_MS = 180_000;

/** Sentinel option shown in the confirm TUI review-model row. */
export const FOLLOW_SESSION_LABEL = "Follow session model";

interface PlanReviewModelPatch {
  present: boolean;
  model?: string;
}

export interface PlanReviewModelResolution {
  /** provider/model reference passed to the review subagent. */
  model: string;
  /** Display label for the confirmation TUI. */
  label: string;
}

export interface PlanReviewResult {
  ok: boolean;
  report?: string;
  error?: string;
}

export interface PlanReviewModelRuntimeOptions {
  loadModel?: (cwd: string, projectTrusted: boolean) => string | undefined;
}

export interface RunPlanReviewOptions {
  markdown: string;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Structural context subset satisfied by both ExtensionContext and PlanContext. */
type PlanReviewContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "model" | "modelRegistry" | "isProjectTrusted"
>;

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function parseModelReference(reference: string): { provider: string; id: string } | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}

function readPlanReviewModelPatch(filePath: string): PlanReviewModelPatch {
  if (!existsSync(filePath)) return { present: false };
  try {
    const root = JSON.parse(readFileSync(filePath, "utf8")) as { plan?: unknown };
    if (!root.plan || typeof root.plan !== "object" || Array.isArray(root.plan)) return { present: false };
    const review = (root.plan as Record<string, unknown>).review;
    if (!review || typeof review !== "object" || Array.isArray(review)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(review, "model")) return { present: false };
    const model = (review as Record<string, unknown>).model;
    if (model === null) return { present: true };
    if (typeof model !== "string" || model.trim().length === 0) return { present: false };
    return { present: true, model: model.trim() };
  } catch {
    return { present: false };
  }
}

/** Read `plan.review.model` with the same user/project/local merge as `plan.model`. */
export function loadPlanReviewModelSetting(cwd: string, projectTrusted = true): string | undefined {
  let model: string | undefined;
  const candidates = projectTrusted
    ? resolvePlanModelSettingsPaths(cwd)
    : resolvePlanModelSettingsPaths(cwd).slice(0, 1);
  for (const filePath of candidates) {
    const patch = readPlanReviewModelPatch(filePath);
    if (patch.present) model = patch.model;
  }
  return model;
}

/** Persist `plan.review.model` into `.pi/settings.local.json`, preserving `plan.model`. */
export async function saveLocalPlanReviewModelSetting(cwd: string, model: string | null): Promise<void> {
  const filePath = join(cwd, ".pi", "settings.local.json");
  const release = await lockSettingsResource(filePath);
  let temporary: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("settings.local.json must contain a JSON object");
      }
      root = parsed as Record<string, unknown>;
    }
    const plan = root.plan && typeof root.plan === "object" && !Array.isArray(root.plan)
      ? { ...(root.plan as Record<string, unknown>) }
      : {};
    const review = plan.review && typeof plan.review === "object" && !Array.isArray(plan.review)
      ? { ...(plan.review as Record<string, unknown>) }
      : {};
    review.model = model;
    plan.review = review;
    root.plan = plan;
    await mkdir(dirname(filePath), { recursive: true });
    temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    temporary = undefined;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
    if (temporary) {
      try { await rm(temporary, { force: true }); } catch { /* best effort */ }
    }
    await release();
  }
}

/**
 * List available teammate model references (provider/model, sorted) for the
 * confirm TUI review-model row. Refreshes the registry only when the cached
 * snapshot is empty so opening the confirmation stays cheap.
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
 * Resolve the model used by the review subagent when the confirm TUI row is
 * unavailable: configured `plan.review.model` (validated, warned when stale)
 * falls back to the session model. Interactive selection lives in the confirm
 * TUI review-model row and `/plan-review-model`.
 */
export async function resolvePlanReviewModel(
  ctx: Pick<
    ExtensionContext,
    "cwd" | "ui" | "modelRegistry" | "model" | "isProjectTrusted"
  >,
  options: PlanReviewModelRuntimeOptions = {},
): Promise<PlanReviewModelResolution> {
  const loadModel = options.loadModel ?? loadPlanReviewModelSetting;
  const sessionModel = modelKey(ctx.model) ?? "";
  const configured = loadModel(ctx.cwd, ctx.isProjectTrusted());
  if (configured) {
    await refreshModelRegistry(ctx);
    const parsed = parseModelReference(configured);
    const target = parsed ? ctx.modelRegistry?.find?.(parsed.provider, parsed.id) : undefined;
    if (target) return { model: configured, label: configured };
    ctx.ui.notify(`Configured Plan review model ${configured} is unavailable; using the session model.`, "warning");
  }
  return { model: sessionModel, label: sessionModel };
}

function buildReviewPrompt(markdown: string): string {
  return [
    "MODE: analysis",
    "",
    "你是 Pi Plan 模式的独立 AI 审核官（reviewer）。审查下面的实施计划，找出可能导致执行失败、范围偏差或返工的问题。",
    "你可以只读浏览当前工作区以核实计划与仓库现状的一致性，但不得修改任何文件。",
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
  ].join("\n");
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
          prompt: buildReviewPrompt(options.markdown),
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

/**
 * `/plan-review-model [provider/model|off]` — set the Plan-confirm AI review
 * model, mirroring `/plan-model` semantics. `off`/`default`/`session` clears
 * the override so the session model is used.
 */
export function registerPlanReviewModelCommand(
  pi: ExtensionAPI,
  options: PlanReviewModelRuntimeOptions = {},
): void {
  const loadModel = options.loadModel ?? loadPlanReviewModelSetting;
  pi.registerCommand("plan-review-model", {
    description: "Configure the model used by the Plan-confirm AI review subagent",
    async handler(args, ctx) {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this workspace before saving a project-local Plan review model.", "warning");
        return;
      }
      await refreshModelRegistry(ctx);
      const references = ctx.modelRegistry
        .getAvailable()
        .map((entry) => modelKey(entry))
        .filter((key): key is string => Boolean(key))
        .sort();
      const requested = args.trim();
      let selected: string | null | undefined;
      if (requested) {
        selected = ["off", "default", "session", "follow"].includes(requested.toLowerCase())
          ? null
          : requested;
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /plan-review-model provider/model or /plan-review-model off", "warning");
          return;
        }
        const choice = await ctx.ui.select("Plan review model", [FOLLOW_SESSION_LABEL, ...references]);
        if (!choice) return;
        selected = choice === FOLLOW_SESSION_LABEL ? null : choice;
      }
      if (selected !== null && !references.includes(selected)) {
        ctx.ui.notify(`Plan review model ${selected} is not available.`, "warning");
        return;
      }
      try {
        await saveLocalPlanReviewModelSetting(ctx.cwd, selected);
        ctx.ui.notify(
          selected ? `Plan review model: ${selected}` : "Plan review model follows the session model.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not save Plan review model: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    },
  });
}
