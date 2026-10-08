import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { bindClassifierRuntime, unbindClassifierRuntime, configureClassifier, classify, classifySync, resetClassifierForTest, classifierStatus, probeClassifierRuntime } from "../src/classify/engine.ts";
import { createNativeJevClient, type ClassifierRuntime } from "../src/classify/client.ts";
import { fileValueDomain } from "../src/classify/domains.ts";

const model: ClassifierModel<"typesafe-system-one"> = { type: "classifier", id: "jev-latest", name: "JEV", provider: "typesafe", api: "typesafe-system-one", baseUrl: "https://api.typesafe.ai", input: ["text"], contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function fakeRuntime(classifyFn: ClassifierRuntime["classify"]): ClassifierRuntime {
  return {
    getAvailableOfType: async () => [model],
    getModelOfType: (_type, provider, id) => provider === model.provider && id === model.id ? model : undefined,
    classify: classifyFn,
  };
}
function result(answers: ClassifierResult["answers"]): ClassifierResult {
  return { api: model.api, provider: model.provider, model: model.id, answers, stopReason: "stop", timestamp: 0 };
}

test("native classifier adapts choice, score and noul without losing probabilities", async () => {
  const runtime = fakeRuntime(async (selected, context, options) => {
    assert.equal(selected, model);
    assert.deepEqual(context.state, { text: "decision input" });
    assert.deepEqual(context.questions.yes, { type: "bool", instructions: "is it", criteria: { true: "Yes", false: "No" } });
    assert.ok(options?.signal);
    return result({ pick: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, rank: { type: "score", score: 2, confidence: 0.9 }, yes: { type: "bool", probability: 0.7 } });
  });
  const response = await createNativeJevClient(runtime, { endpoint: "typesafe" }).decide({ state: "decision input", questions: {
    pick: { type: "choice", instructions: "choose", criteria: { a: "A", b: "B" } },
    rank: { type: "score", instructions: "rank", criteria: ["low", "high"] },
    yes: { type: "noul", instructions: "is it" },
  } });
  assert.deepEqual(response.answers.yes, { type: "noul", noul: 0.7 });
  assert.equal(response.model, "typesafe/jev-latest");
  assert.deepEqual(response.answers.pick, { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } });
});

test("native domain pipeline preserves cache, shadow, and call budget; never calls HTTP", async () => {
  resetClassifierForTest();
  let calls = 0;
  const runtime = fakeRuntime(async () => { calls++; return result({ value: { type: "choice", choice: "required", confidence: 0.9, probabilities: { required: 0.9, unknown: 0.1 } } }); });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier({ enabled: true, hostVersion: "0.98.0", apiKey: "legacy-key", fetchFn: async () => { throw new Error("HTTP must not execute"); }, domains: { "file-value": "jev" }, maxCallsPerSession: 1 });
  const input = { path: "src/a.ts" };
  assert.equal((await classify(fileValueDomain, input)).label, "required");
  assert.equal((await classify(fileValueDomain, input)).layer, "jev");
  assert.equal(calls, 1);
  assert.match((await classify(fileValueDomain, { path: "src/b.ts" })).degradedReason ?? "", /budget/);
  const shadow = new Promise<void>((resolve) => configureClassifier({ enabled: true, domains: { "file-value": "shadow" }, onShadow: (record) => { assert.equal(record.jev?.label, "required"); resolve(); } }));
  assert.notEqual(classifySync(fileValueDomain, input).layer, "jev");
  await shadow;
  assert.equal(classifierStatus().callsUsed, 2);
});

test("classifier shutdown clears the current runtime but cannot unbind a newer host", async () => {
  resetClassifierForTest();
  let calls = 0;
  const previous = fakeRuntime(async () => result({}));
  const current = fakeRuntime(async () => { calls++; return result({ value: { type: "choice", choice: "required", confidence: 0.9, probabilities: { required: 0.9, unknown: 0.1 } } }); });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: previous });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: current });
  configureClassifier({ enabled: true, domains: { "file-value": "jev" } });
  unbindClassifierRuntime(previous);
  assert.equal((await classify(fileValueDomain, { path: "a.ts" })).label, "required");
  unbindClassifierRuntime(current);
  assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /runtime unavailable/);
  assert.equal(calls, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delayedRuntime() {
  const started = deferred<void>();
  const reply = deferred<ClassifierResult>();
  const runtime = fakeRuntime(async () => { started.resolve(); return reply.promise; });
  return { runtime, started, reply };
}

const nativeConfig = { enabled: true, domains: { "file-value": "jev" as const } };
const choiceResult = (choice: string) => result({ value: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } });

