import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpClientOperations } from "../src/remote/acp-client-operations.ts";
import {
  ACP_PENDING_INPUT_LIMIT,
  AcpDriver,
} from "../src/remote/acp-driver.ts";
import type { RemoteRunHandle } from "../src/remote/driver.ts";
import { createRemoteRequest, parseRemoteEnvelopeLine, type RemoteJsonRpcEnvelope } from "../src/remote/protocol.ts";
import { connectRemoteSocket, RemoteBridgeServer } from "../src/remote/server.ts";
import { REMOTE_PROTOCOL_VERSION, type ResolvedRemoteTarget } from "../src/remote/types.ts";

/**
 * macOS resolves `os.tmpdir()` through the `/var` -> `/private/var` symlink, while the remote
 * surfaces reject non-canonical roots and compare a child's `process.cwd()` against the configured
 * root. Tests must hand them the canonical path production callers already receive.
 */
function canonicalTempRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function target(root: string, script: string, mode: string, policy: ResolvedRemoteTarget["acp"] = {}): ResolvedRemoteTarget {
  return {
    id: "local/acp",
    host: "local",
    cwd: root,
    driver: "acp",
    command: [process.execPath, script, mode, path.join(root, "agent-log.jsonl"), path.join(root, "cleanup.txt")],
    acp: policy,
    hostConfig: { host: "localhost", user: "test", port: 22, hostKeySha256: HOST_KEY },
  };
}

function writeFakeAgent(root: string): string {
  const script = path.join(root, "fake-acp-agent.mjs");
  fs.writeFileSync(script, `
import fs from "node:fs";
import path from "node:path";
const [mode, logFile, cleanupFile] = process.argv.slice(2);
let buffer = Buffer.alloc(0);
let nextId = 100;
let promptId;
let promptCount = 0;
const pending = new Map();
const keepAlive = setInterval(() => {}, 1000);
const log = (value) => fs.appendFileSync(logFile, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const update = (sessionUpdate, data = {}) => send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate, ...data } } });
process.on("SIGTERM", () => { fs.writeFileSync(cleanupFile, "terminated"); process.exit(0); });
async function runOperations(id) {
  const permission = await request("session/request_permission", {
    sessionId: "session-1",
    toolCall: { toolCallId: "permission-tool", name: "run operation", title: "Run operation" },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Reject once", kind: "reject_once" },
    ],
  });
  log({ permission });
  const read = await request("fs/read_text_file", { sessionId: "session-1", path: process.cwd() + "/input.txt" });
  log({ read });
  const write = await request("fs/write_text_file", { sessionId: "session-1", path: process.cwd() + "/output.txt", content: "written" });
  log({ write });
  const escaped = await request("fs/read_text_file", { sessionId: "session-1", path: process.cwd() + "/../outside.txt" });
  log({ escaped });
  const echoScript = path.join(process.cwd(), "echo.mjs");
  fs.writeFileSync(echoScript, "process.stdout.write('terminal-ok')");
  const created = await request("terminal/create", {
    sessionId: "session-1",
    command: process.execPath,
    args: [echoScript],
    cwd: process.cwd(),
    outputByteLimit: 1024,
  });
  log({ created });
  const codeEvalDenied = await request("terminal/create", {
    sessionId: "session-1",
    command: process.execPath,
    args: ["-e", "process.stdout.write('terminal-ok')"],
    cwd: process.cwd(),
    outputByteLimit: 1024,
  });
  log({ codeEvalDenied });
  const terminalId = created.result?.terminalId;
  if (terminalId) {
    const waited = await request("terminal/wait_for_exit", { sessionId: "session-1", terminalId });
    const output = await request("terminal/output", { sessionId: "session-1", terminalId });
    const released = await request("terminal/release", { sessionId: "session-1", terminalId });
    log({ waited, output, released });
  }
  const denied = await request("terminal/create", { sessionId: "session-1", command: "not-allowed", args: [] });
  log({ denied });
  update("agent_message_chunk", { content: { type: "text", text: "ops done" } });
  send({ id, result: { stopReason: "end_turn" } });
}
async function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
    return;
  }
  if (message.method === "initialize") {
    log({ initialize: message.params, envProbe: process.env.PROBE_FORWARDED_KEY ?? null });
    if (mode === "hang") return;
    if (mode === "nonzero") { process.stderr.write("agent failed safely"); process.exit(7); }
    send({ id: message.id, result: {
      protocolVersion: mode === "mismatch" ? 2 : 1,
      agentCapabilities: mode === "noresume" ? {} : { sessionCapabilities: { resume: {} } },
      agentInfo: { name: "fake-acp", version: "1" },
    } });
    return;
  }
  if (message.method === "session/new") {
    log({ newSession: message.params });
    send({ id: message.id, result: { sessionId: "session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    promptCount += 1;
    log({ prompt: message.params });
    if (mode === "malformed") { process.stdout.write("{bad json\\n"); return; }
    if (mode === "oversize") { process.stdout.write("x".repeat(1024 * 1024 + 1) + "\\n"); return; }
    if (mode === "cancel") return;
    if (mode === "flood") {
      update("agent_message_chunk", { content: { type: "text", text: "x".repeat(16 * 1024) } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "ops") { void runOperations(message.id); return; }
    if (mode === "followup") {
      update("agent_message_chunk", { content: { type: "text", text: "turn-" + promptCount + " " } });
      if (promptCount === 1) setTimeout(() => send({ id: message.id, result: { stopReason: "end_turn" } }), 50);
      else send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    update("agent_message_chunk", { content: { type: "text", text: "hello " } });
    update("tool_call", { toolCallId: "tool-1", title: "Stable title", status: "in_progress" });
    update("tool_call_update", { toolCallId: "tool-1", status: "completed" });
    update("usage_update", { used: 10, size: 100, cost: { amount: 0.25, currency: "USD" } });
    update("agent_thought_chunk", { content: { type: "text", text: "thinking" } });
    update("agent_message_chunk", { content: { type: "text", text: "done" } });
    send({ id: message.id, result: { stopReason: mode === "refusal" ? "refusal" : "end_turn", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } } });
    return;
  }
  if (message.method === "session/cancel" && mode === "cancel") {
    const permission = await request("session/request_permission", {
      sessionId: "session-1",
      toolCall: { toolCallId: "cancel-tool", title: "After cancel" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    log({ cancelledPermission: permission });
    send({ id: promptId, result: { stopReason: "cancelled" } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const newline = buffer.indexOf(10);
    if (newline < 0) break;
    const line = buffer.subarray(0, newline).toString("utf8");
    buffer = buffer.subarray(newline + 1);
    if (line) void handle(JSON.parse(line));
  }
});
`, { mode: 0o700 });
  return script;
}

