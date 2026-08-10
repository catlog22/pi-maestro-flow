import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cancelProxyDispatch,
  dispatchRegisteredChildTool,
  handleProxyRequest,
} from "../src/extension/teammate-proxy.ts";
import type { TeammateState } from "../src/shared/types.ts";
import {
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  proxyTeammateChildTool,
  registerTeammateChildProxyCaller,
  registerTeammateChildToolBroker,
  registerTeammatePermissionBroker,
  resolveTeammateChildToolBroker,
  resolveTeammatePermissionBroker,
  type TeammateChildProxyCaller,
} from "../src/runs/child-extensions.ts";

interface TestRegistry {
  permissionBrokers: Map<symbol, unknown>;
  permissionBrokerOwners: Map<symbol, unknown>;
  toolBrokers: Map<symbol, { toolName: string; broker: unknown }>;
  toolBrokerOwners: Map<symbol, unknown>;
  proxyCallers: Map<symbol, unknown>;
  proxyCaller?: unknown;
}

/**
 * Reaches into the globalThis registry to fabricate the only situation that can
 * produce two live registrations of one authority: a legacy generation of the
 * package writing into the shared registry without owner metadata.
 */
function registry(): TestRegistry {
  const key = Symbol.for("pi-maestro-teammate.child-extensions");
  return (globalThis as unknown as Record<symbol, TestRegistry>)[key];
}

function callerReturning(text: string): TeammateChildProxyCaller {
  const caller = async () => ({
    content: [{ type: "text", text }],
    details: undefined,
  });
  return caller as unknown as TeammateChildProxyCaller;
}

async function proxyText(): Promise<string> {
  const result = await proxyTeammateChildTool("probe", {});
  const [first] = result.content as { type: string; text: string }[];
  return first.text;
}

test("proxy caller registration is owner-guarded and rejects foreign takeover", async () => {
  const dispose = registerTeammateChildProxyCaller(callerReturning("flow"), { owner: "flow-owner" });
  try {
    assert.equal(await proxyText(), "flow");
    assert.throws(
      () => registerTeammateChildProxyCaller(callerReturning("attacker"), { owner: "attacker" }),
      (error: Error) => {
        assert.match(error.message, /conflicting teammate child proxy caller/i);
        assert.match(error.message, /flow-owner/);
        return true;
      },
    );
    // The rejected registration must not have displaced the incumbent.
    assert.equal(await proxyText(), "flow");
  } finally {
    dispose();
  }
  assert.match(await proxyText(), /Parent IPC proxy is unavailable/);
});

test("same-owner proxy caller replacement survives stale disposal", async () => {
  const disposeFirst = registerTeammateChildProxyCaller(callerReturning("first"), { owner: "flow-owner" });
  const disposeCurrent = registerTeammateChildProxyCaller(callerReturning("current"), { owner: "flow-owner" });

  assert.equal(await proxyText(), "current");
  disposeFirst();
  assert.equal(await proxyText(), "current");
  disposeCurrent();
  assert.match(await proxyText(), /Parent IPC proxy is unavailable/);
});

test("anonymous proxy caller registration keeps last-registration-wins compatibility", async () => {
  const disposeFirst = registerTeammateChildProxyCaller(callerReturning("first"));
  const disposeSecond = registerTeammateChildProxyCaller(callerReturning("second"));

  assert.equal(await proxyText(), "second");
  disposeFirst();
  assert.equal(await proxyText(), "second");
  disposeSecond();
  assert.match(await proxyText(), /Parent IPC proxy is unavailable/);
  assert.equal(registry().proxyCallers.size, 0);
  assert.equal(registry().proxyCaller, undefined);
});

test("named proxy owner cannot displace an anonymous registration silently", async () => {
  const dispose = registerTeammateChildProxyCaller(callerReturning("anonymous"));
  try {
    assert.throws(
      () => registerTeammateChildProxyCaller(callerReturning("named"), { owner: "other-package" }),
      /conflicting teammate child proxy caller/i,
    );
    assert.equal(await proxyText(), "anonymous");
  } finally {
    dispose();
  }
});

