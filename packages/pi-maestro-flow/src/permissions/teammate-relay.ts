import { randomUUID } from "node:crypto";

interface PendingInteraction {
  resolve: (result: unknown | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
): Promise<T | undefined> {
  if (!isTeammateChild()) return undefined;
  const state = relayState();
  installListener(state);
  const requestId = randomUUID();
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(requestId, {
      timer,
      resolve: (result) => resolve(result as T | undefined),
    });
    try {
      process.send?.({
        type: "teammate_interaction_request",
        requestId,
        interaction,
        correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
        payload,
      });
    } catch {
      clearTimeout(timer);
      state.pending.delete(requestId);
      resolve(undefined);
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
