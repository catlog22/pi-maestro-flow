import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTodoEndpoint, type TodoEndpoint } from "pi-maestro-backends/dsh/todo-endpoint";

/**
 * What this endpoint has to prove.
 *
 * Every assertion here drives a real MCP client through a real handshake rather
 * than calling the request handler directly. An implementation that registers
 * the tool but never connects its transport passes the second kind of test and
 * fails every real deployment, so the second kind is not written here.
 */

interface Recorded {
  toolName: string;
  args: unknown;
  correlationId: string;
}

interface Probe {
  endpoint: TodoEndpoint;
  calls: Recorded[];
}

async function probe(result: unknown = { content: [{ type: "text", text: "[]" }] }): Promise<Probe> {
  const calls: Recorded[] = [];
  const endpoint = await startTodoEndpoint({
    correlationId: "run-under-test",
    proxyToolCall: async (request) => {
      calls.push(request);
      return result;
    },
  });
  return { endpoint, calls };
}

/** Connect a real MCP client, run `body`, and close both ends. */
async function withClient(
  endpoint: TodoEndpoint,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "endpoint-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

test("a real MCP client completes initialize and reaches the host broker", async () => {
  const { endpoint, calls } = await probe({ content: [{ type: "text", text: "[]" }] });
  try {
    await withClient(endpoint, async (client) => {
      const called = await client.callTool({ name: "todo", arguments: { action: "list" } });
      assert.deepEqual(called.content, [{ type: "text", text: "[]" }]);
    });
    assert.equal(endpoint.sawClientConnect(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.toolName, "todo");
  } finally {
    await endpoint.close();
  }
});

test("the published todo tool exposes no way to claim another actor", async () => {
  const { endpoint, calls } = await probe();
  try {
    await withClient(endpoint, async (client) => {
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === "todo");
      assert.ok(tool !== undefined, "the endpoint publishes no tool named todo");
      const properties = Object.keys(
        (tool.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      for (const forbidden of ["actor", "correlationId", "assignee"]) {
        assert.equal(properties.includes(forbidden), false, `schema offers "${forbidden}"`);
      }
      assert.deepEqual(
        (tool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum,
        ["list", "get", "update"],
      );

      await client.callTool({
        name: "todo",
        arguments: { action: "list", correlationId: "other-run", actor: "someone-else" },
      });
    });
    assert.equal(calls.length, 1);
    // Identity comes off the endpoint, so a caller that named one is ignored
    // rather than merely overridden further down.
    assert.equal(calls[0]!.correlationId, "run-under-test");
    assert.deepEqual(calls[0]!.args, { action: "list" });
  } finally {
    await endpoint.close();
  }
});

test("a request without the per-run token is refused before any tool runs", async () => {
  const { endpoint, calls } = await probe();
  try {
    const untokened = new URL(endpoint.url);
    untokened.searchParams.delete("token");
    const response = await fetch(untokened, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "todo", arguments: { action: "list" } } }),
    });
    assert.equal(response.status, 403);
    await response.text();
    assert.equal(calls.length, 0);
  } finally {
    await endpoint.close();
  }
});

test("the endpoint stops listening once closed", async () => {
  const { endpoint } = await probe();
  const url = endpoint.url;
  await endpoint.close();
  await assert.rejects(
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
});

test("the published updateFields is the list of field names the host tool reads", async () => {
  // The host's `TodoParams.updateFields` is a `TodoUpdateField[]` and reaches
  // `new Set(params.updateFields)` with no try/catch around it, so publishing
  // this as an object sent every schema-obeying model into a TypeError that
  // surfaced as an internal error rather than as a parameter error. The enum
  // lists only what this endpoint forwards: naming a field it drops would
  // publish a write the host is then told to make and given no value for.
  const { endpoint, calls } = await probe();
  try {
    await withClient(endpoint, async (client) => {
      const listed = await client.listTools();
      const schema = listed.tools.find((entry) => entry.name === "todo")?.inputSchema as {
        properties: { updateFields: { type: string; items?: { enum?: string[] } } };
      };
      assert.equal(schema.properties.updateFields.type, "array");
      assert.deepEqual(schema.properties.updateFields.items?.enum, ["status", "summary"]);

      await client.callTool({
        name: "todo",
        arguments: { action: "update", id: "t1", status: "completed", updateFields: ["status"] },
      });
    });
    // Arrives as an array, not as whatever the model made of an object schema:
    // this is the value the host iterates.
    assert.deepEqual(calls[0]!.args, {
      action: "update",
      id: "t1",
      status: "completed",
      updateFields: ["status"],
    });
  } finally {
    await endpoint.close();
  }
});

test("a host error reaches the model as an error rather than as a successful write", async () => {
  const { endpoint } = await probe({
    content: [{ type: "text", text: "you do not own that item" }],
    isError: true,
    details: { rejected: true },
  });
  try {
    await withClient(endpoint, async (client) => {
      const called = await client.callTool({
        name: "todo",
        arguments: { action: "update", id: "t1", status: "completed" },
      });
      assert.equal(called.isError, true);
      assert.deepEqual(called.content, [{ type: "text", text: "you do not own that item" }]);
    });
  } finally {
    await endpoint.close();
  }
});
