import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSelfEvolve, { setSelfEvolvePolicyEvaluatorForTest, setSelfEvolveReviewRuntimeForTest, setSelfEvolveDepositExecutorForTest } from "../src/self-evolve/extension.ts";
import { DEFAULT_SELF_EVOLVE_CONFIG, normalizeSelfEvolveConfig, setConfigValue, type SelfEvolveConfig } from "../src/self-evolve/runtime.ts";
import { applyCapturePolicy, applyReviewPolicy } from "../src/self-evolve/enrichment.ts";
import { createDecisionPolicyService, type PolicyEvaluation } from "../src/decision-policy/service.ts";
import { DecisionPolicySchema, saveDecisionPolicy } from "../src/decision-policy/config.ts";
import { configureClassifier, resetClassifierForTest, registerClassifyDomain, bindClassifierRuntime } from "pi-maestro-teammate/v1/classify";
import { signalTypeDomain } from "../src/classifier/domains.ts";
import { runSupervisedEvaluation } from "pi-maestro-teammate/v1/supervision";

const result = (overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation => ({ domain: "evolve-capture", mode: "enforce", backend: "classifier", owner: "internal", candidateType: "spec", worthCapturing: true, confidence: .98, matchedRuleIds: ["capture"], rationale: "Reusable local constraint", policyRevision: 1, ...overrides });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 150; i++) { if (await check()) return; await tick(); } throw new Error("Timed out waiting for offline capture"); }
async function ledger(root: string, dir: string): Promise<any[]> {
  try { const names = await readdir(join(root, dir)); return (await Promise.all(names.filter((n) => n.endsWith(".jsonl")).map((n) => readFile(join(root, dir, n), "utf8")))).join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}
async function harness(config: Partial<SelfEvolveConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "self-evolve-policy-"));
  const output = join(root, "output");
  const oldEnv = process.env.SELF_EVOLVE_OUTPUT_DIR;
  const oldEnabled = process.env.PI_SELF_EVOLVE;
  delete process.env.PI_SELF_EVOLVE;
  process.env.SELF_EVOLVE_OUTPUT_DIR = output;
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "self-evolve.json"), JSON.stringify({ ...DEFAULT_SELF_EVOLVE_CONFIG, enabled: true, cooldownMs: 0, ...config }));
  const handlers = new Map<string, Function>();
  let command: any;
  let sessionId = "session-one";
  const notifications: string[] = [];
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => sessionId }, model: { provider: "test", id: "model" }, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] }, ui: { notify: (text: string) => notifications.push(text), setStatus() {} } };
  const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, def: any) => command = def.handler };
  registerSelfEvolve(pi);
  handlers.get("session_start")!({}, ctx);
  await command("status", ctx); // waits for config loading
  return { root, output, ctx, handlers, notifications, command,
    replaceSession() { sessionId = "session-two"; handlers.get("session_start")!({}, ctx); },
    turn(text: string) { return handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] }, ctx); },
    evidenceTurn(text: string) { return handlers.get("agent_end")!({ messages: [{ role: "toolResult", toolCallId: text, toolName: "read", content: [{ type: "text", text }] }, { role: "assistant", content: [{ type: "text", text }] }] }, ctx); },
    compact(text: string) { return handlers.get("session_compact")!({ compactionEntry: { summary: text }, reason: "manual" }, ctx); },
    async close() { handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx); await tick(); setSelfEvolvePolicyEvaluatorForTest(); setSelfEvolveReviewRuntimeForTest(undefined); setSelfEvolveDepositExecutorForTest(undefined); resetClassifierForTest(); if (oldEnv === undefined) delete process.env.SELF_EVOLVE_OUTPUT_DIR; else process.env.SELF_EVOLVE_OUTPUT_DIR = oldEnv; if (oldEnabled === undefined) delete process.env.PI_SELF_EVOLVE; else process.env.PI_SELF_EVOLVE = oldEnabled; await rm(root, { recursive: true, force: true }); },
  };
}
const unknownText = "The widget retains its blue outline while the canvas is resized to a smaller viewport.";
const adviceForReview = { recommendation: "Keep source evidence", rationale: "Grounded local constraint", matchedRuleIds: ["review"], assumptions: [], needsExternalDecision: false };
function offlineQualityReview() {
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => ({ ok: true, verdict: { verdicts: [{ id: /- id: (se-\w+)/.exec(options.task)![1], action: "stage", candidateType: "knowhow", score: .99, reason: "grounded lesson" }] } }) as any } });
}
const lesson = "Pitfall: a stale generation can overwrite a newer resource; always fence delayed callbacks before writing.";

