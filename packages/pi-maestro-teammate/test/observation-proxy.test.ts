import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cancelProxyDispatch, handleProxyRequest } from "../src/extension/index.ts";
import { registerObservationProvider, type ObservationProvider } from "../src/public/v1/observation.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function state(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
}

function addAgent(
  proxyState: TeammateState,
  correlationId: string,
  name: string,
  spawnedBy?: string,
): ActiveAgent {
  const now = Date.now();
  const agent: ActiveAgent = {
    agent: "general",
    name,
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    ...(spawnedBy ? { spawnedBy } : {}),
    depth: spawnedBy ? 1 : 0,
    status: "running",
    sleepMs: 0,
  };
  proxyState.activeRuns.set(correlationId, agent);
  proxyState.namedAgents.set(name, correlationId);
  return agent;
}

const pi = new Proxy({
  events: { on: () => () => {}, emit() {} },
  sendMessage() {},
}, {
  get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    return () => {};
  },
}) as unknown as ExtensionAPI;

function fakeProvider(kind: string): ObservationProvider {
  const completed = (id: string) => ({
    target: { kind, id },
    found: true,
    nativeStatus: "completed",
    phase: "settled" as const,
    outcome: "success" as const,
    waitStatus: "completed" as const,
    summary: `${id} complete`,
    detail: [`${id} complete`],
    updatedAt: Date.now(),
  });
  return {
    kind,
    capabilities: { inspect: true, wait: true },
    snapshot: completed,
    wait: async (id) => completed(id),
  };
}

async function proxy(
  tool: string,
  params: Record<string, unknown>,
  allowCrossSession = false,
  proxyState: TeammateState = state(),
  spawnedBy?: string,
): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await handleProxyRequest(
    pi,
    proxyState,
    { tool, requestId: `${tool}-request`, params },
    (message) => { response = message as Record<string, unknown>; },
    spawnedBy,
    [],
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { authorizeCrossSession: () => allowCrossSession },
  );
  assert.ok(response);
  return response;
}

test("child proxy executes mixed observe requests", async () => {
  const disposeTeammate = registerObservationProvider(fakeProvider("teammate"));
  const disposeJob = registerObservationProvider(fakeProvider("bash_bg"));
  const disposeRemote = registerObservationProvider(fakeProvider("remote"));
  try {
    const response = await proxy("observe", {
      action: "status",
      targets: [
        { kind: "teammate", id: "reviewer" },
        { kind: "bash_bg", id: "build" },
        { kind: "remote", id: "remote:run-1234" },
      ],
    }, true);
    const result = response.result as { isError?: boolean; details?: { result?: { observations?: unknown[] } } };
    assert.equal(result.isError, false);
    assert.equal(result.details?.result?.observations?.length, 3);
  } finally {
    disposeTeammate();
    disposeJob();
    disposeRemote();
  }
});

test("ordinary child proxy rejects aliased providers before execution", async () => {
  let calls = 0;
  const kind = "workspace-alias";
  const dispose = registerObservationProvider({
    ...fakeProvider(kind),
    snapshot(id) {
      calls++;
      return fakeProvider(kind).snapshot(id, { detail: "summary", lines: 20 });
    },
    async wait(id, options) {
      calls++;
      return fakeProvider(kind).wait(id, options);
    },
  });
  try {
    const response = await proxy("observe", {
      action: "status",
      targets: [{ kind, id: "peer" }],
    });
    const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /only local teammate and bash_bg targets/);
    assert.equal(calls, 0);
  } finally {
    dispose();
  }
});

test("child proxy cancellation aborts an in-flight observe wait", async () => {
  const kind = "teammate";
  const dispose = registerObservationProvider({
    kind,
    capabilities: { inspect: true, wait: true },
    snapshot: (id) => ({
      target: { kind, id }, found: true, nativeStatus: "running", phase: "active", summary: "running", updatedAt: Date.now(),
    }),
    wait: (id, options) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({
        target: { kind, id },
        found: true,
        nativeStatus: "running",
        phase: "active",
        outcome: "aborted",
        waitStatus: "aborted",
        summary: "aborted",
        updatedAt: Date.now(),
      }), { once: true });
    }),
  });
  const proxyState = state();
  const requestId = "cancel-observe";
  let response: Record<string, unknown> | undefined;
  try {
    const handling = handleProxyRequest(
      pi,
      proxyState,
      {
        tool: "observe",
        requestId,
        params: { action: "wait", targets: [{ kind, id: "slow" }], timeoutMs: 60_000 },
      },
      (message) => { response = message as Record<string, unknown>; },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(proxyState.proxyObservationControllers?.has(requestId), true);
    assert.deepEqual(cancelProxyDispatch(proxyState, requestId), []);
    await handling;
    assert.equal(proxyState.proxyObservationControllers?.has(requestId) ?? false, false);
    const result = response?.result as { isError?: boolean; details?: { result?: { reason?: string } } } | undefined;
    assert.equal(result?.isError, true);
    assert.equal(result?.details?.result?.reason, "aborted");
  } finally {
    dispose();
  }
});

