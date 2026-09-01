import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openPlanConfirmation } from "../src/tools/plan-confirm.ts";
import { openPlanEditor } from "../src/tools/plan-editor.ts";
import { renderRollbackOverlay } from "../src/tui/plan-rollback-overlay.ts";

function createHarness() {
  let component: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | undefined;
  let doneValue: unknown;
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
      component = factory(tui, theme, {}, (value: unknown) => {
        doneValue = value;
        doneResolve?.(value);
      });
      return donePromise;
    },
  };
  return {
    ctx: { hasUI: true, ui } as unknown as ExtensionContext,
    get component() { return component; },
    get doneValue() { return doneValue; },
  };
}

test("Plan editor renders line numbers, current-line marker and bounded widths", async () => {
  const harness = createHarness();
  const pending = openPlanEditor(harness.ctx, {
    markdown: "# Plan\n\nFirst step",
    revision: 2,
    allowConfirm: true,
    async onSave() { return 3; },
    async onConfirm() {},
  });
  assert.ok(harness.component);
  for (const width of [20, 40, 80, 120]) {
    const lines = harness.component.render(width);
    assert.match(lines.join("\n"), />\s+3\s+│/);
    if (width >= 80) assert.match(lines.join("\n"), /Ctrl\+Enter/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
  }
  harness.component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.action, "cancelled");
});

test("Plan rollback overlay aborts and disposes with one exact close", async () => {
  let component: { handleInput(data: string): void; dispose(): void } | undefined;
  let doneCalls = 0;
  let resolveDone: ((value: unknown) => void) | undefined;
  const donePromise = new Promise<unknown>((resolve) => { resolveDone = resolve; });
  const ctx = {
    hasUI: true,
    ui: {
      async custom(factory: Function) {
        component = factory(
          { requestRender() {} },
          { fg: (_name: string, text: string) => text, bold: (text: string) => text },
          {},
          (value: unknown) => {
            doneCalls += 1;
            resolveDone?.(value);
          },
        );
        return donePromise;
      },
    },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const pending = renderRollbackOverlay(ctx, {
    drafts: [{
      revision: 2,
      checksum: "abcdef0123456789",
      archivedAt: "20260824T100000Z",
      path: "drafts/r2.md",
    }],
    async readDraft() { return "# archived"; },
    signal: controller.signal,
  });
  assert.ok(component);

  controller.abort();
  component.dispose();
  component.handleInput("\x1b");

  assert.deepEqual(await pending, { action: "cancel" });
  assert.equal(doneCalls, 1);
});

test("Plan editor abort closes the custom UI as cancelled", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const pending = openPlanEditor(harness.ctx, {
    markdown: "draft",
    revision: 1,
    allowConfirm: false,
    signal: controller.signal,
    async onSave() { return 2; },
    async onConfirm() {},
  });
  assert.ok(harness.component);
  controller.abort();
  assert.deepEqual(await pending, { action: "cancelled", markdown: "draft", revision: 1 });
});

test("Plan editor saves without closing and confirms the exact edited buffer", async () => {
  const harness = createHarness();
  const saves: Array<{ markdown: string; revision: number }> = [];
  const confirmations: Array<{ markdown: string; revision: number }> = [];
  const pending = openPlanEditor(harness.ctx, {
    markdown: "draft",
    revision: 4,
    allowConfirm: true,
    async onSave(markdown, revision) {
      saves.push({ markdown, revision });
      return revision + 1;
    },
    async onConfirm(markdown, revision) {
      confirmations.push({ markdown, revision });
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput(" updated");
  harness.component.handleInput("\x13");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.doneValue, undefined);
  assert.deepEqual(saves, [{ markdown: "draft updated", revision: 4 }]);

  harness.component.handleInput("\x1b[27;5;13~");
  const result = await pending;
  assert.equal(result.action, "approved");
  assert.deepEqual(confirmations, [{ markdown: "draft updated", revision: 5 }]);
});

test("Plan confirmation renders execution controls without a New Pi session option", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Approved Plan\n\n- Preserve boundaries",
    pathLabel: "current.md",
    canCompactContext: true,
    contextPercent: 75,
  });
  assert.ok(harness.component);
  for (const width of [20, 40, 80, 120]) {
    const lines = harness.component.render(width);
    const rendered = lines.join("\n");
    assert.match(rendered, /Plan confirm|Plan confirmation/);
    assert.doesNotMatch(rendered, /new Pi session|new session/i);
    if (width >= 40) {
      assert.match(lines[0], /╭/);
      assert.match(lines.at(-1) ?? "", /╰/);
      assert.match(rendered, /Execution\s+\[Standalone\]/);
      assert.match(rendered, /Context\s+\[Current\]/);
      assert.match(rendered, /1\. Execute/);
      assert.match(rendered, /2\. View \/ modify Plan/);
      assert.match(rendered, /3\. Review & Refine/);
      assert.match(rendered, /4\. Continue discussion/);
      assert.match(rendered, /5\. Exit Plan mode/);
      assert.ok(lines.length <= 28);
    }
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
  }
  harness.component.handleInput("1");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "standalone", context: "current" },
  });
});

