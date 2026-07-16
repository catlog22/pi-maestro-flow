import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluatePermission, suggestedAllowRule } from "./policy.ts";
import { isTeammateChild, requestTeammateInteraction } from "./teammate-relay.ts";
import {
  addPermissionRule,
  loadPermissionSettings,
  setPermissionDefaultMode,
  updatePermissionRules,
  type LoadedPermissionSettings,
} from "./settings.ts";
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRequestHookDecision,
  PermissionRuleSettings,
  PermissionToolCall,
  PermissionUpdate,
} from "./types.ts";

export interface PermissionRequestHookRunner {
  requestPermission(
    call: PermissionToolCall,
    ctx: ExtensionContext,
    suggestion: string,
    forced: boolean,
  ): Promise<PermissionRequestHookDecision | undefined>;
}

export interface PermissionController {
  reload(ctx: ExtensionContext): Promise<PermissionMode | undefined>;
  setDefaultMode(ctx: ExtensionContext, mode: PermissionMode): Promise<void>;
  authorize(
    call: PermissionToolCall,
    ctx: ExtensionContext,
    mode: PermissionMode,
    hooks?: PermissionRequestHookRunner,
  ): Promise<{ block: true; reason: string } | undefined>;
  summary(mode: PermissionMode): string;
  bypassDisabled(): boolean;
}

