import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { registerToolRoutes } from "../src/gui/tool-routes.ts";
import { registerGuiTool, clearGuiTools } from "../src/gui/gui-registry.ts";
import type { GuiPermissionGateway } from "../src/gui/types.ts";

const fakeCtx = {} as ExtensionContext;

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    execute,
  } as unknown as ToolDefinition;
}

const allowGateway: GuiPermissionGateway = {
  mode: () => "default",
  authorize: async () => undefined,
};

function denyGateway(reason: string): GuiPermissionGateway {
  return { mode: () => "default", authorize: async () => ({ block: true as const, reason }) };
}

async function postInvoke(
  port: number,
  token: string,
  name: string,
  args: unknown,
  options: { invokeId?: string; timeoutMs?: number } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ args, ...options }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function postCancel(port: number, token: string, invokeId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ invokeId }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collectSse(port: number, token: string, eventName: string, timeoutMs = 2000): Promise<any[]> {
  return new Promise((resolve) => {
    const events: any[] = [];
    const req = http.get({ host: "127.0.0.1", port, path: `/events?session=${token}` }, (res) => {
      let buffer = "";
      let current: Partial<{ event: string; data: string }> = {};
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.startsWith(":")) continue;
          if (line === "") {
            if (current.event === eventName && current.data !== undefined) events.push(JSON.parse(current.data));
            current = {};
            continue;
          }
          const colon = line.indexOf(":");
          const field = colon >= 0 ? line.slice(0, colon) : line;
          const value = colon >= 0 ? line.slice(colon + 1).trimStart() : "";
          if (field === "event") current.event = value;
          else if (field === "data") current.data = value;
        }
      });
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

test("POST /tools/:name invokes the tool and serializes the result", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    let receivedArgs: unknown;
    registerGuiTool(
      tool("todo", async (_id, params) => {
        receivedArgs = params;
        return { content: [{ type: "text", text: "listed" }], details: { tasks: [1, 2, 3] } };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const resp = await postInvoke(server.port, server.token, "todo", { action: "list" });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.ok, true);
    assert.ok(resp.body.result.toolCallId);
    assert.deepEqual(resp.body.result.content, [{ type: "text", text: "listed" }]);
    assert.deepEqual(resp.body.result.details, { tasks: [1, 2, 3] });
    assert.deepEqual(receivedArgs, { action: "list" });
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name enforces the permission gateway (deny blocks execute)", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    let executed = false;
    registerGuiTool(
      tool("goal", async () => {
        executed = true;
        return { content: [], details: {} };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: denyGateway("approval required"),
      getCtx: () => fakeCtx,
    });

    const resp = await postInvoke(server.port, server.token, "goal", { action: "create" });
    assert.equal(resp.status, 403);
    assert.equal(resp.body.ok, false);
    assert.equal(resp.body.code, "permission_denied");
    assert.equal(resp.body.error, "approval required");
    assert.equal(executed, false, "execute must not run when the gateway denies");
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name handles unknown tool, missing ctx, and execute errors", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(
      tool("maestro", async () => {
        throw new Error("kaboom");
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const unknown = await postInvoke(server.port, server.token, "nope", {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "not_invocable");

    const boom = await postInvoke(server.port, server.token, "maestro", {});
    assert.equal(boom.status, 500);
    assert.equal(boom.body.code, "tool_error");
    assert.match(boom.body.error, /kaboom/);
  } finally {
    server.close("done");
    clearGuiTools();
  }

  // No active context -> 503.
  const cwd2 = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server2 = await startGuiServer({ sessionId: "s2", cwd: cwd2, writeDiscovery: false });
  try {
    registerGuiTool(tool("todo", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server2, { listAllTools: () => [], gateway: allowGateway, getCtx: () => undefined });
    const resp = await postInvoke(server2.port, server2.token, "todo", {});
    assert.equal(resp.status, 503);
    assert.equal(resp.body.code, "no_context");
  } finally {
    server2.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name rejects args outside the registered canonical schema", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-schema-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  let authorizeCalls = 0;
  let executeCalls = 0;
  let invalidateDuringAuthorization = false;
  try {
    registerGuiTool(
      {
        ...tool("todo", async () => {
          executeCalls += 1;
          return { content: [], details: {} };
        }),
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["list"] } },
          required: ["action"],
          additionalProperties: false,
        },
      } as unknown as ToolDefinition,
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async (_name, input) => {
          authorizeCalls += 1;
          if (invalidateDuringAuthorization) input.action = 7;
          return undefined;
        },
      },
      getCtx: () => fakeCtx,
    });

    for (const args of [{ action: 7 }, { action: "list", extra: true }, null]) {
      const invalid = await postInvoke(server.port, server.token, "todo", args);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, "invalid_args");
      assert.equal(invalid.body.error, "Invalid tool arguments");
    }
    assert.equal(authorizeCalls, 0, "invalid args must fail before authorization");
    assert.equal(executeCalls, 0);

    invalidateDuringAuthorization = true;
    const mutated = await postInvoke(server.port, server.token, "todo", { action: "list" });
    assert.equal(mutated.status, 400);
    assert.equal(mutated.body.code, "invalid_args");
    assert.equal(executeCalls, 0, "authorization mutations must be revalidated before execute");

    invalidateDuringAuthorization = false;
    const valid = await postInvoke(server.port, server.token, "todo", { action: "list" });
    assert.equal(valid.status, 200);
    assert.equal(authorizeCalls, 2);
    assert.equal(executeCalls, 1);
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name converts arguments with host TypeBox semantics", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-schema-convert-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  let authorizedArgs: unknown;
  let executedArgs: unknown;
  try {
    registerGuiTool(
      {
        ...tool("todo", async (_id, params) => {
          executedArgs = params;
          return { content: [], details: {} };
        }),
        parameters: Type.Object({
          count: Type.Integer(),
          enabled: Type.Boolean(),
        }, { additionalProperties: false }),
      } as unknown as ToolDefinition,
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async (_name, input) => {
          authorizedArgs = { ...input };
          return undefined;
        },
      },
      getCtx: () => fakeCtx,
    });

    const response = await postInvoke(server.port, server.token, "todo", {
      count: "7",
      enabled: "false",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(authorizedArgs, { count: 7, enabled: false });
    assert.deepEqual(executedArgs, { count: 7, enabled: false });
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name reserves admission while authorization is pending", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-admission-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const authorizationStarted = deferred();
  const releaseAuthorization = deferred();
  let authorizeCalls = 0;
  try {
    registerGuiTool(tool("todo", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async () => {
          authorizeCalls += 1;
          authorizationStarted.resolve();
          await releaseAuthorization.promise;
          return undefined;
        },
      },
      getCtx: () => fakeCtx,
      maxConcurrentInvokes: 1,
    });

    const first = postInvoke(server.port, server.token, "todo", {}, { invokeId: "auth-pending" });
    await authorizationStarted.promise;
    const second = await postInvoke(server.port, server.token, "todo", {}, { invokeId: "must-not-authorize" });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, "rate_limited");
    assert.equal(authorizeCalls, 1, "the bounded slot must be reserved before awaiting authorization");

    releaseAuthorization.resolve();
    assert.equal((await first).status, 200);
  } finally {
    releaseAuthorization.resolve();
    server.close("done");
    clearGuiTools();
  }
});

test("cancel settles pending authorization even when the gateway ignores its signal", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-auth-cancel-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const authorizationStarted = deferred();
  const lateAuthorization = deferred<{ block: true; reason: string } | undefined>();
  let gatewaySignal: AbortSignal | undefined;
  try {
    registerGuiTool(tool("todo", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async (_name, _input, signal) => {
          gatewaySignal = signal;
          authorizationStarted.resolve();
          return await lateAuthorization.promise;
        },
      },
      getCtx: () => fakeCtx,
    });

    const pending = postInvoke(server.port, server.token, "todo", {}, { invokeId: "pending-auth" });
    await authorizationStarted.promise;
    assert.equal((await postCancel(server.port, server.token, "pending-auth")).status, 200);
    const response = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancel did not settle authorization")), 500)),
    ]);
    assert.equal(response.status, 499);
    assert.equal(response.body.code, "cancelled");
    assert.equal(gatewaySignal?.aborted, true);

    lateAuthorization.reject(new Error("late gateway rejection"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    lateAuthorization.resolve(undefined);
    server.close("done");
    clearGuiTools();
  }
});

