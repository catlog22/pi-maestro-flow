import { randomUUID } from "node:crypto";

interface PendingInteraction {
  resolve: (result: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type TeammateInteractionFailureReason = "unavailable" | "timeout" | "send-failed" | "aborted";

export type TeammateInteractionResult<T> =
  | { ok: true; result: T }
  | { ok: false; reason: TeammateInteractionFailureReason; error?: string };

interface RelayState {
  installed: boolean;
  pending: Map<string, PendingInteraction>;
}

const relayKey = Symbol.for("pi-maestro-flow.teammate-interactions");

export function isTeammateChild(): boolean {
  return process.env.PI_TEAMMATE_CHILD === "1" && typeof process.send === "function";
}

export async function requestTeammateInteraction<T>(
  interaction: "permission" | "question",
  payload: Record<string, unknown>,
  timeoutMs = 10 * 60_000,
  signal?: AbortSignal,
): Promise<TeammateInteractionResult<T>> {
  if (!isTeammateChild()) return { ok: false, reason: "unavailable" };
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const state = relayState();
  installListener(state);
  const requestId = randomUUID();
  return new Promise<TeammateInteractionResult<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const notifyParentAbort = (): void => {
      try {
        process.send?.({
          type: "teammate_proxy_cancel",
          requestId,
          reason: "aborted",
        }, () => {});
      } catch {
        // The channel is already gone, which is itself the cancellation.
      }
    };
    const onAbort = () => {
      notifyParentAbort();
      finish({ ok: false, reason: "aborted" });
    };
    const finish = (result: TeammateInteractionResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      state.pending.delete(requestId);
      resolve(result);
    };
    timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    state.pending.set(requestId, {
      timer,
      resolve: (result) => finish({ ok: true, result: result as T }),
    });
    try {
      process.send?.({
        type: "teammate_interaction_request",
        requestId,
        interaction,
        correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
        payload,
      }, (error) => {
        if (error) {
          finish({ ok: false, reason: "send-failed", error: error.message });
        }
      });
    } catch (error) {
      finish({
        ok: false,
        reason: "send-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function relayState(): RelayState {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[relayKey] as RelayState | undefined;
  if (existing) return existing;
  const created: RelayState = { installed: false, pending: new Map() };
  globals[relayKey] = created;
  return created;
}

function installListener(state: RelayState): void {
  if (state.installed) return;
  state.installed = true;
  process.on("message", (message: unknown) => {
    const record = message as Record<string, unknown>;
    if (record?.type !== "teammate_interaction_response" || typeof record.requestId !== "string") return;
    const pending = state.pending.get(record.requestId);
    if (!pending) return;
    state.pending.delete(record.requestId);
    clearTimeout(pending.timer);
    pending.resolve(record.result);
  });
}