for (const operation of ["configure", "bind", "unbind", "reset"] as const) {
  for (const oldFirst of [true, false]) {
    test(`${operation} fences in-flight native authority/cache (old finishes ${oldFirst ? "first" : "last"})`, async () => {
      resetClassifierForTest();
      const old = delayedRuntime();
      bindClassifierRuntime({ hostVersion: "0.99.0", runtime: old.runtime });
      configureClassifier(nativeConfig);
      const obsolete = classify(fileValueDomain, { path: "same.ts" });
      await old.started.promise;
      const current = delayedRuntime();
      if (operation === "configure") {
        // Same client identity and transport: configuration alone must fence it.
        old.runtime.classify = current.runtime.classify;
        configureClassifier(nativeConfig);
      } else if (operation === "bind") {
        bindClassifierRuntime({ hostVersion: "0.99.0", runtime: current.runtime });
      } else {
        if (operation === "unbind") unbindClassifierRuntime(old.runtime);
        else resetClassifierForTest();
        assert.equal(classifierStatus().cacheSize, 0);
        assert.equal(classifierStatus().callsUsed, operation === "reset" ? 0 : 1);
        if (oldFirst) {
          old.reply.resolve(choiceResult("required"));
          assert.equal((await obsolete).layer, "degraded");
          assert.equal(classifierStatus().cacheSize, 0);
        }
        bindClassifierRuntime({ hostVersion: "0.99.0", runtime: current.runtime });
        configureClassifier(nativeConfig);
      }
      const fresh = classify(fileValueDomain, { path: "same.ts" });
      await current.started.promise;
      if (oldFirst) {
        old.reply.resolve(choiceResult("required"));
        assert.equal((await obsolete).layer, "degraded");
        const joined = classify(fileValueDomain, { path: "same.ts" });
        current.reply.resolve(choiceResult("skip"));
        assert.equal((await joined).label, "skip");
      } else {
        current.reply.resolve(choiceResult("skip"));
        assert.equal((await fresh).label, "skip");
        old.reply.resolve(choiceResult("required"));
      }
      assert.match((await obsolete).degradedReason ?? "", /generation changed/);
      assert.equal((await fresh).label, "skip");
      assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "skip");
      assert.equal(classifierStatus().cacheSize, 1);
      assert.equal(classifierStatus().callsUsed, operation === "reset" ? 1 : 2);
    });
  }
}

test("host classify reconfiguration cannot insert an old reservation into the new generation", async () => {
  resetClassifierForTest();
  let fresh: ReturnType<typeof classify> | undefined;
  let calls = 0;
  const current = fakeRuntime(async () => { calls++; return choiceResult("skip"); });
  const old = fakeRuntime(async () => {
    bindClassifierRuntime({ hostVersion: "0.99.0", runtime: current });
    fresh = classify(fileValueDomain, { path: "same.ts" });
    return choiceResult("required");
  });
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: old });
  configureClassifier(nativeConfig);
  assert.equal((await classify(fileValueDomain, { path: "same.ts" })).layer, "degraded");
  assert.ok(fresh);
  assert.equal((await fresh).label, "skip");
  assert.equal(calls, 1);
  assert.equal(classifierStatus().cacheSize, 1);
});

test("native model resolution is fenced before invoking classify or spending new budget", async () => {
  resetClassifierForTest();
  const available = deferred<readonly typeof model[]>();
  const resolving = deferred<void>();
  let oldCalls = 0;
  const old = fakeRuntime(async () => { oldCalls++; return choiceResult("required"); });
  old.getAvailableOfType = async () => { resolving.resolve(); return available.promise; };
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: old });
  configureClassifier(nativeConfig);
  const obsolete = classify(fileValueDomain, { path: "same.ts" });
  await resolving.promise;
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: fakeRuntime(async () => choiceResult("skip")) });
  assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "skip");
  available.resolve([model]);
  assert.match((await obsolete).degradedReason ?? "", /generation changed/);
  assert.equal(oldCalls, 0);
  assert.equal(classifierStatus().callsUsed, 1);
});

