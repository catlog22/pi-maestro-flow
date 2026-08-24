import assert from "node:assert/strict";
import test from "node:test";
import {
  REFINE_ROLES,
  buildDecomposerPrompt,
  buildOptimizerPrompt,
  buildBrainstormerPrompt,
  createRefineSession,
  cycleRole,
  type RefineRole,
  type RefineSession,
  type RefineTurn,
} from "../src/tools/plan-refine.ts";
import { buildReviewPrompt } from "../src/tools/plan-review.ts";

const PLAN = "# Plan\n\n- Step one\n- Step two";

test("REFINE_ROLES defines four roles with distinct labels and appliesAs", () => {
  const roles = Object.keys(REFINE_ROLES) as RefineRole[];
  assert.deepEqual(roles.sort(), ["brainstormer", "decomposer", "optimizer", "reviewer"]);
  assert.equal(REFINE_ROLES.reviewer.appliesAs, "feedback");
  assert.equal(REFINE_ROLES.decomposer.appliesAs, "feedback");
  assert.equal(REFINE_ROLES.optimizer.appliesAs, "draft");
  assert.equal(REFINE_ROLES.brainstormer.appliesAs, "feedback");
  for (const role of roles) {
    assert.ok(REFINE_ROLES[role].label.length > 0);
    assert.ok(typeof REFINE_ROLES[role].taskType === "string");
  }
});

test("reviewer role reuses buildReviewPrompt and appends user input", () => {
  const prompt = REFINE_ROLES.reviewer.buildPrompt(PLAN, [], "focus on acceptance criteria");
  assert.match(prompt, /<plan>/);
  assert.match(prompt, /## 本次用户指令\nfocus on acceptance criteria/);
  // Should include the reviewer's standard dimensions.
  assert.match(prompt, /总体结论/);
});

test("reviewer role prompt omits the user-input section when input is blank", () => {
  const prompt = REFINE_ROLES.reviewer.buildPrompt(PLAN, [], "");
  assert.match(prompt, /<plan>/);
  assert.doesNotMatch(prompt, /本次用户指令/);
});

test("buildDecomposerPrompt emits the decomposition structure sections", () => {
  const prompt = buildDecomposerPrompt(PLAN, [], "");
  assert.match(prompt, /步骤图/);
  assert.match(prompt, /关键路径与并行/);
  assert.match(prompt, /<plan>/);
  assert.match(prompt, /拆解官/);
});

test("buildOptimizerPrompt asks for a complete rewriteable draft", () => {
  const prompt = buildOptimizerPrompt(PLAN, [], "");
  assert.match(prompt, /可直接作为 current\.md/);
  assert.match(prompt, /<plan>/);
  assert.match(prompt, /优化官/);
});

test("buildBrainstormerPrompt emits omission/boundary/open-question sections", () => {
  const prompt = buildBrainstormerPrompt(PLAN, [], "");
  assert.match(prompt, /遗漏目标/);
  assert.match(prompt, /开放问题/);
  assert.match(prompt, /<plan>/);
  assert.match(prompt, /脑暴官/);
});

test("role prompts inject prior same-role history and cap the budget", () => {
  const longOutput = "x".repeat(5000);
  const history: RefineTurn[] = [
    { role: "reviewer", modelLabel: "provider/reviewer", userInput: "", output: "## 总体结论\nrevise", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "decomposer", modelLabel: "provider/reviewer", userInput: "", output: "## 步骤图\nold", createdAt: "2026-08-24T10:00:01.000Z" },
    { role: "decomposer", modelLabel: "provider/reviewer", userInput: "", output: longOutput, createdAt: "2026-08-24T10:00:02.000Z" },
  ];
  const prompt = buildDecomposerPrompt(PLAN, history, "");
  assert.match(prompt, /前次 refine 输出（共 2 份/);
  assert.match(prompt, /前次输出 1（model: provider\/reviewer）/);
  // The 5000-char report must be truncated below the budget.
  assert.ok(!prompt.includes(longOutput));
  assert.match(prompt, /…/);
});

test("role prompts only include their own role's history", () => {
  const history: RefineTurn[] = [
    { role: "reviewer", modelLabel: "r", userInput: "", output: "reviewer output", createdAt: "" },
    { role: "decomposer", modelLabel: "d", userInput: "", output: "decomposer output", createdAt: "" },
  ];
  const reviewerPrompt = REFINE_ROLES.reviewer.buildPrompt(PLAN, history, "");
  assert.match(reviewerPrompt, /reviewer output/);
  assert.doesNotMatch(reviewerPrompt, /decomposer output/);
  const decomposerPrompt = buildDecomposerPrompt(PLAN, history, "");
  assert.match(decomposerPrompt, /decomposer output/);
  assert.doesNotMatch(decomposerPrompt, /reviewer output/);
});

test("createRefineSession defaults to the reviewer role and session model label", () => {
  const session = createRefineSession("reviewer", "provider/session");
  assert.equal(session.currentRole, "reviewer");
  assert.equal(session.turns.length, 0);
  assert.equal(session.currentModel.label, "provider/session");
});

test("cycleRole wraps through all four roles in both directions", () => {
  assert.equal(cycleRole("reviewer", 1), "decomposer");
  assert.equal(cycleRole("decomposer", 1), "optimizer");
  assert.equal(cycleRole("optimizer", 1), "brainstormer");
  assert.equal(cycleRole("brainstormer", 1), "reviewer");
  assert.equal(cycleRole("reviewer", -1), "brainstormer");
  assert.equal(cycleRole("brainstormer", -1), "optimizer");
});

test("createRefineSession uses Follow session model when no label is provided", () => {
  const session = createRefineSession("optimizer", "");
  assert.equal(session.currentModel.label, "Follow session model");
});

test("buildReviewPrompt stays importable and unchanged from plan-review", () => {
  // Sanity: the reviewer prompt path is the same underlying builder.
  const direct = buildReviewPrompt(PLAN, []);
  const viaRole = REFINE_ROLES.reviewer.buildPrompt(PLAN, [], "");
  assert.equal(direct, viaRole);
});
