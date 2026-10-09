import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-node";

type AsyncSearch<K extends "grep" | "glob" | "fileSearch"> = (
  ...args: Parameters<FileFinderApi[K]>
) => ReturnType<FileFinderApi[K]> | Promise<ReturnType<FileFinderApi[K]>>;

/** Native test doubles remain assignable; real searches cross the process boundary. */
export type FffFinder = Pick<FileFinderApi, "isDestroyed" | "waitForScan"> & {
  destroy(): void | Promise<void>;
  /** Resolves only after the owned worker emits close, not after a cleanup deadline. */
  readonly closed?: Promise<void>;
  grep: AsyncSearch<"grep">;
  glob: AsyncSearch<"glob">;
  fileSearch: AsyncSearch<"fileSearch">;
};
export type CreateFffFinder = (options: InitOptions) => Result<FffFinder>;

interface RuntimeOptions {
  /** Test-only replacement for the packaged, plain-JavaScript worker. */
  workerPath?: string | URL;
  /** Includes startup and time spent waiting behind initialization. */
  requestTimeoutMs?: number;
  /** Test-only failure injection; production always uses Node fork/child.kill. */
  forkChild?: (path: string | URL, args: string[], options: ForkOptions) => ChildProcess;
  killChild?: (child: ChildProcess) => boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Native budgets exclude IPC serialization and delivery of partial results.
const IPC_TIMEOUT_GRACE_MS = 100;
const MAX_PENDING_REQUESTS = 256;
const MAX_STDERR_BYTES = 8_192;
const KILL_ATTEMPTS = 3;
const CLOSE_WAIT_MS = 333;

/**
 * One persistent OS child per finder. This module must never value-import the
 * native library: even loading it in the Pi process defeats crash isolation.
 * Transport failures reject; native operation failures retain their Result shape.
 */
export function createFffProcessFinder(
  options: InitOptions,
  runtimeOptions: RuntimeOptions = {},
): Result<FffFinder> {
  const timeoutMs = runtimeOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { ok: false, error: "FFF request timeout must be a positive finite timer interval" };
  }
  let child: ChildProcess;
  try {
    // NODE_OPTIONS can also inject inspectors/loaders, independently of execArgv.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    // fork forwards windowsHide to spawn, although some Node type versions
    // omit it from ForkOptions.
    const workerOptions: ForkOptions & { windowsHide: boolean } = {
      execPath: process.execPath,
      execArgv: [],
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
      serialization: "json",
    };
    child = (runtimeOptions.forkChild ?? fork)(runtimeOptions.workerPath ?? new URL("../../bin/fff-worker.mjs", import.meta.url), [], workerOptions);
  } catch (error) {
    return { ok: false, error: `FFF worker could not start: ${String(error)}` };
  }