test("capture mode and semantic limits normalize and persist through command/reload", async () => {
  let config = { ...DEFAULT_SELF_EVOLVE_CONFIG };
  for (const [key, value] of Object.entries({ captureMode: "hybrid", maxSemanticCallsPerSession: "7", maxSemanticCandidatesPerSession: "8", semanticBatchSize: "2", semanticTimeoutMs: "1234" })) { const changed = setConfigValue(config, key, value); assert.equal(changed.error, undefined); config = changed.config; }
  assert.deepEqual(normalizeSelfEvolveConfig(JSON.parse(JSON.stringify(config))), config);
  assert.equal(normalizeSelfEvolveConfig({ captureMode: "bogus", semanticTimeoutMs: Infinity } as any).captureMode, "heuristic");
  assert.equal(normalizeSelfEvolveConfig({ semanticTimeoutMs: Infinity }).semanticTimeoutMs, 30000);
  const h = await harness();
  try { await h.command("config captureMode=hybrid maxSemanticCallsPerSession=7 maxSemanticCandidatesPerSession=8 semanticBatchSize=2 semanticTimeoutMs=1234", h.ctx); const saved = JSON.parse(await readFile(join(h.root, ".pi/self-evolve.json"), "utf8")); assert.equal(saved.captureMode, "hybrid"); assert.equal(saved.semanticTimeoutMs, 1234); h.replaceSession(); await h.command("config", h.ctx); assert.match(h.notifications.at(-1)!, /hybrid.*7 calls.*8 candidates.*batch 2.*1234ms/); } finally { await h.close(); }
});

test("off/shadow/degraded preserve heuristic; enforce alone uses worthCapturing and relabels", () => {
  for (const evaluation of [result({ mode: "off" }), result({ mode: "shadow" }), result({ degradedReason: "timeout" }), result({ backend: "none" })]) { assert.deepEqual(applyCapturePolicy(evaluation, "knowhow", true), { accepted: true, candidateType: "knowhow" }); assert.equal(applyCapturePolicy(evaluation, "unknown", false).accepted, false); }
  assert.deepEqual(applyCapturePolicy(result(), "unknown", false), { accepted: true, candidateType: "spec" });
  assert.equal(applyCapturePolicy(result({ worthCapturing: false }), "spec", true).accepted, false);
});

test("unknown is rescued before heuristic gate; enforced negative filters a strong terminal keyword", async () => {
  const h = await harness();
  let calls = 0;
  setSelfEvolvePolicyEvaluatorForTest(async () => result({ worthCapturing: ++calls === 1 }));
  try { assert.equal(h.turn(unknownText), undefined); await until(async () => (await ledger(h.output, "suggestions")).length === 1); h.turn(lesson); await until(async () => (await ledger(h.output, "decision-policy")).length === 2); const signals = await ledger(h.output, "suggestions"); assert.equal(signals.length, 1); assert.equal(signals[0].candidateType, "unknown", "raw heuristic record is never relabeled"); await h.command("signals 1", h.ctx); assert.match(h.notifications.at(-1)!, /spec/); const sidecars = await ledger(h.output, "decision-policy"); assert.equal(sidecars[0].traceHash, signals[0].traceHash); assert.equal(sidecars[0].sessionId, signals[0].sessionId); assert.equal(sidecars[0].signalId, signals[0].id); assert.equal(sidecars[1].accepted, false); } finally { await h.close(); }
});

