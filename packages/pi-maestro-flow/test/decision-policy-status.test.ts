import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DecisionPolicySchema } from "../src/decision-policy/config.ts";
import { createDecisionPolicyService } from "../src/decision-policy/service.ts";
import { executeAsk } from "../src/tools/ask.ts";
import { beginDecisionPolicyStatus, connectDecisionPolicyStatus, resetDecisionPolicyStatus, setDecisionPolicyConfiguring } from "../src/decision-policy/status.ts";

const policy = () => DecisionPolicySchema.parse({ backend: "auto", ask: { mode: "enforce" }, selfEvolve: { mode: "shadow" }, rules: [{ id: "reuse", domain: "ask", instruction: "Recommend local compatible code reuse." }, { id: "capture", domain: "evolve-capture", instruction: "Capture grounded failure lessons." }] });
function harness(id: string) {
  let sessionId = id;
  const updates: Array<string | undefined> = [];
  const ctx = { cwd: "/project", sessionManager: { getSessionId: () => sessionId }, hasUI: true, mode: "rpc", ui: {} } as unknown as ExtensionContext;
  const controller = connectDecisionPolicyStatus(ctx, (text) => updates.push(text));
  return { ctx, controller, updates, latest: () => updates.at(-1) ?? "", replaceSession: () => { sessionId = `${id}-new`; }, close: () => controller.dispose() };
}
test("status distinguishes loading, unconfigured, disabled, invalid and manual configuration", () => {
  const h = harness("status-config");
  try {
    assert.match(h.latest(), /加载中/); h.controller.configure(undefined); assert.match(h.latest(), /未配置/);
    h.controller.configure(DecisionPolicySchema.parse({})); assert.match(h.latest(), /A:off E:off/);
    h.controller.configure(policy()); assert.match(h.latest(), /A:enforce E:shadow.*auto/);
    setDecisionPolicyConfiguring(h.ctx, true); assert.match(h.latest(), /DEC \?.*配置中/);
    setDecisionPolicyConfiguring(h.ctx, false); assert.doesNotMatch(h.latest(), /配置中/);
    h.controller.configure(undefined, true); assert.match(h.latest(), /DEC !.*规范无效/);
  } finally { h.close(); }
  assert.equal(h.updates.at(-1), undefined);
});
test("runtime phases show actual backend and preserve the latest settled result under reverse completion", () => {
  const h = harness("status-concurrency");
  try {
    h.controller.configure(policy());
    const old = beginDecisionPolicyStatus(h.ctx, "ask", "classifying", "classifier");
    assert.match(h.latest(), /CLF.*判别中/);
    const recent = beginDecisionPolicyStatus(h.ctx, "ask", "classifying", "llm");
    assert.match(h.latest(), /LLM.*判别中 ×2/);
    recent.update("advising", "llm"); assert.match(h.latest(), /LLM.*生成建议/);
    recent.finish({ owner: "internal", backend: "llm", advice: true });
    assert.match(h.latest(), /CLF.*判别中/);
    old.finish({ owner: "external", backend: "classifier" });
    assert.match(h.latest(), /LLM.*内部建议/); assert.doesNotMatch(h.latest(), /外部决策/);
  } finally { h.close(); }
});
test("human wait has priority and is removed only at real reply or cancellation", () => {
  const h = harness("status-human");
  try {
    h.controller.configure(policy());
    const waiting = beginDecisionPolicyStatus(h.ctx, "ask", "waiting-user");
    const background = beginDecisionPolicyStatus(h.ctx, "evolve-capture", "classifying", "llm");
    assert.match(h.latest(), /DEC \?.*等待用户 ×2/);
    background.finish({ mode: "shadow", backend: "llm", worthCapturing: true });
    assert.match(h.latest(), /等待用户/);
    waiting.finish({ humanAnswered: true });
    assert.doesNotMatch(h.latest(), /等待用户/); assert.match(h.latest(), /真人已答/);
    const next = beginDecisionPolicyStatus(h.ctx, "ask", "waiting-user");
    next.finish({ cancelled: true }); assert.match(h.latest(), /已取消/);
  } finally { h.close(); }
});
test("reset/reload/session replacement fences old callbacks and cleans status", () => {
  const h = harness("status-reset");
  h.controller.configure(policy());
  const old = beginDecisionPolicyStatus(h.ctx, "ask", "classifying", "llm");
  resetDecisionPolicyStatus("status-reset"); const baseline = h.latest();
  old.update("advising", "llm"); old.finish({ owner: "internal", advice: true }); assert.equal(h.latest(), baseline);
  const otherUpdates: Array<string | undefined> = [];
  const replacement = connectDecisionPolicyStatus(h.ctx, (text) => otherUpdates.push(text));
  h.close(); assert.equal(otherUpdates.at(-1)?.includes("加载中"), true);
  replacement.configure(undefined); assert.match(otherUpdates.at(-1) ?? "", /未配置/);
  const pending = beginDecisionPolicyStatus(h.ctx, "ask", "classifying", "classifier");
  h.replaceSession(); pending.finish({ owner: "internal", advice: true });
  assert.doesNotMatch(otherUpdates.at(-1) ?? "", /内部建议/);
  replacement.dispose(); assert.equal(otherUpdates.at(-1), undefined);
});
test("service emits real fallback/advice stages without question or recommendation text", async () => {
  const h = harness("status-service");
  const secret = "PRIVATE_QUESTION_TEXT";
  const recommendation = "PRIVATE_ADVICE_TEXT";
  const service = createDecisionPolicyService({ loadPolicy: async () => policy(), loadSpecs: async () => "", classifier: async () => { assert.match(h.latest(), /CLF.*判别中/); throw new Error("classifier unavailable"); }, structured: async (request) => {
    assert.match(h.latest(), request.kind === "classification" ? /LLM.*判别中/ : /LLM.*生成建议/);
    return { value: request.kind === "classification" ? { owner: "internal", candidateType: "unknown", worthCapturing: false, confidence: .95, matchedRuleIds: ["reuse"], rationale: secret } : { recommendation, rationale: secret, matchedRuleIds: ["reuse"], assumptions: [], needsExternalDecision: false } };
  } });
  try {
    h.controller.configure(policy());
    assert.equal((await service.evaluate("ask", secret, h.ctx)).owner, "internal");
    assert.match(h.latest(), /LLM.*内部建议/);
    assert.ok(h.updates.every((text) => !text?.includes(secret) && !text?.includes(recommendation)));
    service.invalidateSession("status-service"); assert.doesNotMatch(h.latest(), /内部建议/);
  } finally { h.close(); }
});
test("ask publishes waiting state for actual UI and settles after answer", async () => {
  const h = harness("status-ask");
  try {
    h.controller.configure(undefined);
    let reply!: (text: string) => void;
    h.ctx.ui.input = async () => new Promise((resolve) => { reply = resolve; });
    const pending = executeAsk({ questions: [{ question: "PRIVATE_HUMAN_QUESTION" }] }, h.ctx);
    assert.match(h.latest(), /未配置.*等待用户/); assert.doesNotMatch(h.latest(), /PRIVATE_HUMAN/);
    reply("human reply");
    assert.equal((await pending).details.answers[0].text, "human reply"); assert.match(h.latest(), /真人已答/);
  } finally { h.close(); }
});
