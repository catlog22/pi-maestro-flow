import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DecisionPolicySchema, defaultDecisionPolicy, loadDecisionPolicy, saveDecisionPolicy } from "../src/decision-policy/config.ts";
import { createDecisionPolicyService, hostAskGrantFingerprint, PLAN_AUTO_ASK_RULE_ID, type HostAskPolicyGrant, type PolicyServiceDependencies } from "../src/decision-policy/service.ts";
import { POLICY_CLASSIFY_NAMES, policyClassifyDomain } from "../src/decision-policy/domains.ts";
import { bindClassifierRuntime, classifierStatus, configureClassifier, resetClassifierForTest } from "pi-maestro-teammate/v1/classify";

function policy(overrides: Record<string, unknown> = {}) {
  return DecisionPolicySchema.parse({ rules: [{ id: "local", domain: "ask", instruction: "Recommend compatible local implementation choices; preferences and approvals stay external." }, { id: "capture", domain: "evolve-capture", instruction: "Capture only grounded reusable failure lessons." }, { id: "review", domain: "evolve-review", instruction: "Recommend only; never approve promotion." }], ask: { mode: "enforce" }, selfEvolve: { mode: "enforce" }, backend: "llm", ...overrides });
}
function context(controller?: AbortController) { return { cwd: "/workspace", signal: controller?.signal, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext; }
const verdict = { owner: "internal", candidateType: "unknown", worthCapturing: false, confidence: 0.95, matchedRuleIds: ["local"], rationale: "Matches local rule." };
const advice = { recommendation: "Reuse the existing helper.", rationale: "Smallest compatible change.", matchedRuleIds: ["local"], assumptions: [], needsExternalDecision: false };
function setup(overrides: Partial<PolicyServiceDependencies> = {}, initial = policy()) {
  let current = initial;
  const calls: string[] = [];
  const service = createDecisionPolicyService({ loadPolicy: async () => current, loadSpecs: async () => "Complete governing spec", classifier: async () => { calls.push("classifier"); throw new Error("No classifier model"); }, structured: async (request) => { calls.push(request.kind); assert.match(request.prompt, /confirmedPolicy/); return { value: request.kind === "classification" ? verdict : advice, model: "test/model" }; }, ...overrides });
  return { service, calls, change: (next: typeof current) => { current = next; } };
}

test("policy defaults are off and strict rules/config reject malformed authority", () => {
  assert.equal(defaultDecisionPolicy().ask.mode, "off");
  assert.throws(() => DecisionPolicySchema.parse({ approved: true }));
  assert.throws(() => policy({ rules: [], ask: { mode: "enforce" } }));
  assert.throws(() => policy({ rules: [{ id: "same", domain: "ask", instruction: "A" }, { id: "same", domain: "ask", instruction: "B" }] }));
});
test("policy CAS atomically saves and rejects stale confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-policy-"));
  try {
    assert.equal(await loadDecisionPolicy(dir), undefined);
    const saved = await saveDecisionPolicy(dir, policy(), 0);
    assert.equal(saved.revision, 1);
    assert.deepEqual(await loadDecisionPolicy(dir), saved);
    await assert.rejects(saveDecisionPolicy(dir, policy(), 0), /revision conflict/);
    const results = await Promise.allSettled([saveDecisionPolicy(dir, policy(), 1), saveDecisionPolicy(dir, policy(), 1)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await loadDecisionPolicy(dir))?.revision, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("LLM classification then advice are two validated stages", async () => {
  const { service, calls } = setup();
  const result = await service.evaluate("ask", "Which helper?", context());
  assert.equal(result.backend, "llm"); assert.equal(result.owner, "internal");
  assert.equal(result.advice?.recommendation, advice.recommendation);
  assert.deepEqual(calls, ["classification", "advice"]);
});
test("auto uses one fallback LLM when no classifier and records reason", async () => {
  const { service, calls } = setup({}, policy({ backend: "auto" }));
  const result = await service.evaluate("ask", "Which helper?", context());
  assert.equal(result.backend, "llm"); assert.match(result.fallbackReason ?? "", /No classifier/);
  assert.deepEqual(calls, ["classifier", "classification", "advice"]);
});
test("auto skips unavailable host classifier without spending the fallback LLM budget", async () => {
  configureClassifier({ enabled: false });
  const current = policy({ backend: "auto", classification: { maxCallsPerSession: 1 } });
  let calls = 0;
  const service = createDecisionPolicyService({
    loadPolicy: async () => current,
    loadSpecs: async () => "",
    structured: async () => { calls++; return { value: verdict }; },
  });
  const result = await service.evaluate("ask", "choice", context(), { advice: false });
  assert.equal(result.backend, "llm");
  assert.equal(result.owner, "internal");
  assert.match(result.fallbackReason ?? "", /Classifier disabled/);
  assert.equal(calls, 1);
  assert.match((await service.evaluate("ask", "another", context(), { advice: false })).degradedReason ?? "", /budget exhausted/);
  assert.equal(calls, 1);
});
test("native readiness without an authenticated model preserves the single fallback call", async () => {
  for (const failReadiness of [false, true]) {
    resetClassifierForTest();
    let nativeCalls = 0;
    let llmCalls = 0;
    const runtime = {
      getAvailableOfType: async () => { if (failReadiness) throw new Error("classifier auth unavailable"); return []; },
      getModelOfType: () => undefined,
      classify: async () => { nativeCalls++; throw new Error("must not classify without a model"); },
    };
    bindClassifierRuntime({ hostVersion: "0.99.0", runtime });
    configureClassifier({ enabled: true, domains: { [POLICY_CLASSIFY_NAMES.ask]: "jev" } });
    const current = policy({ backend: "auto", classification: { maxCallsPerSession: 1 } });
    const service = createDecisionPolicyService({ loadPolicy: async () => current, loadSpecs: async () => "", structured: async () => { llmCalls++; return { value: verdict }; } });
    const ctx = { ...context(), modelRegistry: runtime } as unknown as ExtensionContext;
    try {
      const result = await service.evaluate("ask", "choice", ctx, { advice: false });
      assert.equal(result.backend, "llm");
      assert.equal(result.owner, "internal");
      assert.match(result.fallbackReason ?? "", /classifier.*unavailable/);
      assert.equal(llmCalls, 1);
      assert.equal(nativeCalls, 0);
      assert.equal(classifierStatus().callsUsed, 0);
    } finally { resetClassifierForTest(); }
  }
});
test("cancelled readiness never starts a classifier or LLM fallback", async () => {
  const controller = new AbortController();
  const { service, calls } = setup({ classifierUnavailableReason: async () => { controller.abort(); throw new Error("cancelled"); } }, policy({ backend: "auto" }));
  const result = await service.evaluate("ask", "choice", context(controller));
  assert.equal(result.owner, "uncertain");
  assert.deepEqual(calls, []);
});
test("session and policy changes during readiness never start stale classifier or fallback calls", async () => {
  for (const invalidator of ["policy", "session"] as const) {
    for (const rejectReadiness of [false, true]) {
      let finish!: () => void;
      let started!: () => void;
      const submitted = new Promise<void>((resolve) => { started = resolve; });
      const lane = setup({ classifierUnavailableReason: async () => {
        started();
        await new Promise<void>((resolve) => { finish = resolve; });
        if (rejectReadiness) throw new Error("classifier readiness failed");
        return undefined;
      } }, policy({ backend: "auto" }));
      const ctx = context();
      let session = "session";
      ctx.sessionManager.getSessionId = () => session;
      const pending = lane.service.evaluate("ask", "old input", ctx);
      await submitted;
      if (invalidator === "policy") lane.change(policy({ backend: "auto", revision: 1 }));
      else session = "new-session";
      finish();
      const result = await pending;
      assert.equal(result.owner, "uncertain");
      assert.match(result.degradedReason ?? "", /changed/);
      assert.deepEqual(lane.calls, []);
    }
  }
});
test("session changes during policy revalidation fence both sides of its await", async () => {
  let finish!: () => void;
  let started!: () => void;
  const submitted = new Promise<void>((resolve) => { started = resolve; });
  const current = policy({ backend: "auto" });
  let loads = 0;
  const lane = setup({ loadPolicy: async () => {
    if (++loads === 3) { started(); await new Promise<void>((resolve) => { finish = resolve; }); }
    return current;
  } }, current);
  const ctx = context();
  let session = "session";
  ctx.sessionManager.getSessionId = () => session;
  const pending = lane.service.evaluate("ask", "old input", ctx);
  await submitted;
  session = "new-session";
  finish();
  assert.match((await pending).degradedReason ?? "", /session changed/);
  assert.deepEqual(lane.calls, []);
});
test("unavailable classifier fallback reserves one call under concurrent evaluations", async () => {
  const { service, calls } = setup({ classifierUnavailableReason: () => "Classifier runtime unavailable" }, policy({ backend: "auto", classification: { maxCallsPerSession: 1 } }));
  const results = await Promise.all(["one", "two"].map((text) => service.evaluate("ask", text, context(), { advice: false })));
  assert.equal(results.filter((result) => result.owner === "internal").length, 1);
  assert.deepEqual(calls, ["classification"]);
});
test("classifier-only unavailable and real backend failures preserve call-budget bounds", async () => {
  const forced = setup({ classifierUnavailableReason: () => "Classifier runtime unavailable" }, policy({ backend: "classifier" }));
  assert.match((await forced.service.evaluate("ask", "choice", context())).degradedReason ?? "", /runtime unavailable/);
  assert.deepEqual(forced.calls, []);
  const attempted = setup({}, policy({ backend: "auto", classification: { maxCallsPerSession: 1 } }));
  assert.match((await attempted.service.evaluate("ask", "choice", context())).degradedReason ?? "", /budget exhausted/);
  assert.deepEqual(attempted.calls, ["classifier"]);
});
test("auto validates native classification before selecting its single LLM fallback", async () => {
  const { service, calls } = setup({ classifier: async () => ({ value: { ...verdict, matchedRuleIds: ["fabricated"] } }) }, policy({ backend: "auto" }));
  const result = await service.evaluate("ask", "choice", context());
  assert.equal(result.backend, "llm"); assert.equal(result.owner, "internal"); assert.match(result.fallbackReason ?? "", /unknown rule/);
  assert.deepEqual(calls, ["classification", "advice"]);
});

test("contradictory worth-capturing unknown type cannot become an authoritative capture", async () => {
  const { service } = setup({ structured: async () => ({ value: { ...verdict, owner: "uncertain", worthCapturing: true, matchedRuleIds: ["capture"] } }) });
  const result = await service.evaluate("evolve-capture", "lesson", context());
  assert.equal(result.owner, "uncertain"); assert.equal(result.worthCapturing, undefined); assert.match(result.degradedReason ?? "", /knowledge type/);
});

test("auto prefers classifier, forced classifier never silently swaps model", async () => {
  const direct = setup({ classifier: async () => ({ value: verdict, model: "typesafe/jev" }) }, policy({ backend: "auto" }));
  assert.equal((await direct.service.evaluate("ask", "choice", context())).backend, "classifier");
  assert.deepEqual(direct.calls, ["advice"]);
  const forced = setup({}, policy({ backend: "classifier" }));
  assert.equal((await forced.service.evaluate("ask", "choice", context())).owner, "uncertain");
  assert.deepEqual(forced.calls, ["classifier"]);
});
test("invalid structured outputs and fabricated IDs fail closed", async () => {
  for (const value of ["internal", { ...verdict, approved: true }, { ...verdict, matchedRuleIds: ["invented"] }, { ...verdict, matchedRuleIds: [] }, { ...verdict, confidence: 2 }]) {
    const { service } = setup({ structured: async () => ({ value }) });
    const result = await service.evaluate("ask", "choice", context());
    assert.equal(result.owner, "uncertain"); assert.ok(result.degradedReason);
  }
});
test("external, low confidence, shadow and disabled never generate advice", async () => {
  for (const overrides of [{ owner: "external" }, { confidence: 0.6 }]) {
    const calls: string[] = [];
    const { service } = setup({ structured: async (request) => { calls.push(request.kind); return { value: { ...verdict, ...overrides } }; } });
    const result = await service.evaluate("ask", "choice", context());
    assert.notEqual(result.owner, "internal"); assert.deepEqual(calls, ["classification"]);
  }
  for (const mode of ["off", "shadow"] as const) {
    const { service, calls } = setup({}, policy({ ask: { mode } }));
    const result = await service.evaluate("ask", "choice", context());
    assert.equal(result.mode, mode); assert.deepEqual(calls, mode === "off" ? [] : ["classification"]);
  }
});
test("advice failures/external request cannot masquerade as internal answer", async () => {
  for (const output of [{ ...advice, matchedRuleIds: ["invented"] }, { ...advice, needsExternalDecision: true }]) {
    const { service } = setup({ structured: async (request) => ({ value: request.kind === "classification" ? verdict : output }) });
    assert.notEqual((await service.evaluate("ask", "choice", context())).owner, "internal");
  }
});
test("classification cache and budget are per session; concurrent reservations bounded", async () => {
  const { service, calls } = setup({}, policy({ classification: { maxCallsPerSession: 1 } }));
  assert.equal((await service.evaluate("ask", "same", context(), { advice: false })).owner, "internal");
  assert.equal((await service.evaluate("ask", "same", context(), { advice: false })).owner, "internal");
  assert.match((await service.evaluate("ask", "different", context())).degradedReason ?? "", /budget/);
  assert.deepEqual(calls, ["classification"]);
  service.invalidateSession("session");
  assert.equal((await service.evaluate("ask", "different", context(), { advice: false })).owner, "internal");
  const race = setup({}, policy({ classification: { maxCallsPerSession: 1 } }));
  const results = await Promise.all([race.service.evaluate("ask", "one", context(), { advice: false }), race.service.evaluate("ask", "two", context(), { advice: false })]);
  assert.equal(results.filter((result) => result.owner === "internal").length, 1);
});
test("policy changes and session invalidation discard late classification", async () => {
  for (const invalidator of ["policy", "session"] as const) {
    let finish!: (value: { value: unknown }) => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const lane = setup({ structured: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
    const pending = lane.service.evaluate("ask", "choice", context());
    await submitted;
    if (invalidator === "policy") lane.change(policy({ revision: 1 })); else lane.service.invalidateSession("session");
    finish({ value: verdict });
    const result = await pending;
    assert.equal(result.owner, "uncertain"); assert.match(result.degradedReason ?? "", /changed/);
  }
});
test("session invalidation during spec load also fences the request", async () => {
  let finish!: (text: string) => void;
  let started!: () => void;
  const submitted = new Promise<void>((resolve) => { started = resolve; });
  const { service, calls } = setup({ loadSpecs: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
  const pending = service.evaluate("ask", "choice", context()); await submitted;
  service.invalidateSession("session"); finish("spec");
  assert.equal((await pending).owner, "uncertain"); assert.deepEqual(calls, []);
});
test("cancelled classifier never starts LLM fallback", async () => {
  const controller = new AbortController();
  const { service, calls } = setup({ classifier: async () => { controller.abort(); throw new Error("cancelled"); } }, policy({ backend: "auto" }));
  assert.equal((await service.evaluate("ask", "choice", context(controller))).owner, "uncertain");
  assert.deepEqual(calls, []);
});
test("timeouts are bounded even when backend ignores cancellation", async () => {
  const { service } = setup({ structured: async () => new Promise(() => {}) }, policy({ classification: { timeoutMs: 100 } }));
  // Keep the event loop alive; AbortSignal.timeout deliberately uses an unref timer.
  const hold = setInterval(() => {}, 200);
  try { assert.equal((await service.evaluate("ask", "choice", context())).owner, "uncertain"); }
  finally { clearInterval(hold); }
});
test("capture uses worth flag with correct rule and no advice; classifier has no terminal keyword rules", async () => {
  const { service, calls } = setup({ structured: async (request) => { calls.push(request.kind); return { value: { ...verdict, owner: "uncertain", candidateType: "knowhow", worthCapturing: true, matchedRuleIds: ["capture"] } }; } });
  const result = await service.evaluate("evolve-capture", "failure lesson", context());
  assert.equal(result.worthCapturing, true); assert.equal(result.candidateType, "knowhow"); assert.deepEqual(calls, ["classification"]);
  assert.equal(policyClassifyDomain("evolve-capture", policy()).rules({ text: "决策 规则 陷阱" }), undefined);
});

function hostGrant() {
  let current: HostAskPolicyGrant | undefined = {
    snapshot: { cwd: "/workspace", sessionId: "session", generation: 1, planCycle: 1, confirmPending: false,
      taskContext: { markdown: "# Task\nRefactor src/helper.ts using existing spec; no new features.", revision: 2, handoffKey: "task-key" } },
    isCurrent: () => !!current,
  };
  return { resolve: () => current, change: (patch: Partial<HostAskPolicyGrant["snapshot"]>) => { current = { ...current!, snapshot: { ...current!.snapshot, ...patch } }; }, off: () => { current = undefined; } };
}
const sessionVerdict = { ...verdict, matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID] };
const sessionAdvice = { ...advice, matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID] };
function sessionService(overrides: Partial<PolicyServiceDependencies> = {}) {
  const calls: string[] = [];
  const service = createDecisionPolicyService({ loadPolicy: async () => undefined, loadSpecs: async () => "", classifierUnavailableReason: () => "Classifier disabled", structured: async (request) => {
    calls.push(request.kind);
    const input = JSON.parse(request.prompt.split("\nClassification:")[0]);
    assert.match(input.confirmedPolicy.rules.at(-1).instruction, /reversible technical choices/);
    assert.match(input.untrustedAuthorizedTask.markdown, /src\/helper/);
    return { value: request.kind === "classification" ? sessionVerdict : sessionAdvice };
  }, ...overrides });
  return { service, calls };
}
test("host grant enables no-file ask with narrow default auto policy and explicit fallback provenance", async () => {
  const grant = hostGrant(); const { service, calls } = sessionService();
  const result = await service.evaluate("ask", JSON.stringify({ question: "Which helper?", options: [{ label: "A", description: "Reuse src/helper.ts" }] }), context(), { resolveAskGrant: grant.resolve });
  assert.equal(result.mode, "enforce"); assert.equal(result.owner, "internal"); assert.equal(result.backend, "llm");
  assert.match(result.fallbackReason!, /Classifier disabled/); assert.equal(result.projectFingerprint, "missing");
  assert.equal(result.sessionGrantFingerprint, hostAskGrantFingerprint(grant.resolve()!)); assert.deepEqual(calls, ["classification", "advice"]);
});
test("session rule cannot widen a confirmed project external restriction, including project ask off", async () => {
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const grant = hostGrant(); const calls: string[] = [];
    const current = policy({ ask: { mode } });
    const { service } = sessionService({ loadPolicy: async () => current, structured: async (request) => {
      calls.push(request.kind); assert.doesNotMatch(request.prompt, /"id":"session-plan-auto-internal"/); assert.match(request.prompt, /untrustedAuthorizedTask/);
      return { value: { ...verdict, owner: "external" } };
    } });
    const result = await service.evaluate("ask", "Which forbidden implementation?", context(), { resolveAskGrant: grant.resolve });
    assert.equal(result.owner, "external"); assert.equal(result.mode, "enforce"); assert.equal(result.advice, undefined); assert.deepEqual(calls, ["classification"]);
  }
});
test("internal project and session restrictions are both evaluated; original models thresholds budgets preserved", async () => {
  const grant = hostGrant(); const calls: string[] = [];
  const current = policy({ ask: { mode: "off" }, minConfidence: 0.9, classification: { model: "custom/classify", maxCallsPerSession: 2 }, advice: { model: "custom/advice", maxCallsPerSession: 1 } });
  const { service } = sessionService({ loadPolicy: async () => current, structured: async (request) => {
    calls.push(request.modelRef);
    const session = request.prompt.includes(`"id":"${PLAN_AUTO_ASK_RULE_ID}"`);
    return { value: request.kind === "advice" ? sessionAdvice : session ? sessionVerdict : verdict };
  } });
  const result = await service.evaluate("ask", "Which helper?", context(), { resolveAskGrant: grant.resolve });
  assert.equal(result.owner, "internal"); assert.equal(result.minConfidence, 0.9);
  assert.deepEqual(calls, ["custom/classify", "custom/classify", "custom/advice"]);
  assert.match((await service.evaluate("ask", "Different helper?", context(), { resolveAskGrant: grant.resolve })).degradedReason!, /budget/);
});
test("missing task scope and wrong scope cannot classify under host authorization; other domains do not inherit it", async () => {
  for (const patch of [{ cwd: "/other" }, { sessionId: "other" }, { taskContext: { markdown: "", revision: 2 } }, { taskContext: { markdown: "task", revision: 0 } }]) {
    const grant = hostGrant(); grant.change(patch); const { service, calls } = sessionService();
    const result = await service.evaluate("ask", "Which helper?", context(), { resolveAskGrant: grant.resolve });
    assert.equal(result.owner, "uncertain"); assert.match(result.degradedReason!, /scope/); assert.deepEqual(calls, []);
  }
  const grant = hostGrant(); const { service, calls } = sessionService();
  assert.equal((await service.evaluate("evolve-review", "lesson", context(), { resolveAskGrant: grant.resolve })).mode, "off"); assert.deepEqual(calls, []);
});
test("host grant strict classifier failures stay human; auto classifier succeeds before independent advice", async () => {
  const grant = hostGrant();
  const strict = sessionService({ loadPolicy: async () => policy({ rules: [], ask: { mode: "off" }, selfEvolve: { mode: "off" }, backend: "classifier" }) });
  assert.match((await strict.service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve })).degradedReason!, /Classifier disabled/); assert.deepEqual(strict.calls, []);
  const native = sessionService({ classifierUnavailableReason: () => undefined, classifier: async () => ({ value: sessionVerdict, model: "native/classifier" }) });
  const result = await native.service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve });
  assert.equal(result.backend, "classifier"); assert.equal(result.owner, "internal"); assert.deepEqual(native.calls, ["advice"]);
});
test("session outputs require valid session rule references and independent non-external advice", async () => {
  for (const output of [{ ...sessionVerdict, matchedRuleIds: ["local"] }, { ...sessionVerdict, matchedRuleIds: [] }, { ...sessionVerdict, confidence: 0.7 }, { ...sessionAdvice, matchedRuleIds: ["local"] }, { ...sessionAdvice, needsExternalDecision: true }]) {
    const grant = hostGrant(); const isAdvice = "recommendation" in output;
    const { service } = sessionService({ structured: async (request) => ({ value: (request.kind === "advice") === isAdvice ? output : request.kind === "advice" ? sessionAdvice : sessionVerdict }) });
    const result = await service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve });
    assert.notEqual(result.owner, "internal");
  }
});
test("off, new generation, task revision, actor task change and policy creation fence in-flight advice", async () => {
  for (const invalidator of ["off", "generation", "task", "actor", "policy"] as const) {
    const grant = hostGrant(); let project: ReturnType<typeof policy> | undefined;
    let release!: () => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let actorTaskInput = "task #1";
    const resolver = () => grant.resolve() ? { ...grant.resolve()!, actorTaskInput } : undefined;
    const { service } = sessionService({ loadPolicy: async () => project, structured: async (request) => {
      if (request.kind === "advice") { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
      return { value: request.kind === "advice" ? sessionAdvice : sessionVerdict };
    } });
    const pending = service.evaluate("ask", "choice", context(), { resolveAskGrant: resolver }); await started;
    if (invalidator === "off") grant.off();
    if (invalidator === "generation") grant.change({ generation: 2 });
    if (invalidator === "task") grant.change({ taskContext: { markdown: "different task", revision: 3 } });
    if (invalidator === "actor") actorTaskInput = "task #2";
    if (invalidator === "policy") project = policy();
    release(); const result = await pending;
    assert.equal(result.owner, "uncertain"); assert.equal(result.advice, undefined); assert.match(result.degradedReason!, /changed/);
  }
});
test("cache binds generation and full task input, but confirmation consumption alone does not invalidate ask", async () => {
  const grant = hostGrant(); const { service, calls } = sessionService();
  const evaluate = () => service.evaluate("ask", "same", context(), { resolveAskGrant: grant.resolve, advice: false });
  await evaluate(); await evaluate(); assert.equal(calls.length, 1);
  grant.change({ confirmPending: true }); await evaluate(); assert.equal(calls.length, 1);
  grant.change({ generation: 2 }); await evaluate(); assert.equal(calls.length, 2);
  grant.change({ taskContext: { ...grant.resolve()!.snapshot.taskContext, revision: 3 } }); await evaluate(); assert.equal(calls.length, 3);
});
test("host authorization retains default .8/15s/30-call limits and all unavailable stages fail closed", async () => {
  const grant = hostGrant();
  const defaults = sessionService({ classifierUnavailableReason: (_domain, current) => {
    assert.equal(current.minConfidence, 0.8); assert.equal(current.classification.timeoutMs, 15000); assert.equal(current.classification.maxCallsPerSession, 30);
    assert.equal(current.advice.timeoutMs, 15000); assert.equal(current.advice.maxCallsPerSession, 30); return "disabled";
  } });
  assert.equal((await defaults.service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve })).owner, "internal");
  for (const kind of ["classification", "advice"] as const) {
    const lane = sessionService({ structured: async (request) => { if (request.kind === kind) throw new Error("No authenticated model"); return { value: sessionVerdict }; } });
    const result = await lane.service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve });
    assert.equal(result.owner, "uncertain"); assert.match(result.degradedReason!, /authenticated model/); assert.equal(result.advice, undefined);
  }
  const limited = sessionService({ loadPolicy: async () => DecisionPolicySchema.parse({ backend: "llm", classification: { maxCallsPerSession: 1, timeoutMs: 100 } }) });
  assert.equal((await limited.service.evaluate("ask", "first", context(), { resolveAskGrant: grant.resolve })).owner, "internal");
  assert.match((await limited.service.evaluate("ask", "second", context(), { resolveAskGrant: grant.resolve })).degradedReason!, /budget/);
  const stalled = sessionService({ loadPolicy: async () => DecisionPolicySchema.parse({ backend: "llm", classification: { timeoutMs: 100 } }), structured: async () => new Promise(() => {}) });
  const keepAlive = setInterval(() => {}, 200);
  try { assert.equal((await stalled.service.evaluate("ask", "choice", context(), { resolveAskGrant: grant.resolve })).owner, "uncertain"); }
  finally { clearInterval(keepAlive); }
});
