import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGatewayOperation,
  gatewayOperationMayReplay,
} from "../src/gateway/operation-policy.ts";
import {
  GatewayOutcomeUnknownError,
  SshGatewayClientPool,
} from "../src/ssh-manager/gateway-client.ts";
import type { SshExecutor } from "../src/ssh-manager/executor.ts";
import type { SshGatewayBinding, SshHost } from "../src/ssh-manager/model.ts";

const host: SshHost = {
  id: "retry-host",
  label: "Retry Host",
  host: "gateway.example.test",
  user: "runner",
  port: 22,
  shell: "bash",
  hostKey: `SHA256:${"A".repeat(43)}`,
  auth: { kind: "agent" },
};

const binding: SshGatewayBinding = {
  hostId: host.id,
  endpoint: "https://gateway.example.test/mcp",
  token: "t".repeat(43),
  pairingId: "pair-retry",
  expiresAt: Date.now() + 60_000,
  effectiveHostDigest: "digest-retry",
};

class RefusingExecutor {
  opens = 0;
  async openChannel(): Promise<never> {
    this.opens += 1;
    throw new Error("stdio fallback must not be reached in this test");
  }
}

interface RetryFetchProbe {
  fetch: typeof fetch;
  initializes(): number;
  toolCalls(): number;
}

function gatewayFaultOnce(status = 400, body = "invalid session"): RetryFetchProbe {
  let initializeCount = 0;
  let callCount = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)) as { id?: unknown; method?: string; params?: Record<string, unknown> };
    if (request.method === "initialize") initializeCount += 1;
    if (request.method === "tools/call") {
      callCount += 1;
      if (callCount === 1) return new Response(body, { status });
    }
    const result = request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pi-maestro-gateway", version: "1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "host", description: "host", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { replayed: callCount > 1 } }) }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": `retry-${initializeCount}` },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, initializes: () => initializeCount, toolCalls: () => callCount };
}

function poolFor(probe: RetryFetchProbe, executor: RefusingExecutor): SshGatewayClientPool {
  return new SshGatewayClientPool(executor as unknown as Pick<SshExecutor, "openChannel">, {
    bindingSource: { getGatewayBinding: () => binding },
    fetch: probe.fetch,
  });
}

test("Gateway operation policy classifies only canonical reads and durable operationId mutations as replayable", () => {
  const read = classifyGatewayOperation("file", { action: "read", path: "a.txt" });
  assert.deepEqual(read, { retryClass: "read", tool: "file", action: "read" });
  assert.equal(gatewayOperationMayReplay(read), true);

  const receipted = classifyGatewayOperation("session", { action: "renew", operationId: "renew-1" });
  assert.deepEqual(receipted, { retryClass: "receipt-backed", tool: "session", action: "renew", operationId: "renew-1" });
  assert.equal(gatewayOperationMayReplay(receipted), true);

  assert.equal(classifyGatewayOperation("session", { action: "start-pi", operationId: "launch-1" }).retryClass, "receipt-backed");
  assert.equal(classifyGatewayOperation("monitor", { action: "message", operationId: "message-1" }).retryClass, "receipt-backed");
  assert.equal(classifyGatewayOperation("monitor", { action: "cancel", operationId: "cancel-1" }).retryClass, "receipt-backed");

  for (const operation of [
    classifyGatewayOperation("exec", { action: "run", operationId: "not-a-receipt" }),
    classifyGatewayOperation("session", { action: "start-pi", requestId: "launch-1" }),
    classifyGatewayOperation("monitor", { action: "message" }),
    classifyGatewayOperation("todo", { action: "advance" }),
    classifyGatewayOperation("unknown", { action: "list", operationId: "invented" }),
  ]) {
    assert.equal(operation.retryClass, "outcome-unknown");
    assert.equal(gatewayOperationMayReplay(operation), false);
  }

  assert.equal(classifyGatewayOperation("maestro_cli", { action: "stage", operationId: "stage-1" }).retryClass, "receipt-backed");
  assert.equal(classifyGatewayOperation("board", { action: "observe" }).retryClass, "read");
});

test("a read reinitializes once and replays after an HTTPS session-loss fault", async () => {
  const probe = gatewayFaultOnce();
  const executor = new RefusingExecutor();
  const pool = poolFor(probe, executor);
  try {
    const result = await pool.execute(host, "digest-retry", { action: "call", tool: "file", args: { action: "read", path: "README.md" } });
    assert.equal(result.isError, undefined);
    assert.equal(probe.toolCalls(), 2);
    assert.equal(probe.initializes(), 2);
    assert.equal(executor.opens, 0);
  } finally { await pool.close(); }
});

test("a read retries once after a transient HTTPS server fault", async () => {
  const probe = gatewayFaultOnce(503, "temporary");
  const executor = new RefusingExecutor();
  const pool = poolFor(probe, executor);
  try {
    await pool.execute(host, "digest-retry", { action: "call", tool: "host", args: { action: "status" } });
    assert.equal(probe.toolCalls(), 2);
    assert.equal(probe.initializes(), 2);
    assert.equal(executor.opens, 0);
  } finally { await pool.close(); }
});

test("a receipt-backed mutation reinitializes once and replays the same operationId", async () => {
  const probe = gatewayFaultOnce();
  const executor = new RefusingExecutor();
  const pool = poolFor(probe, executor);
  try {
    const args = { action: "renew", sessionId: "s", memberId: "m", expectedSessionRevision: 1, expectedGeneration: 1, leaseTtlMs: 60_000, operationId: "renew-1" };
    const result = await pool.execute(host, "digest-retry", { action: "call", tool: "session", args });
    assert.equal(result.isError, undefined);
    assert.equal(probe.toolCalls(), 2);
    assert.equal(probe.initializes(), 2);
    assert.equal(executor.opens, 0);
  } finally { await pool.close(); }
});

test("an unreceipted mutation returns gateway_outcome_unknown without reconnect or stdio replay", async () => {
  const probe = gatewayFaultOnce();
  const executor = new RefusingExecutor();
  const pool = poolFor(probe, executor);
  try {
    await assert.rejects(
      pool.execute(host, "digest-retry", { action: "call", tool: "session", args: { action: "start-pi", sessionId: "s", memberId: "m", prompt: "do it", requestId: "launch-1" } }),
      (error: unknown) => error instanceof GatewayOutcomeUnknownError
        && error.code === "gateway_outcome_unknown"
        && error.retryable === false
        && error.operation.retryClass === "outcome-unknown",
    );
    assert.equal(probe.toolCalls(), 1, "the possibly accepted mutation is sent exactly once");
    assert.equal(probe.initializes(), 1, "the client does not reinitialize to replay an uncertain mutation");
    assert.equal(executor.opens, 0, "the client does not cross transports after an uncertain mutation");
  } finally { await pool.close(); }
});
