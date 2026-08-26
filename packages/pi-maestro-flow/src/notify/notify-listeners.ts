/**
 * Model lifecycle and user-attention notifications.
 *
 * Native terminal/OS notifications are primary. `ctx.ui.notify` remains a
 * fallback when the current environment cannot dispatch a desktop alert.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendDesktopNotification } from "./desktop-notifier.ts";
import type { NotifyModeHandle } from "./notify-mode.ts";
import type {
  UserAttentionContext,
  UserAttentionHandler,
  UserAttentionRequest,
} from "./user-attention.ts";

const COMPLETE_MESSAGE = "模型已完成本轮响应";
const ERROR_LABEL = "模型报错";
const MAX_SEEN_ATTENTION_IDS = 128;

export interface NotifyController {
  /** Per-turn reset; wire to `before_agent_start`. */
  reset(): void;
  /** Notify immediately before Pi blocks waiting for user input. */
  requestInput: UserAttentionHandler;
}

export interface NotifyListenerOptions {
  sendDesktopNotification?: (title: string, body: string) => boolean;
}

export function registerNotifyListeners(
  pi: ExtensionAPI,
  mode: NotifyModeHandle,
  options: NotifyListenerOptions = {},
): NotifyController {
  let turnError: string | undefined;
  const seenAttentionIds = new Set<string>();
  const attentionOrder: string[] = [];
  const sendSystem = options.sendDesktopNotification ?? sendDesktopNotification;

  const notify = (ctx: UserAttentionContext, message: string, type: "info" | "warning" | "error"): void => {
    let delivered = false;
    try {
      delivered = sendSystem(`Pi · ${basename(ctx.cwd)}`, message);
    } catch {
      delivered = false;
    }
    if (delivered || !ctx.ui?.notify) return;
    try {
      ctx.ui.notify(message, type);
    } catch {
      // Notification failures must never break the event loop or a user prompt.
    }
  };

  const requestInput: UserAttentionHandler = (request, ctx) => {
    const config = mode.getConfig();
    if (!config.enabled || !config.onInput || !ctx.hasUI || seenAttentionIds.has(request.id)) return;
    rememberAttention(request.id, seenAttentionIds, attentionOrder);
    notify(ctx, attentionMessage(request), "info");
  };

  pi.on("after_provider_response", (event) => {
    const config = mode.getConfig();
    if (!config.enabled || !config.onError) return;
    if (event.status >= 400) turnError = `${ERROR_LABEL}：HTTP ${event.status}`;
  });

  pi.on("message_end", (event, ctx) => {
    const config = mode.getConfig();
    if (!config.enabled || !config.onError || event.message.role !== "assistant") return;
    const message = event.message as unknown as { stopReason?: string; errorMessage?: string };
    if (message.stopReason !== "error") return;
    const detail = typeof message.errorMessage === "string" && message.errorMessage
      ? message.errorMessage
      : "未知错误";
    turnError = `${ERROR_LABEL}：${detail}`;
    notify(ctx, turnError, "error");
  });

  pi.on("agent_settled", (_event, ctx) => {
    const config = mode.getConfig();
    if (config.enabled && config.onComplete && !turnError) {
      notify(ctx, COMPLETE_MESSAGE, "info");
    }
    turnError = undefined;
  });

  return {
    reset(): void {
      turnError = undefined;
    },
    requestInput,
  };
}

function attentionMessage(request: UserAttentionRequest): string {
  switch (request.kind) {
    case "plan-confirm": return "Plan 等待确认";
    case "plan-review": return "Plan 等待查看或修改";
    case "question": return "有问题等待回答";
    case "permission": return `权限等待确认${request.subject ? `：${request.subject}` : ""}`;
  }
}

function rememberAttention(id: string, seen: Set<string>, order: string[]): void {
  seen.add(id);
  order.push(id);
  if (order.length <= MAX_SEEN_ATTENTION_IDS) return;
  const oldest = order.shift();
  if (oldest) seen.delete(oldest);
}
