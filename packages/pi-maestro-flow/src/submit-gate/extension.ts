/**
 * submit-gate extension entry — serializes idle submissions across the
 * pre-prompt window to prevent the "Agent is already processing a prompt"
 * single-flight assertion error in pi-agent-core.
 *
 * Root cause (pi-agent-core activeRun single-flight):
 *   AgentSession.prompt()'s busy check (`_isAgentRunActive`) only latches
 *   *after* the submission's async prelude (model auth / pre-submit auto
 *   compaction / extension events) finishes. Auto-compaction stretches this
 *   unlocked window to tens of seconds; a second idle submission during it
 *   slips past the isStreaming/isCompacting guards and reaches
 *   agent.prompt() concurrently, where the later one hits the activeRun
 *   assertion and throws.
 *
 * This extension gates at the `input` event (every session.prompt() passes
 * through it):
 *   - after releasing one idle submission it sets `pending`, held until
 *     `agent_settled` (run fully finished) releases it;
 *   - idle submissions during `pending` are intercepted and queued, then
 *     replayed serially after `settled`;
 *   - a 60s timeout backstops submissions that fail inside the prelude (e.g.
 *     a compaction throw) so the gate never deadlocks.
 *
 * Streaming submissions (streamingBehavior=steer/followUp) are handled by the
 * core queue and have no such race, so they pass straight through.
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const TIMEOUT_MS = 60_000;

interface QueuedMessage {
  text: string;
  images?: ImageContent[];
}

export default function registerSubmitGate(pi: ExtensionAPI): void {
  const queued: QueuedMessage[] = [];
  let submissionPending = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  /** Serially replay queued messages: only send the next after the previous fully settles. */
  function flushQueued(): void {
    clearTimeout(flushTimer);
    // Detach from the current event loop so we don't nest submissions
    // inside the agent_settled emit cycle.
    flushTimer = setTimeout(async () => {
      while (queued.length > 0) {
        const message = queued.shift()!;
        const content: string | (TextContent | ImageContent)[] =
          message.images && message.images.length > 0
            ? [{ type: "text", text: message.text } as TextContent, ...message.images]
            : message.text;
        try {
          await pi.sendUserMessage(content);
        } catch (error) {
          console.error("[submit-gate] failed to flush queued message:", error);
        }
      }
    }, 0);
  }

  function releaseGate(): void {
    submissionPending = false;
    clearTimeout(timeoutTimer);
    flushQueued();
  }

  pi.on("input", (event: InputEvent, ctx: ExtensionContext): InputEventResult | Promise<InputEventResult | void> | void => {
    // Streaming submissions are handled by the core steer/followUp queue — no race here.
    if (event.streamingBehavior !== undefined) return { action: "continue" as const };
    // The gate's own replayed messages (submitted after settled, source=extension) pass through.
    if (event.source === "extension") return { action: "continue" as const };

    if (submissionPending) {
      // Race hit: the previous idle submission is still in compaction / wind-down — queue it.
      queued.push({ text: event.text, images: event.images });
      ctx.ui.notify("上一条消息仍在压缩/收尾,本条已排队,完成后自动发送。", "info");
      return { action: "handled" as const };
    }

    submissionPending = true;
    // Backstop: if the submission fails inside the async prelude (compaction
    // throw, etc.) with no agent_settled, release the gate on timeout.
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      submissionPending = false;
      flushQueued();
    }, TIMEOUT_MS);
    return { action: "continue" as const };
  });

  pi.on("agent_settled", () => releaseGate());

  pi.on("session_shutdown", () => {
    clearTimeout(flushTimer);
    clearTimeout(timeoutTimer);
    queued.length = 0;
  });
}