export function createPermissionController(options: {
  userSettingsPath?: string;
  setMode?: (mode: PermissionMode, ctx: ExtensionContext) => void | Promise<void>;
} = {}): PermissionController {
  const userSettingsPath = options.userSettingsPath ?? join(getAgentDir(), "settings.json");
  let loaded: LoadedPermissionSettings | undefined;
  const sessionRules: Record<PermissionBehavior, string[]> = { allow: [], ask: [], deny: [] };

  return {
    async reload(ctx) {
      sessionRules.allow = [];
      sessionRules.ask = [];
      sessionRules.deny = [];
      loaded = await loadPermissionSettings(ctx.cwd, userSettingsPath);
      for (const error of loaded.errors) ctx.ui.notify(`权限配置无效：${error}`, "warning");
      for (const warning of loaded.warnings) ctx.ui.notify(`权限配置提示：${warning}`, "warning");
      const defaultMode = loaded.permissions.defaultMode;
      if (defaultMode === "bypassPermissions" && this.bypassDisabled()) return "default";
      return defaultMode;
    },

    async setDefaultMode(ctx, mode) {
      if (!loaded) loaded = await loadPermissionSettings(ctx.cwd, userSettingsPath);
      if (mode === "bypassPermissions" && loaded.permissions.disableBypassPermissionsMode === "disable") {
        throw new Error("YOLO mode is disabled by permissions.disableBypassPermissionsMode.");
      }
      await setPermissionDefaultMode(loaded.localSettingsPath, mode);
      loaded.permissions.defaultMode = mode;
      await options.setMode?.(mode, ctx);
    },

    async authorize(call, ctx, mode, hooks) {
      // RPC reports dialog capability as hasUI=true, even though a teammate
      // child has no local terminal. The parent owns the live mode, session
      // rules, hooks, persistence, and any user prompt.
      if (isTeammateChild()) {
        const relayed = await requestTeammateInteraction<{
          action: "allow_once" | "deny";
          reason?: string;
          updatedInput?: Record<string, unknown>;
        }>("permission", {
          authorization: "parent",
          toolName: call.toolName,
          input: call.input,
        });
        if (relayed?.updatedInput) replaceRecord(call.input, relayed.updatedInput);
        if (relayed?.action === "allow_once") return;
        return {
          block: true,
          reason: relayed?.reason ?? "Permission could not be authorized by the parent session.",
        };
      }

      const settings = effectiveSettings(loaded?.permissions, sessionRules);
      if (loaded?.errors.length && mode !== "bypassPermissions") {
        const toolDecision = evaluatePermission(call, "dontAsk", settings);
        if (toolDecision.behavior !== "allow") {
          return { block: true, reason: "Permission settings are invalid; non-read-only tools are blocked until the configuration is fixed." };
        }
      }
      const decision = evaluatePermission(call, mode, settings);
      if (decision.behavior === "allow") return;
      if (decision.behavior === "deny") return { block: true, reason: decision.reason };

      const suggestion = suggestedAllowRule(call);
      const hookDecision = await hooks?.requestPermission(call, ctx, suggestion, Boolean(decision.rule));
      const inputWasUpdated = Boolean(hookDecision?.updatedInput);
      let updatedMode: PermissionMode | undefined;
      if (hookDecision?.updatedInput) replaceRecord(call.input, hookDecision.updatedInput);
      if (hookDecision?.updatedPermissions) {
        try {
          updatedMode = await applyPermissionUpdates(
            hookDecision.updatedPermissions,
            loaded,
            sessionRules,
            options.setMode,
            ctx,
          );
        } catch (error) {
          return { block: true, reason: `Permission update failed: ${errorMessage(error)}` };
        }
      }
      if (hookDecision?.behavior === "deny") {
        return { block: true, reason: hookDecision.message ?? "Permission request denied by hook." };
      }
      if (hookDecision?.behavior === "allow") {
        if (updatedMode === "plan") {
          return { block: true, reason: "Permission mode changed to plan; retry the tool under the Plan hard boundary." };
        }
        if (!inputWasUpdated && !hookDecision.updatedPermissions?.length) return;
        const reevaluated = evaluatePermission(
          call,
          updatedMode ?? mode,
          effectiveSettings(loaded?.permissions, sessionRules),
        );
        if (reevaluated.behavior === "deny") return { block: true, reason: reevaluated.reason };
        if (reevaluated.behavior === "allow") return;
      }
      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required for ${suggestion}, but no interactive UI is available.` };
      }

      const choice = await ctx.ui.select(permissionPrompt(call, decision.reason), [
        "Allow once",
        "Always allow",
        "Deny",
      ]);
      if (choice === "Allow once") return;
      if (choice === "Always allow") {
        if (!loaded) loaded = await loadPermissionSettings(ctx.cwd, userSettingsPath);
        try {
          await addPermissionRule(loaded.localSettingsPath, "allow", suggestion);
        } catch (error) {
          return { block: true, reason: `Failed to persist permission rule: ${errorMessage(error)}` };
        }
        loaded.permissions.allow = [...new Set([...loaded.permissions.allow, suggestion])];
        ctx.ui.notify(`已写入本地权限规则：${suggestion}`, "info");
        return;
      }
      return { block: true, reason: `Permission denied by user for ${suggestion}.` };
    },

    summary(mode) {
      const permissions = loaded?.permissions ?? { allow: [], ask: [], deny: [] };
      const sources = loaded?.sources.length ? loaded.sources.join("\n") : "无配置文件";
      return [
        `Mode: ${mode}`,
        formatRules("Allow", [...permissions.allow, ...sessionRules.allow]),
        formatRules("Ask", [...permissions.ask, ...sessionRules.ask]),
        formatRules("Deny", [...permissions.deny, ...sessionRules.deny]),
        "",
        `Sources:\n${sources}`,
      ].join("\n");
    },

    bypassDisabled() {
      return loaded?.permissions.disableBypassPermissionsMode === "disable";
    },
  };
}

function effectiveSettings(
  loaded: PermissionRuleSettings | undefined,
  session: Record<PermissionBehavior, string[]>,
): PermissionRuleSettings {
  return {
    allow: [...new Set([...(loaded?.allow ?? []), ...session.allow])],
    ask: [...new Set([...(loaded?.ask ?? []), ...session.ask])],
    deny: [...new Set([...(loaded?.deny ?? []), ...session.deny])],
    ...(loaded?.defaultMode ? { defaultMode: loaded.defaultMode } : {}),
    ...(loaded?.disableBypassPermissionsMode ? {
      disableBypassPermissionsMode: loaded.disableBypassPermissionsMode,
    } : {}),
  };
}

async function applyPermissionUpdates(
  updates: PermissionUpdate[],
  loaded: LoadedPermissionSettings | undefined,
  session: Record<PermissionBehavior, string[]>,
  setMode: ((mode: PermissionMode, ctx: ExtensionContext) => void | Promise<void>) | undefined,
  ctx: ExtensionContext,
): Promise<PermissionMode | undefined> {
  let updatedMode: PermissionMode | undefined;
  for (const update of updates) {
    if (update.type === "setMode" && update.mode) {
      if (update.mode === "bypassPermissions" && loaded?.permissions.disableBypassPermissionsMode === "disable") {
        continue;
      }
      if (update.destination === "localSettings" && loaded) {
        await setPermissionDefaultMode(loaded.localSettingsPath, update.mode);
        loaded.permissions.defaultMode = update.mode;
      }
      await setMode?.(update.mode, ctx);
      updatedMode = update.mode;
      continue;
    }
    if (!update.behavior || !["addRules", "replaceRules", "removeRules"].includes(update.type)) continue;
    const rules = (update.rules ?? []).map((rule) =>
      rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
    );
    const operation = update.type === "addRules" ? "add"
      : update.type === "replaceRules" ? "replace"
        : "remove";
    if (update.destination === "localSettings" && loaded) {
      await updatePermissionRules(loaded.localSettingsPath, update.behavior, operation, rules);
      if (operation === "replace") loaded.permissions[update.behavior] = [...new Set(rules)];
      if (operation === "add") {
        loaded.permissions[update.behavior] = [...new Set([...loaded.permissions[update.behavior], ...rules])];
      }
      if (operation === "remove") {
        const removals = new Set(rules);
        loaded.permissions[update.behavior] = loaded.permissions[update.behavior]
          .filter((rule) => !removals.has(rule));
      }
    } else {
      if (operation === "replace") session[update.behavior] = [...new Set(rules)];
      if (operation === "add") session[update.behavior] = [...new Set([...session[update.behavior], ...rules])];
      if (operation === "remove") {
        const removals = new Set(rules);
        session[update.behavior] = session[update.behavior].filter((rule) => !removals.has(rule));
      }
    }
  }
  return updatedMode;
}

function permissionPrompt(call: PermissionToolCall, reason: string): string {
  const details = typeof call.input.command === "string"
    ? call.input.command
    : typeof call.input.path === "string"
      ? call.input.path
      : typeof call.input.file_path === "string"
        ? call.input.file_path
        : JSON.stringify(call.input);
  const bounded = details.length > 500 ? `${details.slice(0, 497)}...` : details;
  return `Permission required: ${call.toolName}\n\n${bounded}\n\n${reason}`;
}

function replaceRecord(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function formatRules(label: string, rules: string[]): string {
  const unique = [...new Set(rules)];
  return `${label} (${unique.length}): ${unique.length ? unique.join(", ") : "-"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
