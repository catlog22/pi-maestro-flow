import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  createChildProxyRequest,
  rejectAllChildProxyRequests,
  resolveChildProxyRequest,
  type ChildProxyPendingRequests,
} from "../src/extension/index.ts";
import {
  bindChildTerminationSignal,
  createChildTerminationController,
  sendChildIpcMessage,
} from "../src/runs/execution.ts";

class FakeChild extends EventEmitter {
  pid = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("child termination escalates once only while the real process state is alive", async () => {
  const child = new FakeChild();
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    platform: "linux",
  });

  termination.terminate();
  termination.terminate();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  const outcome = await Promise.race([
    termination.outcome,
    delay(100).then(() => { throw new Error("termination outcome timed out"); }),
  ]);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(outcome, {
    status: "unreaped",
    forced: true,
    reason: "exit-unconfirmed",
  });
  termination.cleanup();
});

test("failed TERM and KILL delivery reports an unreaped outcome", async () => {
  const child = new FakeChild();
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    child.signals.push(signal);
    return false;
  };
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    platform: "linux",
  });

  termination.terminate();
  const outcome = await Promise.race([
    termination.outcome,
    delay(100).then(() => { throw new Error("termination outcome timed out"); }),
  ]);
  assert.deepEqual(outcome, {
    status: "unreaped",
    forced: true,
    reason: "delivery-failed",
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  termination.cleanup();
});

test("child exit state and exit event cancel force-kill escalation", async () => {
  const alreadyExited = new FakeChild();
  alreadyExited.signalCode = "SIGTERM";
  const completed = createChildTerminationController(alreadyExited as unknown as ChildProcess, {
    graceMs: 5,
    platform: "linux",
  });
  completed.terminate();
  assert.deepEqual(alreadyExited.signals, []);
  completed.cleanup();

  const exiting = new FakeChild();
  const termination = createChildTerminationController(exiting as unknown as ChildProcess, {
    graceMs: 5,
    platform: "linux",
  });
  termination.terminate();
  exiting.signalCode = "SIGTERM";
  exiting.emit("exit", null, "SIGTERM");
  assert.deepEqual(await termination.outcome, { status: "reclaimed", forced: false });
  await delay(15);
  assert.deepEqual(exiting.signals, ["SIGTERM"]);
  termination.cleanup();
});

test("child close cleanup cancels the pending grace timer", async () => {
  const child = new FakeChild();
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    platform: "linux",
  });
  termination.terminate();
  termination.cleanup();
  await delay(15);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("Windows exited roots avoid redundant forced taskkill when graceful tree confirmation stalls", async () => {
  const child = new FakeChild();
  const calls: Array<{ command: string; args: string[]; shell: boolean | undefined }> = [];
  const spawnProcess = ((command: string, args: string[], options: { shell?: boolean }) => {
    calls.push({ command, args, shell: options.shell });
    return new EventEmitter();
  }) as unknown as typeof import("node:child_process").spawn;
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    reclamationTimeoutMs: 10,
    platform: "win32",
    spawnProcess,
  });

  termination.terminate();
  assert.deepEqual(calls, [{
    command: "taskkill",
    args: ["/PID", "4321", "/T"],
    shell: false,
  }]);
  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");
  termination.cleanup();
  const outcome = await Promise.race([
    termination.outcome,
    delay(100).then(() => { throw new Error("Windows exited-root outcome timed out"); }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(outcome, {
    status: "reclaimed",
    forced: false,
    treeCleanupConfirmed: false,
  });
  assert.deepEqual(child.signals, []);
  termination.cleanup();
});

test("Windows forced taskkill timeout reports an unreaped outcome", async () => {
  const child = new FakeChild();
  const killers: EventEmitter[] = [];
  const spawnProcess = (() => {
    const killer = new EventEmitter();
    killers.push(killer);
    return killer;
  }) as unknown as typeof import("node:child_process").spawn;
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    reclamationTimeoutMs: 10,
    platform: "win32",
    spawnProcess,
  });

  termination.terminate();
  const outcome = await Promise.race([
    termination.outcome,
    delay(100).then(() => { throw new Error("Windows termination outcome timed out"); }),
  ]);
  assert.equal(killers.length, 2);
  assert.deepEqual(outcome, {
    status: "unreaped",
    forced: true,
    reason: "exit-unconfirmed",
  });
  termination.cleanup();
});

