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

test("statusline reflects ACT, PLAN and READY with width-aware labels", () => {
  const harness = createHarness();
  try {
    for (const [status, full, compact, narrow] of [
      ["ACT", "[A] ACT", "ACT", "A"],
      ["PLAN", "[P] PLAN", "PLAN", "P"],
      ["READY", "[P] READY", "READY", "R"],
    ] as const) {
      harness.statuses.set("mode", status);
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
