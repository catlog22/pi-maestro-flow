/**
 * Turn-completion / error detection → `ctx.ui.notify` bridge.
 *
 * Listens to the three Pi events that bracket a model turn and fires a single
 * toast per turn:
 *   - `after_provider_response`: HTTP status ≥400 → provider error.
 *   - `message_end` (assistant, stopReason "error"): streaming/model error.
 *   - `agent_settled`: the turn fully settled with no retry/compaction/continuation pending.
 *
 * A turn that errors suppresses the "complete" toast so the user sees the
 * error message once. The first `before_agent_start` of a turn resets the
 * per-turn error latch. Disabled via the `NotifyModeHandle` config.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotifyConfig, NotifyModeHandle } from "./notify-mode.ts";

const COMPLETE_MESSAGE = "模型已完成本轮响应 ✓";
const ERROR_LABEL = "模型报错";

export interface NotifyController {
  /** Per-turn reset; wire to `before_agent_start`. */
  reset(): void;
}

/**
 * Register turn/error listeners against `pi`. Returns a controller for the
 * `before_agent_start` reset hook (kept separate so the entry point can chain
 * it with its existing before_agent_start handler).
 */
export function registerNotifyListeners(
  pi: ExtensionAPI,
  mode: NotifyModeHandle,
): NotifyController {
  let turnError: string | undefined;

  const notify = (ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void => {
    if (!ctx?.ui?.notify) return;
    try {
      ctx.ui.notify(message, type);
    } catch {
      // Notification is cosmetic — never break the event loop.
    }
  };

  // HTTP-level provider error (4xx/5xx). Captured before the stream is
  // consumed; the error message is also surfaced later via message_end, so
  // this only seeds the latch without notifying yet (avoids duplicates).
  pi.on("after_provider_response", (event, ctx) => {
    const config = mode.getConfig();
    if (!config.enabled || !config.onError) return;
    if (event.status >= 400) {
      turnError = `${ERROR_LABEL}：HTTP ${event.status}`;
    }
    // No notify here; message_end/agent_settled owns the single toast.
    void ctx;
  });

  // Streaming/model error (stopReason "error"). The authoritative error text.
  pi.on("message_end", (event, ctx) => {
    const config = mode.getConfig();
    if (!config.enabled || !config.onError) return;
    if (event.message.role !== "assistant") return;
    const message = event.message as unknown as { stopReason?: string; errorMessage?: string };
    if (message.stopReason !== "error") return;
    const detail = typeof message.errorMessage === "string" && message.errorMessage
      ? message.errorMessage
      : "未知错误";
    turnError = `${ERROR_LABEL}：${detail}`;
    notify(ctx, turnError, "error");
  });

  // Turn fully settled. Emit a completion toast only when no error was seen
  // this turn (otherwise the error toast above already fired).
  pi.on("agent_settled", (_event, ctx) => {
    const config = mode.getConfig();
    if (config.enabled && config.onComplete && !turnError) {
      notify(ctx, COMPLETE_MESSAGE, "info");
    }
    // Reset after the turn regardless so the next turn starts clean.
    turnError = undefined;
  });

  return {
    reset(): void {
      turnError = undefined;
    },
  };
}