test("Windows forced child exit is reclaimed when taskkill confirmation stalls", async () => {
  const child = new FakeChild();
  const killers: EventEmitter[] = [];
  const spawnProcess = (() => {
    const killer = new EventEmitter();
    killers.push(killer);
    return killer;
  }) as unknown as typeof import("node:child_process").spawn;
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    reclamationTimeoutMs: 15,
    platform: "win32",
    spawnProcess,
  });

  termination.terminate();
  await delay(8);
  assert.equal(killers.length, 2);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  const outcome = await Promise.race([
    termination.outcome,
    delay(100).then(() => { throw new Error("Windows forced-exit outcome timed out"); }),
  ]);
  assert.deepEqual(outcome, {
    status: "reclaimed",
    forced: true,
    treeCleanupConfirmed: false,
  });
  termination.cleanup();
});

test("Windows confirmed graceful tree cleanup cancels force escalation", async () => {
  const child = new FakeChild();
  const killers: EventEmitter[] = [];
  const spawnProcess = (() => {
    const killer = new EventEmitter();
    killers.push(killer);
    return killer;
  }) as unknown as typeof import("node:child_process").spawn;
  const termination = createChildTerminationController(child as unknown as ChildProcess, {
    graceMs: 5,
    platform: "win32",
    spawnProcess,
  });

  termination.terminate();
  killers[0].emit("close", 0);
  assert.deepEqual(await termination.outcome, { status: "reclaimed", forced: false });
  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");
  termination.cleanup();
  await delay(15);
  assert.equal(killers.length, 1);
});

test("pre-aborted child termination signal is applied immediately after binding", () => {
  const controller = new AbortController();
  controller.abort();
  let terminations = 0;
  const unbind = bindChildTerminationSignal({
    outcome: Promise.resolve({ status: "reclaimed", forced: false }),
    terminate() { terminations += 1; },
    cleanup() {},
  }, controller.signal);

  assert.equal(terminations, 1);
  unbind();
});

test("child IPC async delivery failure disconnects the channel", async () => {
  let callbackInstalled = false;
  let disconnects = 0;
  let connected = true;
  const child = {
    get connected() { return connected; },
    send(_message: unknown, callback: (error: Error | null) => void) {
      callbackInstalled = typeof callback === "function";
      queueMicrotask(() => callback(Object.assign(new Error("channel closed"), {
        code: "ERR_IPC_CHANNEL_CLOSED",
      })));
      return true;
    },
    disconnect() { connected = false; disconnects += 1; },
  } as unknown as ChildProcess;

  assert.equal(sendChildIpcMessage(child, { type: "late_reply" }), true);
  await delay(0);
  assert.equal(callbackInstalled, true);
  assert.equal(disconnects, 1);

  const disconnectedChild = { connected: false } as unknown as ChildProcess;
  assert.equal(sendChildIpcMessage(disconnectedChild, { type: "after_disconnect" }), false);
});

test("child IPC backpressure still counts as an accepted envelope", async () => {
  let callbackCompleted = false;
  const child = {
    connected: true,
    send(_message: unknown, callback: (error: Error | null) => void) {
      queueMicrotask(() => { callbackCompleted = true; callback(null); });
      return false;
    },
  } as unknown as ChildProcess;

  assert.equal(sendChildIpcMessage(child, { type: "backpressure" }), true);
  await delay(0);
  assert.equal(callbackCompleted, true);
});

