export interface MonitorSessionStartupTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface MonitorSessionStartupDispatchResult {
  isError?: boolean;
  content?: readonly unknown[];
}

export interface MonitorSessionStartupOptions<TInvocation> {
  dispatch: () => Promise<MonitorSessionStartupDispatchResult>;
  isRootFenceCurrent: () => boolean;
  onDispatchError?: (result: MonitorSessionStartupDispatchResult) => Error;
  onRootFenceChanged?: () => Error;
  onIdentityMissing?: () => Error;
  timer?: MonitorSessionStartupTimer;
  timeoutMs?: number;
}

export interface MonitorSessionStartup<TInvocation> {
  readonly promise: Promise<TInvocation>;
  start(): void;
  accept(invocation: TInvocation): boolean;
  reject(error: Error): void;
}

const systemTimer: MonitorSessionStartupTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function defaultDispatchError(result: MonitorSessionStartupDispatchResult): Error {
  const text = Array.isArray(result.content)
    ? result.content
      .map((entry) => typeof entry === "object" && entry !== null && "text" in entry
        ? String((entry as { text?: unknown }).text ?? "")
        : "")
      .join("\n")
      .trim()
    : "";
  return new Error(text || "Monitor evaluator dispatch was rejected.");
}

/**
 * Coordinates the async gap between accepting a background dispatch and
 * publishing the host-owned evaluator identity.
 */
export function createMonitorSessionStartup<TInvocation>(
  options: MonitorSessionStartupOptions<TInvocation>,
): MonitorSessionStartup<TInvocation> {
  const timer = options.timer ?? systemTimer;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let settled = false;
  let started = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (invocation: TInvocation) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<TInvocation>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const clearStartupTimer = (): void => {
    if (startupTimer === undefined) return;
    timer.clearTimeout(startupTimer);
    startupTimer = undefined;
  };
  const reject = (error: Error): void => {
    if (settled) return;
    settled = true;
    clearStartupTimer();
    rejectPromise(error);
  };
  const accept = (invocation: TInvocation): boolean => {
    if (settled) return false;
    settled = true;
    clearStartupTimer();
    resolvePromise(invocation);
    return true;
  };
  const start = (): void => {
    if (started || settled) return;
    started = true;
    void options.dispatch().then((result) => {
      if (settled || !result.isError) return;
      reject((options.onDispatchError ?? defaultDispatchError)(result));
    }).catch((error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (settled) return;
    startupTimer = timer.setTimeout(() => {
      if (settled) return;
      reject(!options.isRootFenceCurrent()
        ? (options.onRootFenceChanged ?? (() => new Error(
          "Monitor evaluator session changed before its session identity was published.",
        )))()
        : (options.onIdentityMissing ?? (() => new Error(
          "Monitor evaluator did not publish a session identity.",
        )))());
    }, timeoutMs);
    startupTimer.unref?.();
  };

  return { promise, start, accept, reject };
}