function startRequest(configured: ResolvedRemoteTarget) {
  return {
    commandId: "start-1",
    targetId: configured.id,
    monitorOwnerNonce: "owner-1",
    name: "ACP test",
    objective: "Run the ACP test",
    cwd: configured.cwd,
    driver: "acp" as const,
    command: configured.command,
  };
}

async function start(driver: AcpDriver, configured: ResolvedRemoteTarget): Promise<RemoteRunHandle> {
  return driver.start(startRequest(configured), {
    workerId: "worker-1",
    instanceNonce: "instance-1",
    target: configured,
    signal: new AbortController().signal,
  });
}

async function waitForTerminalSnapshot(handle: RemoteRunHandle, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (["completed", "failed", "cancelled", "lost"].includes(handle.snapshot().status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for ACP run terminal snapshot");
}

async function collectEvents(handle: RemoteRunHandle): Promise<any[]> {
  const events: any[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

function readLog(root: string): any[] {
  const file = path.join(root, "agent-log.jsonl");
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

class BridgePeer {
  readonly #socket: net.Socket;
  readonly #responses = new Map<string, RemoteJsonRpcEnvelope>();
  readonly #notifications: RemoteJsonRpcEnvelope[] = [];
  #buffer = Buffer.alloc(0);

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (true) {
        const newline = this.#buffer.indexOf(0x0a);
        if (newline < 0) break;
        const envelope = parseRemoteEnvelopeLine(this.#buffer.subarray(0, newline + 1).toString("utf8"));
        this.#buffer = this.#buffer.subarray(newline + 1);
        if ("id" in envelope && typeof envelope.id === "string") this.#responses.set(envelope.id, envelope);
        else this.#notifications.push(envelope);
      }
    });
  }

  async request(id: string, method: Parameters<typeof createRemoteRequest>[1], params: any): Promise<RemoteJsonRpcEnvelope> {
    this.#socket.write(`${JSON.stringify(createRemoteRequest(id, method, params))}\n`);
    return this.#wait(() => this.#responses.get(id));
  }

  async notification(method: string): Promise<RemoteJsonRpcEnvelope> {
    return this.#wait(() => this.#notifications.find((value) => "method" in value && value.method === method));
  }

  close(): void { this.#socket.destroy(); }

  async #wait<T>(read: () => T | undefined): Promise<T> {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for bridge response");
  }
}

test("bridge defaults register the ACP driver", async () => {
  const root = canonicalTempRoot("pi-acp-bridge-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "normal");
  const server = new RemoteBridgeServer({ stateDirectory: path.join(root, "state"), targets: [configured], heartbeatMs: 60_000 });
  const owner = `owner-${randomUUID()}`;
  let peer: BridgePeer | undefined;
  try {
    await server.listen();
    peer = new BridgePeer(await connectRemoteSocket(path.join(root, "state")));
    const initialized = await peer.request("init", "remote/initialize", {
      commandId: "init-command",
      protocolVersions: [REMOTE_PROTOCOL_VERSION],
      monitorOwnerNonce: owner,
    });
    assert.equal("result" in initialized, true);
    const started = await peer.request("start", "run/start", {
      ...startRequest(configured),
      commandId: "start-command",
      monitorOwnerNonce: owner,
    });
    assert.equal("result" in started, true);
    const result = await peer.notification("run/result");
    assert.equal("params" in result && (result.params as { status?: string }).status, "completed");
  } finally {
    peer?.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP driver forwards declared target env names from the daemon environment", async () => {
  const root = canonicalTempRoot("pi-acp-env-");
  const script = writeFakeAgent(root);
  const previous = process.env.PROBE_FORWARDED_KEY;
  process.env.PROBE_FORWARDED_KEY = "forwarded-value";
  try {
    const configured: ResolvedRemoteTarget = {
      ...target(root, script, "normal"),
      env: ["PROBE_FORWARDED_KEY"],
    };
    const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000 });
    const handle = await start(driver, configured);
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1)?.status, "completed");
    const log = readLog(root);
    assert.equal(log.some((entry) => entry.envProbe === "forwarded-value"), true);
  } finally {
    if (previous === undefined) delete process.env.PROBE_FORWARDED_KEY;
    else process.env.PROBE_FORWARDED_KEY = previous;
  }
});

test("ACP driver uses stable v1 init/new/prompt and streams normalized events", async () => {
  const root = canonicalTempRoot("pi-acp-normal-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "normal");
  const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000 });
  try {
    const handle = await start(driver, configured);
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1).status, "completed");
    assert.equal(events.at(-1).result, "hello done");
    assert.equal(events.at(-1).nativeStatus, "end_turn");
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    const toolEvents = events.filter((event) => event.event?.type === "tool").map((event) => event.event.tool);
    assert.deepEqual(toolEvents.map((tool) => [tool.toolName, tool.phase]), [["Stable title", "start"], ["Stable title", "end"]]);
    assert.equal(events.some((event) => event.event?.usage?.costUsd === 0.25), true);
    assert.equal(events.some((event) => event.event?.usage?.totalTokens === 6), true);
    assert.equal(events.some((event) => event.event?.name === "agent_thought_chunk"), true);
    const log = readLog(root);
    assert.equal(log[0].initialize.protocolVersion, 1);
    assert.deepEqual(log[1].newSession, { cwd: root, mcpServers: [] });
    assert.equal(log[2].prompt.prompt[0].text, "Run the ACP test");
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP client operations enforce permissions, root containment, and terminal allowlists", async () => {
  const root = canonicalTempRoot("pi-acp-ops-");
  const outside = path.join(path.dirname(root), "outside.txt");
  fs.writeFileSync(path.join(root, "input.txt"), "inside");
  fs.writeFileSync(outside, "outside");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "ops", {
    permissionMode: "allow-once",
    permissionTools: ["run operation"],
    fs: { read: true, write: true, maxReadBytes: 1024, maxWriteBytes: 1024 },
    terminal: {
      commands: [{ executable: process.execPath, args: [path.join(root, "echo.mjs")], environment: [] }],
      maxOutputBytes: 4,
      timeoutMs: 2_000,
      maxProcesses: 1,
    },
  });
  const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000 });
  try {
    const handle = await start(driver, configured);
    await waitForTerminalSnapshot(handle, 10_000);
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1).status, "completed");
    const descriptorContainmentAvailable = process.platform === "linux" && fs.existsSync("/proc/self/fd");
    const log = readLog(root);
    if (descriptorContainmentAvailable) {
      assert.equal(fs.readFileSync(path.join(root, "output.txt"), "utf8"), "written");
      assert.equal(log.find((entry) => entry.read).read.result.content, "inside");
    } else {
      assert.equal(fs.existsSync(path.join(root, "output.txt")), false);
      assert.equal(log.find((entry) => entry.read).read.error.code, -32602);
      assert.equal(log.find((entry) => entry.write).write.error.code, -32602);
      assert.equal(log[0].initialize.clientCapabilities.fs, undefined);
    }
    assert.equal(log.find((entry) => entry.permission).permission.result.outcome.optionId, "allow");
    assert.equal(log.find((entry) => entry.escaped).escaped.error.code, -32602);
    const createdTerminal = log.find((entry) => entry.created).created;
    assert.equal(createdTerminal.error, undefined, JSON.stringify(createdTerminal));
    const terminalOutput = log.find((entry) => entry.output).output.result;
    assert.equal(terminalOutput.output, "l-ok");
    assert.equal(terminalOutput.truncated, true);
    assert.equal(log.find((entry) => entry.codeEvalDenied).codeEvalDenied.error.code, -32602);
    assert.equal(log.find((entry) => entry.denied).denied.error.code, -32602);
  } finally {
    await driver.close();
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP follow-up prompts are queued on the same session", async () => {
  const root = canonicalTempRoot("pi-acp-followup-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "followup");
  const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000 });
  try {
    const handle = await start(driver, configured);
    await assert.rejects(handle.input({
      commandId: "steer-1",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      mode: "steer",
      message: "Unsupported",
    }), /does not support steer/);
    const accepted = await handle.input({
      commandId: "followup-1",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      mode: "follow_up",
      message: "Second turn",
    });
    assert.deepEqual(accepted, { accepted: true, effectiveMode: "follow_up", receipt: "queued" });
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1).status, "completed");
    assert.equal(events.at(-1).result, "turn-1 turn-2");
    const prompts = readLog(root).filter((entry) => entry.prompt);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].prompt.prompt[0].text, "Second turn");
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP follow-up queue is count-bounded and rejects input as soon as cancellation starts", async () => {
  const root = canonicalTempRoot("pi-acp-input-bound-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "cancel");
  const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 10_000 });
  try {
    const handle = await start(driver, configured);
    for (let index = 0; index < ACP_PENDING_INPUT_LIMIT; index += 1) {
      const accepted = await handle.input({
        commandId: `followup-${index}`,
        runId: handle.capture.runId,
        generation: handle.capture.generation,
        monitorOwnerNonce: handle.capture.monitorOwnerNonce,
        mode: "follow_up",
        message: "queued",
      });
      assert.equal(accepted.accepted, true);
    }
    await assert.rejects(handle.input({
      commandId: "followup-overflow",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      mode: "follow_up",
      message: "overflow",
    }), /queue limit/);

    const cancelling = handle.cancel({
      commandId: "cancel-bound",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      reason: "test",
    });
    await assert.rejects(handle.input({
      commandId: "followup-after-cancel",
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

test("ACP event floods exceed a byte bound and terminate with one bounded failure", async () => {
  const root = canonicalTempRoot("pi-acp-event-bound-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "flood");
  const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000, eventQueueBytes: 4_096 });
  try {
    const handle = await start(driver, configured);
    await waitForTerminalSnapshot(handle);
    const events = await collectEvents(handle);
    await handle.close();
    assert.equal(events.at(-1).status, "failed");
    assert.match(events.at(-1).error, /event queue byte limit exceeded/);
    assert.equal(Buffer.byteLength(JSON.stringify(events), "utf8") <= 4_096, true);
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP refusal fails and a non-resuming agent still completes", async (t) => {
  for (const mode of ["refusal", "noresume"] as const) {
    await t.test(mode, async () => {
      const root = canonicalTempRoot(`pi-acp-${mode}-`);
      const script = writeFakeAgent(root);
      const configured = target(root, script, mode);
      const driver = new AcpDriver({ cancelGraceMs: 50, startupTimeoutMs: 1_000 });
      try {
        const handle = await start(driver, configured);
        const events = await collectEvents(handle);
        await handle.close();
        assert.equal(events.at(-1).status, mode === "refusal" ? "failed" : "completed");
        if (mode === "refusal") assert.equal(events.at(-1).nativeStatus, "refusal");
      } finally {
        await driver.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("ACP permission response is cancelled during run cancellation", async () => {
  const root = canonicalTempRoot("pi-acp-cancel-");
  const script = writeFakeAgent(root);
  const configured = target(root, script, "cancel", { permissionMode: "allow-once" });
  const driver = new AcpDriver({ cancelGraceMs: 200, startupTimeoutMs: 1_000 });
  try {
    const handle = await start(driver, configured);
    const eventsPromise = collectEvents(handle);
    await handle.cancel({
      commandId: "cancel-1",
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      monitorOwnerNonce: handle.capture.monitorOwnerNonce,
      reason: "test",
    });
    const events = await eventsPromise;
    await handle.close();
    assert.equal(events.at(-1).status, "cancelled");
    assert.equal(readLog(root).find((entry) => entry.cancelledPermission).cancelledPermission.result.outcome.outcome, "cancelled");
  } finally {
    await driver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP driver fails closed on mismatch, malformed, oversize, hanging, and nonzero agents", async (t) => {
  for (const mode of ["mismatch", "malformed", "oversize", "hang", "nonzero"] as const) {
    await t.test(mode, async () => {
      const root = canonicalTempRoot(`pi-acp-${mode}-`);
      const script = writeFakeAgent(root);
      const configured = target(root, script, mode);
      const driver = new AcpDriver({
        cancelGraceMs: 30,
        startupTimeoutMs: mode === "hang" ? 80 : 10_000,
      });
      try {
        if (mode === "mismatch" || mode === "hang" || mode === "nonzero") {
          await assert.rejects(start(driver, configured), mode === "mismatch" ? /version mismatch/ : /timed out|exited|closed|failed/i);
        } else {
          const handle = await start(driver, configured);
          const events = await collectEvents(handle);
          await handle.close();
          assert.equal(events.at(-1).status, "failed");
          assert.match(events.at(-1).error, mode === "malformed" ? /malformed JSON/ : /exceeds the remote protocol limit/);
        }
      } finally {
        await driver.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("in-process ACP operations default deny and honor AbortSignal", async () => {
  const root = canonicalTempRoot("pi-acp-policy-");
  const controller = new AbortController();
  const operations = new AcpClientOperations({
    targetRoot: root,
    signal: controller.signal,
    isCancelling: () => false,
    sessionId: () => "session",
  });
  try {
    const permission = operations.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "tool" },
      options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
    }, controller.signal);
    assert.equal(permission.outcome.outcome, "selected");
    await assert.rejects(
      operations.readTextFile({ sessionId: "session", path: path.join(root, "missing") }, controller.signal),
      RequestError,
    );
    controller.abort();
    assert.equal(operations.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "tool" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }, controller.signal).outcome.outcome, "cancelled");

    const timeoutController = new AbortController();
    const timeoutOperations = new AcpClientOperations({
      targetRoot: root,
      policy: {
        terminal: {
          commands: [{ executable: process.execPath, args: [path.join(root, "hang.mjs")], environment: [] }],
          timeoutMs: 30,
          maxOutputBytes: 1024,
          maxProcesses: 1,
        },
      },
      signal: timeoutController.signal,
      isCancelling: () => false,
      sessionId: () => "session",
    });
    try {
      fs.writeFileSync(path.join(root, "hang.mjs"), "setInterval(() => {}, 1000)");
      const created = await timeoutOperations.createTerminal({
        sessionId: "session",
        command: process.execPath,
        args: [path.join(root, "hang.mjs")],
      }, timeoutController.signal);
      const startedAt = Date.now();
      const exit = await timeoutOperations.waitForTerminalExit({ sessionId: "session", terminalId: created.terminalId }, timeoutController.signal);
      const waitBudgetMs = process.platform === "win32" ? 10_000 : 2_000;
      assert.equal(Date.now() - startedAt < waitBudgetMs, true);
      assert.equal(exit.exitCode !== undefined || exit.signal !== undefined, true);
      timeoutOperations.releaseTerminal({ sessionId: "session", terminalId: created.terminalId });
    } finally {
      timeoutOperations.close();
    }
  } finally {
    operations.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
