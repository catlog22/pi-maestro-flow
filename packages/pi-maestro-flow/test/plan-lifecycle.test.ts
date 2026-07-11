import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getMode,
  initPlan,
  onAgentEndPlan,
  onSessionShutdownPlan,
  onSessionStartPlan,
  onToolCallPlan,
  registerPlanTools,
} from "../src/tools/plan.ts";
import { PlanStore } from "../src/tools/plan-store.ts";

interface ToolLike {
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<any>;
}

function createHarness(root: string, autoConfirm = false, failingApproval = false) {
  let active = ["Read", "Write", "todo", "custom-tool"];
  const tools = new Map<string, ToolLike>();
  const messages: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const tui = { requestRender() {} };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ui = {
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    notify(message: string) { notifications.push(message); },
    async custom(factory: Function) {
      return new Promise((resolve) => {
        const component = factory(tui, theme, {}, resolve);
        if (autoConfirm) {
          setImmediate(() => {
            component.handleInput("\x1b[13;5u");
            if (failingApproval) setTimeout(() => component.handleInput("\x1b"), 100);
          });
        } else {
          setImmediate(() => component.handleInput("\x1b"));
        }
      });
    },
  };
  const pi = {
    registerTool(tool: { name: string }) { tools.set(tool.name, tool as unknown as ToolLike); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; },
    sendUserMessage(message: string) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: join(root, "workspace"),
    hasUI: true,
    isIdle: () => true,
    ui,
  } as unknown as ExtensionContext;

  initPlan(pi, {
    storeFactory: (cwd) => new PlanStore(cwd, {
      rootDir: join(root, "global"),
      ...(failingApproval
        ? { approvalCommitHook: async () => { throw new Error("approval storage failed"); } }
        : {}),
    }),
  });
  registerPlanTools(pi);
  return {
    pi,
    ctx,
    tools,
    messages,
    notifications,
    statuses,
    get active() { return active; },
  };
}

async function execute(harness: ReturnType<typeof createHarness>, name: string, params: Record<string, unknown> = {}) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(name, params, undefined, undefined, harness.ctx);
}

test("Plan lifecycle dynamically activates safe tools and restores the exact Act snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-lifecycle-"));
  const harness = createHarness(root);
  try {
    await onSessionStartPlan(harness.ctx);
    const actSnapshot = [...harness.active];
    assert.deepEqual(actSnapshot, ["Read", "Write", "todo", "custom-tool", "plan-enter"]);

    await execute(harness, "plan-enter");
    assert.equal(getMode(), "plan");
    assert.deepEqual(harness.active, [
      "Read", "todo", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status",
    ]);

    const updated = await execute(harness, "plan-update", { markdown: "# Durable plan" });
    assert.equal(updated.details.revision, 1);
    assert.equal(await readFile(join(root, "global", new PlanStore(harness.ctx.cwd, { rootDir: join(root, "global") }).workspaceId, "plans", "current.md"), "utf8"), "# Durable plan");

    await execute(harness, "plan-exit");
    assert.equal(getMode(), "act");
    assert.deepEqual(harness.active, actSnapshot);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation archives the exact draft before restoring Act and injecting work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-"));
  const harness = createHarness(root, true);
  try {
    await onSessionStartPlan(harness.ctx);
    const actSnapshot = [...harness.active];
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nImplement safely" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(getMode(), "act");
    assert.deepEqual(harness.active, actSnapshot);
    assert.match(harness.messages.at(-1) ?? "", /# Approved/);

    const store = new PlanStore(harness.ctx.cwd, { rootDir: join(root, "global") });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.ok(loaded.manifest.approvedPath);
    assert.equal(await readFile(join(store.plansDir, loaded.manifest.approvedPath!), "utf8"), "# Approved\n\nImplement safely");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Approval failure leaves Plan mode and Plan tools active", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-fail-"));
  const harness = createHarness(root, true, true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "must survive" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(confirmed.details.revision, 2);
    assert.equal(getMode(), "plan");
    assert.ok(harness.active.includes("plan-confirm"));
    assert.ok(!harness.active.includes("Write"));
    const store = new PlanStore(harness.ctx.cwd, { rootDir: join(root, "global") });
    assert.equal((await store.load()).markdown, "must survive");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan hooks keep compatibility capture and block unapproved tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-hooks-"));
  const harness = createHarness(root);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /blocks/);
    assert.match(onToolCallPlan({ toolName: "custom-tool", input: {} })?.reason ?? "", /does not allow/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git status" } })?.reason ?? "allowed", /allowed/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git commit -am x" } })?.reason ?? "", /mutating/);

    await onAgentEndPlan({
      messages: [{ role: "assistant", content: "<proposed_plan>\n# Legacy plan\n</proposed_plan>" }],
    }, harness.ctx);
    const status = await execute(harness, "plan-status");
    assert.equal(status.details.revision, 1);
    assert.equal(status.details.status, "draft");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Session restart stays in Act and resumes the persisted draft only after plan-enter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-restart-"));
  const first = createHarness(root);
  try {
    await onSessionStartPlan(first.ctx);
    await execute(first, "plan-enter");
    await execute(first, "plan-update", { markdown: "restart draft" });
    onSessionShutdownPlan(first.ctx);

    const second = createHarness(root);
    await onSessionStartPlan(second.ctx);
    assert.equal(getMode(), "act");
    assert.deepEqual(second.active, ["Read", "Write", "todo", "custom-tool", "plan-enter"]);
    await execute(second, "plan-enter");
    const status = await execute(second, "plan-status");
    assert.equal(status.details.status, "draft");
    assert.equal(status.details.revision, 1);
    onSessionShutdownPlan(second.ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
