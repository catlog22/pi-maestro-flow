import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionPolicySchema, loadDecisionPolicy, saveDecisionPolicy } from "../src/decision-policy/config.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginPlanAutoCycle, getPlanAutoSnapshot, registerPlanAuto, resetPlanAuto, revokePlanAuto } from "../src/tools/plan-auto.ts";
import { executeAsk, resolvePlanAutoAskPolicyGrant } from "../src/tools/ask.ts";
import { createDecisionPolicyService, hostAskGrantFingerprint, PLAN_AUTO_ASK_RULE_ID } from "../src/decision-policy/service.ts";
import type { TodoTask } from "../src/tools/todo.ts";

test("decision policy extension and manual Skill are shipped through canonical package resources", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./src/decision-policy/extension.ts"));
  assert.ok(manifest.files.includes("src/**/*.ts"));
  assert.ok(manifest.pi.skills.includes("./.pi/skills"));
  const skill = await readFile(new URL("../../../.pi/skills/decision-policy/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /policy_config.*action:"commit"/);
  const packaging = await readFile(join(root, "scripts", "prepare-package-skills.mjs"), "utf8");
  assert.match(packaging, /\.pi.*skills|skills.*\.pi/s);
});
test("under-lock owner cancellation prevents late publication and cleans temporary draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "policy-guard-"));
  const draft = DecisionPolicySchema.parse({});
  try {
    let checks = 0;
    await assert.rejects(saveDecisionPolicy(cwd, draft, 0, () => { checks++; if (checks === 2) throw new Error("owner cancelled"); }), /owner cancelled/);
    assert.equal(await loadDecisionPolicy(cwd), undefined);
    assert.deepEqual(await readdir(join(cwd, ".pi")), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("policy publication shares a synchronous commit point with the final owner check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "policy-commit-point-"));
  const abort = new AbortController();
  let checks = 0;
  let publishedAtCancellation = false;
  try {
    const saved = await saveDecisionPolicy(cwd, DecisionPolicySchema.parse({ backend: "llm" }), 0, () => {
      abort.signal.throwIfAborted();
      if (++checks === 2) queueMicrotask(() => {
        publishedAtCancellation = existsSync(join(cwd, ".pi", "decision-policy.json"));
        abort.abort();
      });
    });
    assert.equal(publishedAtCancellation, true, "no event-loop turn may separate owner check and publication");
    assert.equal(saved.revision, 1);
    assert.equal((await loadDecisionPolicy(cwd))?.backend, "llm");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

async function realHostGrant(cwd: string) {
  const previous = process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_CHILD;
  const events = new Map<string, Function[]>(); let terminal!: (data: string) => unknown;
  const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root" }, ui: { notify() {}, onTerminalInput(handler: typeof terminal) { terminal = handler; return () => {}; }, getEditorText: () => "/plan-auto on", setEditorText() {} } } as unknown as ExtensionContext;
  registerPlanAuto({ registerCommand() {}, registerShortcut() {}, appendEntry() {}, on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); } } as unknown as ExtensionAPI, { isPlanMode: () => true, onStateChange() {} });
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
  beginPlanAutoCycle(ctx, { markdown: "# Implement src/helper.ts within existing contracts", revision: 1, handoffKey: "approved-task" });
  terminal("\r"); assert.ok(getPlanAutoSnapshot(ctx));
  if (previous !== undefined) process.env.PI_TEAMMATE_CHILD = previous;
  return ctx;
}
test("actual memory grant feeds the ask service; relayed actor scope must match root task without revoking it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-host-grant-"));
  try {
    const root = await realHostGrant(cwd);
    const task = { id: "1", subject: "Implement helper", description: "Use existing source constraints", status: "in_progress", assignee: { id: "child-1", kind: "teammate" }, planHandoffKey: "approved-task" } as TodoTask;
    const resolver = () => resolvePlanAutoAskPolicyGrant({ ...root }, root, { correlationId: "child-1", cwd }, [task]);
    const scoped = resolver(); assert.ok(scoped); assert.match(scoped.actorTaskInput!, /Implement helper/);
    for (const actor of [{ correlationId: "unknown", cwd }, { correlationId: "child-2", cwd }, { correlationId: "child-1", cwd: "remote:device" }, { correlationId: "child-1", cwd: `${cwd}-other` }]) {
      assert.equal(resolvePlanAutoAskPolicyGrant(root, root, actor, [task]), undefined); assert.ok(getPlanAutoSnapshot(root));
    }
    assert.equal(resolvePlanAutoAskPolicyGrant({ ...root, cwd: `${cwd}-other` }, root), undefined); assert.ok(getPlanAutoSnapshot(root));
    assert.equal(resolvePlanAutoAskPolicyGrant(root, root, { correlationId: "child-1", cwd }, [{ ...task, planHandoffKey: "old-task" }]), undefined);
    const service = createDecisionPolicyService({ loadSpecs: async () => "", classifierUnavailableReason: () => "disabled", structured: async (request) => ({ value: request.kind === "classification" ? { owner: "internal", candidateType: "unknown", worthCapturing: false, confidence: 0.95, matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID], rationale: "Source constraints" } : { recommendation: "Reuse existing helper", rationale: "Compatible", assumptions: [], matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID], needsExternalDecision: false } }) });
    const result = await executeAsk({ questions: [{ question: "Which helper in src/helper.ts?" }] }, { ...root, hasUI: false }, { resolveAskGrant: resolver, policyEvaluator: service.evaluate });
    assert.equal(result.isError, undefined); assert.deepEqual(result.details.answers, []); assert.equal(result.details.decisions?.[0].evaluation.owner, "internal");
    revokePlanAuto("off"); assert.equal(scoped.isCurrent(), false); assert.equal(resolver(), undefined);
    assert.equal(await loadDecisionPolicy(cwd), undefined);
  } finally { resetPlanAuto("test-end"); await rm(cwd, { recursive: true, force: true }); }
});
test("child ask relays first and cannot consult a host authorization resolver", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD; const previousSend = process.send;
  process.env.PI_TEAMMATE_CHILD = "1";
  process.send = ((message: any, callback: any) => { callback?.(); queueMicrotask(() => process.emit("message", { type: "teammate_interaction_response", requestId: message.requestId, result: { action: "answer", answers: [], decisions: [{ questionIndex: 0, question: "Which helper?", evaluation: { owner: "internal" } }] } })); return true; }) as typeof process.send;
  try {
    const ctx = { cwd: "child", sessionManager: { getSessionId: () => "child" } } as unknown as ExtensionContext;
    const result = await executeAsk({ questions: [{ question: "Which helper?" }] }, ctx, { resolveAskGrant: () => { throw new Error("child must relay first"); }, policyEvaluator: async () => { throw new Error("child must not classify"); } });
    assert.equal(result.isError, undefined); assert.deepEqual(result.details.answers, []); assert.equal(result.details.decisions?.[0].questionIndex, 0);
  } finally { process.send = previousSend; if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = previousChild; }
});

