import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ensureMaestroKeybindings,
  restorePiKeybindings,
  type KeybindingUpdateResult,
} from "../scripts/configure-keybindings.mjs";

const CHECK_LABEL = "检查当前快捷键冲突";
const FIX_LABEL = "修复冲突：思考强度改为 Ctrl+Shift+E，Maestro 使用 Shift+Tab";
const RESTORE_LABEL = "恢复 Pi 默认：思考强度使用 Shift+Tab";
const THINKING_ACTION = "app.thinking.cycle";
const DEFAULT_THINKING_KEY = "shift+tab";

export const MAESTRO_GLOBAL_SHORTCUTS = [
  { key: "shift+tab", owner: "Maestro approval mode" },
  { key: "alt+shift+p", owner: "Maestro Plan mode" },
  { key: "alt+t", owner: "Maestro Todo panel" },
  { key: "alt+g", owner: "Maestro Goal center" },
  { key: "alt+r", owner: "Teammate/Cockpit session list" },
  { key: "alt+w", owner: "Cockpit Window monitoring" },
  { key: "alt+e", owner: "Cockpit agent session detail" },
  { key: "alt+l", owner: "Cockpit sidebar focus" },
  { key: "ctrl+shift+r", owner: "Cockpit sidebar resize" },
  { key: "alt+m", owner: "Teammate control center" },
  { key: "alt+j", owner: "Cockpit background jobs" },
  { key: "alt+shift+t", owner: "Cockpit Todo center" },
  { key: "alt+shift+e", owner: "Prompt enhance" },
] as const;

type KeybindingAction = "check" | "fix" | "restore";
type UserKeybindings = Record<string, string | string[]>;

export interface ShortcutConflict {
  key: string;
  owners: string[];
}

function keyList(value: unknown): string[] {
  if (typeof value === "string") return [value.toLowerCase()];
  if (!Array.isArray(value)) return [];
  return value.filter((key): key is string => typeof key === "string").map((key) => key.toLowerCase());
}

export function auditShortcutConflicts(bindings: UserKeybindings): ShortcutConflict[] {
  const claims = new Map<string, Set<string>>();
  const claim = (key: string, owner: string) => {
    const owners = claims.get(key) ?? new Set<string>();
    owners.add(owner);
    claims.set(key, owners);
  };

  for (const shortcut of MAESTRO_GLOBAL_SHORTCUTS) claim(shortcut.key, shortcut.owner);

  const thinkingKeys = Object.hasOwn(bindings, THINKING_ACTION)
    ? keyList(bindings[THINKING_ACTION])
    : [DEFAULT_THINKING_KEY];
  for (const key of thinkingKeys) claim(key, `Pi ${THINKING_ACTION}`);

  for (const [action, configured] of Object.entries(bindings)) {
    if (action === THINKING_ACTION) continue;
    for (const key of keyList(configured)) claim(key, `Pi ${action}`);
  }

  return [...claims.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([key, owners]) => ({ key, owners: [...owners] }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function defaultKeybindingsPath(): string {
  return join(homedir(), ".pi", "agent", "keybindings.json");
}

function loadUserKeybindings(configPath = defaultKeybindingsPath()): { bindings?: UserKeybindings; error?: string } {
  if (!existsSync(configPath)) return { bindings: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "keybindings.json 的根节点必须是对象。" };
    }
    return { bindings: parsed as UserKeybindings };
  } catch (error) {
    return { error: `无法读取 keybindings.json：${error instanceof Error ? error.message : String(error)}` };
  }
}

function actionFromArgs(args: string): KeybindingAction | undefined {
  const action = args.trim().toLowerCase();
  if (["check", "audit", "status"].includes(action)) return "check";
  if (["fix", "apply", "set"].includes(action)) return "fix";
  if (["restore", "reset", "default"].includes(action)) return "restore";
  return undefined;
}

function formatConflicts(conflicts: ShortcutConflict[]): string {
  return conflicts.map((conflict) => `${conflict.key}: ${conflict.owners.join(" / ")}`).join("；");
}

function notifyUpdateResult(
  ctx: ExtensionContext,
  action: Exclude<KeybindingAction, "check">,
  result: KeybindingUpdateResult,
  configPath: string,
): void {
  if (result.status === "skipped") {
    ctx.ui.notify(`快捷键配置未修改：${result.message}`, "error");
    return;
  }

  if (action === "fix") {
    const prefix = result.status === "updated" ? "已保存 Shift+Tab 冲突修复。" : "Shift+Tab 修复配置未发生变化。";
    const loaded = loadUserKeybindings(configPath);
    if (!loaded.bindings) {
      ctx.ui.notify(`${prefix}${loaded.error ?? "无法复查快捷键配置。"}`, "warning");
      return;
    }
    const residual = auditShortcutConflicts(loaded.bindings);
    if (residual.length > 0) {
      ctx.ui.notify(`${prefix}仍有 ${residual.length} 个冲突：${formatConflicts(residual)}`, "warning");
      return;
    }
    ctx.ui.notify(`${prefix}执行 /reload 后：Ctrl+Shift+E 切换思考强度，Shift+Tab 切换 approval mode。未发现其他冲突。`, "info");
    return;
  }

  const prefix = result.status === "updated" ? "已恢复 Pi 默认配置。" : "当前已经是 Pi 默认配置。";
  ctx.ui.notify(`${prefix}执行 /reload 后 Shift+Tab 将切换思考强度，Maestro 的 Shift+Tab 会因冲突停用。`, "warning");
}

function notifyAudit(ctx: ExtensionContext, configPath: string): void {
  const loaded = loadUserKeybindings(configPath);
  if (!loaded.bindings) {
    ctx.ui.notify(loaded.error ?? "无法检查快捷键配置。", "error");
    return;
  }
  const conflicts = auditShortcutConflicts(loaded.bindings);
  if (conflicts.length === 0) {
    ctx.ui.notify(`未发现冲突。已检查 ${MAESTRO_GLOBAL_SHORTCUTS.length} 个 Maestro/Teammate/Cockpit 全局快捷键。`, "info");
    return;
  }
  const details = formatConflicts(conflicts);
  ctx.ui.notify(`发现 ${conflicts.length} 个快捷键冲突：${details}`, "warning");
}

export async function executeKeybindingsCommand(
  args: string,
  ctx: ExtensionContext,
  configPath = defaultKeybindingsPath(),
): Promise<void> {
  let action = actionFromArgs(args);
  if (args.trim() && !action) {
    ctx.ui.notify("用法：/maestro-keybindings [check|fix|restore]", "warning");
    return;
  }

  if (!action) {
    const choice = await ctx.ui.select("快捷键冲突管理", [CHECK_LABEL, FIX_LABEL, RESTORE_LABEL]);
    if (choice === undefined) return;
    action = choice === CHECK_LABEL ? "check" : choice === FIX_LABEL ? "fix" : "restore";
  }

  if (action === "check") {
    notifyAudit(ctx, configPath);
    return;
  }

  try {
    const result = action === "fix"
      ? ensureMaestroKeybindings(configPath)
      : restorePiKeybindings(configPath);
    notifyUpdateResult(ctx, action, result, configPath);
  } catch (error) {
    ctx.ui.notify(`快捷键配置未修改：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function registerKeybindingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("maestro-keybindings", {
    description: "检查、修改或恢复 Pi 快捷键映射，处理扩展快捷键冲突",
    async handler(args, ctx) {
      await executeKeybindingsCommand(args, ctx);
    },
  });
}
