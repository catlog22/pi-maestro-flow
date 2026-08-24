import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
import { renderRefineOverlay } from "../src/tui/plan-refine-overlay.ts";

const PLAN = "# Plan\n\n- Step one\n- Step two";

function createOverlayHarness() {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let doneResolve: ((value: unknown) => void) | undefined;
  const donePromise = new Promise<unknown>((resolve) => { doneResolve = resolve; });
  const tui = { requestRender() {} };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ui = {
    async custom(factory: Function) {
      component = factory(tui, theme, {}, (value: unknown) => doneResolve?.(value));
      return donePromise;
    },
  };
  return {
    ctx: { hasUI: true, ui } as unknown as ExtensionContext,
    get component() { return component; },
  };
}

function overlaySession(): RefineSession {
  const session = createRefineSession("reviewer", "provider/session");
  session.currentModel.model = "provider/session";
  return session;
}

test("Review & Refine overlay renders a bounded cursor and changes Role with arrows", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    async pickModel() { return undefined; },
    async run() { return { ok: true, output: "reviewed" }; },
  });
  assert.ok(harness.component);
  for (const width of [40, 80, 120]) {
    const lines = harness.component.render(width);
    assert.match(lines.join("\n"), /› Run review\/refine/);
    assert.ok(lines.length <= 32, `width ${width}: ${lines.length} lines`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
  }

  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  assert.match(harness.component.render(80).join("\n"), /› Role/);
  harness.component.handleInput("\x1b[C");
  assert.equal(session.currentRole, "decomposer");
  harness.component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.action, "cancel");
});

test("Review & Refine cursor activates model, input, run, and done rows", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const runs: Array<{ role: RefineRole; model: string; input: string }> = [];
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    async pickModel() { return { model: "provider/picked", label: "Picked model" }; },
    async run(role, model, _label, userInput) {
      runs.push({ role, model, input: userInput });
      return { ok: true, output: "## Result\naccepted" };
    },
  });
  assert.ok(harness.component);
  harness.component.render(80);

  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.currentModel.model, "provider/picked");

  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  harness.component.handleInput("focus acceptance");
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [{ role: "reviewer", model: "provider/picked", input: "focus acceptance" }]);

  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  const result = await pending;
  assert.equal(result.action, "done");
  assert.equal(result.latestOutput, "## Result\naccepted");
});

test("Review & Refine overlay scrolls long previews and keeps shortcut compatibility", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: Array.from({ length: 50 }, (_, index) => `Plan line ${index + 1}`).join("\n\n"),
    session,
    roles: REFINE_ROLES,
    async pickModel() { return { model: "provider/shortcut", label: "Shortcut model" }; },
    async run() { return { ok: true, output: "shortcut output" }; },
  });
  assert.ok(harness.component);
  let rendered = harness.component.render(80).join("\n");
  assert.match(rendered, /Plan · 1-/);
  harness.component.handleInput("\x1b[6~");
  rendered = harness.component.render(80).join("\n");
  assert.match(rendered, /Plan · 6-/);

  harness.component.handleInput("m");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.currentModel.model, "provider/shortcut");
  harness.component.handleInput("i");
  harness.component.handleInput("\x1b");
  harness.component.handleInput("d");
  const result = await pending;
  assert.equal(result.action, "done");
});

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
