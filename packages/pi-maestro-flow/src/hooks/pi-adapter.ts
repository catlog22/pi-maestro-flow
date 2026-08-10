import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  type CodexHookEvent,
  type LoadedCodexHooks,
  isRecord,
  loadCodexHooks,
} from "./schema.ts";
import {
  countSkippedHandlers,
  getMatchingCommandHooks,
  runMatchingCommandHooks,
  type ParsedHookOutput,
} from "./runner.ts";
import {
  isHookConfigTrusted,
  loadHookToggles,
  revokeHookConfigTrust,
  setHookEnabled,
  trustHookConfig,
} from "./trust.ts";
import {
  buildHookReviewEntries,
  sanitizeHookDisplayText,
  type HookReviewEntry,
} from "./review.ts";
import {
  HookReviewOverlay,
  type HookReviewAction,
  type HookReviewUiState,
} from "./review-tui.ts";
import { runMaestroHookInstaller } from "./installer.ts";
import { evaluateHardGate } from "pi-maestro-teammate/experts-mode";
import type {
  PermissionMode,
  PermissionToolCall,
} from "../permissions/types.ts";
import { isTeammateChild } from "../permissions/teammate-relay.ts";
import { getTuiLocale } from "../tui/locale.ts";
import {
  createHookContextComponent,
  parseMaestroContext,
  type HookContextDetails,
} from "./hook-context-renderer.ts";

export type { PermissionMode } from "../permissions/types.ts";

const STATUS_KEY = "maestro-hooks";
const MAX_HOOK_COMMAND_LENGTH = 240;
const MAX_HOOK_OUTPUT_LENGTH = 1200;
const MAX_HOOK_NOTICE_LENGTH = 500;
const MAX_FAILURE_SUMMARIES = 3;
const UNSUPPORTED_PI_EVENTS: CodexHookEvent[] = [
  "SubagentStart",
  "SubagentStop",
];