test("classifier and auto structured LLM fallback actually participate in capture", async () => {
  for (const backend of ["classifier", "auto"] as const) {
    const h = await harness();
    const policy = DecisionPolicySchema.parse({ backend, selfEvolve: { mode: "enforce" }, rules: [{ id: "capture", domain: "evolve-capture", instruction: "Capture useful local constraints" }] });
    const calls: string[] = [];
    const value = { owner: "internal", candidateType: "knowhow", worthCapturing: true, confidence: .98, matchedRuleIds: ["capture"], rationale: "Reusable lesson" };
    const service = createDecisionPolicyService({ loadPolicy: async () => policy, loadSpecs: async () => "", classifier: async () => { calls.push("classifier"); if (backend === "auto") throw new Error("not configured"); return { value, model: "test/classifier" }; }, structured: async () => { calls.push("llm"); return { value, model: "test/model" }; } });
    setSelfEvolvePolicyEvaluatorForTest(service.evaluate);
    try { h.turn(unknownText); await until(async () => (await ledger(h.output, "suggestions")).length === 1); const audit = (await ledger(h.output, "decision-policy"))[0]; assert.equal(audit.evaluation.backend, backend === "auto" ? "llm" : "classifier"); assert.deepEqual(calls, backend === "auto" ? ["classifier", "llm"] : ["classifier"]); } finally { await h.close(); }
  }
});

test("degraded capture preserves failure trajectory and provenance", async () => {
  const h = await harness();
  setSelfEvolvePolicyEvaluatorForTest(async () => result({ candidateType: "unknown", degradedReason: "classification timed out" }));
  try { h.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "toolCall", id: "bad-call", name: "browser", arguments: { action: "run" } }] }, { role: "toolResult", toolCallId: "bad-call", toolName: "browser", isError: true, content: [{ type: "text", text: "Operation timeout" }] }, { role: "assistant", content: [{ type: "text", text: lesson }] }] }, h.ctx); await until(async () => (await ledger(h.output, "suggestions")).length === 1); const signal = (await ledger(h.output, "suggestions"))[0]; assert.ok(signal.toolCalls.some((call: any) => call.outcome === "timeout")); assert.ok(signal.episodes.length); assert.match((await ledger(h.output, "decision-policy"))[0].evaluation.degradedReason, /timed out/); } finally { await h.close(); }
});

test("malformed policy preserves heuristic capture and dry-run review without authorization", async () => {
  const h = await harness();
  await writeFile(join(h.root, ".pi", "decision-policy.json"), "{invalid-json");
  // Default evaluator parses the actual invalid file; no model is invoked.
  setSelfEvolvePolicyEvaluatorForTest();
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run, options) => ({ ok: true, verdict: { verdicts: [{ id: /- id: (se-[a-z0-9]+)/.exec(options.task)![1], action: "stage", candidateType: "knowhow", score: .99, reason: "grounded reusable lesson" }] } }) } });
  try {
    h.turn(lesson); await until(async () => (await ledger(h.output, "suggestions")).length === 1);
    assert.equal((await ledger(h.output, "suggestions"))[0].candidateType, "knowhow");
    const capture = (await ledger(h.output, "decision-policy"))[0]; assert.ok(capture.evaluation.degradedReason);
    await h.command("review 1", h.ctx);
    const reviews = await ledger(h.output, "reviews");
    assert.equal(reviews.length, 1, JSON.stringify(h.notifications));
    assert.equal(reviews[0].verdicts[0].action, "stage");
    assert.equal((await ledger(h.output, "deposits")).length, 0);
  } finally { await h.close(); }
});

test("delayed classification never blocks compaction or writes after shutdown/session replacement/policy change", async () => {
  for (const change of ["shutdown", "session", "policy"] as const) {
    const h = await harness();
    const policy = DecisionPolicySchema.parse({ rules: [{ id: "capture", domain: "evolve-capture", instruction: "Capture lessons" }] });
    await saveDecisionPolicy(h.root, policy, 0);
    let release!: (value: PolicyEvaluation) => void;
    let started = false;
    setSelfEvolvePolicyEvaluatorForTest(async () => { started = true; return await new Promise<PolicyEvaluation>((resolve) => release = resolve); });
    try { assert.equal(h.compact(lesson), undefined); await until(async () => started); if (change === "shutdown") h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx); else if (change === "session") h.replaceSession(); else await saveDecisionPolicy(h.root, policy, 1); release(result()); await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal((await ledger(h.output, "suggestions")).length, 0); assert.equal((await ledger(h.output, "decision-policy")).length, 0); } finally { await h.close(); }
  }
});