test("empty proxy caller owner is rejected", () => {
  assert.throws(
    () => registerTeammateChildProxyCaller(callerReturning("blank"), { owner: "  " }),
    /owner must not be empty/i,
  );
});

test("permission broker conflict names the incumbent owner", () => {
  const dispose = registerTeammatePermissionBroker(async () => ({ action: "deny" as const }), {
    owner: "flow-permission-owner",
  });
  try {
    assert.throws(
      () => registerTeammatePermissionBroker(async () => ({ action: "allow_once" as const }), {
        owner: "foreign-permission-owner",
      }),
      (error: Error) => {
        assert.match(error.message, /conflicting teammate permission broker/i);
        assert.match(error.message, /owner "flow-permission-owner"/);
        assert.match(error.message, /re-register with the same owner/i);
        return true;
      },
    );
  } finally {
    dispose();
  }
});

test("child tool broker conflict names the incumbent owner and the tool", () => {
  const broker = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
  const dispose = registerTeammateChildToolBroker("authority-probe", broker, { owner: "flow-tool-owner" });
  try {
    assert.throws(
      () => registerTeammateChildToolBroker("authority-probe", broker, { owner: "foreign-tool-owner" }),
      (error: Error) => {
        assert.match(error.message, /conflicting teammate child tool broker "authority-probe"/i);
        assert.match(error.message, /owner "flow-tool-owner"/);
        return true;
      },
    );
  } finally {
    dispose();
  }
});

test("permission broker resolution distinguishes unregistered from conflicting", () => {
  const empty = resolveTeammatePermissionBroker();
  assert.equal(empty.status, "unregistered");
  assert.equal(empty.broker, undefined);
  assert.match(empty.reason ?? "", /No teammate permission broker is registered/);
  assert.deepEqual(empty.owners, []);
  assert.equal(getTeammatePermissionBroker(), undefined);

  const broker = async () => ({ action: "deny" as const, reason: "resolved" });
  const dispose = registerTeammatePermissionBroker(broker, { owner: "flow-permission-owner" });
  try {
    const resolved = resolveTeammatePermissionBroker();
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.broker, broker);
    assert.equal(resolved.reason, undefined);
    assert.equal(getTeammatePermissionBroker(), broker);

    // Simulate a legacy generation that registered without owner metadata.
    const legacyToken = Symbol("legacy-permission-broker");
    registry().permissionBrokers.set(legacyToken, async () => ({ action: "allow_once" as const }));
    try {
      const conflict = resolveTeammatePermissionBroker();
      assert.equal(conflict.status, "conflict");
      assert.equal(conflict.broker, undefined);
      assert.match(conflict.reason ?? "", /Ambiguous teammate permission broker/);
      assert.deepEqual(conflict.owners, ["flow-permission-owner", "<anonymous:legacy-permission-broker>"]);
      // The historical getter keeps its fail-closed undefined.
      assert.equal(getTeammatePermissionBroker(), undefined);
    } finally {
      registry().permissionBrokers.delete(legacyToken);
      registry().permissionBrokerOwners.delete(legacyToken);
    }
  } finally {
    dispose();
  }
});

test("child tool broker resolution distinguishes unregistered from conflicting", () => {
  const missing = resolveTeammateChildToolBroker("never-registered");
  assert.equal(missing.status, "unregistered");
  assert.match(missing.reason ?? "", /No teammate child tool broker "never-registered" is registered/);

  const broker = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
  const dispose = registerTeammateChildToolBroker("resolve-probe", broker, { owner: "flow-tool-owner" });
  try {
    const resolved = resolveTeammateChildToolBroker("resolve-probe");
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.broker, broker);
    assert.equal(getTeammateChildToolBroker("resolve-probe"), broker);

    const legacyToken = Symbol("legacy-tool-broker");
    registry().toolBrokers.set(legacyToken, { toolName: "resolve-probe", broker: async () => ({ content: [] }) });
    try {
      const conflict = resolveTeammateChildToolBroker("resolve-probe");
      assert.equal(conflict.status, "conflict");
      assert.deepEqual(conflict.owners, ["flow-tool-owner", "<anonymous:legacy-tool-broker>"]);
      assert.equal(getTeammateChildToolBroker("resolve-probe"), undefined);
      // A sibling tool name stays unaffected by the contested one.
      assert.equal(resolveTeammateChildToolBroker("other-probe").status, "unregistered");
    } finally {
      registry().toolBrokers.delete(legacyToken);
      registry().toolBrokerOwners.delete(legacyToken);
    }
  } finally {
    dispose();
  }
});