  let destroyed = false;
  let failure: Error | undefined;
  let stderr = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map<number, PendingRequest>();
  const callTimers = new Set<ReturnType<typeof setTimeout>>();
  let didClose = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let reclamation: Promise<void> | undefined;
  const killChild = runtimeOptions.killChild ?? ((owned: ChildProcess) => owned.kill("SIGKILL"));
  // Never signal again after exit (even if stdio close is still outstanding).
  const canKill = (): boolean => !didClose && child.exitCode === null && child.signalCode === null;
  const onParentExit = (): void => {
    if (!canKill()) return;
    try {
      if (!killChild(child)) process.stderr.write("FFF worker cleanup failed during parent exit: SIGKILL refused\n");
    } catch (error) {
      process.stderr.write(`FFF worker cleanup failed during parent exit: ${String(error)}\n`);
    }
  };
  process.once("exit", onParentExit);
  const waitForClose = (): Promise<void> => new Promise((resolve) => {
    if (didClose) { resolve(); return; }
    const settled = (): void => {
      clearTimeout(timer);
      child.removeListener("close", settled);
      resolve();
    };
    const timer = setTimeout(settled, CLOSE_WAIT_MS);
    child.once("close", settled);
  });
  const reclaim = (): Promise<void> => {
    if (reclamation) return reclamation;
    if (didClose) return Promise.resolve();
    const attempt = (async () => {
      const errors: string[] = [];
      // No graceful native destroy: native work can hang/crash. Kill only this
      // exact ChildProcess (no descendants/PID lookup), then require close.
      for (let retry = 0; retry < KILL_ATTEMPTS && !didClose; retry++) {
        if (canKill()) {
          try {
            if (!killChild(child)) errors.push("SIGKILL refused");
          } catch (error) { errors.push(`SIGKILL failed: ${String(error)}`); }
        }
        await waitForClose();
      }
      if (!didClose) {
        throw new Error(`FFF worker cleanup failed: close not confirmed after ${KILL_ATTEMPTS} attempts${errors.length ? ` (${errors.join("; ")})` : ""}`);
      }
    })();
    reclamation = attempt;
    // Internal timeout/error cleanup and unused finders must never generate an
    // unhandled rejection. Keep ownership, but permit a later explicit retry.
    void attempt.catch(() => { if (reclamation === attempt) reclamation = undefined; });
    return attempt;
  };
  const stop = (reason: string): Promise<void> => {
    if (destroyed) return reclamation ?? Promise.resolve();
    destroyed = true;
    const cause = new Error(`${reason}${stderr.length ? `\nFFF worker stderr: ${stderr.toString("utf8")}` : ""}`);
    failure = cause;
    const requests = [...pending.values()];
    for (const request of requests) clearTimeout(request.timer);
    pending.clear();
    for (const timer of callTimers) clearTimeout(timer);
    callTimers.clear();
    const cleanup = reclaim();
    // Fence synchronously, but settle outstanding calls after bounded cleanup
    // so their original failure also reports any unconfirmed reclamation.
    void cleanup.then(() => {
      for (const request of requests) request.reject(cause);
    }, (error: Error) => {
      failure = new AggregateError([cause, error], `${cause.message}\n${error.message}`);
      for (const request of requests) request.reject(failure);
    });
    return cleanup;
  };
  child.on("close", (code, signal) => {
    didClose = true;
    process.removeListener("exit", onParentExit);
    resolveClosed();
    // close can precede the usual stop events (e.g. a spawn failure).
    void stop(`FFF worker closed (code ${code}, signal ${signal})`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
  });
  child.on("error", (error) => stop(`FFF worker error: ${error.message}`));
  child.on("exit", (code, signal) => stop(`FFF worker exited (code ${code}, signal ${signal})`));
  child.on("disconnect", () => stop("FFF worker disconnected"));
  child.on("message", (message: unknown) => {
    if (destroyed || !message || typeof message !== "object") return;
    const reply = message as { id?: number; result?: unknown; error?: string };
    if (typeof reply.id !== "number") return;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (typeof reply.error === "string") request.reject(new Error(`FFF worker: ${reply.error}`));
    else if (reply.result && typeof reply.result === "object" && "ok" in reply.result) request.resolve(reply.result);
    else {
      // Include this malformed reply in the same cleanup-aware rejection path.
      pending.set(reply.id, request);
      void stop("FFF worker protocol failure: returned an invalid response");
    }
  });

  const request = <T>(method: string, args: unknown[], deadlineMs = timeoutMs): Promise<T> => {
    if (destroyed) return Promise.reject(failure ?? new Error("FFF finder destroyed"));
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("FFF worker request limit reached"));
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => stop(`FFF worker request timed out (${method}, ${deadlineMs}ms)`), deadlineMs);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        if (!child.connected) stop("FFF worker IPC is disconnected");
        else child.send({ id, method, args }, (error) => {
          if (error) stop(`FFF worker send failed: ${error.message}`);
        });
      } catch (error) {
        stop(`FFF worker send failed: ${String(error)}`);
      }
    });
  };

  // Start eagerly, but always observe its rejection, even if the factory caller
  // never uses the finder. Public calls get their own enqueue-time deadline.
  const initialized = request<Result<boolean>>("init", [options]).then(async (result) => {
    if (!result.ok) {
      await stop(`FFF worker initialization failed: ${result.error}`).catch(() => {});
      throw failure;
    }
  }, (error) => {
    stop(`FFF worker initialization failed: ${String(error)}`);
    throw failure;
  });
  void initialized.catch(() => {});
  const call = <T>(method: string, args: unknown[]): Promise<T> => {
    let budget: unknown;
    if (method === "waitForScan") budget = args[0] ?? 5_000;
    else if (method === "grep") budget = (args[1] as { timeBudgetMs?: number } | undefined)?.timeBudgetMs;
    let deadlineMs = timeoutMs;
    if (typeof budget === "number" && Number.isFinite(budget)
      && (method === "waitForScan" ? budget >= 0 : budget > 0)) {
      deadlineMs = Math.min(timeoutMs, Math.max(1, budget) + IPC_TIMEOUT_GRACE_MS);
    }
    // A reply may arrive before init completes. Keep the enqueue-time deadline
    // through both promises, rather than retiring it on that early IPC reply.
    const timer = setTimeout(() => stop(`FFF worker request timed out (${method}, ${deadlineMs}ms)`), deadlineMs);
    callTimers.add(timer);
    const result = request<T>(method, args, deadlineMs);
    // Attach handlers to both immediately; no deferred/unobserved rejection.
    return Promise.all([initialized, result]).then(([, value]) => {
      if (destroyed) throw failure;
      return value;
    }).finally(() => {
      clearTimeout(timer);
      callTimers.delete(timer);
    });
  };

  return {
    ok: true,
    value: {
      get isDestroyed() { return destroyed; },
      closed,
      destroy() { return destroyed ? reclaim() : stop("FFF finder destroyed"); },
      waitForScan: (...args) => call("waitForScan", args),
      grep: (...args) => call("grep", args),
      glob: (...args) => call("glob", args),
      fileSearch: (...args) => call("fileSearch", args),
    },
  };
}

/** Initialization rejects after fencing are expected; failed cleanup is not. */
export async function awaitFffTeardown(cleanups: Promise<void>[], scans: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled([...cleanups, Promise.allSettled(scans)]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) {
    const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    throw new AggregateError(errors, `FFF cleanup unconfirmed: ${details}`);
  }
}