test("review invokes ownership advice without overriding its independent policy model; recommendations never raise skip or bypass score gate", async () => {
  const h = await harness({ model: "test/model" });
  const calls: any[] = [];
  const advice = { recommendation: "Keep pending; retain source evidence", rationale: "Needs grounded review", matchedRuleIds: ["review"], assumptions: [], needsExternalDecision: false };
  setSelfEvolvePolicyEvaluatorForTest(async (domain, _text, _ctx, options) => { calls.push({ domain, options }); return result({ domain, candidateType: "knowhow", ...(domain === "evolve-review" ? { advice } : {}) }); });
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("must use offline supervision"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => { const id = /- id: (se-\w+)/.exec(options.task)![1]; return { ok: true, verdict: { verdicts: [{ id, action: "stage", candidateType: "knowhow", score: .2, reason: "low confidence" }] } } as any; } } });
  try { h.turn(lesson); await until(async () => (await ledger(h.output, "suggestions")).length === 1); await h.command("review 1", h.ctx); const reviewCall = calls.find((call) => call.domain === "evolve-review"); assert.equal(reviewCall.options.advice, true); assert.equal(reviewCall.options.adviceModel, undefined); const review = (await ledger(h.output, "reviews"))[0]; assert.equal(review.verdicts[0].action, "uncertain"); assert.match(review.verdicts[0].reason, /recommendation only, not authorization/); assert.ok(h.notifications.some((text) => text.includes(advice.recommendation))); assert.equal((await ledger(h.output, "deposits")).length, 0); const skip: any = { id: "x", action: "skip", candidateType: "knowhow", score: 1, reason: "noise" }; assert.equal(applyReviewPolicy(skip, result({ advice })).action, "skip"); assert.equal(applyReviewPolicy({ ...skip, action: "stage" }, result({ owner: "external" })).action, "uncertain"); } finally { await h.close(); }
});

test("hybrid enrichment reserves budget before await and cannot persist late results", async () => {
  const h = await harness({ captureMode: "hybrid", maxSemanticCallsPerSession: 1, maxSemanticCandidatesPerSession: 1 });
  let release!: (value: any) => void;
  let enrichmentCalls = 0;
  setSelfEvolvePolicyEvaluatorForTest(async () => result());
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => { enrichmentCalls++; assert.equal(options.timeoutMs, h.ctx ? 30000 : 0); return await new Promise<any>((resolve) => release = resolve); } } });
  try {
    h.turn(unknownText);
    await until(async () => enrichmentCalls === 1);
    h.turn(`${unknownText} The boundary persists in another viewport.`);
    await until(async () => (await ledger(h.output, "suggestions")).length === 2);
    assert.equal(enrichmentCalls, 1, "in-flight reservation must prevent overspending");
    h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
    release({ ok: false, reason: "model timed out" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await ledger(h.output, "enrichments")).length, 0, "stale second-stage model may not write");
  } finally { await h.close(); }
});

test("hybrid second-stage failure writes terminal fallback while raw failure evidence remains", async () => {
  const h = await harness({ captureMode: "hybrid", semanticTimeoutMs: 321 });
  setSelfEvolvePolicyEvaluatorForTest(async () => result({ degradedReason: "classifier unavailable" }));
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => { assert.equal(options.timeoutMs, 321); return { ok: false, reason: "enrichment timed out" }; } } });
  try {
    h.turn(lesson);
    await until(async () => (await ledger(h.output, "enrichments")).length === 1);
    const raw = (await ledger(h.output, "suggestions"))[0];
    const enrichment = (await ledger(h.output, "enrichments"))[0];
    assert.equal(enrichment.status, "heuristic_fallback");
    assert.equal(enrichment.traceHash, raw.traceHash);
    assert.equal(enrichment.sessionId, raw.sessionId);
    assert.match(enrichment.error, /timed out/);
    assert.equal(raw.candidateType, "knowhow");
    assert.match(raw.summary, /generation/);
  } finally { await h.close(); }
});