test("registered child tool brokers receive cancellation from the requesting child", async () => {
  let brokerSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const dispose = registerTeammateChildToolBroker("cancel-probe", async (request) => {
    brokerSignal = request.signal;
    markStarted();
    if (!request.signal) {
      return { content: [{ type: "text" as const, text: "missing signal" }], isError: true };
    }
    return new Promise((resolve) => {
      request.signal!.addEventListener("abort", () => resolve({
        content: [{ type: "text" as const, text: "aborted" }],
        isError: true,
      }), { once: true });
    });
  }, { owner: "cancel-owner" });
  const actorController = new AbortController();
  const state = {
    activeRuns: new Map([["actor-1", {
      correlationId: "actor-1",
      abortController: actorController,
    }]]),
  } as unknown as TeammateState;
  const replies: unknown[] = [];

  try {
    const pending = dispatchRegisteredChildTool({
      type: "teammate_proxy_request",
      tool: "cancel-probe",
      requestId: "request-1",
      params: {},
    }, (message) => replies.push(message), state, "actor-1");
    await started;

    assert.equal(brokerSignal?.aborted, false);
    assert.deepEqual(cancelProxyDispatch(state, "request-1", "test cancellation"), []);
    assert.equal(brokerSignal?.aborted, true);
    assert.equal(await pending, true);
    assert.equal(state.proxyObservationControllers?.size, 0);
    assert.match(JSON.stringify(replies), /aborted/);
  } finally {
    dispose();
  }
});

test("registered child tools are admitted before asynchronous model refresh", async () => {
  let refreshCalls = 0;
  const dispose = registerTeammateChildToolBroker("ingress-probe", async () => ({
    content: [{ type: "text" as const, text: "started" }],
  }), { owner: "ingress-owner" });
  const state = {
    sessionGeneration: 1,
    activeRuns: new Map([["actor-1", {
      correlationId: "actor-1",
      abortController: new AbortController(),
    }]]),
  } as unknown as TeammateState;
  const replies: unknown[] = [];

  try {
    await handleProxyRequest(
      {} as ExtensionAPI,
      state,
      { type: "teammate_proxy_request", tool: "ingress-probe", requestId: "ingress-1", params: {} },
      (message) => replies.push(message),
      "actor-1",
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      async () => { refreshCalls++; return []; },
    );
    assert.equal(refreshCalls, 0);
    assert.match(JSON.stringify(replies), /started/);
  } finally {
    dispose();
  }
});

test("model refresh continuation rejects requests from a stale session generation", async () => {
  let markRefreshStarted!: () => void;
  let finishRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve; });
  const state = {
    sessionGeneration: 4,
    baseCwd: process.cwd(),
    activeRuns: new Map([["actor-1", {
      correlationId: "actor-1",
      abortController: new AbortController(),
      depth: 0,
    }]]),
  } as unknown as TeammateState;
  const replies: unknown[] = [];

  const pending = handleProxyRequest(
    {} as ExtensionAPI,
    state,
    { type: "teammate_proxy_request", tool: "teammate", requestId: "stale-1", params: { tasks: [{ prompt: "noop" }] } },
    (message) => replies.push(message),
    "actor-1",
    [],
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      markRefreshStarted();
      await refreshGate;
      return [];
    },
  );
  await refreshStarted;
  state.sessionGeneration = 5;
  finishRefresh();
  await pending;

  assert.equal(state.pendingProxyDispatchRequests?.size, 0);
  assert.match(JSON.stringify(replies), /session generation changed/i);
});
