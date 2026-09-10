/** Absolute-deadline and bounded probing helpers shared by tunnel providers. */
import type { GatewayTunnelDeadlineContext, GatewayTunnelProbeResult } from "./contracts.ts";

export class GatewayTunnelDeadlineError extends Error {
  readonly code = "tunnel_deadline_exceeded";
  constructor(readonly deadlineAt: number, stage = "operation") {
    super(`Tunnel ${stage} exceeded its absolute deadline`);
    this.name = "GatewayTunnelDeadlineError";
  }
}

export interface GatewayTunnelDeadlineOptions {
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class GatewayTunnelDeadline implements GatewayTunnelDeadlineContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly clearTimer: typeof clearTimeout;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(deadlineAt: number, options: GatewayTunnelDeadlineOptions = {}) {
    if (!Number.isFinite(deadlineAt) || deadlineAt < 0) throw new Error("Tunnel deadlineAt must be a finite non-negative timestamp");
    this.deadlineAt = deadlineAt;
    this.now = options.now ?? (() => Date.now());
    this.signal = this.controller.signal;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    const delay = Math.max(0, deadlineAt - this.now());
    const setTimer = options.setTimer ?? setTimeout;
    this.timer = setTimer(() => this.controller.abort(new GatewayTunnelDeadlineError(deadlineAt)), delay);
    if (delay === 0) this.controller.abort(new GatewayTunnelDeadlineError(deadlineAt));
  }

  remainingMs(): number { return Math.max(0, this.deadlineAt - this.now()); }
  throwIfExpired(stage = "operation"): void {
    if (this.remainingMs() <= 0 || this.signal.aborted) throw new GatewayTunnelDeadlineError(this.deadlineAt, stage);
  }
  close(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

export function createGatewayTunnelDeadline(timeoutMs: number, options: GatewayTunnelDeadlineOptions & { deadlineAt?: number } = {}): GatewayTunnelDeadline {
  const now = options.now ?? (() => Date.now());
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Tunnel timeoutMs must be a positive number");
  return new GatewayTunnelDeadline(options.deadlineAt ?? now() + timeoutMs, { ...options, now });
}

export async function runWithinTunnelDeadline<T>(
  context: GatewayTunnelDeadlineContext,
  stage: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  context.throwIfExpired(stage);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(context.signal.reason instanceof Error ? context.signal.reason : new GatewayTunnelDeadlineError(context.deadlineAt, stage));
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
  });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { if (onAbort) context.signal.removeEventListener("abort", onAbort); }
}

export async function waitWithinTunnelDeadline(context: GatewayTunnelDeadlineContext, delayMs: number): Promise<void> {
  context.throwIfExpired("probe");
  const bounded = Math.min(Math.max(0, delayMs), context.remainingMs());
  if (bounded <= 0) return context.throwIfExpired("probe");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      context.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, bounded);
    const onAbort = (): void => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      reject(context.signal.reason instanceof Error ? context.signal.reason : new GatewayTunnelDeadlineError(context.deadlineAt, "probe"));
    };
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
  });
  context.throwIfExpired("probe");
}

/** Poll until ready/terminal while preserving the caller's single deadline. */
export async function probeGatewayTunnel(
  context: GatewayTunnelDeadlineContext,
  probe: () => Promise<GatewayTunnelProbeResult>,
  defaultIntervalMs = 100,
  onResult?: (result: GatewayTunnelProbeResult) => void | Promise<void>,
): Promise<GatewayTunnelProbeResult> {
  for (;;) {
    context.throwIfExpired("probe");
    const result = await runWithinTunnelDeadline(context, "probe", probe);
    if (onResult) await runWithinTunnelDeadline(context, "probe publish", () => onResult(result));
    if (result.ready || result.terminal) return result;
    await waitWithinTunnelDeadline(context, Math.max(1, result.retryAfterMs ?? defaultIntervalMs));
  }
}