test("native cache keys follow effective provider, model and endpoint within one generation", async () => {
  resetClassifierForTest();
  let selected = model;
  let calls = 0;
  const runtime = fakeRuntime(async (actual) => {
    assert.equal(actual, selected);
    calls++;
    return { ...choiceResult(calls === 1 ? "required" : "skip"), provider: actual.provider, model: actual.id };
  });
  runtime.getAvailableOfType = async () => [selected];
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier(nativeConfig);
  assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "required");
  assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "required");
  assert.equal(calls, 1);
  for (const change of [{ provider: "other" }, { id: "other-model" }, { baseUrl: "https://other.invalid" }]) {
    selected = { ...selected, ...change };
    assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "skip");
  }
  assert.equal(calls, 4);
  selected = model;
  assert.equal((await classify(fileValueDomain, { path: "same.ts" })).label, "required");
  assert.equal(calls, 4);
});

for (const operation of ["bind", "unbind", "reset"] as const) {
  for (const finish of ["success", "failure"] as const) {
    test(`${operation} suppresses obsolete native shadow ${finish} and preserves current sink`, async () => {
      resetClassifierForTest();
      const old = delayedRuntime();
      let oldRecords = 0;
      let newRecords = 0;
      bindClassifierRuntime({ hostVersion: "0.99.0", runtime: old.runtime });
      configureClassifier({ enabled: true, domains: { "file-value": "shadow" }, onShadow: () => oldRecords++ });
      classifySync(fileValueDomain, { path: "same.ts" });
      await old.started.promise;
      if (operation === "unbind") unbindClassifierRuntime(old.runtime);
      if (operation === "reset") resetClassifierForTest();
      bindClassifierRuntime({ hostVersion: "0.99.0", runtime: fakeRuntime(async () => choiceResult("skip")) });
      const published = deferred<void>();
      configureClassifier({ enabled: true, domains: { "file-value": "shadow" }, onShadow: (record) => {
        assert.equal(record.jev?.label, "skip");
        newRecords++;
        published.resolve();
      } });
      classifySync(fileValueDomain, { path: "same.ts" });
      await published.promise;
      if (finish === "success") old.reply.resolve(choiceResult("required"));
      else old.reply.reject(new Error("old classify failed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(oldRecords, 0);
      assert.equal(newRecords, 1);
      assert.equal(classifierStatus().cacheSize, 1);
      assert.equal(classifierStatus().callsUsed, operation === "reset" ? 1 : 2);
    });
  }
}

test("native choice validation rejects prototype labels", async () => {
  for (const choice of ["constructor", "__proto__"]) {
    const runtime = fakeRuntime(async () => choiceResult(choice));
    await assert.rejects(createNativeJevClient(runtime, { endpoint: "typesafe" }).decide({
      state: "input", questions: fileValueDomain.questions(),
    }), /requested question schema/);
  }
});

test("native and unknown hosts fail explicitly rather than using HTTP; auth errors remain visible", async () => {
  for (const hostVersion of ["0.99.0", "unknown"]) {
    resetClassifierForTest();
    configureClassifier({ enabled: true, hostVersion, apiKey: "key", domains: { "file-value": "jev" }, fetchFn: async () => { throw new Error("unexpected HTTP fallback"); } });
    assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /runtime unavailable/);
  }
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: fakeRuntime(async () => ({ ...result({}), stopReason: "error", errorMessage: "typesafe authentication unavailable" })) });
  configureClassifier({ enabled: true, domains: { "file-value": "jev" } });
  assert.match((await classify(fileValueDomain, { path: "a.ts" })).degradedReason ?? "", /authentication unavailable/);
});

const routerModel = { ...model, provider: "openrouter", id: "typesafe/jev-1.13", api: "openrouter-decisions" as const, baseUrl: "https://openrouter.ai" };