test("Plan confirmation abort closes the custom UI", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    signal: controller.signal,
  });
  assert.ok(harness.component);
  controller.abort();
  assert.deepEqual(await pending, { action: "close" });
});

test("Plan confirmation selects compact execution in the current Pi session", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Approved Plan",
    canCompactContext: true,
  });
  assert.ok(harness.component);
  harness.component.render(100);
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[C");
  assert.match(harness.component.render(100).join("\n"), /Context\s+\[Compact current\]/);
  harness.component.handleInput("\x1b[27;5;13~");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "standalone", context: "compact" },
  });
});

test("Plan confirmation selects current or new Workflow Session independently from Pi context", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Workflow Plan",
    canCompactContext: true,
    workflow: {
      current: { sessionId: "workflow-1", intent: "Implement workflow plan", available: true },
      allowNew: true,
    },
  });
  assert.ok(harness.component);
  harness.component.render(120);
  harness.component.handleInput("\x1b[C");
  assert.match(harness.component.render(120).join("\n"), /Execution\s+\[Workflow\]/);
  assert.match(harness.component.render(120).join("\n"), /Workflow target\s+\[Current: workflow-1\]/);
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[C");
  assert.match(harness.component.render(120).join("\n"), /Workflow target\s+\[Create new Session\]/);
  harness.component.handleInput("\x1b[27;5;13~");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "workflow", context: "current", workflowTarget: "new" },
  });
});

test("Plan confirmation keeps Workflow execution unavailable without a writable target", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    workflow: {
      current: { sessionId: "workflow-1", intent: "Other work", available: false, reason: "Owned by another Pi session" },
      allowNew: false,
    },
  });
  assert.ok(harness.component);
  harness.component.render(100);
  harness.component.handleInput("\x1b[C");
  assert.match(harness.component.render(100).join("\n"), /Owned by another Pi session/);
  harness.component.handleInput("\x1b[27;5;13~");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "standalone", context: "current" },
  });
});

test("Plan confirmation accepts Ctrl+Enter across modifyOtherKeys encoding", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[27;5;13~");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "standalone", context: "current" },
  });
});

test("Plan confirmation number keys match the numbered actions", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  harness.component.handleInput("2");
  assert.deepEqual(await pending, { action: "modify" });
});

test("Plan confirmation uses arrow keys to select actions after the Plan reaches the bottom", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: Array.from({ length: 40 }, (_, index) => `Plan line ${index + 1}`).join("\n\n"),
  });
  assert.ok(harness.component);
  harness.component.render(80);
  for (let index = 0; index < 20; index++) harness.component.handleInput("\x1b[6~");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  assert.deepEqual(await pending, {
    action: "execute",
    execution: { backend: "standalone", context: "current" },
  });
});

test("Plan confirmation returns to Plan scrolling when Up leaves the first control", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: Array.from({ length: 40 }, (_, index) => `Plan line ${index + 1}`).join("\n\n"),
  });
  assert.ok(harness.component);
  harness.component.render(80);
  for (let index = 0; index < 20; index++) harness.component.handleInput("\x1b[6~");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[A");
  harness.component.handleInput("\x1b[A");
  const range = harness.component.render(80).join("\n").match(/Plan \d+-(\d+)\/(\d+)/);
  assert.ok(range);
  assert.ok(Number(range[1]) < Number(range[2]));
  harness.component.handleInput("\x1b");
  assert.deepEqual(await pending, { action: "close" });
});