const HOOK_UI_CATALOGS = {
  en: {
    "status.hook": "⬡ Hook…",
    "notice.untrustedAnnounce": "Found an untrusted hooks config: {path}. Run /hooks to review.",
    "notice.incompatibleOutput": "{event} Hook output is incompatible: {message}",
    "notice.toggleUnsupported": "Cannot toggle · only synchronous command Hooks are executed",
    "notice.toggled": "{state} · {event} · {command}",
    "value.enabled": "Enabled",
    "value.disabled": "Disabled",
    "notice.toggleFailed": "Update failed · {error}",
    "confirm.revokeTitle": "Revoke hooks trust?",
    "confirm.trustTitle": "Trust project Hooks?",
    "confirm.revokeDetail": "Config: {path}\nAfter revocation all Hooks stop firing immediately.",
    "confirm.trustDetail": "Config: {path}\nHash: {hash}\nEnabled: {enabled}/{total}",
    "notice.cancelRevoke": "Revoke cancelled",
    "notice.cancelTrust": "Trust cancelled",
    "notice.revoked": "Hooks trust revoked",
    "notice.trusted": "Hooks config trusted · enabled entries will run automatically",
    "notice.trustFailed": "Trust update failed · {error}",
    "notice.notFound": "Not found: {path}",
    "notice.revokedCurrent": "Trust for the current hooks config revoked.",
    "notice.revokeFailed": "Failed to revoke hooks trust: {error}",
    "notice.tuiUnavailable": "Hook TUI unavailable, nothing installed or trusted: {error}",
    "notice.installNeedsTui": "Maestro Flow Hooks installation requires an interactive TUI.",
    "notice.fallbackTrusted": "Hooks trusted and enabled: {path}",
    "notice.fallbackUnsafe": "Cannot safely display the full hooks config, trust unchanged: {path}. Retry /hooks in the interactive TUI.",
    "notice.unsupportedEvents": "Pi does not yet map Codex Hooks: {events}",
    "notice.skippedHandlers": "Skipped {count} prompt, agent or async Hooks; only command Hooks run.",
    "notice.compat.stopPlainText": "Stop must return JSON, not plain text",
    "notice.compat.preToolUseUnsupported": "PreToolUse does not support continue, stopReason or suppressOutput",
    "notice.compat.updatedInput": "updatedInput may only be returned with permissionDecision: allow or ask",
    "notice.compat.postToolUseUnsupported": "PostToolUse currently does not support updatedMCPToolOutput or suppressOutput",
    "failure.title": "Hook failed · {event}",
    "failure.titleWithCount": "Hook failed · {event} ({count})",
    "failure.command": "Command: {command}",
    "failure.reason": "Reason: {reason}",
    "failure.output": "Output: {output}",
    "failure.others": "Other failures:",
    "failure.more": "… {count} more failures",
    "command.hooks.description": "Install, review, trust or revoke .pi/hooks.json",
  },
  "zh-CN": {
    "status.hook": "⬡ Hook…",
    "notice.untrustedAnnounce": "发现未信任的 Hook 配置：{path}。运行 /hooks 进行审核。",
    "notice.incompatibleOutput": "{event} Hook 输出不兼容：{message}",
    "notice.toggleUnsupported": "无法切换 · 当前仅执行同步 command Hook",
    "notice.toggled": "{state} · {event} · {command}",
    "value.enabled": "已启用",
    "value.disabled": "已停用",
    "notice.toggleFailed": "更新失败 · {error}",
    "confirm.revokeTitle": "撤销 Hook 信任？",
    "confirm.trustTitle": "信任项目 Hooks？",
    "confirm.revokeDetail": "配置：{path}\n撤销后所有 Hook 将立即停止触发。",
    "confirm.trustDetail": "配置：{path}\nHash：{hash}\n启用：{enabled}/{total}",
    "notice.cancelRevoke": "已取消撤销",
    "notice.cancelTrust": "已取消信任",
    "notice.revoked": "已撤销 Hook 信任",
    "notice.trusted": "已信任 Hook 配置 · 已启用项将自动运行",
    "notice.trustFailed": "更新信任失败 · {error}",
    "notice.notFound": "未找到 {path}",
    "notice.revokedCurrent": "已撤销当前 Hook 配置的信任。",
    "notice.revokeFailed": "撤销 Hook 信任失败：{error}",
    "notice.tuiUnavailable": "Hook TUI 不可用，未进行安装或信任：{error}",
    "notice.installNeedsTui": "Maestro Flow Hooks 安装需要交互式 TUI。",
    "notice.fallbackTrusted": "Hook 已信任并启用：{path}",
    "notice.fallbackUnsafe": "无法安全显示完整 Hook 配置，信任未更改：{path}。请在交互式 TUI 中重试 /hooks。",
    "notice.unsupportedEvents": "Pi 暂未映射 Codex Hook：{events}",
    "notice.skippedHandlers": "已跳过 {count} 个 prompt、agent 或 async Hook；当前仅执行 command Hook。",
    "notice.compat.stopPlainText": "Stop 必须返回 JSON，不能返回纯文本",
    "notice.compat.preToolUseUnsupported": "PreToolUse 不支持 continue、stopReason 或 suppressOutput",
    "notice.compat.updatedInput": "updatedInput 只能与 permissionDecision: allow 或 ask 一起返回",
    "notice.compat.postToolUseUnsupported": "PostToolUse 当前不支持 updatedMCPToolOutput 或 suppressOutput",
    "failure.title": "Hook 失败 · {event}",
    "failure.titleWithCount": "Hook 失败 · {event}（{count}）",
    "failure.command": "命令：{command}",
    "failure.reason": "原因：{reason}",
    "failure.output": "输出：{output}",
    "failure.others": "其他失败：",
    "failure.more": "… 还有 {count} 个失败",
    "command.hooks.description": "安装、审核、信任或撤销 .pi/hooks.json",
  },
} as const;

type HookCatalogKey = keyof (typeof HOOK_UI_CATALOGS)["en"];
type HookTranslator = (key: HookCatalogKey, vars?: Readonly<Record<string, string | number>>) => string;