test("auto resolves only authenticated classifiers with stable provider preference; explicit endpoint never drifts", async () => {
  resetClassifierForTest();
  let available: readonly (typeof model | typeof routerModel)[] = [routerModel];
  let selected: unknown;
  const runtime = fakeRuntime(async (actual) => { selected = actual; return { ...choiceResult("required"), provider: actual.provider, model: actual.id }; });
  runtime.getAvailableOfType = async () => available;
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier(nativeConfig);
  assert.equal(classifierStatus().runtimeStatus, "unknown");
  assert.equal(classifierStatus().apiKeyPresent, false);
  assert.deepEqual(await probeClassifierRuntime(), { status: "available", available: true, model: "openrouter/typesafe/jev-1.13" });
  assert.equal(classifierStatus().callsUsed, 0);
  assert.equal((await classify(fileValueDomain, { path: "router.ts" })).layer, "jev");
  assert.equal(selected, routerModel);
  available = [routerModel, { ...model, provider: "other" }, model];
  assert.equal((await probeClassifierRuntime()).model, "typesafe/jev-latest");
  configureClassifier({ ...nativeConfig, endpoint: "openrouter" });
  assert.equal((await probeClassifierRuntime()).model, "openrouter/typesafe/jev-1.13");
  configureClassifier({ ...nativeConfig, endpoint: "typesafe" });
  available = [routerModel];
  assert.equal((await probeClassifierRuntime()).status, "unavailable");
  assert.equal((await classify(fileValueDomain, { path: "no-drift.ts" })).layer, "degraded");
  assert.equal(classifierStatus().callsUsed, 1);
});

test("pinned native registry models must also be authenticated; conflicting endpoints and auth errors fail visibly", async () => {
  resetClassifierForTest();
  let calls = 0;
  const runtime = fakeRuntime(async () => { calls++; return choiceResult("required"); });
  runtime.getAvailableOfType = async () => [];
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier({ ...nativeConfig, model: "typesafe/jev-latest" });
  assert.match((await probeClassifierRuntime()).reason ?? "", /authenticated/);
  assert.match((await classify(fileValueDomain, { path: "pin.ts" })).degradedReason ?? "", /authenticated/);
  configureClassifier({ ...nativeConfig, endpoint: "openrouter", model: "typesafe/jev-latest" });
  assert.match((await probeClassifierRuntime()).reason ?? "", /conflicts/);
  runtime.getAvailableOfType = async () => { throw new Error("classifier authentication unavailable"); };
  configureClassifier(nativeConfig);
  assert.match((await probeClassifierRuntime()).reason ?? "", /authentication unavailable/);
  assert.equal(classifierStatus().runtimeStatus, "unavailable");
  runtime.getAvailableOfType = async () => [model];
  assert.equal((await probeClassifierRuntime()).status, "available");
  assert.equal(calls, 0);
  assert.equal(classifierStatus().callsUsed, 0);
});

for (const operation of ["configure", "rebind", "session", "unbind", "reset", "refresh"] as const) {
  test(operation + " fences late readiness without quota or stale status writes", async () => {
    resetClassifierForTest();
    const available = deferred<readonly typeof model[]>();
    const entered = deferred<void>();
    const runtime = fakeRuntime(async () => choiceResult("required"));
    runtime.getAvailableOfType = async () => { entered.resolve(); return available.promise; };
    bindClassifierRuntime({ hostVersion: "0.99.0", runtime, sessionId: "old", cwd: "/project" });
    configureClassifier(nativeConfig);
    const old = probeClassifierRuntime();
    await entered.promise;
    runtime.getAvailableOfType = async () => [model];
    if (operation === "configure") configureClassifier({ enabled: false });
    else if (operation === "unbind") unbindClassifierRuntime(runtime);
    else if (operation === "reset") resetClassifierForTest();
    else if (operation !== "refresh") bindClassifierRuntime({ hostVersion: "0.99.0", runtime, sessionId: operation === "session" ? "new" : "old", cwd: "/project" });
    if (["rebind", "session", "refresh"].includes(operation)) assert.equal((await probeClassifierRuntime()).status, "available");
    const status = classifierStatus();
    available.resolve([]);
    assert.equal((await old).status, operation === "refresh" ? "unavailable" : "unknown");
    assert.deepEqual(classifierStatus(), status);
    assert.equal(status.callsUsed, 0);
  });
}

test("cancelled native readiness is bounded and never replaces status or consumes quota", async () => {
  resetClassifierForTest();
  const runtime = fakeRuntime(async () => choiceResult("required"));
  runtime.getAvailableOfType = async () => new Promise(() => {});
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier(nativeConfig);
  const controller = new AbortController();
  const probe = probeClassifierRuntime(controller.signal);
  controller.abort(new Error("cancelled probe"));
  assert.match((await probe).reason ?? "", /cancelled probe/);
  assert.equal(classifierStatus().runtimeStatus, "unknown");
  assert.equal(classifierStatus().callsUsed, 0);
});