test("proxy wait surfaces reject necessary self and ancestor barriers", async () => {
  let providerCalls = 0;
  const dispose = registerObservationProvider({
    ...fakeProvider("teammate"),
    snapshot(id, options) {
      providerCalls += 1;
      return fakeProvider("teammate").snapshot(id, options);
    },
    async wait(id, options) {
      providerCalls += 1;
      return fakeProvider("teammate").wait(id, options);
    },
  });
  const proxyState = state();
  addAgent(proxyState, "container-id", "container");
  addAgent(proxyState, "caller-id", "caller", "container-id");
  addAgent(proxyState, "sibling-id", "sibling", "container-id");
  addAgent(proxyState, "sibling-2-id", "sibling-2", "container-id");

  try {
    const observeSelf = await proxy("observe", {
      action: "wait",
      targets: [{ kind: "teammate", id: "caller" }],
      timeoutMs: 1_000,
    }, false, proxyState, "caller-id");
    const observeDetails = (observeSelf.result as { details?: Record<string, unknown> }).details;
    assert.equal(observeDetails?.code, "self-wait-deadlock");
    assert.deepEqual(observeDetails?.cyclicIds, ["caller-id"]);
    assert.equal(providerCalls, 0, "rejected barriers must not reach observation providers");

    const legacySelf = await proxy("teammate-wait", {
      name: "caller",
      timeoutMs: 1_000,
    }, false, proxyState, "caller-id");
    assert.equal((legacySelf.result as { details?: { code?: string } }).details?.code, "self-wait-deadlock");
    assert.equal(providerCalls, 0);

    const monitorAncestor = await proxy("teammate-monitor", {
      action: "wait",
      targets: ["container"],
      waitMode: "all",
      timeoutMs: 1_000,
    }, false, proxyState, "caller-id");
    const monitorDetails = (monitorAncestor.result as { details?: Record<string, unknown> }).details;
    assert.equal(monitorDetails?.code, "self-wait-deadlock");
    assert.deepEqual(monitorDetails?.cyclicIds, ["container-id"]);
    assert.equal(providerCalls, 0);

    const statusSelf = await proxy("observe", {
      action: "status",
      targets: [{ kind: "teammate", id: "caller" }],
    }, false, proxyState, "caller-id");
    assert.equal((statusSelf.result as { isError?: boolean }).isError, false);

    const satisfiableAny = await proxy("observe", {
      action: "wait",
      waitMode: "any",
      targets: [
        { kind: "teammate", id: "caller" },
        { kind: "teammate", id: "sibling" },
      ],
      timeoutMs: 1_000,
    }, false, proxyState, "caller-id");
    assert.notEqual(
      (satisfiableAny.result as { details?: { code?: string } }).details?.code,
      "self-wait-deadlock",
    );
    assert.ok(providerCalls > 0, "satisfiable any barriers must reach observation providers");

    const satisfiableCount = await proxy("teammate-monitor", {
      action: "wait",
      targets: ["caller", "sibling", "sibling-2"],
      waitMode: "count",
      waitCount: 2,
      timeoutMs: 1_000,
    }, false, proxyState, "caller-id");
    assert.notEqual(
      (satisfiableCount.result as { details?: { code?: string } }).details?.code,
      "self-wait-deadlock",
    );
  } finally {
    dispose();
  }
});

test("child proxy rejects malformed monitor parameters without throwing", async () => {
  const response = await proxy("teammate-monitor", { action: "wait" });
  const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Invalid teammate-monitor parameters/);
});

test("child proxy teammate-monitor delegates to the observation provider", async () => {
  const dispose = registerObservationProvider(fakeProvider("teammate"));
  try {
    const response = await proxy("teammate-monitor", {
      action: "wait",
      targets: ["reviewer", "tester"],
      waitMode: "all",
      timeoutMs: 1_000,
    });
    const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, false);
    assert.doesNotMatch(result.content?.[0]?.text ?? "", /Unsupported teammate child proxy tool/);
    assert.match(result.content?.[0]?.text ?? "", /reviewer/);
  } finally {
    dispose();
  }
});
