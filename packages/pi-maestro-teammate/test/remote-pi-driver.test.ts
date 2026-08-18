import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PiRpcDriver } from "../src/remote/pi-rpc-driver.ts";
import {
  createRemoteRequest,
  parseRemoteEnvelopeLine,
  type RemoteJsonRpcEnvelope,
  type RemoteJsonRpcFailure,
  type RemoteJsonRpcId,
  type RemoteJsonRpcSuccess,
  type RemoteRequestMethod,
  type RemoteRequestParamsByMethod,
  type RemoteResultByMethod,
} from "../src/remote/protocol.ts";
import { connectRemoteSocket, RemoteBridgeServer } from "../src/remote/server.ts";
import { RemoteRunJournal } from "../src/remote/journal.ts";
import { REMOTE_PROTOCOL_VERSION, type ResolvedRemoteTarget } from "../src/remote/types.ts";

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function target(cwd: string, command: [string, ...string[]]): ResolvedRemoteTarget {
  return {
    id: "local/pi",
    host: "local",
    cwd,
    driver: "pi-rpc",
    command,
    hostConfig: {
      host: "localhost",
      user: "test",
      port: 22,
      hostKeySha256: HOST_KEY,
    },
  };
}

function writeFakePi(root: string, delayMs = 0): { script: string; argvFile: string } {
  const script = path.join(root, "fake-pi.mjs");
  const argvFile = path.join(root, "argv.json");
  fs.writeFileSync(script, `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "structured_output", args: { ok: true } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "structured_output", isError: false }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "usage", usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0.01 } } }) + "\\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), ${delayMs});
    }
  }
});
`, { mode: 0o700 });
  return { script, argvFile };
}

function writeHangingPi(root: string): { script: string; markerFile: string } {
  const script = path.join(root, "hanging-pi.mjs");
  const markerFile = path.join(root, "started.txt");
  fs.writeFileSync(script, `
import fs from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) {
    fs.writeFileSync(process.argv[2], "started");
    process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    process.stderr.write("x".repeat(100000));
    setInterval(() => {}, 1000);
  }
});
`, { mode: 0o700 });
  return { script, markerFile };
}

function writeAdversarialPi(root: string, mode: "flood" | "secret", marker: string): { script: string; environmentFile: string } {
  const script = path.join(root, `adversarial-${mode}.mjs`);
  const environmentFile = path.join(root, "observed-environment.txt");
  fs.writeFileSync(script, `
import fs from "node:fs";
const [mode, marker, environmentFile] = process.argv.slice(2);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes("\\n")) return;
  if (mode === "flood") {
    const lines = [JSON.stringify({ type: "agent_start" }) + "\\n"];
    for (let index = 0; index < 100; index += 1) {
      lines.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1024) } }) + "\\n");
    }
    process.stdout.write(lines.join(""));
    setInterval(() => {}, 1000);
    return;
  }
  fs.writeFileSync(environmentFile, process.env.PI_TEST_SECRET_TOKEN ?? "missing");
  process.stderr.write(marker);
  process.stdout.write(JSON.stringify({ type: "error", message: "token=" + marker }) + "\\n");
  setTimeout(() => process.exit(7), 10);
});
`, { mode: 0o700 });
  return { script, environmentFile };
}