test("quota survives configure, on/off, rebind and unbind; identities isolate and restore, lower/raise gives only delta", async () => {
  resetClassifierForTest();
  let calls = 0;
  const runtime = fakeRuntime(async () => { calls++; return choiceResult("required"); });
  const bind = (sessionId = "one", cwd = "/project") => bindClassifierRuntime({ hostVersion: "0.99.0", runtime, sessionId, cwd });
  bind();
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 1 });
  assert.equal((await classify(fileValueDomain, { path: "first.ts" })).layer, "jev");
  assert.equal((await classify(fileValueDomain, { path: "first.ts" })).layer, "jev");
  configureClassifier({ ...nativeConfig, enabled: false });
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 1, model: "jev-latest", cacheTtlMs: 1 });
  bind();
  unbindClassifierRuntime(runtime);
  bind();
  assert.match((await classify(fileValueDomain, { path: "next.ts" })).degradedReason ?? "", /budget/);
  for (const [session, cwd] of [["two", "/project"], ["one", "/other"]]) {
    bind(session, cwd);
    assert.equal(classifierStatus().callsUsed, 0);
    assert.equal((await classify(fileValueDomain, { path: "other.ts" })).layer, "jev");
  }
  bind();
  assert.equal(classifierStatus().callsUsed, 1);
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 0 });
  assert.match((await classify(fileValueDomain, { path: "lower.ts" })).degradedReason ?? "", /budget/);
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 2 });
  assert.equal((await classify(fileValueDomain, { path: "delta.ts" })).layer, "jev");
  assert.match((await classify(fileValueDomain, { path: "excess.ts" })).degradedReason ?? "", /budget/);
  assert.equal(calls, 4);
});

test("concurrent native calls reserve quota, identical pending calls join, failures never refund", async () => {
  resetClassifierForTest();
  const lane = delayedRuntime();
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: lane.runtime });
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 1 });
  const first = classify(fileValueDomain, { path: "one.ts" });
  await lane.started.promise;
  const same = classify(fileValueDomain, { path: "one.ts" });
  assert.match((await classify(fileValueDomain, { path: "two.ts" })).degradedReason ?? "", /budget/);
  lane.reply.reject(new Error("cancelled model request"));
  assert.match((await first).degradedReason ?? "", /cancelled/);
  assert.match((await same).degradedReason ?? "", /cancelled/);
  configureClassifier({ ...nativeConfig, maxCallsPerSession: 1 });
  assert.match((await classify(fileValueDomain, { path: "three.ts" })).degradedReason ?? "", /budget/);
  assert.equal(classifierStatus().callsUsed, 1);
});

test("auto supports other authenticated providers and fully qualified openrouter pins", async () => {
  resetClassifierForTest();
  const other = { ...model, provider: "other", id: "classifier" };
  const runtime = fakeRuntime(async (selected) => ({ ...choiceResult("required"), provider: selected.provider, model: selected.id }));
  runtime.getAvailableOfType = async () => [other];
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
  configureClassifier(nativeConfig);
  assert.equal((await probeClassifierRuntime()).model, "other/classifier");
  assert.equal((await classify(fileValueDomain, { path: "other.ts" })).model, "other/classifier");
  runtime.getAvailableOfType = async () => [model, routerModel];
  configureClassifier({ ...nativeConfig, model: "openrouter/typesafe/jev-1.13" });
  assert.equal((await probeClassifierRuntime()).model, "openrouter/typesafe/jev-1.13");
  assert.equal((await classify(fileValueDomain, { path: "pin.ts" })).model, "openrouter/typesafe/jev-1.13");
});

