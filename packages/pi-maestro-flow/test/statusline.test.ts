import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowSnapshotLike } from "../src/session/view-model.ts";
import { installStatusline } from "../src/statusline/statusline.ts";
import { ansiFg, ANSI_BOLD, COLORS } from "../src/statusline/constants.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createHarness(options: {
  activeToolCalls?: number;
  workflowSnapshot?: WorkflowSnapshotLike;
  branchEntries?: unknown[];
  cwd?: string;
  exec?: (cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
} = {}) {
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
    async exec(_command: string, _args: string[], execOptions: { cwd?: string }) {
      return options.exec?.(execOptions.cwd ?? "") ?? { code: 1, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI;
  let branchEntries = options.branchEntries ?? [];
  let branchReads = 0;
  let branchEntryVisits = 0;
  let ctx = {
    cwd: options.cwd ?? "D:\\pi-maestro-flow",
    hasUI: true,
    model: { id: "claude-test" },
    getContextUsage: () => ({ percent: 42 }),
    sessionManager: {
      getBranch: () => {
        branchReads += 1;
        return {
          *[Symbol.iterator]() {
            for (const entry of branchEntries) {
              branchEntryVisits += 1;
              yield entry;
            }
          },
        };
      },
    },
    ui: {
      setFooter(factory: Function) {
        component = factory({ requestRender() {} }, {}, footerData);
      },
    },
  } as unknown as ExtensionContext;

  const activeToolCalls = new Map(Array.from(
    { length: options.activeToolCalls ?? 0 },
    (_, index) => [String(index), { action: "tool", startedAt: 0, correlationId: String(index) }],
  ));
  installStatusline(
    pi,
    () => ({ activeToolCalls }),
    () => options.workflowSnapshot,
  );
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);

  return {
    statuses,
    emit(name: string, event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    },
    startSession(nextCwd: string) {
      ctx = { ...ctx, cwd: nextCwd } as ExtensionContext;
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    },
    setBranch(entries: unknown[]) {
      branchEntries = entries;
    },
    tokenScanCounts() {
      return { branchReads, branchEntryVisits };
    },
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

test("statusline rejects initial and periodic Git results from an older Session", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: Array<{
    cwd: string;
    resolve(result: { code: number; stdout: string; stderr: string }): void;
  }> = [];
  const harness = createHarness({
    cwd: "D:\\old-session",
    exec: (cwd) => new Promise((resolve) => calls.push({ cwd, resolve })),
  });
  try {
    assert.deepEqual(calls.map((call) => call.cwd), ["D:\\old-session"]);

    t.mock.timers.tick(30_000);
    assert.deepEqual(
      calls.map((call) => call.cwd),
      ["D:\\old-session", "D:\\old-session"],
      "the old Session periodic refresh must be in flight before switching",
    );

    harness.startSession("D:\\new-session");
    assert.deepEqual(
      calls.map((call) => call.cwd),
      ["D:\\old-session", "D:\\old-session", "D:\\new-session"],
    );

    calls[2]!.resolve({ code: 0, stdout: "## new-branch\n", stderr: "" });
    await settleAsyncWork();
    assert.match(stripAnsi(harness.render(120)[0]), /new-branch/);

    calls[0]!.resolve({ code: 0, stdout: "## stale-initial\n", stderr: "" });
    calls[1]!.resolve({ code: 0, stdout: "## stale-periodic\n", stderr: "" });
    await settleAsyncWork();
    const rendered = stripAnsi(harness.render(120)[0]);
    assert.match(rendered, /new-branch/);
    assert.doesNotMatch(rendered, /stale-initial|stale-periodic/);
  } finally {
    harness.dispose();
    t.mock.timers.reset();
  }
});

test("statusline accumulates message usage incrementally and rebuilds only at branch lifecycle boundaries", () => {
  const initialBranch = Array.from({ length: 1_000 }, () => ({
    type: "message",
    message: { role: "assistant", usage: { input: 1, output: 2 } },
  }));
  const harness = createHarness({ branchEntries: initialBranch });
  try {
    assert.deepEqual(harness.tokenScanCounts(), { branchReads: 1, branchEntryVisits: 1_000 });

    for (let index = 0; index < 1_000; index++) {
      harness.emit("message_end", {
        type: "message_end",
        message: { role: "assistant", usage: { input: 1, output: 3 } },
      });
    }
    harness.emit("message_end", { type: "message_end", message: { role: "user" } });

    assert.deepEqual(
      harness.tokenScanCounts(),
      { branchReads: 1, branchEntryVisits: 1_000 },
      "message_end must remain O(1) instead of rescanning the growing branch",
    );
    assert.match(stripAnsi(harness.render(120)[0]), /↑2\.0k ↓5\.0k/);

    harness.setBranch([{
      type: "message",
      message: { role: "assistant", usage: { input: 7, output: 11 } },
    }]);
    harness.emit("session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "new" });
    assert.deepEqual(harness.tokenScanCounts(), { branchReads: 2, branchEntryVisits: 1_001 });
    assert.match(stripAnsi(harness.render(120)[0]), /↑7 ↓11/);
  } finally {
    harness.dispose();
  }
});

test("statusline links approval mode with ACT, PLAN and READY using width-aware labels", () => {
  const harness = createHarness();
  try {
    for (const [status, approval, full, compact, narrow] of [
      ["ACT", "APPROVAL default", "[A] ACT · APPROVAL default", "ACT/default", "A/D"],
      ["ACT", "APPROVAL acceptEdits", "[A] ACT · APPROVAL acceptEdits", "ACT/acceptEdits", "A/E"],
	  ["ACT", "APPROVAL dontAsk", "[A] ACT · APPROVAL dontAsk", "ACT/dontAsk", "A/N"],
	  ["ACT", "APPROVAL YOLO", "[A] ACT · APPROVAL YOLO", "ACT/YOLO", "A/Y"],
      ["PLAN", "APPROVAL default", "[P] PLAN · APPROVAL plan", "PLAN/plan", "P/P"],
      ["READY", "APPROVAL bypassPermissions", "[P] READY · APPROVAL plan", "READY/plan", "R/P"],
    ] as const) {
      harness.statuses.set("mode", status);
      harness.statuses.set("approval-mode", approval);
      assert.ok(stripAnsi(harness.render(100)[0]).startsWith(full));
      assert.ok(stripAnsi(harness.render(60)[0]).startsWith(compact));
      assert.ok(stripAnsi(harness.render(30)[0]).startsWith(narrow));
    }

    harness.statuses.set("mode", "ACT");
    harness.statuses.set("approval-mode", "APPROVAL YOLO");
    const yolo = harness.render(100)[0];
    assert.ok(yolo.includes(`${ansiFg(COLORS.danger)}${ANSI_BOLD}APPROVAL YOLO`));

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
    assert.match(stripAnsi(harness.render(70)[1]), /CTX PRUNE -3/);
    assert.match(stripAnsi(harness.render(36)[1]), /CTX PRUNE -3/);
    assert.equal(harness.render(36).length, 2);
    assert.doesNotMatch(stripAnsi(harness.render(36)[0]), /CTX PRUNE/);

    harness.statuses.set("maestro-auto-compact", "CTX CRITICAL 91000/90000");
    assert.match(stripAnsi(harness.render(120)[1]), /CTX CRITICAL 91000\/90000/);
    assert.match(stripAnsi(harness.render(36)[1]), /CTX CRITICAL/);

    harness.statuses.set("maestro-auto-compact", "COMPACT 91000/90000");
    assert.match(stripAnsi(harness.render(120)[1]), /CTX COMPACT 91000\/90000/);
    assert.match(stripAnsi(harness.render(36)[1]), /CTX COMPACT/);
    for (let width = 1; width <= 120; width++) {
      for (const line of harness.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
      }
    }

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

test("statusline renders canonical Session/Run separately from active tool calls", () => {
  const harness = createHarness({
    activeToolCalls: 2,
    workflowSnapshot: {
      source: "canonical",
      projectRoot: "D:\\pi-maestro-flow",
      loadedAt: "2026-07-15T00:00:00.000Z",
      revision: { sessionRevision: 1, fingerprint: "statusline" },
      diagnostics: [],
      session: {
        sessionId: "20260715-auth-m1",
        label: "auth-m1",
        intent: "Auth",
        status: "paused",
        revision: 1,
        activeRunId: "003",
        definitionOfDone: "Auth verified",
        gates: [
          { id: "GATE-001", blocking: true, status: "passed" },
          { id: "GATE-002", blocking: true, status: "passed" },
          { id: "GATE-003", blocking: true, status: "pending" },
        ],
        chain: [
          { step: "analyze", command: "analyze", status: "completed", runId: null },
          { step: "grill", command: "grill", status: "completed", runId: null },
          { step: "plan", command: "plan", status: "blocked", runId: "003" },
        ],
        runs: [{
          runId: "003",
          parentRunId: null,
          command: "plan",
          status: "blocked",
          goal: null,
          args: [],
          gates: [{ id: "GATE-003", blocking: true, status: "pending" }],
          primaryArtifactId: null,
          handoff: null,
          startedAt: "2026-07-15T00:00:00.000Z",
          endedAt: null,
        }],
        artifacts: [],
        aliases: {},
      },
      recoveryAction: "Resume from gate",
      goal: { objective: "Auth", status: "paused", tokensUsed: 45_000, tokenBudget: 300_000 },
    },
  });
  try {
    const full = harness.render(120).map(stripAnsi);
    assert.equal(full.length, 2);
    assert.match(full[0], /2 calls/);
    assert.doesNotMatch(full[0], /2 runs/);
    assert.match(full[1], /⚑ auth-m1/);
    assert.match(full[1], /! blocked/);
    assert.match(full[1], /003\/plan/);
    assert.doesNotMatch(full.join("\n"), /milestone|phase/i);
    assert.match(stripAnsi(harness.render(40)[1]), /^» Resume from gate/);

    for (let width = 1; width <= 120; width++) {
      for (const line of harness.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
      }
    }
  } finally {
    harness.dispose();
  }
});