async function collectEvents(handle: { events(): AsyncIterable<unknown> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

class RpcClient {
  readonly socket: net.Socket;
  readonly notifications: RemoteJsonRpcEnvelope[] = [];
  readonly #responses = new Map<RemoteJsonRpcId, RemoteJsonRpcEnvelope>();
  readonly #waiters = new Map<RemoteJsonRpcId, (value: RemoteJsonRpcEnvelope) => void>();
  #buffer = Buffer.alloc(0);

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
  }

  async request<Method extends RemoteRequestMethod>(
    id: RemoteJsonRpcId,
    method: Method,
    params: RemoteRequestParamsByMethod[Method],
  ): Promise<RemoteJsonRpcSuccess<RemoteResultByMethod[Method]> | RemoteJsonRpcFailure> {
    const request = createRemoteRequest(id, method, params);
    this.socket.write(`${JSON.stringify(request)}\n`);
    const existing = this.#responses.get(id);
    if (existing) {
      this.#responses.delete(id);
      return existing as RemoteJsonRpcSuccess<RemoteResultByMethod[Method]> | RemoteJsonRpcFailure;
    }
    return new Promise<RemoteJsonRpcSuccess<RemoteResultByMethod[Method]> | RemoteJsonRpcFailure>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${String(id)}`));
      }, 5_000);
      this.#waiters.set(id, (value) => {
        clearTimeout(timer);
        resolve(value as RemoteJsonRpcSuccess<RemoteResultByMethod[Method]> | RemoteJsonRpcFailure);
      });
    });
  }

  async waitForNotification(predicate: (value: RemoteJsonRpcEnvelope) => boolean): Promise<RemoteJsonRpcEnvelope> {
    const existing = this.notifications.find(predicate);
    if (existing) return existing;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const value = this.notifications.find(predicate);
      if (value) return value;
    }
    throw new Error("Timed out waiting for remote notification");
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.#buffer.subarray(0, newline + 1).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      const envelope = parseRemoteEnvelopeLine(line);
      if ("id" in envelope) {
        const waiter = envelope.id === null ? undefined : this.#waiters.get(envelope.id);
        if (waiter && envelope.id !== null) {
          this.#waiters.delete(envelope.id);
          waiter(envelope);
        } else if (envelope.id !== null) this.#responses.set(envelope.id, envelope);
      } else {
        this.notifications.push(envelope);
      }
    }
  }
}

test("Pi RPC driver launches trusted argv, normalizes events, and removes private scratch files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-driver-"));
  const scratchRoot = path.join(root, "scratch");
  const fake = writeFakePi(root);
  const configured = target(root, [process.execPath, fake.script, fake.argvFile]);
  const driver = new PiRpcDriver({ scratchRoot, cancelGraceMs: 100 });
  const controller = new AbortController();
  try {
    const handle = await driver.start({
      commandId: "start-1",
      targetId: configured.id,
      monitorOwnerNonce: "owner-1",
      name: "fake run",
      objective: "Run the fake Pi task",
      cwd: configured.cwd,
      driver: "pi-rpc",
      command: configured.command,
      outputSchema: { type: "object" },
    }, {
      workerId: "worker-1",
      instanceNonce: "instance-1",
      target: configured,
      signal: controller.signal,
    });
    const events = await collectEvents(handle);
    await handle.close();

    assert.deepEqual(events.map((event) => event.type), [
      "run/state",
      "run/event",
      "run/event",
      "run/event",
      "run/event",
      "run/result",
    ]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
    assert.equal(events[1].event.text, "done");
    assert.equal(events[4].event.usage.totalTokens, 15);
    assert.deepEqual(events[5].structuredOutput, { ok: true });
    assert.equal(events[5].result, "done");
    const argv = JSON.parse(fs.readFileSync(fake.argvFile, "utf8")) as string[];
    assert.deepEqual(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2), ["--mode", "rpc"]);
    assert.deepEqual(argv.slice(argv.indexOf("--name"), argv.indexOf("--name") + 2), ["--name", "fake run"]);
    assert.equal(argv.includes("--extension"), true);
    assert.deepEqual(fs.readdirSync(scratchRoot), []);
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi RPC driver cancellation terminates the detached child and publishes one terminal event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-cancel-"));
  const scratchRoot = path.join(root, "scratch");
  const fake = writeHangingPi(root);
  const configured = target(root, [process.execPath, fake.script, fake.markerFile]);
  const driver = new PiRpcDriver({ scratchRoot, cancelGraceMs: 100 });
  try {
    const handle = await driver.start({
      commandId: "start-cancel",
      targetId: configured.id,
      monitorOwnerNonce: "owner-cancel",
      name: "cancel run",
      objective: "Wait until cancelled",
      cwd: configured.cwd,
      driver: "pi-rpc",
      command: configured.command,
    }, {
      workerId: "worker-cancel",
      instanceNonce: "instance-cancel",
      target: configured,
      signal: new AbortController().signal,
    });
    const eventsPromise = collectEvents(handle);
    const startedAt = Date.now();
    while (!fs.existsSync(fake.markerFile) && Date.now() - startedAt < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(fake.markerFile), true);
    const cancelled = await handle.cancel({
      commandId: "cancel-1",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      reason: "test",
    });
    assert.equal(cancelled.accepted, true);
    const events = await eventsPromise;
    await handle.close();
    const terminal = events.filter((event) => event.type === "run/result");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].status, "cancelled");
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.deepEqual(fs.readdirSync(scratchRoot), []);
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi RPC input is rejected immediately after cancellation starts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-cancel-input-"));
  const fake = writeHangingPi(root);
  const configured = target(root, [process.execPath, fake.script, fake.markerFile]);
  const driver = new PiRpcDriver({ scratchRoot: path.join(root, "scratch"), cancelGraceMs: 50 });
  try {
    const handle = await driver.start({
      commandId: "start-cancel-input",
      targetId: configured.id,
      monitorOwnerNonce: "owner-cancel-input",
      name: "cancel input run",
      objective: "Wait until cancelled",
      cwd: configured.cwd,
      driver: "pi-rpc",
      command: configured.command,
    }, {
      workerId: "worker-cancel-input",
      instanceNonce: "instance-cancel-input",
      target: configured,
      signal: new AbortController().signal,
    });
    const cancelling = handle.cancel({
      commandId: "cancel-input",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      reason: "test",
    });
    await assert.rejects(handle.input({
      commandId: "late-input",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      mode: "follow_up",
      message: "late",
    }), /cancellation is already in progress/);
    await cancelling;
    const events = await collectEvents(handle);
    assert.equal(events.at(-1).status, "cancelled");
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi RPC event floods terminate at the byte bound and clean scratch state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-event-bound-"));
  const fake = writeAdversarialPi(root, "flood", "unused");
  const scratchRoot = path.join(root, "scratch");
  const configured = target(root, [process.execPath, fake.script, "flood", "unused", fake.environmentFile]);
  const driver = new PiRpcDriver({ scratchRoot, cancelGraceMs: 50, eventQueueBytes: 4_096 });
  try {
    const handle = await driver.start({
      commandId: "start-flood",
      targetId: configured.id,
      monitorOwnerNonce: "owner-flood",
      name: "flood run",
      objective: "Flood",
      cwd: configured.cwd,
      driver: "pi-rpc",
      command: configured.command,
    }, {
      workerId: "worker-flood",
      instanceNonce: "instance-flood",
      target: configured,
      signal: new AbortController().signal,
    });
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1).status, "failed");
    assert.match(events.at(-1).error, /event queue byte limit exceeded/);
    assert.equal(Buffer.byteLength(JSON.stringify(events), "utf8") <= 4_096, true);
    assert.deepEqual(fs.readdirSync(scratchRoot), []);
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi RPC strips secret environment values and redacts child failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-secret-"));
  const marker = "pi-secret-marker-7f3d";
  const fake = writeAdversarialPi(root, "secret", marker);
  const configured = target(root, [process.execPath, fake.script, "secret", marker, fake.environmentFile]);
  const driver = new PiRpcDriver({ scratchRoot: path.join(root, "scratch"), cancelGraceMs: 50 });
  const previous = process.env.PI_TEST_SECRET_TOKEN;
  process.env.PI_TEST_SECRET_TOKEN = marker;
  try {
    const handle = await driver.start({
      commandId: "start-secret",
      targetId: configured.id,
      monitorOwnerNonce: "owner-secret",
      name: "secret run",
      objective: "Fail safely",
      cwd: configured.cwd,
      driver: "pi-rpc",
      command: configured.command,
    }, {
      workerId: "worker-secret",
      instanceNonce: "instance-secret",
      target: configured,
      signal: new AbortController().signal,
    });
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(fs.readFileSync(fake.environmentFile, "utf8"), "missing");
    assert.equal(JSON.stringify(events).includes(marker), false);
    assert.equal(JSON.stringify(events).includes("[REDACTED]"), true);
    assert.equal(events.at(-1).status, "failed");
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SECRET_TOKEN;
    else process.env.PI_TEST_SECRET_TOKEN = previous;
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote daemon survives gateway disconnect, replays durable events, and deduplicates commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-server-"));
  const fake = writeFakePi(root, 120);
  const configured = target(root, [process.execPath, fake.script, fake.argvFile]);
  const journal = new RemoteRunJournal(path.join(root, "state"));
  const driver = new PiRpcDriver({ scratchRoot: path.join(root, "scratch"), cancelGraceMs: 100 });
  const server = new RemoteBridgeServer({ journal, targets: [configured], drivers: [driver], heartbeatMs: 60_000 });
  const owner = `owner-${randomUUID()}`;
  try {
    await server.listen();
    const first = new RpcClient(await connectRemoteSocket(journal.stateDirectory));
    const initialized = await first.request("rpc-init-1", "remote/initialize", {
      commandId: "initialize-command",
      protocolVersions: [REMOTE_PROTOCOL_VERSION],
      monitorOwnerNonce: owner,
    });
    assert.equal("result" in initialized && initialized.result.protocolVersion, REMOTE_PROTOCOL_VERSION);
    const startParams = {
      commandId: "start-command",
      targetId: configured.id,
      monitorOwnerNonce: owner,
      name: "loopback run",
      objective: "Keep running after disconnect",
      cwd: configured.cwd,
      driver: "pi-rpc" as const,
      command: configured.command,
    };
    const started = await first.request("rpc-start-1", "run/start", startParams);
    assert.equal("result" in started, true);
    if (!("result" in started)) throw new Error(started.error.message);
    const startResult = started.result;
    first.socket.destroy();

    const second = new RpcClient(await connectRemoteSocket(journal.stateDirectory));
    await second.request("rpc-init-2", "remote/initialize", {
      commandId: "initialize-command-2",
      protocolVersions: [REMOTE_PROTOCOL_VERSION],
      monitorOwnerNonce: owner,
    });
    const attached = await second.request("rpc-attach", "run/attach", {
      commandId: "attach-command",
      runId: startResult.runId,
      generation: startResult.generation,
      monitorOwnerNonce: owner,
      lastSequence: 0,
    });
    assert.equal("result" in attached && attached.result.runId, startResult.runId);
    const resultNotification = await second.waitForNotification((envelope) => (
      "method" in envelope && envelope.method === "run/result"
    ));
    assert.equal(
      "params" in resultNotification && (resultNotification.params as { status?: unknown }).status,
      "completed",
    );

    const listParams = { commandId: "list-command", monitorOwnerNonce: owner };
    const listedOnce = await second.request("rpc-list-1", "run/list", listParams);
    const listedTwice = await second.request("rpc-list-2", "run/list", listParams);
    assert.deepEqual(
      "result" in listedTwice ? listedTwice.result : undefined,
      "result" in listedOnce ? listedOnce.result : undefined,
    );
    assert.equal("result" in listedOnce && listedOnce.result.runs[0].lastSequence, 6);
    second.socket.destroy();
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal keeps a stable worker id, rotates instance nonce, and marks interrupted runs lost", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-journal-"));
  try {
    const first = new RemoteRunJournal(root);
    const capture = {
      ...first.identity,
      runId: "interrupted-run",
      generation: 1,
      monitorOwnerNonce: "owner",
      targetId: "local/pi",
    };
    first.createRun(capture, {
      commandId: "start",
      targetId: "local/pi",
      monitorOwnerNonce: "owner",
      name: "interrupted",
      objective: "test",
      cwd: "/tmp",
      driver: "pi-rpc",
      command: ["pi"],
    });
    first.appendEvent(capture, {
      type: "run/state",
      ...first.identity,
      runId: capture.runId,
      generation: 1,
      sequence: 1,
      status: "running",
      updatedAt: Date.now(),
    });

    const second = new RemoteRunJournal(root);
    assert.equal(second.identity.workerId, first.identity.workerId);
    assert.notEqual(second.identity.instanceNonce, first.identity.instanceNonce);
    const recovered = second.getRun(capture.runId)!;
    assert.equal(recovered.snapshot.status, "lost");
    assert.equal(recovered.snapshot.lastSequence, 2);
    assert.equal(second.readEvents(capture.runId, 1)[0].type, "run/result");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