test("Plan confirmation exposes continue discussion as the fourth action", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  harness.component.handleInput("4");
  assert.deepEqual(await pending, { action: "continue" });
});

test("Plan confirmation exposes exiting Plan mode as the fifth action", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  harness.component.handleInput("5");
  assert.deepEqual(await pending, { action: "exit-plan" });
});

test("Plan confirmation blocks invisible actions below 20 columns", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  harness.component.render(12);
  harness.component.handleInput("1");
  harness.component.handleInput("\r");
  harness.component.handleInput("\x1b[27;5;13~");
  assert.equal(harness.doneValue, undefined);
  harness.component.handleInput("\x1b");
  assert.deepEqual(await pending, { action: "close" });
});

test("Plan editor blocks invisible editing below the minimum width", async () => {
  const harness = createHarness();
  const pending = openPlanEditor(harness.ctx, {
    markdown: "safe draft",
    revision: 1,
    allowConfirm: true,
    async onSave() { return 2; },
    async onConfirm() {},
  });
  assert.ok(harness.component);
  assert.match(harness.component.render(12).join("\n"), /Esc/);
  harness.component.handleInput(" hidden mutation");
  harness.component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.markdown, "safe draft");
});

test("Plan editor keeps the buffer open when approval fails", async () => {
  const harness = createHarness();
  const pending = openPlanEditor(harness.ctx, {
    markdown: "important draft",
    revision: 1,
    allowConfirm: true,
    async onSave() { return 2; },
    async onConfirm() { throw new Error("disk full"); },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[13;5u");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.doneValue, undefined);
  assert.match(harness.component.render(80).join("\n"), /approval failed: disk full/);
  harness.component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.action, "cancelled");
  assert.equal(result.markdown, "important draft");
});

test("Plan editor ignores Esc while approval is in flight", async () => {
  const harness = createHarness();
  let releaseApproval: (() => void) | undefined;
  const pending = openPlanEditor(harness.ctx, {
    markdown: "race-safe draft",
    revision: 3,
    allowConfirm: true,
    async onSave() { return 4; },
    async onConfirm() {
      await new Promise<void>((resolve) => { releaseApproval = resolve; });
    },
  });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[13;5u");
  harness.component.handleInput("\x1b");
  assert.equal(harness.doneValue, undefined);
  releaseApproval?.();
  const result = await pending;
  assert.equal(result.action, "approved");
});

test("Plan confirmation exposes only the unified Review & Refine action", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  const rendered = harness.component.render(80).join("\n");
  assert.match(rendered, /3\. Review & Refine/);
  assert.doesNotMatch(rendered, /Review with AI subagent|Apply review feedback|Review report/);
  harness.component.handleInput("3");
  assert.deepEqual(await pending, { action: "refine" });
});

test("Plan confirmation shows the rollback action only when archived drafts exist", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, { markdown: "# Plan" });
  assert.ok(harness.component);
  let rendered = harness.component.render(80).join("\n");
  assert.doesNotMatch(rendered, /Rollback to draft version/);
  harness.component.handleInput("\x1b");
  await pending;

  const harness2 = createHarness();
  const pending2 = openPlanConfirmation(harness2.ctx, {
    markdown: "# Plan",
    drafts: [{ revision: 2, archivedAt: "20260824T100000Z", checksum: "ab12cd34" }],
  });
  assert.ok(harness2.component);
  rendered = harness2.component.render(80).join("\n");
  assert.match(rendered, /Rollback to draft version/);
  harness2.component.handleInput("\x1b");
  await pending2;
});

test("Plan confirmation keeps refine Apply/Discard actions inside the refine panel", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Approved Plan\n\n- Step",
  });
  assert.ok(harness.component);
  const before = harness.component.render(80).join("\n");
  assert.match(before, /3\. Review & Refine/);
  assert.match(before, /Approved Plan/);
  assert.doesNotMatch(before, /Refine result attached/);
  assert.doesNotMatch(before, /Apply refine result/);
  assert.doesNotMatch(before, /Discard refine result/);
  assert.doesNotMatch(before, /R:/);
  harness.component.handleInput("R");
  const after = harness.component.render(80).join("\n");
  assert.match(after, /Approved Plan/);
  assert.doesNotMatch(after, /Apply refine result|Discard refine result|R:/);
  harness.component.handleInput("\x1b");
  assert.deepEqual(await pending, { action: "close" });
});