test("external review ownership routes stage-worthy candidates to human review, never auto-deposit", async () => {
  const h = await harness({ mode: "auto-deposit" });
  setSelfEvolvePolicyEvaluatorForTest(async (domain) => result({ domain, ...(domain === "evolve-review" ? { owner: "external" } : {}) }));
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => ({ ok: true, verdict: { verdicts: [{ id: /- id: (se-\w+)/.exec(options.task)![1], action: "stage", candidateType: "spec", score: .99, reason: "prescriptive constraint" }] } }) as any } });
  try { h.turn(lesson); await until(async () => (await ledger(h.output, "suggestions")).length === 1); await h.command("review 1", h.ctx); const review = (await ledger(h.output, "reviews"))[0]; assert.equal(review.verdicts[0].action, "uncertain"); assert.match(review.verdicts[0].reason, /human review required/); assert.equal((await ledger(h.output, "deposits")).length, 0); } finally { await h.close(); }
});

test("enforce unconfirmed review cannot auto-deposit; off/shadow keep the quality gate", async () => {
  const verdict: any = { id: "x", action: "stage", candidateType: "knowhow", score: .99, reason: "grounded" };
  for (const mode of ["off", "shadow"] as const) {
    assert.deepEqual(applyReviewPolicy(verdict, result({ mode, degradedReason: "offline" })), verdict);
  }
  for (const unconfirmed of [{ degradedReason: "timeout", advice: adviceForReview }, { backend: "none" as const, advice: adviceForReview }, { owner: "uncertain" as const, advice: adviceForReview }, {}]) {
    const h = await harness({ mode: "auto-deposit" });
    let stages = 0;
    setSelfEvolveDepositExecutorForTest(async () => { stages++; throw new Error("must not stage"); });
    setSelfEvolvePolicyEvaluatorForTest(async (domain) => result({ domain, ...(domain === "evolve-review" ? unconfirmed : {}) }));
    offlineQualityReview();
    try {
      h.turn(lesson);
      await until(async () => (await ledger(h.output, "suggestions")).length === 1);
      await h.command("review 1", h.ctx);
      assert.equal((await ledger(h.output, "reviews"))[0].verdicts[0].action, "uncertain");
      assert.equal(stages, 0);
      assert.equal((await ledger(h.output, "deposits")).length, 0);
      assert.equal(applyReviewPolicy({ ...verdict, action: "skip" }, result(unconfirmed)).action, "skip");
    } finally { await h.close(); }
  }
});

test("review quality, policy classification and advice use independent configured models", async () => {
  const h = await harness({ model: "test/quality" });
  const models: string[] = [];
  const policy = DecisionPolicySchema.parse({ backend: "llm", selfEvolve: { mode: "enforce" }, classification: { model: "test/classification" }, advice: { model: "test/advice" }, rules: [{ id: "capture", domain: "evolve-capture", instruction: "Capture lessons" }, { id: "review", domain: "evolve-review", instruction: "Recommend local review" }] });
  const service = createDecisionPolicyService({ loadPolicy: async () => policy, loadSpecs: async () => "", structured: async (request) => {
    models.push(request.modelRef);
    return { value: request.kind === "advice" ? adviceForReview : { owner: "internal", candidateType: "knowhow", worthCapturing: true, confidence: .99, matchedRuleIds: [request.prompt.includes('"domain":"evolve-review"') ? "review" : "capture"], rationale: "Grounded rule" } };
  } });
  setSelfEvolvePolicyEvaluatorForTest(service.evaluate);
  h.ctx.modelRegistry.getAvailable = () => [{ provider: "test", id: "quality" }];
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async (params: any) => {
    assert.equal(params.tasks[0].model, "test/quality");
    const id = /- id: (se-\w+)/.exec(params.tasks[0].prompt)![1];
    return { exitCode: 0, structuredOutput: { verdicts: [{ id, action: "stage", candidateType: "knowhow", score: .99, reason: "grounded lesson" }] } } as any;
  }, supervision: { runSupervisedEvaluation } });
  try {
    h.turn(lesson);
    await until(async () => (await ledger(h.output, "suggestions")).length === 1);
    await h.command("review 1", h.ctx);
    assert.deepEqual(models, ["test/classification", "test/classification", "test/advice"]);
    assert.equal((await ledger(h.output, "reviews"))[0].verdicts[0].action, "stage");
  } finally { await h.close(); }
});

