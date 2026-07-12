import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installStatusline } from "../src/statusline/statusline.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const statuses = new Map<string, string>();
  let component: { render(width: number): string[]; dispose?(): void } | undefined;
  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
  const pi = {
    on(name: string, handler: EventHandler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    async exec() { return { code: 1, stdout: "", stderr: "" }; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "D:\\pi-maestro-flow",
    hasUI: true,
    model: { id: "claude-test" },
    getContextUsage: () => ({ percent: 42 }),
    ui: {
      setFooter(factory: Function) {
        component = factory({ requestRender() {} }, {}, footerData);
      },
    },
  } as unknown as ExtensionContext;

  installStatusline(pi, () => ({ activeRuns: new Map() }));
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);

  return {
    statuses,
    render(width: number): string[] {
      assert.ok(component);
      return component.render(width);
    },
    dispose() {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
      component?.dispose?.();
    },
  };
}

test("statusline links approval mode with ACT, PLAN and READY using width-aware labels", () => {
  const harness = createHarness();
  try {
    for (const [status, approval, full, compact, narrow] of [
      ["ACT", "APPROVAL default", "[A] ACT · APPROVAL default", "ACT/default", "A/D"],
      ["ACT", "APPROVAL acceptEdits", "[A] ACT · APPROVAL acceptEdits", "ACT/acceptEdits", "A/E"],
      ["PLAN", "APPROVAL default", "[P] PLAN · APPROVAL plan", "PLAN/plan", "P/P"],
      ["READY", "APPROVAL bypassPermissions", "[P] READY · APPROVAL plan", "READY/plan", "R/P"],
    ] as const) {
      harness.statuses.set("mode", status);
      harness.statuses.set("approval-mode", approval);
      assert.ok(stripAnsi(harness.render(100)[0]).startsWith(full));
      assert.ok(stripAnsi(harness.render(60)[0]).startsWith(compact));
      assert.ok(stripAnsi(harness.render(30)[0]).startsWith(narrow));
    }

    for (let width = 1; width <= 120; width++) {
      for (const line of harness.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
      }
    }
  } finally {
    harness.dispose();
  }
});

test("statusline renders context pressure across full compact and narrow widths", () => {
  const harness = createHarness();
  try {
    harness.statuses.set("mode", "ACT");
    harness.statuses.set("approval-mode", "APPROVAL default");
    harness.statuses.set("maestro-auto-compact", "CTX AUTO-PRUNE 82000/90000 -3");
    assert.equal(harness.render(120).length, 2);
    assert.match(stripAnsi(harness.render(120)[1]), /CTX AUTO-PRUNE 82000\/90000 -3/);
    assert.match(stripAnsi(harness.render(70)[1]), /PRUNE -3/);
    assert.match(stripAnsi(harness.render(36)[0]), /P!/);
    assert.equal(harness.render(36).length, 1);

    harness.statuses.set("maestro-auto-compact", "CTX CRITICAL 91000/90000");
    assert.match(stripAnsi(harness.render(120)[1]), /CTX CRITICAL 91000\/90000/);
    assert.match(stripAnsi(harness.render(36)[0]), /C!/);

    harness.statuses.set("maestro-auto-compact", "COMPACT 91000/90000");
    assert.match(stripAnsi(harness.render(120)[1]), /CTX COMPACT 91000\/90000/);
    assert.match(stripAnsi(harness.render(36)[0]), /C\*/);

    harness.statuses.delete("maestro-auto-compact");
    assert.equal(harness.render(120).length, 1);
    assert.doesNotMatch(stripAnsi(harness.render(120)[0]), /AUTO-PRUNE|CRITICAL|P!|C!/);

    for (let width = 1; width <= 120; width++) {
      for (const line of harness.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
      }
    }
  } finally {
    harness.dispose();
  }
});
