import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import type {
  PermissionMode,
  PermissionToolCall,
} from "../permissions/types.ts";
import { isTeammateChild } from "../permissions/teammate-relay.ts";

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

interface AdapterOptions {
  getPermissionMode?: () => PermissionMode;
  trustFilePath?: string;
  isTeammateChild?: () => boolean;
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
        ctx.ui.notify(`发现未信任的 Hook 配置：${sanitizeHookDisplayText(state.loaded.filePath)}。运行 /hooks 进行审核。`, "warning");
      }
      if (state.active && announce) reportCompatibilityWarnings(ctx, state.loaded);
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
      if (failures.length > 0) sendHookFailureMessage(pi, eventName, failures);
      const protocolErrors = outputs
        .map((output) => outputCompatibilityError(eventName, output))
        .filter((message): message is string => Boolean(message));
      if (protocolErrors.length > 0) {
        ctx.ui.notify(`${eventName} Hook 输出不兼容：${protocolErrors[0]}`, "warning");
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
      const action = await showHookReviewOverlay(ctx, entries, state.active, loaded, uiState, notice);
      uiState = action.uiState;
      if (action.kind === "close") return "close";
      if (action.kind === "install") return "install";

      if (action.kind === "toggle") {
        const selected = entries.find((entry) => entry.id === action.hookId);
        if (!selected?.supported) {
          notice = "无法切换 · 当前仅执行同步 command Hook";
          continue;
        }
        const enabled = !selected.enabled;
        try {
          await setHookEnabled(trustFilePath, loaded.filePath, selected.id, enabled);
          state.toggles = { ...state.toggles, [selected.id]: enabled };
          notice = `${enabled ? "已启用" : "已停用"} · ${selected.event} · ${truncateHookText(selected.command, 100)}`;
        } catch (error) {
          notice = `更新失败 · ${errorMessage(error)}`;
        }
        continue;
      }

      const confirmed = await ctx.ui.confirm(
        state.active ? "撤销 Hook 信任？" : "信任项目 Hooks？",
        state.active
          ? `配置：${sanitizeHookDisplayText(loaded.filePath)}\n撤销后所有 Hook 将立即停止触发。`
          : `配置：${sanitizeHookDisplayText(loaded.filePath)}\nHash：${hash.slice(0, 12)}\n启用：${entries.filter((entry) => entry.enabled).length}/${entries.length}`,
      );
      if (!confirmed) {
        notice = state.active ? "已取消撤销" : "已取消信任";
        continue;
      }
      try {
        if (state.active) {
          await revokeHookConfigTrust(trustFilePath, loaded.filePath);
          state.active = false;
          notice = "已撤销 Hook 信任";
        } else {
          await trustHookConfig(trustFilePath, loaded.filePath, hash);
          state.active = true;
          notice = "已信任 Hook 配置 · 已启用项将自动运行";
          reportCompatibilityWarnings(ctx, loaded);
        }
      } catch (error) {
        notice = `更新信任失败 · ${errorMessage(error)}`;
      }
    }
    return "close";
  };

  const runHookInterface = async (ctx: ExtensionContext, startInInstaller: boolean): Promise<void> => {
    let installMode = startInInstaller;
    while (true) {
      if (installMode || !state.loaded?.exists || !state.loaded.hash) {
        const result = await runMaestroHookInstaller(ctx);
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
      ctx.ui.notify(`Hook 已信任并启用：${sanitizeHookDisplayText(loaded.filePath)}`, "info");
      reportCompatibilityWarnings(ctx, loaded);
      return;
    }
    ctx.ui.notify(
      `无法安全显示完整 Hook 配置，信任未更改：${sanitizeHookDisplayText(loaded.filePath)}。请在交互式 TUI 中重试 /hooks。`,
      "error",
    );
  };

  pi.registerCommand("hooks", {
    description: "安装、审核、信任或撤销 .pi/hooks.json",
    async handler(args, ctx) {
      await reload(ctx, false);
      const action = args.trim().toLowerCase();
      const loaded = state.loaded;
      if (action === "revoke") {
        if (!loaded?.exists || !loaded.hash) {
          ctx.ui.notify(`未找到 ${loaded?.filePath ?? join(ctx.cwd, ".pi", "hooks.json")}`, "info");
          return;
        }
        try {
          await revokeHookConfigTrust(trustFilePath, loaded.filePath);
          state.active = false;
          ctx.ui.notify("已撤销当前 Hook 配置的信任。", "info");
        } catch (error) {
          ctx.ui.notify(`撤销 Hook 信任失败：${sanitizeHookDisplayText(errorMessage(error))}`, "error");
        }
        return;
      }
      if (ctx.hasUI) {
        try {
          await runHookInterface(ctx, action === "install" || !loaded?.exists || !loaded.hash);
          return;
        } catch (error) {
          ctx.ui.notify(`Hook TUI 不可用，未进行安装或信任：${sanitizeHookDisplayText(errorMessage(error))}`, "error");
          return;
        }
      }
      if (!loaded?.exists || !loaded.hash || action === "install") {
        ctx.ui.notify("Maestro Flow Hooks 安装需要交互式 TUI。", "error");
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
  });

  pi.on("before_agent_start", (_event) => {
    state.turnId ??= randomUUID();
    if (state.pendingContext.length === 0) return;
    const context = state.pendingContext.splice(0).join("\n\n");
    return {
      message: {
        customType: "codex-hook-context",
        content: context,
        display: false,
        details: { source: "hooks" },
      },
    };
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
    if (outputs.some(hasContinueFalse)) return { cancel: true };
  });

  pi.on("session_compact", async (_event, ctx) => {
    const outputs = await execute("PostCompact", ["auto"], {
      ...turnInput("PostCompact", ctx, state, getPermissionMode()),
      trigger: "auto",
    }, ctx);
    state.pendingContext.push(...collectAdditionalContext(outputs, false));
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.active) return;
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

  return { beforeToolCall, requestPermission };
}

async function showHookReviewOverlay(
  ctx: ExtensionContext,
  entries: readonly HookReviewEntry[],
  trusted: boolean,
  loaded: LoadedCodexHooks,
  initialState: Partial<HookReviewUiState>,
  notice: string | undefined,
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
      `Hook 失败 · ${eventName}${failures.length > 1 ? `（${failures.length}）` : ""}`,
      `命令：${truncateHookText(hookCommand(first), MAX_HOOK_COMMAND_LENGTH)}`,
      `原因：${truncateHookText(firstReason, MAX_HOOK_NOTICE_LENGTH)}`,
      ...(firstOutput && firstOutput !== firstReason
        ? [`输出：${truncateHookText(firstOutput, MAX_HOOK_OUTPUT_LENGTH)}`]
        : []),
      ...(summaries.length > 0 ? ["其他失败：", ...summaries] : []),
      ...(remaining > 0 ? [`… 还有 ${remaining} 个失败`] : []),
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
): string | undefined {
  if (!isSuccessfulOutput(output)) return undefined;
  const json = output.json;
  if (eventName === "Stop" && output.exitCode === 0 && output.plainText) {
    return "Stop 必须返回 JSON，不能返回纯文本";
  }
  if (!json) return undefined;
  if (eventName === "PreToolUse") {
    const specific = hookSpecific(output);
    if (json.continue === false || "stopReason" in json || "suppressOutput" in json) {
      return "PreToolUse 不支持 continue、stopReason 或 suppressOutput";
    }
    if (isRecord(specific?.updatedInput) && specific?.permissionDecision !== "allow") {
      if (specific?.permissionDecision !== "ask") {
        return "updatedInput 只能与 permissionDecision: allow 或 ask 一起返回";
      }
    }
  }
  if (eventName === "PostToolUse" && ("updatedMCPToolOutput" in json || "suppressOutput" in json)) {
    return "PostToolUse 当前不支持 updatedMCPToolOutput 或 suppressOutput";
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

function reportCompatibilityWarnings(ctx: ExtensionContext, loaded: LoadedCodexHooks): void {
  const configuredUnsupported = UNSUPPORTED_PI_EVENTS.filter((eventName) =>
    (loaded.config.hooks[eventName]?.length ?? 0) > 0,
  );
  if (configuredUnsupported.length > 0) {
    ctx.ui.notify(`Pi 暂未映射 Codex Hook：${configuredUnsupported.join(", ")}`, "warning");
  }
  const skipped = countSkippedHandlers(loaded.config);
  if (skipped > 0) ctx.ui.notify(`已跳过 ${skipped} 个 prompt、agent 或 async Hook；当前仅执行 command Hook。`, "warning");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