function enrichmentPromptInputs(prompt: string) {
  return prompt.split("### signal ").slice(1).map((block) => ({ id: block.split(" ")[0], evidenceIds: [...block.matchAll(/  - (ev-\w+):/g)].map((match) => match[1]) }));
}
function semanticReply(input: { id: string; evidenceIds: string[] }) {
  return { signalId: input.id, worthCapturing: true, candidateType: "spec", title: "A grounded constraint", summary: "Preserve ownership before publishing", evidenceIds: input.evidenceIds };
}

test("semantic batches dispatch once for multiple candidates, map reordered results and charge actual counts", async () => {
  const h = await harness({ captureMode: "hybrid", semanticBatchSize: 3, maxSemanticCallsPerSession: 5, maxSemanticCandidatesPerSession: 5 });
  const sizes: number[] = [];
  setSelfEvolvePolicyEvaluatorForTest(async () => result());
  setSelfEvolveReviewRuntimeForTest({ supervision: { runSupervisedEvaluation }, runTeammate: async (params: any) => {
    const inputs = enrichmentPromptInputs(params.tasks[0].prompt);
    sizes.push(inputs.length);
    const results = inputs.map(semanticReply).reverse();
    if (sizes.length === 1) results[1].evidenceIds = inputs[0].evidenceIds; // cannot borrow a sibling's evidence
    return { structuredOutput: { results } } as any;
  } });
  try {
    for (let i = 0; i < 3; i++) h.evidenceTurn(`${unknownText} src/batch-${i}.ts:1`);
    await until(async () => (await ledger(h.output, "enrichments")).length === 3);
    assert.deepEqual(sizes, [3]);
    for (let i = 3; i < 5; i++) h.evidenceTurn(`${unknownText} src/batch-${i}.ts:1`);
    await until(async () => (await ledger(h.output, "enrichments")).length === 5);
    h.evidenceTurn(`${unknownText} src/batch-5.ts:1`);
    await until(async () => (await ledger(h.output, "suggestions")).length === 6);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(sizes, [3, 2], "candidate budget is 5, not 5 batches");
    const raw = await ledger(h.output, "suggestions");
    const records = await ledger(h.output, "enrichments");
    assert.equal(records.filter((record) => record.status === "semantic").length, 4, JSON.stringify(records));
    assert.match(records.find((record) => record.status === "heuristic_fallback").error, /evidence/);
    for (const record of records) {
      const signal = raw.find((signal) => signal.id === record.signalId);
      assert.equal(record.traceHash, signal.traceHash);
      assert.equal(record.sessionId, signal.sessionId);
    }
  } finally { await h.close(); }
});

test("missing, duplicate and foreign batch IDs each leave exact-key terminal fallbacks", async () => {
  const h = await harness({ captureMode: "hybrid", semanticBatchSize: 3 });
  setSelfEvolvePolicyEvaluatorForTest(async () => result());
  setSelfEvolveReviewRuntimeForTest({ supervision: { runSupervisedEvaluation }, runTeammate: async (params: any) => {
    const inputs = enrichmentPromptInputs(params.tasks[0].prompt);
    return { structuredOutput: { results: [semanticReply(inputs[0]), semanticReply(inputs[0]), { ...semanticReply(inputs[1]), signalId: "foreign-id" }] } } as any;
  } });
  try {
    for (let i = 0; i < 3; i++) h.evidenceTurn(`${unknownText} src/missing-${i}.ts:1`);
    await until(async () => (await ledger(h.output, "enrichments")).length === 3);
    const records = await ledger(h.output, "enrichments");
    assert.ok(records.every((record) => record.status === "heuristic_fallback"));
    assert.equal(new Set(records.map((record) => record.signalId)).size, 3);
  } finally { await h.close(); }
});