test("legacy quota rejection and non-verifying probes cannot supersede in-flight readiness evidence", async () => {
  for (const fail of [false, true]) {
    for (const probeFirst of [false, true]) {
      resetClassifierForTest();
      const entered = deferred<void>();
      const reply = deferred<Response>();
      let calls = 0;
      configureClassifier({ ...nativeConfig, hostVersion: "0.98.0", apiKey: "mock-only", maxCallsPerSession: 1,
        fetchFn: async () => { calls++; entered.resolve(); return reply.promise; } });
      try {
        const first = classify(fileValueDomain, { path: "accepted.ts" });
        await entered.promise;
        if (probeFirst) assert.equal((await probeClassifierRuntime()).status, "unknown");
        assert.match((await classify(fileValueDomain, { path: "rejected.ts" })).degradedReason ?? "", /budget/);
        if (!probeFirst) assert.equal((await probeClassifierRuntime()).status, "unknown");
        if (fail) reply.reject(new Error("mock auth failed"));
        else reply.resolve(new Response(JSON.stringify({ model: "verified-model", answers: {
          value: { type: "choice", choice: "required", confidence: .9 },
        } })));
        assert.equal((await first).layer, fail ? "degraded" : "jev");
        assert.equal(classifierStatus().runtimeStatus, fail ? "unavailable" : "available");
        assert.equal(classifierStatus().callsUsed, 1);
        assert.equal(calls, 1);
      } finally { resetClassifierForTest(); }
    }
  }
});

test("joined legacy success or failure owns readiness; probes preserve execution evidence", async () => {
  for (const fail of [false, true]) {
    resetClassifierForTest();
    const entered = deferred<void>();
    const reply = deferred<Response>();
    let calls = 0;
    configureClassifier({ ...nativeConfig, hostVersion: "0.98.0", apiKey: "mock-only",
      fetchFn: async () => { calls++; entered.resolve(); return reply.promise; } });
    try {
      const first = classify(fileValueDomain, { path: "joined.ts" });
      await entered.promise;
      const joined = classify(fileValueDomain, { path: "joined.ts" });
      await new Promise(resolve => setImmediate(resolve));
      if (fail) reply.reject(new Error("mock auth failed"));
      else reply.resolve(new Response(JSON.stringify({ model: "verified-model", answers: {
        value: { type: "choice", choice: "required", confidence: .9 },
      } })));
      assert.equal((await first).layer, fail ? "degraded" : "jev");
      assert.equal((await joined).layer, fail ? "degraded" : "jev");
      assert.equal(classifierStatus().runtimeStatus, fail ? "unavailable" : "available");
      assert.equal(classifierStatus().callsUsed, 1);
      assert.equal(calls, 1);
      const executed = classifierStatus();
      const probed = await probeClassifierRuntime();
      assert.equal(probed.status, fail ? "unavailable" : "available");
      if (fail) assert.match(probed.reason ?? "", /mock auth failed/);
      assert.deepEqual(classifierStatus(), executed, "non-verifying probe must preserve failure reason, model and quota");
      if (!fail) {
        assert.equal(classifierStatus().effectiveModel, "verified-model");
        assert.equal((await classify(fileValueDomain, { path: "joined.ts" })).layer, "jev");
        assert.equal(classifierStatus().runtimeStatus, "available");
        assert.equal(calls, 1);
      }
    } finally { resetClassifierForTest(); }
  }
});

test("readiness distinguishes disabled, unknown host, unverified legacy credentials and successful transport", async () => {
  resetClassifierForTest();
  assert.deepEqual(await probeClassifierRuntime(), { status: "disabled", available: false });
  let calls = 0;
  const fetchFn = (async () => { calls++; return new Response(JSON.stringify({ answers: { value: { type: "choice", choice: "required", confidence: .9 } } })); }) as typeof fetch;
  configureClassifier({ ...nativeConfig, hostVersion: "unknown", apiKey: "fixture", fetchFn });
  assert.equal((await probeClassifierRuntime()).status, "unavailable");
  assert.equal((await classify(fileValueDomain, { path: "closed.ts" })).layer, "degraded");
  assert.equal(calls, 0);
  const oldTypesafe = process.env.TYPESAFE_API_KEY;
  const oldRouter = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    process.env.OPENROUTER_API_KEY = "fixture-key";
    configureClassifier({ ...nativeConfig, hostVersion: "0.98.0", fetchFn });
    assert.equal(classifierStatus().apiKeyPresent, true);
    assert.equal(classifierStatus().runtimeStatus, "unknown");
    assert.equal((await probeClassifierRuntime()).available, false);
    assert.equal(calls, 0);
    assert.equal((await classify(fileValueDomain, { path: "legacy.ts" })).layer, "jev");
    assert.equal(classifierStatus().runtimeStatus, "available");
    assert.equal(classifierStatus().effectiveModel, "typesafe/jev-1.13");
    assert.equal(calls, 1);
  } finally {
    if (oldTypesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldTypesafe;
    if (oldRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouter;
  }
});
