import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { bindClassifierRuntime, unbindClassifierRuntime, configureClassifier, classify, classifySync, resetClassifierForTest, classifierStatus } from "../src/classify/engine.ts";
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
  assert.equal(classifierStatus().callsUsed, 1);
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
        assert.equal(classifierStatus().callsUsed, 0);
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
      assert.equal(classifierStatus().callsUsed, 1);
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
      assert.equal(classifierStatus().callsUsed, 1);
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
