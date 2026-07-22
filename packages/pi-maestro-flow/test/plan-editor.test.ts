import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openPlanConfirmation } from "../src/tools/plan-confirm.ts";
import { openPlanEditor } from "../src/tools/plan-editor.ts";

function createHarness() {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
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

test("Plan confirmation renders Markdown and selects compact execution", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Approved Plan\n\n- Preserve boundaries",
    pathLabel: "current.md",
    canClearContext: true,
  });
  assert.ok(harness.component);
  for (const width of [20, 40, 80, 120]) {
    const lines = harness.component.render(width);
    assert.match(lines.join("\n"), /Plan confirm|Plan confirmation/);
    if (width >= 40) {
      assert.match(lines[0], /╭/);
      assert.match(lines.at(-1) ?? "", /╰/);
      assert.match(lines.join("\n"), /1\. Execute/);
      assert.match(lines.join("\n"), /2\. Execute in new session/);
      assert.match(lines.join("\n"), /3\. Compact then execute/);
      assert.match(lines.join("\n"), /4\. Modify Plan/);
      assert.match(lines.join("\n"), /5\. Exit Plan mode/);
      assert.ok(lines.length <= 28);
    }
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
  }
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  assert.equal(await pending, "execute-compact");
});

test("Plan confirmation keeps clear-context execution unavailable outside command context", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    canClearContext: false,
  });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  assert.equal(harness.doneValue, undefined);
  assert.match(harness.component.render(100).join("\n"), /Use \/plan approve/);
  harness.component.handleInput("\x1b");
  assert.equal(await pending, "cancel");
});

test("Plan confirmation keeps compact execution unavailable from tool-result context", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    canClearContext: false,
    canCompactContext: false,
  });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  assert.equal(harness.doneValue, undefined);
  assert.match(harness.component.render(100).join("\n"), /Use \/plan approve to compact before execution/);
  harness.component.handleInput("\x1b");
  assert.equal(await pending, "cancel");
});

test("Plan confirmation accepts Ctrl+Enter across modifyOtherKeys encoding", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    canClearContext: true,
  });
  assert.ok(harness.component);
  harness.component.handleInput("\x1b[27;5;13~");
  assert.equal(await pending, "execute");
});

test("Plan confirmation number keys match the numbered actions", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    canClearContext: true,
  });
  assert.ok(harness.component);
  harness.component.handleInput("4");
  assert.equal(await pending, "modify");
});

test("Plan confirmation blocks invisible actions below 20 columns", async () => {
  const harness = createHarness();
  const pending = openPlanConfirmation(harness.ctx, {
    markdown: "# Plan",
    canClearContext: true,
  });
  assert.ok(harness.component);
  harness.component.render(12);
  harness.component.handleInput("1");
  harness.component.handleInput("\r");
  harness.component.handleInput("\x1b[27;5;13~");
  assert.equal(harness.doneValue, undefined);
  harness.component.handleInput("\x1b");
  assert.equal(await pending, "cancel");
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