test("every canonical actor task material participates in classification and in-flight freshness", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-actor-material-"));
  try {
    const root = await realHostGrant(cwd);
    for (const field of ["skills", "resourceUris", "summary", "blockedBy"] as const) {
      const task = { id: "1", subject: "Implement helper", status: "in_progress", assignee: { id: "child-1", kind: "teammate" },
        planHandoffKey: "approved-task", skills: [], resourceUris: [], summary: "Original constraints", blockedBy: [] } as unknown as TodoTask;
      const resolver = () => resolvePlanAutoAskPolicyGrant(root, root, { correlationId: "child-1", cwd }, [task]);
      const original = resolver()!;
      const originalFingerprint = hostAskGrantFingerprint(original);
      let arrived!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => { arrived = resolve; });
      const paused = new Promise<void>((resolve) => { resume = resolve; });
      const service = createDecisionPolicyService({ loadSpecs: async () => "", classifierUnavailableReason: () => "disabled", structured: async (request) => {
        assert.ok(request.prompt.includes(field), `${field} must reach classification/advice input`);
        if (request.kind === "advice") { arrived(); await paused; }
        return { value: request.kind === "classification"
          ? { owner: "internal", candidateType: "unknown", worthCapturing: false, confidence: 0.95, matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID], rationale: "Source constraints" }
          : { recommendation: "Reuse existing helper", rationale: "Compatible", assumptions: [], matchedRuleIds: [PLAN_AUTO_ASK_RULE_ID], needsExternalDecision: false } };
      } });
      const pending = executeAsk({ questions: [{ question: "Which helper in src/helper.ts?" }] }, { ...root, hasUI: false }, { resolveAskGrant: resolver, policyEvaluator: service.evaluate });
      await reached;
      if (field === "skills") task.skills = [{ name: "source-constraints", role: "primary" }];
      if (field === "resourceUris") task.resourceUris = ["file:changed-constraints.md"];
      if (field === "summary") task.summary = "Changed constraints";
      if (field === "blockedBy") task.blockedBy = ["dependency"];
      assert.notEqual(hostAskGrantFingerprint(resolver()!), originalFingerprint, `${field} must change freshness identity`);
      resume();
      const result = await pending;
      assert.equal(result.isError, true, field);
      assert.deepEqual(result.details.answers, []);
      assert.equal(result.details.decisions, undefined, "old task recommendations must be discarded");
    }
  } finally { resetPlanAuto("test-end"); await rm(cwd, { recursive: true, force: true }); }
});

test("invalidated root or caller contexts cannot resolve memory authorization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-stale-resolver-"));
  try {
    const root = await realHostGrant(cwd);
    const invalidated = { get cwd(): never { throw new Error("Pi context invalidated"); } } as ExtensionContext;
    assert.equal(resolvePlanAutoAskPolicyGrant(invalidated, root), undefined);
    assert.equal(resolvePlanAutoAskPolicyGrant(root, invalidated), undefined);
    assert.ok(getPlanAutoSnapshot(root), "stale callers cannot revoke current root authorization");
  } finally { resetPlanAuto("test-end"); await rm(cwd, { recursive: true, force: true }); }
});
