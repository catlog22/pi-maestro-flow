import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import type { ClientChannel } from "ssh2";
import { Value } from "typebox/value";
import {
  SshGatewayCapabilityError,
  SshGatewayClientPool,
} from "../src/ssh-manager/gateway-client.ts";
import { SSH_GATEWAY_COMMAND } from "../src/ssh-manager/guide.ts";
import { SshToolParams } from "../src/ssh-manager/llm-tool.ts";
import type {
  SshCommandChannel,
  SshExecuteOptions,
  SshExecuteRequest,
  SshExecutor,
} from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const host: SshHost = {
  id: "gateway-host",
  label: "Gateway Host",
  host: "gateway.example.test",
  user: "runner",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "agent" },
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

class FakeGatewayChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly calls: JsonRpcRequest[] = [];
  private input = "";

  constructor(private readonly serverName = "pi-maestro-gateway") {
    super();
  }

  _read(): void {}

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    try {
      while (this.input.includes("\n")) {
        const newline = this.input.indexOf("\n");
        const line = this.input.slice(0, newline).replace(/\r$/u, "");
        this.input = this.input.slice(newline + 1);
        if (line) this.handle(JSON.parse(line) as JsonRpcRequest);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  disconnect(): void {
    this.destroy();
  }

  private handle(request: JsonRpcRequest): void {
    this.calls.push(request);
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      this.respond(request.id, {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: "1" },
      });
      return;
    }
    if (request.method === "tools/list") {
      this.respond(request.id, {
        tools: [
          {
            name: "host",
            description: "Inspect the Gateway host.",
            inputSchema: {
              type: "object",
              properties: { action: { type: "string", enum: ["status", "test"] } },
              required: ["action"],
              additionalProperties: false,
            },
          },
          {
            name: "exec",
            description: "Run bounded argv commands.",
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          },
        ],
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      const args = params.arguments as Record<string, unknown> | undefined;
      let envelope: unknown = { ok: name !== "missing", data: { name, arguments: args }, meta: { principalId: "local-owner" } };
      if (name === "host" && args?.action === "describe") envelope = { ok: true, data: { cwd: "/remote/root" }, meta: { principalId: "local-owner" } };
      if (name === "session" && args?.action === "create") {
        const now = Date.now();
        envelope = { ok: true, data: { session: { id: args.sessionId, revision: 1 }, member: { id: args.ownerId, principalId: "stdio:local-owner", status: "active", generation: 1, leaseExpiresAt: now + 90_000, updatedAt: now } }, meta: { principalId: "local-owner" } };
      }
      if (name === "session" && args?.action === "start-pi") envelope = { ok: true, data: { taskId: "remote-task-1" }, meta: { principalId: "local-owner" } };
      if (name === "monitor") envelope = { ok: true, data: { handle: args?.handle, nextCursor: 2 }, meta: { principalId: "local-owner" } };
      this.respond(request.id, {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        ...(name === "missing" ? { isError: true } : {}),
      });
      return;
    }
    this.push(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } })}\n`);
  }

  private respond(id: string | number, result: unknown): void {
    this.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

class FakeGatewayExecutor {
  readonly requests: SshExecuteRequest[] = [];
  readonly channels: FakeGatewayChannel[] = [];
  closeCount = 0;
  failure: Error | undefined;
  serverName = "pi-maestro-gateway";
  effectiveDigest: string | undefined;
  openGate: Promise<void> | undefined;

  async openChannel(
    _host: unknown,
    request: SshExecuteRequest,
    _options?: SshExecuteOptions,
  ): Promise<SshCommandChannel> {
    this.requests.push(structuredClone(request));
    if (this.failure) throw this.failure;
    await this.openGate;
    const channel = new FakeGatewayChannel(this.serverName);
    this.channels.push(channel);
    let closed = false;
    return {
      channel: channel as unknown as ClientChannel,
      ...(this.effectiveDigest === undefined ? {} : { effectiveDigest: this.effectiveDigest }),
      close: () => {
        if (closed) return;
        closed = true;
        this.closeCount += 1;
        channel.destroy();
      },
    };
  }
}

const asExecutor = (executor: FakeGatewayExecutor): Pick<SshExecutor, "openChannel"> => executor as unknown as Pick<SshExecutor, "openChannel">;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("ssh tool schema is a strict legacy-or-Gateway union with an object root", () => {
  assert.equal(SshToolParams.type, "object");
  assert.equal(Value.Check(SshToolParams, { command: "uname -a", cwd: "/srv", timeout: 5 }), true);
  assert.equal(Value.Check(SshToolParams, { action: "guide" }), true);
  assert.equal(Value.Check(SshToolParams, { action: "status" }), true);
  assert.equal(Value.Check(SshToolParams, { action: "list" }), true);
  assert.equal(Value.Check(SshToolParams, { action: "describe", tool: "host" }), true);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "host", args: { action: "status" }, timeout: 5 }), true);
  assert.equal(Value.Check(SshToolParams, { command: "id", action: "status" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "host", command: "evil" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "status", host: "attacker.test" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "host", args: [], timeout: 5 }), false);
});

test("Gateway MCP uses the fixed command, frames list/describe/call, and reuses one client", async () => {
  const executor = new FakeGatewayExecutor();
  const pool = new SshGatewayClientPool(asExecutor(executor));
  try {
    const status = await pool.execute(host, "digest-a", { action: "status" });
    assert.equal(status.summary, "gateway connected · 2 tools");
    assert.deepEqual((status.data as { tools: string[] }).tools, ["host", "exec"]);

    const listed = await pool.execute(host, "digest-a", { action: "list" });
    assert.equal((listed.data as { tools: unknown[] }).tools.length, 2);
    const described = await pool.execute(host, "digest-a", { action: "describe", tool: "host" });
    assert.equal((described.data as { name: string }).name, "host");

    const called = await pool.execute(host, "digest-a", {
      action: "call",
      tool: "host",
      args: { action: "status", command: "must-not-become-ssh-command" },
      timeout: 7,
    });
    assert.equal(called.isError, undefined);
    assert.equal(executor.requests.length, 1);
    assert.deepEqual(executor.requests[0], { command: SSH_GATEWAY_COMMAND, timeout: 30 });
    const rpcCall = executor.channels[0]!.calls.find((request) => request.method === "tools/call");
    assert.deepEqual(rpcCall?.params, {
      name: "host",
      arguments: { action: "status", command: "must-not-become-ssh-command" },
    });
  } finally {
    await pool.close();
  }
  assert.equal(executor.closeCount, 1);
});

test("start_pi survives transport reconnect and forwards only a fenced Monitor call", async () => {
  const executor = new FakeGatewayExecutor();
  const pool = new SshGatewayClientPool(asExecutor(executor));
  const todo = {
    id: "28", subject: "Remote work", description: "Focused only", status: "in_progress" as const,
    blockedBy: [], skills: [], resourceUris: [], createdBy: { kind: "root" as const, id: "root", label: "root" },
    assignee: { kind: "root" as const, id: "root", label: "root" }, createdAt: 1, updatedAt: 2,
  };
  try {
    const started = await pool.execute(host, "digest-a", {
      action: "start_pi", todoIds: ["28"], requestId: "launch-1",
    }, undefined, { piSessionRef: "pi-session-1", todos: [todo] });
    const launch = started.data as { executionHandle: string; monitorHandle: string; monitor: { args: Record<string, unknown> } };
    assert.equal(launch.executionHandle, "remote-task-1");
    assert.equal(launch.monitorHandle, launch.executionHandle);
    assert.equal(launch.monitor.args.handle, launch.monitorHandle);
    assert.deepEqual(executor.requests, [{ command: SSH_GATEWAY_COMMAND, timeout: 30 }]);
    const startRpc = executor.channels[0]!.calls.find((request) => request.method === "tools/call"
      && (request.params?.name === "session")
      && ((request.params?.arguments as Record<string, unknown>)?.action === "start-pi"));
    assert.equal((startRpc?.params?.arguments as Record<string, unknown>).todoIds, undefined);

    executor.channels[0]!.disconnect();
    await tick();
    const monitored = await pool.execute(host, "digest-a", {
      action: "call", tool: "monitor", args: launch.monitor.args,
    });
    assert.equal(monitored.isError, undefined);
    assert.equal(executor.requests.length, 2, "a disconnected transport reconnects without restarting Pi");
    const monitorRpc = executor.channels[1]!.calls.find((request) => request.method === "tools/call"
      && request.params?.name === "monitor");
    assert.equal((monitorRpc?.params?.arguments as Record<string, unknown>)._sshLaunch, undefined);
    assert.equal((monitorRpc?.params?.arguments as Record<string, unknown>).handle, "remote-task-1");

    executor.channels[1]!.disconnect();
    await tick();
    await pool.execute(host, "digest-b", { action: "list" });
    await assert.rejects(
      pool.execute(host, "digest-b", { action: "call", tool: "monitor", args: launch.monitor.args }),
      /Monitor handle is stale/u,
      "an effective digest change invalidates receipts even after the old transport disconnected",
    );
  } finally {
    await pool.close();
  }
});

test("Gateway pool reserves a same-key admission before any await", async () => {
  const executor = new FakeGatewayExecutor();
  const gate = deferred();
  executor.openGate = gate.promise;
  const pool = new SshGatewayClientPool(asExecutor(executor));
  try {
    const first = pool.execute(host, "digest-a", { action: "list" });
    const second = pool.execute(host, "digest-a", { action: "list" });
    await tick();
    assert.equal(executor.requests.length, 1, "same-key callers share the synchronously reserved promise");
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(executor.requests.length, 1);
    assert.equal(pool.size, 1);
  } finally {
    gate.resolve();
    await pool.close();
  }
});

test("Gateway pool invalidation and close fence pending admissions without resurrection", async () => {
  for (const action of ["invalidate", "close"] as const) {
    const executor = new FakeGatewayExecutor();
    const gate = deferred();
    executor.openGate = gate.promise;
    const pool = new SshGatewayClientPool(asExecutor(executor));
    const pending = pool.execute(host, "digest-a", { action: "list" });
    await tick();
    assert.equal(executor.requests.length, 1);
    const invalidation = action === "invalidate" ? pool.invalidateHost(host.id) : pool.close();
    gate.resolve();
    await assert.rejects(pending, SshGatewayCapabilityError, `${action} rejects the stale caller`);
    await invalidation;
    assert.equal(pool.size, 0, `${action} leaves no resurrected entry`);
    assert.equal(executor.closeCount, 1, `${action} closes the full stale channel chain`);

    executor.openGate = undefined;
    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(executor.requests.length, 2, `${action} permits only a fresh admission afterwards`);
    await pool.close();
    assert.equal(executor.closeCount, 2);
  }
});

test("Gateway pool invalidates, reconnects after disconnect, and evicts at its bound", async () => {
  const executor = new FakeGatewayExecutor();
  const pool = new SshGatewayClientPool(asExecutor(executor), { maxEntries: 1 });
  const otherHost = { ...host, id: "other-host", label: "Other Host" };
  try {
    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(pool.size, 1);
    await pool.invalidateHost(host.id);
    assert.equal(pool.size, 0);
    assert.equal(executor.closeCount, 1);

    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(executor.requests.length, 2);
    executor.channels.at(-1)!.disconnect();
    await tick();
    assert.equal(pool.size, 0);

    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(executor.requests.length, 3);
    await pool.execute(otherHost, "digest-b", { action: "list" });
    assert.equal(pool.size, 1);
    assert.equal(executor.closeCount, 3, "disconnect and bounded eviction both close their clients");
  } finally {
    await pool.close();
  }
  assert.equal(executor.closeCount, 4);
});

test("a revision cache fence reconnects without corrupting effective chain validation", async () => {
  const executor = new FakeGatewayExecutor();
  executor.effectiveDigest = "effective-a";
  const pool = new SshGatewayClientPool(asExecutor(executor));
  try {
    await pool.execute(host, "effective-a", { action: "list" }, undefined, undefined, "1:effective-a");
    await pool.execute(host, "effective-a", { action: "list" }, undefined, undefined, "2:effective-a");
    assert.equal(executor.requests.length, 2, "a credential revision fence opens a fresh Gateway channel");
    assert.equal(executor.closeCount, 1, "the prior cached channel closes on revision change");
    assert.equal(pool.size, 1);
  } finally {
    await pool.close();
  }
  assert.equal(executor.closeCount, 2);
});

test("an effective chain digest change closes the old full transport and fences mismatched opens", async () => {
  const executor = new FakeGatewayExecutor();
  const pool = new SshGatewayClientPool(asExecutor(executor));
  try {
    executor.effectiveDigest = "digest-a";
    await pool.execute(host, "digest-a", { action: "list" });
    executor.effectiveDigest = "digest-b";
    await pool.execute(host, "digest-b", { action: "list" });
    assert.equal(executor.closeCount, 1, "the prior command channel closes its entire executor-owned chain");
    assert.equal(pool.size, 1);

    executor.effectiveDigest = "digest-c-raced";
    await assert.rejects(
      pool.execute(host, "digest-c", { action: "list" }),
      (error: unknown) => error instanceof SshGatewayCapabilityError
        && error.cause instanceof Error
        && /connection chain changed/u.test(error.cause.message),
    );
    assert.equal(executor.closeCount, 3, "both the stale pooled chain and mismatched new chain close");
    assert.equal(pool.size, 0);
  } finally {
    await pool.close();
  }
});

function bindingFetch(statusForPost = 200, serverName = "pi-maestro-gateway"): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (statusForPost !== 200) return new Response("failure", { status: statusForPost });
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: serverName, version: "1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "host", description: "host", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: JSON.stringify({ ok: true, data: {} }) }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } });
  }) as typeof fetch;
}

const binding = { hostId: host.id, endpoint: "https://gateway.example.test/mcp", token: "t".repeat(43), pairingId: "pair-1", expiresAt: Date.now() + 60_000, effectiveHostDigest: "digest-a" };

test("paired Gateway uses HTTPS directly and keeps binding material out of results", async () => {
  const executor = new FakeGatewayExecutor();
  const pool = new SshGatewayClientPool(asExecutor(executor), { bindingSource: { getGatewayBinding: () => binding }, fetch: bindingFetch() });
  try {
    const result = await pool.execute(host, "digest-a", { action: "status" }, undefined, undefined, "binding-fence");
    assert.equal(executor.requests.length, 0, "paired calls close the SSH bootstrap path before direct HTTPS use");
    assert.doesNotMatch(JSON.stringify(result), /gateway\.example|t{20}|pair-1/u);
  } finally { await pool.close(); }
});

test("HTTP session loss performs one bounded initialize and only then permits transient 5xx stdio fallback", async () => {
  const executor = new FakeGatewayExecutor();
  let initializes = 0;
  let lists = 0;
  const reconnectFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.method === "initialize") initializes += 1;
    if (request.method === "tools/list") lists += 1;
    if (request.method === "tools/list" && lists === 2) return new Response("invalid session", { status: 400 });
    if (request.method === "tools/list" && lists === 4) return new Response("temporary", { status: 503 });
    const result = request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pi-maestro-gateway", version: "1" } }
      : { tools: [{ name: "host", description: "host", inputSchema: { type: "object" } }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": `session-${initializes}` } });
  }) as typeof fetch;
  const pool = new SshGatewayClientPool(asExecutor(executor), { bindingSource: { getGatewayBinding: () => binding }, fetch: reconnectFetch });
  try {
    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(initializes, 2, "exactly one reinitialize follows session loss");
    assert.equal(executor.requests.length, 1, "a transient 5xx may use stdio only after the bounded reconnect");
  } finally { await pool.close(); }
});

test("HTTPS fallback matrix allows availability/protocol only and fails closed on auth, TLS, identity, digest, and expiry", async () => {
  for (const status of [404, 405]) {
    const executor = new FakeGatewayExecutor();
    const pool = new SshGatewayClientPool(asExecutor(executor), { bindingSource: { getGatewayBinding: () => binding }, fetch: bindingFetch(status) });
    await pool.execute(host, "digest-a", { action: "list" });
    assert.equal(executor.requests.length, 1, `${status} falls back to fixed stdio`);
    await pool.close();
  }
  const cases: Array<{ name: string; value: typeof binding; fetch: typeof fetch }> = [
    { name: "auth", value: binding, fetch: bindingFetch(401) },
    { name: "tls", value: binding, fetch: (async () => { throw Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }); }) as typeof fetch },
    { name: "identity", value: binding, fetch: bindingFetch(200, "other-server") },
    { name: "digest", value: { ...binding, effectiveHostDigest: "b".repeat(64) }, fetch: bindingFetch() },
    { name: "expiry", value: { ...binding, expiresAt: 1 }, fetch: bindingFetch() },
  ];
  for (const item of cases) {
    const executor = new FakeGatewayExecutor();
    const pool = new SshGatewayClientPool(asExecutor(executor), { bindingSource: { getGatewayBinding: () => item.value }, fetch: item.fetch, now: () => 2 });
    await assert.rejects(pool.execute(host, "digest-a", { action: "list" }), SshGatewayCapabilityError, item.name);
    assert.equal(executor.requests.length, 0, `${item.name} must not silently downgrade`);
    await pool.close();
  }
});

test("ordinary SSH hosts get an explicit Gateway capability error without fallback", async () => {
  const executor = new FakeGatewayExecutor();
  executor.failure = new Error("SSH command could not be started");
  const pool = new SshGatewayClientPool(asExecutor(executor));
  await assert.rejects(
    pool.execute(host, "digest-a", { action: "status" }),
    (error: unknown) => error instanceof SshGatewayCapabilityError
      && /No shell fallback was attempted/u.test(error.message),
  );
  assert.deepEqual(executor.requests, [{ command: SSH_GATEWAY_COMMAND, timeout: 30 }]);
  assert.equal(pool.size, 0);

  executor.failure = undefined;
  executor.serverName = "some-other-mcp-server";
  await assert.rejects(
    pool.execute(host, "digest-b", { action: "status" }),
    (error: unknown) => error instanceof SshGatewayCapabilityError,
  );
  assert.equal(pool.size, 0);
});
