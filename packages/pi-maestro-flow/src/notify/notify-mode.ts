/**
 * Desktop notification mode for model settlement, errors, and interaction
 * points that block waiting for user input.
 *
 * Mirrors `registerChineseResponseMode`'s lifecycle: a global persistent
 * switch in `~/.pi/maestro-notify-mode.json` (workspace-independent), a
 * `/notify` slash command, and lightweight event listeners registered by the
 * extension entry point. Pure public API — no patches.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NOTIFY_STATE_ENTRY = "maestro-notify-mode";
const NOTIFY_GLOBAL_STATE_FILE = "maestro-notify-mode.json";

/** Default config: all notification categories enabled. */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enabled: true,
  onError: true,
  onComplete: true,
  onInput: true,
};

export interface NotifyConfig {
  enabled: boolean;
  /** Notify when the model/provider returns an error (HTTP ≥400 or stopReason "error"). */
  onError: boolean;
  /** Notify when an agent turn fully settles (no retry/compaction/continuation pending). */
  onComplete: boolean;
  /** Notify when Pi is blocked waiting for a user decision or answer. */
  onInput: boolean;
}

export function notifyGlobalStatePath(homeDir: string): string {
  return join(homeDir, ".pi", NOTIFY_GLOBAL_STATE_FILE);
}

/** Load the global notify config, or undefined when absent/malformed. */
export function loadNotifyGlobalState(homeDir: string): Partial<NotifyConfig> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(notifyGlobalStatePath(homeDir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const config: Partial<NotifyConfig> = {};
      if (typeof record.enabled === "boolean") config.enabled = record.enabled;
      if (typeof record.onError === "boolean") config.onError = record.onError;
      if (typeof record.onComplete === "boolean") config.onComplete = record.onComplete;
      if (typeof record.onInput === "boolean") config.onInput = record.onInput;
      if (Object.keys(config).length > 0) return config;
    }
  } catch {
    // Missing or malformed state falls back to the session branch.
  }
  return undefined;
}

/** Persist the global notify config (atomic write, last toggle wins). */
export function saveNotifyGlobalState(config: NotifyConfig, homeDir: string): void {
  const filePath = notifyGlobalStatePath(homeDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Merge partial state into the live config, returning the next full config. */
export function applyNotifyPatch(current: NotifyConfig, patch: Partial<NotifyConfig>): NotifyConfig {
  return {
    enabled: patch.enabled ?? current.enabled,
    onError: patch.onError ?? current.onError,
    onComplete: patch.onComplete ?? current.onComplete,
    onInput: patch.onInput ?? current.onInput,
  };
}

export interface NotifyModeHandle {
  getConfig(): NotifyConfig;
  setConfig(value: NotifyConfig, ctx: ExtensionContext): void;
  toggle(ctx: ExtensionContext): void;
}

const USAGE = "用法：/notify [on|off|error|complete|input|status]";

/**
 * Register the `/notify` slash command and resolve the initial config from
 * global state → session branch → defaults. Does not register event
 * listeners; the extension entry point wires those against `getConfig()`.
 */
export function registerNotifyMode(
  pi: ExtensionAPI,
  options: { homeDir?: string } = {},
): NotifyModeHandle {
  let config: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG };
  const stateHomeDir = options.homeDir ?? homedir();

  const persist = (next: NotifyConfig, ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void => {
    config = next;
    pi.appendEntry(NOTIFY_STATE_ENTRY, { ...next });
    try {
      saveNotifyGlobalState(next, stateHomeDir);
      ctx.ui.notify(message, type);
    } catch {
      ctx.ui.notify(`${message}（但全局配置保存失败）`, "warning");
    }
  };

  const describe = (cfg: NotifyConfig): string =>
    `模型通知：${cfg.enabled ? "已开启" : "已关闭"}`
    + `（报错${cfg.onError ? "✓" : "✕"} / 完成${cfg.onComplete ? "✓" : "✕"} / 等待输入${cfg.onInput ? "✓" : "✕"}）`;

  pi.registerCommand("notify", {
    description: "切换模型完成/报错/等待输入提醒，支持 on、off、error、complete、input、status",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(describe(config), "info");
        return;
      }
      if (action === "" ) {
        // Bare /notify toggles the master switch.
        persist(applyNotifyPatch(config, { enabled: !config.enabled }), ctx, describe({ ...config, enabled: !config.enabled }));
        return;
      }
      if (action === "on" || action === "enable") {
        persist({ ...config, enabled: true }, ctx, describe({ ...config, enabled: true }));
        return;
      }
      if (action === "off" || action === "disable") {
        persist({ ...config, enabled: false }, ctx, describe({ ...config, enabled: false }));
        return;
      }
      if (action === "error") {
        const next = { ...config, enabled: true, onError: !config.onError };
        persist(next, ctx, describe(next));
        return;
      }
      if (action === "complete") {
        const next = { ...config, enabled: true, onComplete: !config.onComplete };
        persist(next, ctx, describe(next));
        return;
      }
      if (action === "input") {
        const next = { ...config, enabled: true, onInput: !config.onInput };
        persist(next, ctx, describe(next));
        return;
      }
      ctx.ui.notify(USAGE, "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const globalState = loadNotifyGlobalState(stateHomeDir);
    if (globalState) {
      config = applyNotifyPatch(DEFAULT_NOTIFY_CONFIG, globalState);
      return;
    }
    const entries = ctx.sessionManager.getBranch() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
    const state = entries
      .filter((entry) => entry.type === "custom" && entry.customType === NOTIFY_STATE_ENTRY)
      .at(-1)?.data as Partial<NotifyConfig> | undefined;
    if (state) config = applyNotifyPatch(DEFAULT_NOTIFY_CONFIG, state);
  });

  return {
    getConfig: () => config,
    setConfig: (value, ctx) => persist(value, ctx, describe(value)),
    toggle: (ctx) => persist({ ...config, enabled: !config.enabled }, ctx, describe({ ...config, enabled: !config.enabled })),
  };
}