test("GUI shutdown settles pending authorization even when the gateway never settles", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-auth-shutdown-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const authorizationStarted = deferred();
  let gatewaySignal: AbortSignal | undefined;
  try {
    registerGuiTool(tool("todo", async () => ({ content: [], details: {} })), "pi-maestro-flow");
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async (_name, _input, signal) => {
          gatewaySignal = signal;
          authorizationStarted.resolve();
          return await new Promise<never>(() => {});
        },
      },
      getCtx: () => fakeCtx,
    });

    const pending = postInvoke(server.port, server.token, "todo", {}, { invokeId: "shutdown-auth" });
    await authorizationStarted.promise;
    server.close("session-shutdown");
    const response = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown did not settle authorization")), 500)),
    ]);
    assert.equal(response.status, 499);
    assert.equal(response.body.code, "cancelled");
    assert.equal(gatewaySignal?.aborted, true);
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name rejects a context replaced during authorization", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-stale-ctx-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const authorizationStarted = deferred();
  const releaseAuthorization = deferred();
  let currentCtx = fakeCtx;
  let executed = false;
  try {
    registerGuiTool(
      tool("todo", async () => {
        executed = true;
        return { content: [], details: {} };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async () => {
          authorizationStarted.resolve();
          await releaseAuthorization.promise;
          return undefined;
        },
      },
      getCtx: () => currentCtx,
    });

    const pending = postInvoke(server.port, server.token, "todo", {});
    await authorizationStarted.promise;
    currentCtx = {} as ExtensionContext;
    releaseAuthorization.resolve();

    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "stale_context");
    assert.equal(executed, false);
  } finally {
    releaseAuthorization.resolve();
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name rejects a registry entry replaced during authorization", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-stale-tool-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const authorizationStarted = deferred();
  const releaseAuthorization = deferred();
  let originalExecuted = false;
  let replacementExecuted = false;
  try {
    registerGuiTool(
      tool("todo", async () => {
        originalExecuted = true;
        return { content: [], details: {} };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, {
      listAllTools: () => [],
      gateway: {
        mode: () => "default",
        authorize: async () => {
          authorizationStarted.resolve();
          await releaseAuthorization.promise;
          return undefined;
        },
      },
      getCtx: () => fakeCtx,
    });

    const pending = postInvoke(server.port, server.token, "todo", {});
    await authorizationStarted.promise;
    registerGuiTool(
      tool("todo", async () => {
        replacementExecuted = true;
        return { content: [], details: {} };
      }),
      "pi-maestro-flow",
    );
    releaseAuthorization.resolve();

    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "stale_tool");
    assert.equal(originalExecuted, false);
    assert.equal(replacementExecuted, false);
  } finally {
    releaseAuthorization.resolve();
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name rejects duplicate invokeId without losing the original owner", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-collision-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const firstStarted = deferred();
  let calls = 0;
  try {
    registerGuiTool(
      tool("todo", async (_id, _params, signal) => {
        calls += 1;
        if (calls > 1) return { content: [], details: { calls } };
        firstStarted.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const first = postInvoke(server.port, server.token, "todo", {}, { invokeId: "same-id" });
    await firstStarted.promise;
    const collision = await postInvoke(server.port, server.token, "todo", {}, { invokeId: "same-id" });
    assert.equal(collision.status, 409);
    assert.equal(collision.body.code, "invoke_conflict");

    const cancelled = await postCancel(server.port, server.token, "same-id");
    assert.equal(cancelled.status, 200, "the duplicate must not replace the original controller");
    assert.equal((await first).status, 499);

    const reused = await postInvoke(server.port, server.token, "todo", {}, { invokeId: "same-id" });
    assert.equal(reused.status, 200, "identity-checked cleanup must release the original id");
    assert.equal(calls, 2);
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("aborted invoke suppresses late progress and successful completion", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-late-abort-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const executeStarted = deferred();
  const releaseExecute = deferred();
  let lateUpdate: (() => void) | undefined;
  try {
    registerGuiTool(
      tool("maestro", async (_id, _params, _signal, onUpdate) => {
        lateUpdate = () => onUpdate?.({ content: [], details: { late: true } });
        executeStarted.resolve();
        await releaseExecute.promise;
        return { content: [], details: { completed: true } };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const progressEvents = collectSse(server.port, server.token, "tool.progress", 500);
    const invokedEvents = collectSse(server.port, server.token, "tool.invoked", 500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pending = postInvoke(server.port, server.token, "maestro", {}, { invokeId: "late-abort" });
    await executeStarted.promise;
    assert.equal((await postCancel(server.port, server.token, "late-abort")).status, 200);
    lateUpdate?.();
    releaseExecute.resolve();

    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal(response.body.code, "cancelled");
    const [progress, invoked] = await Promise.all([progressEvents, invokedEvents]);
    assert.deepEqual(progress, [], "progress emitted after abort must be suppressed");
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].ok, false);
    assert.equal(invoked[0].cancelled, true);
  } finally {
    releaseExecute.resolve();
    server.close("done");
    clearGuiTools();
  }
});

test("GUI server close aborts every route-owned invocation", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-shutdown-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const bothStarted = deferred();
  let started = 0;
  let aborted = 0;
  try {
    registerGuiTool(
      tool("todo", async (_id, _params, signal) => {
        started += 1;
        if (started === 2) bothStarted.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("shutdown"));
          }, { once: true });
        });
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const first = postInvoke(server.port, server.token, "todo", {}, { invokeId: "shutdown-1" });
    const second = postInvoke(server.port, server.token, "todo", {}, { invokeId: "shutdown-2" });
    await bothStarted.promise;
    server.close("session-shutdown");

    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [499, 499]);
    assert.equal(aborted, 2);
  } finally {
    server.close("done");
    clearGuiTools();
  }
});

test("POST /tools/:name bridges onUpdate to SSE tool.progress", async () => {
  clearGuiTools();
  const cwd = await mkdtemp(join(tmpdir(), "gui-invoke-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerGuiTool(
      tool("maestro", async (_id, _params, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
        return { content: [{ type: "text", text: "final" }], details: { step: 2 } };
      }),
      "pi-maestro-flow",
    );
    registerToolRoutes(server, { listAllTools: () => [], gateway: allowGateway, getCtx: () => fakeCtx });

    const progress = collectSse(server.port, server.token, "tool.progress");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resp = await postInvoke(server.port, server.token, "maestro", {});
    assert.equal(resp.status, 200);
    assert.deepEqual(resp.body.result.details, { step: 2 });

    const events = await progress;
    assert.ok(events.length >= 1, "expected at least one tool.progress event");
    assert.equal(events[0].name, "maestro");
    assert.deepEqual(events[0].partial.details, { step: 1 });
  } finally {
    server.close("done");
    clearGuiTools();
  }
});
