import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LspClient } from "../src/tools/lsp/client.ts";

function fixture(onClose?: (error?: Error) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill() {
      this.signalCode = "SIGTERM";
      this.emit("exit", null, "SIGTERM");
      this.emit("close", null, "SIGTERM");
      return true;
    },
  });
  // Inject transport faults without spawning a process or exposing a production factory.
  const client: LspClient = Reflect.construct(LspClient, [
    { name: "faults", command: "fake", args: [], fileTypes: [".ts"], rootMarkers: [] },
    process.cwd(), child, onClose,
  ]);
  const send = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message));
    child.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  child.stdin.on("data", (frame: Buffer) => {
    const message = JSON.parse(frame.subarray(frame.indexOf("\r\n\r\n") + 4).toString());
    if (message.method === "shutdown") send({ jsonrpc: "2.0", id: message.id, result: null });
    if (message.method === "exit") {
      child.exitCode = 0;
      child.emit("exit", 0);
      child.emit("close", 0);
    }
  });
  return { client, child, send };
}

for (const message of [null, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: null }]) {
  test(`malformed LSP message ${JSON.stringify(message)} fails pending calls locally`, async () => {
    const { client, send } = fixture();
    try {
      const pending = client.request("test/pending", null);
      const rejected = assert.rejects(pending, /Invalid LSP frame.*message handling failed/);
      assert.doesNotThrow(() => send(message));
      await rejected;
      assert.equal(client.closed, true);
      await assert.rejects(client.request("test/next", null), /is closed/);
    } finally { await client.shutdown(); }
  });
}

for (const action of ["timeout", "abort"] as const) {
  test(`LSP ${action} preserves its error even when cancellation notification throws`, async () => {
    let closeError: Error | undefined;
    const { client } = fixture((error) => { closeError = error; });
    const controller = new AbortController();
    client.notify = () => { throw new Error("transport input closed"); };
    try {
      const pending = client.request("test/pending", null, controller.signal, action === "timeout" ? 5 : 1_000);
      const rejected = assert.rejects(pending, (error: Error) => action === "abort"
        ? error.name === "AbortError"
        : /test\/pending timed out after 5ms/.test(error.message));
      if (action === "abort") controller.abort();
      await rejected;
      assert.equal(client.closed, true);
      assert.match(closeError?.message ?? "", /cancel request write failed.*transport input closed/);
    } finally { await client.shutdown(); }
  });
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`LSP ${stream} errors reject local calls and retire the transport`, async () => {
    const { client, child } = fixture();
    const failure = new Error(`${stream} failed`);
    try {
      const pending = client.request("test/pending", null);
      const rejected = assert.rejects(pending, (error) => error === failure);
      assert.doesNotThrow(() => child[stream].emit("error", failure));
      await rejected;
      assert.equal(client.closed, true);
      assert.equal(child.signalCode, "SIGTERM");
    } finally { await client.shutdown(); }
  });
}

for (const asyncCallback of [false, true]) {
  test(`LSP close notification ${asyncCallback ? "rejection" : "throw"} cannot escape shutdown`, async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
    const failure = new Error("notification failed");
    const { client } = fixture(asyncCallback ? async () => { throw failure; } : () => { throw failure; });
    await client.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(client.closed, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LSP faults close notification failed: notification failed/);
  });
}