test("child proxy response wins exactly once over a late send callback error", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  let sendCallback: ((error: Error | null) => void) | undefined;
  const response = createChildProxyRequest(
    pending,
    "request-1",
    { type: "teammate_proxy_request", requestId: "request-1" },
    (_message, callback) => {
      sendCallback = callback;
      return true;
    },
    100,
  );

  assert.equal(resolveChildProxyRequest(pending, "request-1", { ok: true }), true);
  sendCallback?.(new Error("late IPC callback"));
  assert.deepEqual(await response, { ok: true });
  assert.equal(resolveChildProxyRequest(pending, "request-1", { duplicate: true }), false);
  assert.equal(pending.size, 0);
});

test("child proxy send failures and timeouts reject and clear their pending entries", async () => {
  const callbackFailurePending: ChildProxyPendingRequests = new Map();
  let failSend: ((error: Error | null) => void) | undefined;
  const callbackFailure = createChildProxyRequest(
    callbackFailurePending,
    "callback-failure",
    { type: "teammate_proxy_request", requestId: "callback-failure" },
    (_message, callback) => {
      failSend = callback;
      return false;
    },
    100,
  );
  failSend?.(new Error("IPC send callback failed"));
  await assert.rejects(callbackFailure, /IPC send callback failed/);
  assert.equal(callbackFailurePending.size, 0);

  const sendFailurePending: ChildProxyPendingRequests = new Map();
  const sendFailure = createChildProxyRequest(
    sendFailurePending,
    "send-failure",
    { type: "teammate_proxy_request", requestId: "send-failure" },
    () => { throw new Error("IPC channel closed"); },
    100,
  );
  await assert.rejects(sendFailure, /IPC channel closed/);
  assert.equal(sendFailurePending.size, 0);

  const timeoutPending: ChildProxyPendingRequests = new Map();
  const timedOut = createChildProxyRequest(
    timeoutPending,
    "timeout",
    { type: "teammate_proxy_request", requestId: "timeout" },
    () => true,
    5,
  );
  await assert.rejects(timedOut, /timed out after 5ms/);
  assert.equal(timeoutPending.size, 0);
});

test("child proxy lifecycle failure rejects and clears every pending request", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  const first = createChildProxyRequest(
    pending,
    "first",
    { type: "teammate_proxy_request", requestId: "first" },
    () => true,
    1_000,
  );
  const second = createChildProxyRequest(
    pending,
    "second",
    { type: "teammate_proxy_request", requestId: "second" },
    () => true,
    1_000,
  );

  rejectAllChildProxyRequests(pending, new Error("session shutdown"));
  await Promise.all([
    assert.rejects(first, /session shutdown/),
    assert.rejects(second, /session shutdown/),
  ]);
  assert.equal(pending.size, 0);
});

test("child proxy abort rejects exactly once, clears pending, and skips pre-aborted sends", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortedPending: ChildProxyPendingRequests = new Map();
  let sends = 0;
  const skipped = createChildProxyRequest(
    preAbortedPending,
    "pre-aborted",
    { type: "teammate_proxy_request", requestId: "pre-aborted" },
    () => { sends += 1; return true; },
    100,
    preAborted.signal,
  );
  await assert.rejects(skipped, (error: Error) => error.name === "AbortError");
  assert.equal(sends, 0);
  assert.equal(preAbortedPending.size, 0);

  const pending: ChildProxyPendingRequests = new Map();
  const controller = new AbortController();
  let sendCallback: ((error: Error | null) => void) | undefined;
  const aborted = createChildProxyRequest(
    pending,
    "abort-race",
    { type: "teammate_proxy_request", requestId: "abort-race" },
    (_message, callback) => {
      sendCallback = callback;
      return true;
    },
    100,
    controller.signal,
  );
  controller.abort();
  sendCallback?.(new Error("late send failure"));
  assert.equal(resolveChildProxyRequest(pending, "abort-race", { late: true }), false);
  await assert.rejects(aborted, (error: Error) => error.name === "AbortError");
  assert.equal(pending.size, 0);
});
