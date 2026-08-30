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
  let component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
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
    assert.match(lines.join("\n"), /› 4\. Run review\/refine/);
    assert.ok(lines.length <= 32, `width ${width}: ${lines.length} lines`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
  }

  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  assert.match(harness.component.render(80).join("\n"), /› 1\. Role/);
  harness.component.handleInput("\x1b[C");
  assert.equal(session.currentRole, "decomposer");
  harness.component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.action, "cancel");
});

test("Review & Refine cursor activates model, input, run, apply, and discard rows", async () => {
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

  assert.match(harness.component.render(80).join("\n"), /4\. Re-run review\/refine/);
  harness.component.handleInput("5");
  const result = await pending;
  assert.equal(result.action, "apply");
  assert.equal(result.latestOutput, "## Result\naccepted");
});

test("Review & Refine keeps the persisted Artifact timestamp and surfaces save warnings", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    async pickModel() { return undefined; },
    async run() {
      return {
        ok: true,
        output: "# Review output",
        createdAt: "2026-08-28T12:00:00.000Z",
        warning: "Review result is visible but could not be saved as an Artifact: disk full",
      };
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.turns[0]?.createdAt, "2026-08-28T12:00:00.000Z");
  assert.match(harness.component.render(100).join("\n"), /could not be saved as an Artifact/);
  harness.component.handleInput("d");
  assert.equal((await pending).action, "discard");
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
  assert.equal(result.action, "discard");
});

test("Review & Refine Up/Down browses the preview before moving between controls", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: Array.from({ length: 50 }, (_, index) => `Plan line ${index + 1}`).join("\n\n"),
    session,
    roles: REFINE_ROLES,
    async pickModel() { return undefined; },
    async run() { return { ok: true, output: "reviewed" }; },
  });
  assert.ok(harness.component);
  assert.match(harness.component.render(80).join("\n"), /Plan · 1-/);

  harness.component.handleInput("\x1b[B");
  let rendered = harness.component.render(80).join("\n");
  assert.match(rendered, /Plan · 2-/);
  assert.match(rendered, /› 4\. Run review\/refine/);
  harness.component.handleInput("\x1b[A");
  rendered = harness.component.render(80).join("\n");
  assert.match(rendered, /Plan · 1-/);
  assert.match(rendered, /› 4\. Run review\/refine/);

  for (let index = 0; index < 30; index++) harness.component.handleInput("\x1b[6~");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[B");
  assert.match(harness.component.render(80).join("\n"), /› 6\. Discard \(return to Plan\)/);
  harness.component.handleInput("d");
  const result = await pending;
  assert.equal(result.action, "discard");
});

test("Review & Refine shows elapsed time and Esc aborts only the active run", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const parent = new AbortController();
  let clock = 10_000;
  let runSignal: AbortSignal | undefined;
  let resolveRun: ((result: { ok: true; output: string }) => void) | undefined;
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    signal: parent.signal,
    now: () => clock,
    async pickModel() { return undefined; },
    async run(_role, _model, _label, _userInput, signal) {
      runSignal = signal;
      return new Promise((resolve) => { resolveRun = resolve; });
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runSignal);
  assert.notEqual(runSignal, parent.signal);
  assert.equal(runSignal.aborted, false);

  clock = 22_345;
  assert.match(harness.component.render(80).join("\n"), /Running .* 12s · Esc cancel/);
  harness.component.handleInput("\x1b");
  assert.equal(runSignal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.match(harness.component.render(80).join("\n"), /cancelled/);

  resolveRun?.({ ok: true, output: "late output" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.turns.length, 0, "a cancelled run must discard late output");
  harness.component.handleInput("d");
  const result = await pending;
  assert.equal(result.action, "discard");
  assert.equal(result.latestOutput, undefined);
});

test("Review & Refine composes the parent abort signal into each run", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  const parent = new AbortController();
  let runSignal: AbortSignal | undefined;
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    signal: parent.signal,
    async pickModel() { return undefined; },
    async run(_role, _model, _label, _userInput, signal) {
      runSignal = signal;
      return new Promise(() => {});
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runSignal);

  parent.abort();
  assert.equal(runSignal.aborted, true);
  const result = await pending;
  assert.equal(result.action, "cancel");
});

test("Review & Refine settles as cancelled when the parent aborts while idle", async () => {
  const harness = createOverlayHarness();
  const parent = new AbortController();
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session: overlaySession(),
    roles: REFINE_ROLES,
    signal: parent.signal,
    async pickModel() { return undefined; },
    async run() { return { ok: true, output: "unused" }; },
  });
  parent.abort();
  assert.equal((await pending).action, "cancel");
});

test("Review & Refine disposal aborts the run and settles the overlay", async () => {
  const harness = createOverlayHarness();
  const session = overlaySession();
  let runSignal: AbortSignal | undefined;
  let resolveRun: ((result: { ok: true; output: string }) => void) | undefined;
  const pending = renderRefineOverlay(harness.ctx, {
    markdown: PLAN,
    session,
    roles: REFINE_ROLES,
    async pickModel() { return undefined; },
    async run(_role, _model, _label, _userInput, signal) {
      runSignal = signal;
      return new Promise((resolve) => { resolveRun = resolve; });
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  harness.component.dispose();

  assert.equal(runSignal?.aborted, true);
  assert.equal((await pending).action, "cancel");
  resolveRun?.({ ok: true, output: "late output" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.turns.length, 0);
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
