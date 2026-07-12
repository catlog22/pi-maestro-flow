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
  revokeHookConfigTrust,
  trustHookConfig,
} from "./trust.ts";

const STATUS_KEY = "maestro-hooks";
const MAX_HOOK_COMMAND_LENGTH = 800;
const MAX_HOOK_OUTPUT_LENGTH = 3000;
const UNSUPPORTED_PI_EVENTS: CodexHookEvent[] = [
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
];

export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

interface AdapterOptions {
  getPermissionMode?: () => PermissionMode;
  trustFilePath?: string;
}

interface HookState {
  loaded?: LoadedCodexHooks;
  active: boolean;
  turnId?: string;
  pendingContext: string[];
  toolContext: Map<string, string[]>;
  stopHookActive: boolean;
}

export function registerCodexHookAdapter(pi: ExtensionAPI, options: AdapterOptions = {}): void {
  const trustFilePath = options.trustFilePath ?? join(getAgentDir(), "hook-trust.json");
  const getPermissionMode = options.getPermissionMode ?? (() => "default");
  const state: HookState = {
    active: false,
    pendingContext: [],
    toolContext: new Map(),
    stopHookActive: false,
  };

  const reload = async (ctx: ExtensionContext, announce: boolean): Promise<void> => {
    try {
      state.loaded = await loadCodexHooks(ctx.cwd);
      state.active = false;
      if (!state.loaded.exists || !state.loaded.hash) return;
      state.active = await isHookConfigTrusted(trustFilePath, state.loaded.filePath, state.loaded.hash);
      if (!state.active && announce) {
        ctx.ui.notify(`发现未信任的 Hook 配置：${state.loaded.filePath}。运行 /hooks 进行审核。`, "warning");
      }
      if (state.active && announce) reportCompatibilityWarnings(ctx, state.loaded);
    } catch (error) {
      state.loaded = undefined;
      state.active = false;
      ctx.ui.notify(errorMessage(error), "error");
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
    const handlers = getMatchingCommandHooks(state.loaded.config, eventName, matchValues);
    const status = handlers.find((handler) => handler.statusMessage)?.statusMessage;
    if (status) ctx.ui.setStatus(STATUS_KEY, status);
    try {
      const outputs = await runMatchingCommandHooks(
        state.loaded.config,
        eventName,
        matchValues,
        input,
        ctx.cwd,
      );
      const failures = outputs.filter((output) =>
        output.error || output.timedOut || (output.exitCode !== 0 && output.exitCode !== 2),
      );
      if (failures.length > 0) {
        const detail = failures[0].error || failures[0].stderr.trim() || `exit ${failures[0].exitCode}`;
        ctx.ui.notify(`${eventName} Hook 失败（${failures.length}）：${detail}`, "warning");
      }
      const protocolErrors = outputs
        .map((output) => outputCompatibilityError(eventName, output))
        .filter((message): message is string => Boolean(message));
      if (protocolErrors.length > 0) {
        ctx.ui.notify(`${eventName} Hook 输出不兼容：${protocolErrors[0]}`, "warning");
      }
      for (const output of outputs) notifySystemMessage(output, ctx);
      for (const output of outputs) sendHookOutputMessage(pi, eventName, output);
      return outputs;
    } finally {
      if (status) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  pi.registerCommand("hooks", {
    description: "审核、信任或撤销 .pi/hooks.json",
    async handler(args, ctx) {
      await reload(ctx, false);
      const loaded = state.loaded;
      if (!loaded?.exists || !loaded.hash) {
        ctx.ui.notify(`未找到 ${loaded?.filePath ?? join(ctx.cwd, ".pi", "hooks.json")}`, "info");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action === "revoke") {
        await revokeHookConfigTrust(trustFilePath, loaded.filePath);
        state.active = false;
        ctx.ui.notify("已撤销当前 Hook 配置的信任。", "info");
        return;
      }
      if (state.active) {
        ctx.ui.notify(`Hook 已信任并启用：${loaded.filePath}`, "info");
        reportCompatibilityWarnings(ctx, loaded);
        return;
      }
      const commands = collectCommands(loaded);
      const confirmed = await ctx.ui.confirm(
        "信任项目 Hooks？",
        [`配置：${loaded.filePath}`, `Hash：${loaded.hash.slice(0, 12)}`, "", ...commands].join("\n"),
      );
      if (!confirmed) return;
      await trustHookConfig(trustFilePath, loaded.filePath, loaded.hash);
      state.active = true;
      ctx.ui.notify("Hook 配置已信任并启用。配置内容变化后需要重新审核。", "info");
      reportCompatibilityWarnings(ctx, loaded);
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
    if (!state.active) return;
    const names = toolMatchValues(event.toolName);
    const outputs = await execute("PreToolUse", names, {
      ...turnInput("PreToolUse", ctx, state, getPermissionMode()),
      tool_name: names[0],
      pi_tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
    }, ctx);
    const reason = preToolDenyReason(outputs);
    if (reason) return { block: true, reason };

    const updatedInput = lastUpdatedInput(outputs);
    if (updatedInput) replaceRecord(event.input, updatedInput);
    const context = collectAdditionalContext(outputs, false);
    if (context.length > 0) state.toolContext.set(event.toolCallId, context);
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
    state.stopHookActive = true;
    pi.sendUserMessage(reason, { deliverAs: "followUp" });
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
  if (toolName === "edit") return ["apply_patch", "Edit", "edit"];
  if (toolName === "write") return ["apply_patch", "Write", "write"];
  return [toolName];
}

function preToolDenyReason(outputs: ParsedHookOutput[]): string | undefined {
  for (const output of outputs) {
    if (output.exitCode === 2) return output.stderr.trim() || "Tool blocked by hook.";
    const specific = hookSpecific(output);
    if (specific?.permissionDecision === "deny") {
      return typeof specific.permissionDecisionReason === "string"
        ? specific.permissionDecisionReason
        : "Tool blocked by hook.";
    }
    if (output.json?.decision === "block") return stringField(output.json, "reason") ?? "Tool blocked by hook.";
  }
  return undefined;
}

function blockingReason(outputs: ParsedHookOutput[]): string | undefined {
  for (const output of outputs) {
    if (output.exitCode === 2) return output.stderr.trim() || "Blocked by hook.";
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
  return output.json?.continue === false;
}

function lastUpdatedInput(outputs: ParsedHookOutput[]): Record<string, unknown> | undefined {
  let updated: Record<string, unknown> | undefined;
  for (const output of outputs) {
    const specific = hookSpecific(output);
    if (specific?.permissionDecision === "allow" && isRecord(specific.updatedInput)) {
      updated = specific.updatedInput;
    }
  }
  return updated;
}

function collectAdditionalContext(outputs: ParsedHookOutput[], allowPlainText: boolean): string[] {
  const context: string[] = [];
  for (const output of outputs) {
    if (allowPlainText && output.exitCode === 0 && output.plainText) context.push(output.plainText);
    const specific = hookSpecific(output);
    if (typeof specific?.additionalContext === "string") context.push(specific.additionalContext);
  }
  return context;
}

function hookSpecific(output: ParsedHookOutput): Record<string, unknown> | undefined {
  return isRecord(output.json?.hookSpecificOutput) ? output.json.hookSpecificOutput : undefined;
}

function notifySystemMessage(output: ParsedHookOutput, ctx: ExtensionContext): void {
  const message = output.json && stringField(output.json, "systemMessage");
  if (message) ctx.ui.notify(message, "warning");
}

function sendHookOutputMessage(
  pi: ExtensionAPI,
  eventName: CodexHookEvent,
  output: ParsedHookOutput,
): void {
  const command = process.platform === "win32" && output.handler.commandWindows
    ? output.handler.commandWindows
    : output.handler.command;
  pi.sendMessage({
    customType: "codex-hook-output",
    content: [
      `Codex Hook: ${eventName}`,
      `Command: ${truncateHookText(command, MAX_HOOK_COMMAND_LENGTH)}`,
      `Output:\n${truncateHookText(hookOutputText(output), MAX_HOOK_OUTPUT_LENGTH)}`,
    ].join("\n"),
    display: true,
    details: { event: eventName, command },
  }, { triggerTurn: false });
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
    if (json.decision === "approve" || specific?.permissionDecision === "ask") {
      return "PreToolUse 当前不支持 approve 或 ask 决策";
    }
    if (isRecord(specific?.updatedInput) && specific?.permissionDecision !== "allow") {
      return "updatedInput 只能与 permissionDecision: allow 一起返回";
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

function collectCommands(loaded: LoadedCodexHooks): string[] {
  const commands: string[] = [];
  for (const [eventName, groups] of Object.entries(loaded.config.hooks)) {
    for (const group of groups ?? []) {
      for (const handler of group.hooks) {
        if (handler.type === "command") commands.push(`${eventName}: ${handler.commandWindows ?? handler.command}`);
      }
    }
  }
  return commands.length > 0 ? commands : ["没有可执行的 command Hook。"];
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