/** Translate a catalog key with optional {var} substitution. */
function translateHook(
  locale: SupportedSettingsLocale,
  key: HookCatalogKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const catalog = HOOK_UI_CATALOGS[locale] ?? HOOK_UI_CATALOGS.en;
  const template: unknown = catalog[key];
  const text = typeof template === "string" ? template : HOOK_UI_CATALOGS.en[key] as string;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

interface AdapterOptions {
  getPermissionMode?: () => PermissionMode;
  trustFilePath?: string;
  isTeammateChild?: () => boolean;
  onCompactionCancelled?: () => void;
  shouldSkipStopHook?: () => boolean;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
}

interface HookState {
  loaded?: LoadedCodexHooks;
  active: boolean;
  lifecycle: AbortController;
  toggles: Record<string, boolean>;
  turnId?: string;
  pendingContext: string[];
  toolContext: Map<string, string[]>;
  stopHookActive: boolean;
}

export interface CodexHookAdapter {
  openSettings(ctx: ExtensionContext): Promise<void>;
  beforeToolCall(
    call: PermissionToolCall & { toolCallId?: string },
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined>;
  requestPermission(
    call: PermissionToolCall,
    ctx: ExtensionContext,
    suggestion: string,
    forced: boolean,
  ): Promise<undefined>;
}

export function registerCodexHookAdapter(pi: ExtensionAPI, options: AdapterOptions = {}): CodexHookAdapter {
  const trustFilePath = options.trustFilePath ?? join(getAgentDir(), "hook-trust.json");
  const getPermissionMode = options.getPermissionMode ?? (() => "default");
  const resolveLocale = (): SupportedSettingsLocale => getTuiLocale(options.locale);
  const t: HookTranslator = (key, vars) => translateHook(resolveLocale(), key, vars);
  const state: HookState = {
    active: false,
    lifecycle: new AbortController(),
    toggles: {},
    pendingContext: [],
    toolContext: new Map(),
    stopHookActive: false,
  };
  const resetLifecycle = (): void => {
    state.lifecycle.abort();
    state.lifecycle = new AbortController();
  };

  const reload = async (ctx: ExtensionContext, announce: boolean): Promise<void> => {
    resetLifecycle();
    try {
      state.loaded = await loadCodexHooks(ctx.cwd);
      state.active = false;
      state.toggles = {};
      if (!state.loaded.exists || !state.loaded.hash) return;
      state.toggles = await loadHookToggles(trustFilePath, state.loaded.filePath);
      state.active = await isHookConfigTrusted(trustFilePath, state.loaded.filePath, state.loaded.hash);
      if (!state.active && announce) {
        ctx.ui.notify(t("notice.untrustedAnnounce", { path: sanitizeHookDisplayText(state.loaded.filePath) }), "warning");
      }
      if (state.active && announce) reportCompatibilityWarnings(ctx, state.loaded, t);
    } catch (error) {
      state.loaded = undefined;
      state.active = false;
      ctx.ui.notify(sanitizeHookDisplayText(errorMessage(error)), "error");
      console.error(`[maestro-hooks] ${errorMessage(error)}`);
    }
  };

  const execute = async (
    eventName: CodexHookEvent,
    matchValues: string[],
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<ParsedHookOutput[]> => {
    if (!state.active || !state.loaded) return [];
    const lifecycle = state.lifecycle;
    const config = state.loaded.config;
    const handlers = getMatchingCommandHooks(config, eventName, matchValues, state.toggles);
    const status = handlers.find((handler) => handler.statusMessage)?.statusMessage;
    if (status) ctx.ui.setStatus(STATUS_KEY, status);
    try {
      const outputs = await runMatchingCommandHooks(
        config,
        eventName,
        matchValues,
        input,
        ctx.cwd,
        lifecycle.signal,
        state.toggles,
      );
      if (lifecycle.signal.aborted || lifecycle !== state.lifecycle) return [];
      const failures = outputs.filter((output) =>
        output.error || output.timedOut || (output.exitCode !== 0 && output.exitCode !== 2),
      );
      if (failures.length > 0) sendHookFailureMessage(pi, eventName, failures, t);
      const protocolErrors = outputs
        .map((output) => outputCompatibilityError(eventName, output, t))
        .filter((message): message is string => Boolean(message));
      if (protocolErrors.length > 0) {
        ctx.ui.notify(t("notice.incompatibleOutput", { event: eventName, message: protocolErrors[0] }), "warning");
      }
      for (const output of outputs) notifySystemMessage(output, ctx);
      return outputs;
    } finally {
      if (status && !lifecycle.signal.aborted && lifecycle === state.lifecycle) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    }
  };

  const requestPermission = async (
    call: PermissionToolCall,
    ctx: ExtensionContext,
    suggestion: string,
    _forced: boolean,
  ): Promise<undefined> => {
    const names = toolMatchValues(call.toolName);
    await execute("PermissionRequest", names, {
      ...turnInput("PermissionRequest", ctx, state, getPermissionMode()),
      tool_name: names[0],
      pi_tool_name: call.toolName,
      tool_input: call.input,
      permission_suggestions: [{
        type: "addRules",
        rules: [{ toolName: names[0], ruleContent: suggestionRuleContent(suggestion) }],
        behavior: "allow",
        destination: "localSettings",
      }],
    }, ctx);
    return undefined;
  };

  const beforeToolCall = async (
    event: PermissionToolCall & { toolCallId?: string },
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> => {
    if (!state.active) return;
    const names = toolMatchValues(event.toolName);

    // Experts Mode P1/P5 hard-gate (before user hooks):
    // deny blocks with teammate rewrite guidance; ask injects guidance; allowlist paths pass.
    // State file: <cwd>/.experts-mode.json or EXPERTS_MODE_STATE.
    try {
      const gate = evaluateHardGate(event.toolName, {
        cwd: ctx.cwd,
        toolInput: event.input,
      });
      if (gate.decision === "deny") {
        const rewrite = gate.rewriteSuggestion;
        const rewriteLine = rewrite
          ? ` [rewrite] teammate taskType=${rewrite.taskType} agent=${rewrite.agent}`
            + (rewrite.stage ? ` stage=${rewrite.stage}` : "")
          : "";
        return { block: true, reason: `${gate.reason}${rewriteLine}` };
      }
      if (gate.decision === "ask" && event.toolCallId) {
        const warn = `[experts-mode] ${gate.reason}`;
        const prev = state.toolContext.get(event.toolCallId) ?? [];
        state.toolContext.set(event.toolCallId, [...prev, warn]);
      }
    } catch {
      // Never fail tool path if experts-mode state is unreadable.
    }

    const outputs = await execute("PreToolUse", names, {
      ...turnInput("PreToolUse", ctx, state, getPermissionMode()),
      tool_name: names[0],
      pi_tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
    }, ctx);
    const updatedInput = lastUpdatedInput(outputs);
    if (updatedInput) replaceRecord(event.input, updatedInput);
    const context = collectAdditionalContext(outputs, false);
    if (context.length > 0 && event.toolCallId) state.toolContext.set(event.toolCallId, context);
  };

  const runHookReview = async (ctx: ExtensionContext): Promise<"close" | "install"> => {
    let uiState: Partial<HookReviewUiState> = { query: "" };
    let notice: string | undefined;
    while (state.loaded?.exists && state.loaded.hash) {
      const loaded = state.loaded;
      const hash = loaded.hash;
      if (!hash) return "close";
      const entries = buildHookReviewEntries(loaded, state.toggles);
      const action = await showHookReviewOverlay(ctx, entries, state.active, loaded, uiState, notice, resolveLocale());
      uiState = action.uiState;
      if (action.kind === "close") return "close";
      if (action.kind === "install") return "install";

      if (action.kind === "toggle") {
        const selected = entries.find((entry) => entry.id === action.hookId);
        if (!selected?.supported) {
          notice = t("notice.toggleUnsupported");
          continue;
        }
        const enabled = !selected.enabled;
        try {
          await setHookEnabled(trustFilePath, loaded.filePath, selected.id, enabled);
          state.toggles = { ...state.toggles, [selected.id]: enabled };
          notice = t("notice.toggled", {
            state: enabled ? t("value.enabled") : t("value.disabled"),
            event: selected.event,
            command: truncateHookText(selected.command, 100),
          });
        } catch (error) {
          notice = t("notice.toggleFailed", { error: errorMessage(error) });
        }
        continue;
      }

      const confirmed = await ctx.ui.confirm(
        state.active ? t("confirm.revokeTitle") : t("confirm.trustTitle"),
        state.active
          ? t("confirm.revokeDetail", { path: sanitizeHookDisplayText(loaded.filePath) })
          : t("confirm.trustDetail", {
              path: sanitizeHookDisplayText(loaded.filePath),
              hash: hash.slice(0, 12),
              enabled: entries.filter((entry) => entry.enabled).length,
              total: entries.length,
            }),
      );
      if (!confirmed) {
        notice = state.active ? t("notice.cancelRevoke") : t("notice.cancelTrust");
        continue;
      }
      try {
        if (state.active) {
          await revokeHookConfigTrust(trustFilePath, loaded.filePath);
          state.active = false;
          notice = t("notice.revoked");
        } else {
          await trustHookConfig(trustFilePath, loaded.filePath, hash);
          state.active = true;
          notice = t("notice.trusted");
          reportCompatibilityWarnings(ctx, loaded, t);
        }
      } catch (error) {
        notice = t("notice.trustFailed", { error: errorMessage(error) });
      }
    }
    return "close";
  };

  const runHookInterface = async (ctx: ExtensionContext, startInInstaller: boolean): Promise<void> => {
    let installMode = startInInstaller;
    while (true) {
      if (installMode || !state.loaded?.exists || !state.loaded.hash) {
        const result = await runMaestroHookInstaller(ctx, undefined, resolveLocale());
        if (!result.changed) return;
        await reload(ctx, false);
        installMode = false;
      }
      if (!state.loaded?.exists || !state.loaded.hash) return;
      const next = await runHookReview(ctx);
      if (next === "install") {
        installMode = true;
        continue;
      }
      return;
    }
  };

  const fallbackHookReview = async (ctx: ExtensionContext, loaded: LoadedCodexHooks): Promise<void> => {
    if (state.active) {
      ctx.ui.notify(t("notice.fallbackTrusted", { path: sanitizeHookDisplayText(loaded.filePath) }), "info");
      reportCompatibilityWarnings(ctx, loaded, t);
      return;
    }
    ctx.ui.notify(
      t("notice.fallbackUnsafe", { path: sanitizeHookDisplayText(loaded.filePath) }),
      "error",
    );
  };

  pi.registerCommand("hooks", {
    description: t("command.hooks.description"),
    async handler(args, ctx) {
      await reload(ctx, false);
      const action = args.trim().toLowerCase();
      const loaded = state.loaded;
      if (action === "revoke") {
        if (!loaded?.exists || !loaded.hash) {
          ctx.ui.notify(t("notice.notFound", { path: loaded?.filePath ?? join(ctx.cwd, ".pi", "hooks.json") }), "info");
          return;
        }
        try {
          await revokeHookConfigTrust(trustFilePath, loaded.filePath);
          state.active = false;
          ctx.ui.notify(t("notice.revokedCurrent"), "info");
        } catch (error) {
          ctx.ui.notify(t("notice.revokeFailed", { error: sanitizeHookDisplayText(errorMessage(error)) }), "error");
        }
        return;
      }
      if (ctx.hasUI) {
        try {
          await runHookInterface(ctx, action === "install" || !loaded?.exists || !loaded.hash);
          return;
        } catch (error) {
          ctx.ui.notify(t("notice.tuiUnavailable", { error: sanitizeHookDisplayText(errorMessage(error)) }), "error");
          return;
        }
      }
      if (!loaded?.exists || !loaded.hash || action === "install") {
        ctx.ui.notify(t("notice.installNeedsTui"), "error");
        return;
      }
      await fallbackHookReview(ctx, loaded);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    state.turnId = undefined;
    state.pendingContext = [];
    state.toolContext.clear();
    state.stopHookActive = false;
    await reload(ctx, true);
    if (!state.active) return;
    const source = sessionStartSource(event.reason);
    const outputs = await execute("SessionStart", [source], {
      ...commonInput("SessionStart", ctx, getPermissionMode()),
      source,
    }, ctx);
    state.pendingContext.push(...collectAdditionalContext(outputs, true));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.lifecycle.abort();
    state.active = false;
    state.loaded = undefined;
    state.pendingContext = [];
    state.toolContext.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !state.active) return;
    state.turnId = randomUUID();
    state.stopHookActive = false;
    ctx.ui.setStatus(STATUS_KEY, t("status.hook"));
    try {
      const outputs = await execute("UserPromptSubmit", [], {
        ...turnInput("UserPromptSubmit", ctx, state, getPermissionMode()),
        prompt: event.text,
      }, ctx);
      const blocked = blockingReason(outputs) ?? continueFalseReason(outputs);
      if (blocked) {
        ctx.ui.notify(blocked, "warning");
        return { action: "handled" as const };
      }
      state.pendingContext.push(...collectAdditionalContext(outputs, true));
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("before_agent_start", (_event) => {
    state.turnId ??= randomUUID();
    if (state.pendingContext.length === 0) return;
    const context = state.pendingContext.splice(0).join("\n\n");
    const details = parseMaestroContext(context);
    return {
      message: {
        customType: "codex-hook-context",
        content: context,
        display: true,
        details,
      },
    };
  });

  pi.registerMessageRenderer<HookContextDetails>("codex-hook-context", (message, options, theme) => {
    const details = message.details;
    if (!details) return undefined;
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    return createHookContextComponent(content, details, options.expanded, theme);
  });

  pi.on("tool_call", async (event, ctx) => {
    // The parent permission broker runs the live parent's hooks exactly once.
    // Running PreToolUse in the RPC child can otherwise block before relay.
    if ((options.isTeammateChild ?? isTeammateChild)()) return;
    return beforeToolCall(event, ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.active) return;
    const names = toolMatchValues(event.toolName);
    const outputs = await execute("PostToolUse", names, {
      ...turnInput("PostToolUse", ctx, state, getPermissionMode()),
      tool_name: names[0],
      pi_tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
      tool_response: {
        content: event.content,
        details: event.details,
        isError: event.isError,
      },
    }, ctx);
    const pending = state.toolContext.get(event.toolCallId) ?? [];
    state.toolContext.delete(event.toolCallId);
    const reason = blockingReason(outputs) ?? continueFalseReason(outputs);
    const context = [...pending, ...collectAdditionalContext(outputs, false)];
    if (reason) return { content: [{ type: "text" as const, text: reason }] };
    if (context.length > 0) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `Hook context:\n${context.join("\n\n")}` },
        ],
      };
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const outputs = await execute("PreCompact", ["auto"], {
      ...turnInput("PreCompact", ctx, state, getPermissionMode()),
      trigger: "auto",
    }, ctx);
    if (outputs.some(hasContinueFalse)) {
      try {
        ctx.ui.notify(
          "Auto-compaction cancelled: a PreCompact hook rejected it. Check your hooks configuration.",
          "info",
        );
      } catch { /* best-effort; cancellation stays authoritative */ }
      options.onCompactionCancelled?.();
      return { cancel: true };
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    const outputs = await execute("PostCompact", ["auto"], {
      ...turnInput("PostCompact", ctx, state, getPermissionMode()),
      trigger: "auto",
    }, ctx);
    state.pendingContext.push(...collectAdditionalContext(outputs, false));
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.active || options.shouldSkipStopHook?.()) return;
    const outputs = await execute("Stop", [], {
      ...turnInput("Stop", ctx, state, getPermissionMode()),
      stop_hook_active: state.stopHookActive,
      last_assistant_message: findLastAssistantText(event.messages),
    }, ctx);
    if (outputs.some(hasContinueFalse)) return;
    const reason = blockingReason(outputs);
    if (!reason) return;
    // Goal 或压缩恢复可能已拥有下一轮；Stop Hook 不得在其后追加第二条续接。
    if (ctx.hasPendingMessages?.()) return;
    state.stopHookActive = true;
    pi.sendUserMessage(reason, { deliverAs: "followUp" });
  });

  return {
    async openSettings(ctx) {
      await reload(ctx, false);
      await runHookInterface(ctx, !state.loaded?.exists || !state.loaded.hash);
    },
    beforeToolCall,
    requestPermission,
  };
}

async function showHookReviewOverlay(
  ctx: ExtensionContext,
  entries: readonly HookReviewEntry[],
  trusted: boolean,
  loaded: LoadedCodexHooks,
  initialState: Partial<HookReviewUiState>,
  notice: string | undefined,
  locale: SupportedSettingsLocale,
): Promise<HookReviewAction> {
  return ctx.ui.custom<HookReviewAction>((tui, theme, _keybindings, done) =>
    new HookReviewOverlay({
      entries,
      trusted,
      configPath: loaded.filePath,
      hash: loaded.hash ?? "",
      theme,
      notice,
      initialState,
      locale,
      requestRender: () => tui.requestRender(),
      done,
    }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}

function commonInput(
  eventName: CodexHookEvent,
  ctx: ExtensionContext,
  permissionMode: PermissionMode,
): Record<string, unknown> {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? null,
    cwd: ctx.cwd,
    hook_event_name: eventName,
    model: ctx.model?.id ?? "unknown",
    permission_mode: permissionMode,
  };
}

function turnInput(
  eventName: CodexHookEvent,
  ctx: ExtensionContext,
  state: HookState,
  permissionMode: PermissionMode,
): Record<string, unknown> {
  state.turnId ??= randomUUID();
  return { ...commonInput(eventName, ctx, permissionMode), turn_id: state.turnId };
}

function sessionStartSource(reason: string): "startup" | "resume" | "clear" | "compact" {
  if (reason === "resume" || reason === "fork") return "resume";
  if (reason === "new") return "clear";
  return "startup";
}

function toolMatchValues(toolName: string): string[] {
  if (toolName === "bash") return ["Bash", "bash"];
  if (toolName === "edit") return ["Edit", "edit"];
  if (toolName === "write") return ["Write", "write"];
  return [toolName];
}

function blockingReason(outputs: ParsedHookOutput[]): string | undefined {
  for (const output of outputs) {
    if (output.exitCode === 2) return output.stderr.trim() || "Blocked by hook.";
    if (!isSuccessfulOutput(output)) continue;
    if (output.json?.decision === "block") return stringField(output.json, "reason") ?? "Blocked by hook.";
  }
  return undefined;
}

function continueFalseReason(outputs: ParsedHookOutput[]): string | undefined {
  const output = outputs.find(hasContinueFalse);
  if (!output?.json) return undefined;
  return stringField(output.json, "stopReason") ?? stringField(output.json, "systemMessage") ?? "Stopped by hook.";
}

function hasContinueFalse(output: ParsedHookOutput): boolean {
  return isSuccessfulOutput(output) && output.json?.continue === false;
}

function lastUpdatedInput(outputs: ParsedHookOutput[]): Record<string, unknown> | undefined {
  let updated: Record<string, unknown> | undefined;
  for (const output of outputs) {
    if (!isSuccessfulOutput(output)) continue;
    const specific = hookSpecific(output);
    if (
      (specific?.permissionDecision === "allow" || specific?.permissionDecision === "ask")
      && isRecord(specific.updatedInput)
    ) {
      updated = specific.updatedInput;
    }
  }
  return updated;
}

function collectAdditionalContext(outputs: ParsedHookOutput[], allowPlainText: boolean): string[] {
  const context: string[] = [];
  for (const output of outputs) {
    if (!isSuccessfulOutput(output)) continue;
    if (allowPlainText && output.plainText) context.push(output.plainText);
    const specific = hookSpecific(output);
    if (typeof specific?.additionalContext === "string") context.push(specific.additionalContext);
  }
  return context;
}

function isSuccessfulOutput(output: ParsedHookOutput): boolean {
  return output.exitCode === 0 && !output.timedOut && !output.error;
}

function hookSpecific(output: ParsedHookOutput): Record<string, unknown> | undefined {
  return isRecord(output.json?.hookSpecificOutput) ? output.json.hookSpecificOutput : undefined;
}

function notifySystemMessage(output: ParsedHookOutput, ctx: ExtensionContext): void {
  if (!isSuccessfulOutput(output)) return;
  const message = output.json && stringField(output.json, "systemMessage");
  if (message) ctx.ui.notify(truncateHookText(message, MAX_HOOK_NOTICE_LENGTH), "info");
}

function sendHookFailureMessage(
  pi: ExtensionAPI,
  eventName: CodexHookEvent,
  failures: ParsedHookOutput[],
  t: HookTranslator,
): void {
  const first = failures[0];
  if (!first) return;
  const firstReason = hookFailureReason(first);
  const firstOutput = hookOutputText(first);
  const summaries = failures.slice(1, MAX_FAILURE_SUMMARIES).map((failure, index) => {
    const command = hookCommand(failure);
    const reason = hookFailureReason(failure);
    return `${index + 2}. ${truncateHookText(command, 120)} · ${truncateHookText(reason, 240)}`;
  });
  const remaining = failures.length - Math.min(failures.length, MAX_FAILURE_SUMMARIES);
  pi.sendMessage({
    customType: "codex-hook-failure",
    content: [
      failures.length > 1
        ? t("failure.titleWithCount", { event: eventName, count: failures.length })
        : t("failure.title", { event: eventName }),
      t("failure.command", { command: truncateHookText(hookCommand(first), MAX_HOOK_COMMAND_LENGTH) }),
      t("failure.reason", { reason: truncateHookText(firstReason, MAX_HOOK_NOTICE_LENGTH) }),
      ...(firstOutput && firstOutput !== firstReason
        ? [t("failure.output", { output: truncateHookText(firstOutput, MAX_HOOK_OUTPUT_LENGTH) })]
        : []),
      ...(summaries.length > 0 ? [t("failure.others"), ...summaries] : []),
      ...(remaining > 0 ? [t("failure.more", { count: remaining })] : []),
    ].join("\n"),
    display: true,
    details: { event: eventName, count: failures.length },
  }, { triggerTurn: false });
}

function hookCommand(output: ParsedHookOutput): string {
  return process.platform === "win32" && output.handler.commandWindows
    ? output.handler.commandWindows
    : output.handler.command;
}

function hookFailureReason(output: ParsedHookOutput): string {
  return output.error || output.stderr.trim() || `exit ${output.exitCode ?? "unknown"}`;
}

function hookOutputText(output: ParsedHookOutput): string {
  if (output.plainText?.trim()) return output.plainText.trim();
  if (output.json) return JSON.stringify(output.json, null, 2);
  if (output.stdout.trim()) return output.stdout.trim();
  if (output.stderr.trim()) return output.stderr.trim();
  if (output.error) return output.error;
  return `exit ${output.exitCode ?? "unknown"}`;
}

function truncateHookText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "\n… [truncated]";
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function outputCompatibilityError(
  eventName: CodexHookEvent,
  output: ParsedHookOutput,
  t: HookTranslator,
): string | undefined {
  if (!isSuccessfulOutput(output)) return undefined;
  const json = output.json;
  if (eventName === "Stop" && output.exitCode === 0 && output.plainText) {
    return t("notice.compat.stopPlainText");
  }
  if (!json) return undefined;
  if (eventName === "PreToolUse") {
    const specific = hookSpecific(output);
    if (json.continue === false || "stopReason" in json || "suppressOutput" in json) {
      return t("notice.compat.preToolUseUnsupported");
    }
    if (isRecord(specific?.updatedInput) && specific?.permissionDecision !== "allow") {
      if (specific?.permissionDecision !== "ask") {
        return t("notice.compat.updatedInput");
      }
    }
  }
  if (eventName === "PostToolUse" && ("updatedMCPToolOutput" in json || "suppressOutput" in json)) {
    return t("notice.compat.postToolUseUnsupported");
  }
  return undefined;
}

function replaceRecord(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function suggestionRuleContent(suggestion: string): string | undefined {
  const match = /^[^()]+\((.*)\)$/.exec(suggestion);
  return match?.[1];
}

function findLastAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function reportCompatibilityWarnings(ctx: ExtensionContext, loaded: LoadedCodexHooks, t: HookTranslator): void {
  const configuredUnsupported = UNSUPPORTED_PI_EVENTS.filter((eventName) =>
    (loaded.config.hooks[eventName]?.length ?? 0) > 0,
  );
  if (configuredUnsupported.length > 0) {
    ctx.ui.notify(t("notice.unsupportedEvents", { events: configuredUnsupported.join(", ") }), "warning");
  }
  const skipped = countSkippedHandlers(loaded.config);
  if (skipped > 0) ctx.ui.notify(t("notice.skippedHandlers", { count: skipped }), "warning");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
