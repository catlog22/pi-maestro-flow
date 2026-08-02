import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lockSettingsResourceSync } from "../settings/resource-lock.ts";
import { isPlanMode } from "./plan.ts";

interface PlanModelPatch {
  present: boolean;
  model?: string;
}

export interface PlanModelRuntimeOptions {
  isPlanMode?: () => boolean;
  loadModel?: (cwd: string, projectTrusted: boolean) => string | undefined;
}

function readPlanModelPatch(filePath: string): PlanModelPatch {
  if (!existsSync(filePath)) return { present: false };
  try {
    const root = JSON.parse(readFileSync(filePath, "utf8")) as { plan?: unknown };
    if (!root.plan || typeof root.plan !== "object" || Array.isArray(root.plan)) return { present: false };
    const plan = root.plan as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(plan, "model")) return { present: false };
    if (plan.model === null) return { present: true };
    if (typeof plan.model !== "string" || plan.model.trim().length === 0) return { present: false };
    return { present: true, model: plan.model.trim() };
  } catch {
    return { present: false };
  }
}

export function resolvePlanModelSettingsPaths(cwd: string): string[] {
  const userDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [
    join(userDir, "settings.json"),
    join(cwd, ".pi", "settings.json"),
    join(cwd, ".pi", "settings.local.json"),
  ];
}

export function loadPlanModelSetting(cwd: string, projectTrusted = true): string | undefined {
  let model: string | undefined;
  const paths = resolvePlanModelSettingsPaths(cwd);
  const candidates = projectTrusted ? paths : paths.slice(0, 1);
  for (const filePath of candidates) {
    const patch = readPlanModelPatch(filePath);
    if (patch.present) model = patch.model;
  }
  return model;
}

export function saveLocalPlanModelSetting(cwd: string, model: string | null): void {
  const filePath = join(cwd, ".pi", "settings.local.json");
  const release = lockSettingsResourceSync(filePath);
  let temporary: string | undefined;
  let descriptor: number | undefined;
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("settings.local.json must contain a JSON object");
      }
      root = parsed as Record<string, unknown>;
    }
    const plan = root.plan && typeof root.plan === "object" && !Array.isArray(root.plan)
      ? { ...(root.plan as Record<string, unknown>) }
      : {};
    plan.model = model;
    root.plan = plan;
    mkdirSync(dirname(filePath), { recursive: true });
    temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    temporary = undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (temporary !== undefined) {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
    release();
  }
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function parseModelReference(reference: string): { provider: string; id: string } | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}

export function registerPlanModelSelection(
  pi: ExtensionAPI,
  options: PlanModelRuntimeOptions = {},
): void {
  const planModeActive = options.isPlanMode ?? isPlanMode;
  const configuredModel = options.loadModel ?? loadPlanModelSetting;
  let restoreModel: NonNullable<ExtensionContext["model"]> | undefined;
  const warnedMessages = new Set<string>();

  pi.registerCommand("plan-model", {
    description: "Configure the dedicated model used in Plan mode",
    async handler(args, ctx) {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this workspace before saving a project-local Plan model.", "warning");
        return;
      }
      const available = ctx.modelRegistry.getAvailable();
      const references = available.map((model) => modelKey(model)!).sort();
      const requested = args.trim();
      let selected: string | null | undefined;
      if (requested) {
        selected = ["off", "default", "session"].includes(requested.toLowerCase()) ? null : requested;
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /plan-model provider/model or /plan-model off", "warning");
          return;
        }
        const follow = "Follow session model";
        const choice = await ctx.ui.select("Plan mode model", [follow, ...references]);
        if (!choice) return;
        selected = choice === follow ? null : choice;
      }
      if (selected !== null && !references.includes(selected)) {
        ctx.ui.notify(`Plan model ${selected} is not available.`, "warning");
        return;
      }
      try {
        saveLocalPlanModelSetting(ctx.cwd, selected);
        warnedMessages.clear();
        ctx.ui.notify(selected ? `Plan model: ${selected}` : "Plan model follows the session model.", "info");
      } catch (error) {
        ctx.ui.notify(`Could not save Plan model: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  const warnOnce = (ctx: ExtensionContext, message: string): void => {
    if (warnedMessages.has(message)) return;
    warnedMessages.add(message);
    ctx.ui.notify(message, "warning");
  };

  const restore = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!restoreModel) return true;
    if (modelKey(ctx.model) === modelKey(restoreModel)) {
      restoreModel = undefined;
      return true;
    }
    try {
      if (!await pi.setModel(restoreModel)) {
        warnOnce(ctx, `Could not restore the Act model ${modelKey(restoreModel)}; it has no configured authentication.`);
        return false;
      }
      restoreModel = undefined;
      warnedMessages.clear();
      return true;
    } catch (error) {
      warnOnce(ctx, `Could not restore the Act model ${modelKey(restoreModel)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (restoreModel) await restore(ctx);
    if (!restoreModel) warnedMessages.clear();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Outside Plan mode the configured value is never used, so checking the
    // mode first keeps ordinary Act turns from probing the settings files.
    if (!planModeActive()) {
      await restore(ctx);
      return;
    }
    const reference = configuredModel(ctx.cwd, ctx.isProjectTrusted());
    if (!reference) {
      await restore(ctx);
      return;
    }

    const parsed = parseModelReference(reference);
    const target = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
    if (!target) {
      await restore(ctx);
      warnOnce(ctx, `Plan model ${reference} is unavailable; continuing with the session model.`);
      return;
    }
    if (modelKey(ctx.model) === modelKey(target)) return;

    const previous = ctx.model;
    try {
      if (!await pi.setModel(target)) {
        await restore(ctx);
        warnOnce(ctx, `Plan model ${reference} has no configured authentication; continuing with the session model.`);
        return;
      }
      if (!restoreModel && previous) restoreModel = previous;
      warnedMessages.clear();
    } catch (error) {
      await restore(ctx);
      warnOnce(ctx, `Could not select Plan model ${reference}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (await restore(ctx)) warnedMessages.clear();
  });
}
