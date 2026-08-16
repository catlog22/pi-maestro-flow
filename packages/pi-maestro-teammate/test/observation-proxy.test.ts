import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cancelProxyDispatch, handleProxyRequest } from "../src/extension/index.ts";
import { registerObservationProvider, type ObservationProvider } from "../src/public/v1/observation.ts";
import type { TeammateState } from "../src/shared/types.ts";

function state(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
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
): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await handleProxyRequest(
    pi,
    state(),
    { tool, requestId: `${tool}-request`, params },
    (message) => { response = message as Record<string, unknown>; },
    undefined,
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

test("child proxy rejects the reserved Monitor evaluator name", async () => {
  const response = await proxy("teammate", {
    tasks: [{ agent: "general", name: "monitor-session", prompt: "claim authority" }],
  });
  const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /reserved for the host-owned Monitor evaluator/);
});

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
