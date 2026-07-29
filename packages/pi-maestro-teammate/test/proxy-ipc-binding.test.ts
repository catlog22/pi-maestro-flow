import test from "node:test";
import assert from "node:assert/strict";
import { createIpcSender, type IpcSender } from "../src/extension/index.ts";

/**
 * Regression guard for the nested-teammate IPC bug: `proxyCall` used to detach
 * `process.send` (`const send = process.send`) and call it bare. Node's IPC
 * send reads `this.connected` internally, so with `this === undefined` (module
 * scope, strict mode) every proxied teammate tool threw
 * "Cannot read properties of undefined (reading 'connected')".
 *
 * A plain mock `send` would miss this — the mock below faithfully reads
 * `this.connected` exactly like Node, so a detached call reproduces the
 * production TypeError and a properly bound sender succeeds.
 */
function makeFakeIpcProcess(connected = true) {
  const sent: Array<{ message: Record<string, unknown>; receiver: unknown }> = [];
  const proc = {
    connected,
    sent,
    send(
      this: unknown,
      message: Record<string, unknown>,
      callback?: (error: Error | null) => void,
    ): boolean {
      // Faithful to Node: reads `this.connected`. Throws the production error
      // when called detached (this === undefined).
      const self = this as { connected?: boolean };
      if (!self.connected) return false;
      sent.push({ message, receiver: this });
      callback?.(null);
      return true;
    },
  };
  return proc;
}

test("createIpcSender binds the owner so a Node-style send keeps its receiver", () => {
  const proc = makeFakeIpcProcess();
  const send = createIpcSender(proc);
  assert.ok(send, "a live IPC channel must yield a sender");

  let callbackError: Error | null | undefined;
  const ok = send!({ type: "teammate_proxy_request" }, (error) => {
    callbackError = error;
  });

  assert.equal(ok, true);
  assert.equal(proc.sent.length, 1);
  assert.equal(proc.sent[0].receiver, proc, "send must run with the owner as its receiver");
  assert.equal(callbackError, null);
});

test("a detached send (the pre-fix pattern) throws the connected TypeError", () => {
  const proc = makeFakeIpcProcess();
  const detached = proc.send; // the old buggy `const send = process.send`
  assert.throws(
    () => (detached as unknown as IpcSender)({ type: "teammate_proxy_request" }, () => {}),
    /Cannot read properties of undefined \(reading 'connected'\)/,
  );
});

test("createIpcSender returns undefined when the channel is down or absent", () => {
  assert.equal(createIpcSender(makeFakeIpcProcess(false)), undefined, "disconnected channel");
  assert.equal(createIpcSender({} as never), undefined, "no send method");
  assert.equal(createIpcSender({ connected: true } as never), undefined, "send not a function");
});