test("partial semantic batch flushes without waiting for full capacity and respects call budget", async () => {
  const h = await harness({ captureMode: "hybrid", semanticBatchSize: 3, maxSemanticCallsPerSession: 1 });
  let calls = 0;
  setSelfEvolvePolicyEvaluatorForTest(async () => result());
  setSelfEvolveReviewRuntimeForTest({ supervision: { runSupervisedEvaluation }, runTeammate: async (params: any) => { calls++; const inputs = enrichmentPromptInputs(params.tasks[0].prompt); assert.equal(inputs.length, 1); return { structuredOutput: { results: inputs.map(semanticReply) } } as any; } });
  try {
    h.evidenceTurn(`${unknownText} src/partial.ts:1`);
    await until(async () => (await ledger(h.output, "enrichments")).length === 1);
    h.evidenceTurn(`${unknownText} src/exhausted.ts:1`);
    await until(async () => (await ledger(h.output, "suggestions")).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test("pending semantic batches are discarded on shutdown/off/config, never flushed into a new lifecycle", async () => {
  for (const change of ["shutdown", "off", "config"] as const) {
    const h = await harness({ captureMode: "hybrid", semanticBatchSize: 3 });
    let calls = 0;
    setSelfEvolvePolicyEvaluatorForTest(async () => result());
    setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async () => { calls++; return { ok: false }; } } });
    try {
      h.turn(unknownText);
      await until(async () => (await ledger(h.output, "suggestions")).length === 1);
      assert.equal(calls, 0, "candidate is still in coalescing queue");
      if (change === "shutdown") h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
      else await h.command(change === "off" ? "off" : "config semanticBatchSize=2", h.ctx);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(calls, 0);
      assert.equal((await ledger(h.output, "enrichments")).length, 0);
    } finally { await h.close(); }
  }
});

test("in-flight batch results cannot cross off/config/session/policy fences", async () => {
  for (const change of ["off", "config", "session", "policy"] as const) {
    const h = await harness({ captureMode: "hybrid", semanticBatchSize: 2 });
    let release!: (value: any) => void;
    let inputs: ReturnType<typeof enrichmentPromptInputs> = [];
    setSelfEvolvePolicyEvaluatorForTest(async () => result());
    setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => { inputs = enrichmentPromptInputs(options.task); return await new Promise<any>((resolve) => release = resolve); } } });
    try {
      h.evidenceTurn(`${unknownText} src/fenced-a.ts:1`); h.evidenceTurn(`${unknownText} src/fenced-b.ts:1`);
      await until(async () => inputs.length === 2);
      if (change === "session") h.replaceSession();
      else if (change === "policy") await writeFile(join(h.root, ".pi/decision-policy.json"), "{}");
      else await h.command(change === "off" ? "off" : "config semanticBatchSize=1", h.ctx);
      release({ ok: true, verdict: { results: inputs.map(semanticReply) } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await ledger(h.output, "enrichments")).length, 0);
    } finally { await h.close(); }
  }
});

