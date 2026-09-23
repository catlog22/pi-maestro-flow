import type { AskAnswer, AskQuestionSpec } from "./tools/ask.ts";

export type AskTransportCancelReason =
  | "remote_answered"
  | "tui_answered"
  | "cancelled"
  | "aborted"
  | "transport_error";

export interface AskTransportRequest {
  readonly toolCallId: string;
  readonly questions: readonly AskQuestionSpec[];
  readonly cwd: string;
  readonly mode: string;
  readonly sessionFile?: string;
  readonly signal: AbortSignal;
}

export type AskTransportResult =
  | { status: "answered"; answers: AskAnswer[] }
  | { status: "cancelled" };

export interface AskTransportHandle {
  readonly promise: Promise<AskTransportResult>;
  cancel(reason: AskTransportCancelReason): void | Promise<void>;
}

/**
 * Optional transport registered by a host that wants to race an external Ask
 * surface against the local Pi TUI surface. Returning undefined declines the
 * request and leaves the native Ask path in control.
 */
export interface AskTransport {
  open(request: AskTransportRequest): AskTransportHandle | undefined;
}

const registryKey = Symbol.for("pi-maestro-flow.ask-transports");

interface AskTransportRegistry {
  transports: AskTransport[];
}

function registry(): AskTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as AskTransportRegistry | undefined;
  if (existing) return existing;
  const created: AskTransportRegistry = { transports: [] };
  globals[registryKey] = created;
  return created;
}

/** Register an optional external Ask transport and return its disposer. */
export function registerAskTransport(transport: AskTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

export function getAskTransports(): readonly AskTransport[] {
  return [...registry().transports];
}