function configureSignalClassifier(mode: "off" | "shadow" | "jev", classifyFn: () => Promise<any>) {
  resetClassifierForTest();
  registerClassifyDomain(signalTypeDomain);
  const model: any = { type: "classifier", id: "jev-latest", name: "JEV", provider: "typesafe", api: "typesafe-system-one", baseUrl: "https://offline.invalid", input: ["text"], contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  bindClassifierRuntime({ hostVersion: "0.99.0", runtime: { getAvailableOfType: async () => [model], getModelOfType: () => model, classify: classifyFn } });
  configureClassifier({ enabled: true, domains: { "signal-type": mode } });
}
const jevSpecReply = () => ({ api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", answers: { type: { type: "choice", choice: "spec", confidence: .99 }, worthCapturing: { type: "bool", probability: .99 } }, stopReason: "stop", timestamp: 0 });

test("production signal-type jev adjudicates asynchronously; off/shadow retain immediate rules and one policy capture", async () => {
  for (const source of ["agent_end", "session_compact"] as const) for (const mode of ["off", "shadow", "jev"] as const) {
    const h = await harness();
    let classifierCalls = 0;
    let policyCalls = 0;
    let release!: (reply: any) => void;
    configureSignalClassifier(mode, async () => { classifierCalls++; return await new Promise<any>((resolve) => release = resolve); });
    setSelfEvolvePolicyEvaluatorForTest(async () => { policyCalls++; return result({ mode: "off" }); });
    try {
      assert.equal(source === "agent_end" ? h.turn(unknownText) : h.compact(unknownText), undefined);
      if (mode !== "off") await until(async () => classifierCalls === 1);
      if (mode === "jev") {
        assert.equal(policyCalls, 0, "policy waits for the adjudicated candidate");
        assert.equal((await ledger(h.output, "suggestions")).length, 0);
        release(jevSpecReply());
      }
      await until(async () => (await ledger(h.output, "decision-policy")).length === 1);
      const signals = await ledger(h.output, "suggestions");
      if (mode === "jev") {
        await until(async () => (await ledger(h.output, "suggestions")).length === 1);
        assert.equal((await ledger(h.output, "suggestions"))[0].candidateType, "spec");
      } else if (source === "session_compact") {
        await until(async () => (await ledger(h.output, "suggestions")).length === 1);
        assert.equal((await ledger(h.output, "suggestions"))[0].candidateType, "unknown");
      } else assert.equal(signals.length, 0);
      if (mode === "shadow") release(jevSpecReply());
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(classifierCalls, mode === "off" ? 0 : 1, "no duplicate sync shadow + async classification");
      assert.equal(policyCalls, 1);
      assert.equal((await ledger(h.output, "decision-policy")).length, 1);
    } finally { await h.close(); }
  }
});

test("late production JEV cannot write policy or signals across shutdown/off/config/session/policy changes", async () => {
  for (const change of ["shutdown", "off", "config", "session", "policy"] as const) {
    const h = await harness();
    let started = false;
    let release!: (reply: any) => void;
    let policyCalls = 0;
    configureSignalClassifier("jev", async () => { started = true; return await new Promise<any>((resolve) => release = resolve); });
    setSelfEvolvePolicyEvaluatorForTest(async () => { policyCalls++; return result(); });
    try {
      h.compact(unknownText);
      await until(async () => started);
      if (change === "shutdown") h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, h.ctx);
      else if (change === "session") h.replaceSession();
      else if (change === "policy") await writeFile(join(h.root, ".pi/decision-policy.json"), "{}");
      else await h.command(change === "off" ? "off" : "config cooldownMs=1", h.ctx);
      release(jevSpecReply());
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(policyCalls, 0);
      assert.equal((await ledger(h.output, "decision-policy")).length, 0);
      assert.equal((await ledger(h.output, "suggestions")).length, 0);
    } finally { await h.close(); }
  }
});

test("production JEV preserves terminal L0 hits and degrades unavailable adjudication conservatively", async () => {
  const h = await harness();
  let calls = 0;
  configureSignalClassifier("jev", async () => { calls++; throw new Error("offline transport failed"); });
  setSelfEvolvePolicyEvaluatorForTest(async () => result({ mode: "off" }));
  try {
    h.turn(lesson);
    await until(async () => (await ledger(h.output, "suggestions")).length === 1);
    assert.equal(calls, 0, "terminal knowhow rule is authoritative");
    h.turn(unknownText);
    await until(async () => (await ledger(h.output, "decision-policy")).length === 2);
    assert.equal(calls, 1);
    assert.equal((await ledger(h.output, "suggestions")).length, 1, "degraded unknown remains filtered by the original gate");
  } finally { await h.close(); }
});

test("delayed review advice is fenced before sidecar, review ledger or staging writes", async () => {
  const h = await harness({ mode: "auto-deposit" });
  let release!: (value: PolicyEvaluation) => void;
  let advising = false;
  setSelfEvolvePolicyEvaluatorForTest(async (domain) => {
    if (domain === "evolve-capture") return result();
    advising = true;
    return await new Promise<PolicyEvaluation>((resolve) => release = resolve);
  });
  setSelfEvolveReviewRuntimeForTest({ runTeammate: async () => { throw new Error("offline only"); }, supervision: { runSupervisedEvaluation: async (_run: any, options: any) => ({ ok: true, verdict: { verdicts: [{ id: /- id: (se-\w+)/.exec(options.task)![1], action: "stage", candidateType: "spec", score: .99, reason: "prescriptive constraint" }] } }) as any } });
  try {
    h.turn(lesson);
    await until(async () => (await ledger(h.output, "suggestions")).length === 1);
    const review = h.command("review 1", h.ctx);
    await until(async () => advising);
    h.replaceSession();
    release(result({ domain: "evolve-review" }));
    await review;
    assert.equal((await ledger(h.output, "reviews")).length, 0);
    assert.equal((await ledger(h.output, "deposits")).length, 0);
    assert.equal((await ledger(h.output, "decision-policy")).filter((rec) => rec.evaluation.domain === "evolve-review").length, 0);
  } finally { await h.close(); }
});
