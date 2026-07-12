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
  onBeforeAgentStartPlan,
  onSessionShutdownPlan,
  onSessionStartPlan,
  onToolCallPlan,
  registerPlanTools,
} from "../src/tools/plan.ts";
import { PlanStore } from "../src/tools/plan-store.ts";

interface ToolLike {
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<any>;
}

function createHarness(
  root: string,
  autoConfirm = false,
  failingApproval = false,
  failingSave = false,
  failFirstLoad = false,
  sessionId = "session-main",
  confirmationInputs?: string[],
  supportsNewSession = false,
) {
  let active = ["Read", "Write", "todo", "custom-tool"];
  const tools = new Map<string, ToolLike>();
  const messages: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const compactions: Array<{ customInstructions?: string; onComplete?: (result: unknown) => void }> = [];
  let newSessions = 0;
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
        if (confirmationInputs) {
          setImmediate(() => {
            for (const input of confirmationInputs) component.handleInput(input);
          });
        } else if (autoConfirm) {
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
    compact(options: { customInstructions?: string; onComplete?: (result: unknown) => void }) {
      compactions.push(options);
      setImmediate(() => options.onComplete?.({}));
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(root, `${sessionId}.jsonl`),
      getSessionName: () => sessionId,
    },
    ui,
    ...(supportsNewSession
      ? {
          async newSession(options?: { withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void> }) {
            newSessions++;
            await options?.withSession?.({ async sendUserMessage(message: string) { messages.push(message); } });
            return { cancelled: false };
          },
        }
      : {}),
  } as unknown as ExtensionContext;

  class FailingSaveStore extends PlanStore {
    override async saveDraft(): Promise<never> {
      throw new Error("draft storage failed");
    }
  }

  class FailingLoadStore extends PlanStore {
    override async load(): Promise<never> {
      throw new Error("draft load failed");
    }
  }

  let storeCalls = 0;

  initPlan(pi, {
    storeFactory: (cwd, session) => {
      const call = storeCalls++;
      if (failFirstLoad && call === 0) return new FailingLoadStore(cwd, { rootDir: join(root, "global"), session });
      return failingSave ? new FailingSaveStore(cwd, {
        rootDir: join(root, "global"),
        session,
      }) : new PlanStore(cwd, {
      rootDir: join(root, "global"),
      session,
      ...(failingApproval
        ? { approvalCommitHook: async () => { throw new Error("approval storage failed"); } }
        : {}),
      });
    },
  });
  registerPlanTools(pi);
  return {
    pi,
    ctx,
    tools,
    messages,
    notifications,
    statuses,
    compactions,
    get newSessions() { return newSessions; },
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
    assert.equal(harness.statuses.at(-1), "ACT");
    const actSnapshot = [...harness.active];
    assert.deepEqual(actSnapshot, ["Read", "Write", "todo", "custom-tool", "plan-enter"]);

    await execute(harness, "plan-enter");
    assert.equal(getMode(), "plan");
    assert.equal(harness.statuses.at(-1), "PLAN");
    assert.deepEqual(harness.active, [
      "Read", "todo", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status",
    ]);
    assert.match(onToolCallPlan({ toolName: "maestro", input: { action: "delegate" } })?.reason ?? "", /requires delegate mode='analysis'/);
    assert.equal(onToolCallPlan({ toolName: "maestro", input: { action: "delegate", mode: "analysis" } }), undefined);

    const updated = await execute(harness, "plan-update", { markdown: "# Durable plan" });
    assert.equal(updated.details.revision, 1);
    assert.equal(harness.statuses.at(-1), "READY");
    assert.equal(await readFile(updated.details.path, "utf8"), "# Durable plan");

    await execute(harness, "plan-exit");
    assert.equal(getMode(), "act");
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.deepEqual(harness.active, actSnapshot);

    await execute(harness, "plan-enter");
    onSessionShutdownPlan(harness.ctx);
    assert.deepEqual(harness.active, actSnapshot);
    await onSessionStartPlan(harness.ctx);
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
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.deepEqual(harness.active, actSnapshot);
    assert.doesNotMatch(harness.messages.at(-1) ?? "", /# Approved/);
    assert.match(harness.messages.at(-1) ?? "", /already in the current context/);
    assert.match(harness.messages.at(-1) ?? "", /Todo dependency graph/);
    assert.match(harness.messages.at(-1) ?? "", /one active Goal/);
    assert.match(harness.messages.at(-1) ?? "", /locked boundaries and acceptance checks/);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.ok(loaded.manifest.approvedPath);
    assert.equal(await readFile(join(store.plansDir, loaded.manifest.approvedPath!), "utf8"), "# Approved\n\nImplement safely");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation compacts with an explicit approved-Plan link before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-compact-"));
  const harness = createHarness(root, false, false, false, false, "compact-chat", ["\x1b[B", "\x1b[B", "\r"]);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Plan\n\nKeep boundary A" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(harness.compactions.length, 1);
    assert.match(harness.compactions[0].customInstructions ?? "", /authoritative execution contract/);
    assert.match(harness.compactions[0].customInstructions ?? "", /# Compact Plan/);
    assert.match(harness.compactions[0].customInstructions ?? "", /current\.md/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(harness.messages.at(-1) ?? "", /# Compact Plan/);
    assert.match(harness.messages.at(-1) ?? "", /already in the current context/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation can execute in a new session from command-capable context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-clear-"));
  const harness = createHarness(root, false, false, false, false, "clear-chat", ["\x1b[B", "\r"], true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Clean Context Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(harness.newSessions, 1);
    assert.match(harness.messages.at(-1) ?? "", /# Clean Context Plan/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cancelling Plan confirmation exits Plan mode and preserves the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-cancel-"));
  const harness = createHarness(root, false, false, false, false, "cancel-chat", ["\x1b"]);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Preserved Draft" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(getMode(), "act");
    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "draft");
    assert.equal(loaded.markdown, "# Preserved Draft");
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
    assert.equal(harness.statuses.at(-1), "READY");
    assert.ok(harness.active.includes("plan-confirm"));
    assert.ok(!harness.active.includes("Write"));
    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
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
    const planPrompt = onBeforeAgentStartPlan({ systemPrompt: "base" })?.systemPrompt ?? "";
    assert.match(planPrompt, /Align every user requirement/);
    assert.match(planPrompt, /verifiable acceptance check/);
    assert.match(planPrompt, /Socratic pressure review/);
    assert.match(planPrompt, /Use ask-user-question for every user question/);
    assert.match(planPrompt, /Ask 2-4 related questions per call/);
    assert.match(planPrompt, /scope, boundaries, non-goals/);
    assert.match(planPrompt, /one active Goal/);
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /blocks/);
    assert.match(onToolCallPlan({ toolName: "custom-tool", input: {} })?.reason ?? "", /does not allow/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git status" } })?.reason ?? "allowed", /allowed/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git commit -am x" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git status; node --version" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "PowerShell", input: { command: "Get-Content x | Set-Content y" } })?.reason ?? "", /mutating/);
    assert.equal(onToolCallPlan({ toolName: "PowerShell", input: { command: "Get-Content x" } }), undefined);
    assert.match(onToolCallPlan({ toolName: "bash", input: {} })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "find . -delete" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "find . -exec rm {} ;" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git diff --output=review.patch" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git log --ext-diff" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git branch -D old" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git remote set-url origin evil" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git grep x --open-files-in-pager=sh" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "fd pattern -x rm" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "rg pattern --pre 'rm file'" } })?.reason ?? "", /mutating/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "npm audit --fix" } })?.reason ?? "", /mutating/);

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

test("Compatibility capture errors are isolated inside the Plan hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-capture-fail-"));
  const harness = createHarness(root, false, false, true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await onAgentEndPlan({
      messages: [{ role: "assistant", content: "<proposed_plan># Must not break goal hook</proposed_plan>" }],
    }, harness.ctx);
    assert.match(harness.notifications.join("\n"), /compatibility capture failed/);
    assert.equal(getMode(), "plan");
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
    assert.equal(second.statuses.at(-1), "ACT");
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

test("Different chat sessions in one workspace keep independent Plan drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-chat-isolation-"));
  try {
    const chatA = createHarness(root, false, false, false, false, "chat-a");
    await onSessionStartPlan(chatA.ctx);
    await execute(chatA, "plan-enter");
    await execute(chatA, "plan-update", { markdown: "chat A plan" });
    const statusA = await execute(chatA, "plan-status");
    assert.equal(statusA.details.sessionId, "chat-a");
    onSessionShutdownPlan(chatA.ctx);

    const chatB = createHarness(root, false, false, false, false, "chat-b");
    await onSessionStartPlan(chatB.ctx);
    await execute(chatB, "plan-enter");
    const emptyB = await execute(chatB, "plan-status");
    assert.equal(emptyB.details.sessionId, "chat-b");
    assert.equal(emptyB.details.status, "empty");
    await execute(chatB, "plan-update", { markdown: "chat B plan" });
    onSessionShutdownPlan(chatB.ctx);

    const resumedA = createHarness(root, false, false, false, false, "chat-a");
    await onSessionStartPlan(resumedA.ctx);
    await execute(resumedA, "plan-enter");
    assert.equal((await execute(resumedA, "plan-status")).details.status, "draft");
    assert.equal((await execute(resumedA, "plan-status")).details.sessionId, "chat-a");
    assert.equal(await readFile((await execute(resumedA, "plan-status")).details.path, "utf8"), "chat A plan");
    onSessionShutdownPlan(resumedA.ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Session-start storage failure clears the failed store so plan-enter can retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-start-retry-"));
  const harness = createHarness(root, false, false, false, true);
  try {
    await onSessionStartPlan(harness.ctx);
    assert.match(harness.notifications.join("\n"), /draft unavailable/);
    const entered = await execute(harness, "plan-enter");
    assert.equal(entered.details.mode, "plan");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Reinitializing Plan restores a leaked tool snapshot and resets module state", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "pi-plan-reinit-first-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "pi-plan-reinit-second-"));
  const first = createHarness(firstRoot);
  try {
    await onSessionStartPlan(first.ctx);
    const firstActTools = first.active;
    await execute(first, "plan-enter");
    assert.equal(getMode(), "plan");

    const second = createHarness(secondRoot);
    assert.deepEqual(first.active, firstActTools);
    assert.equal(getMode(), "act");
    await onSessionStartPlan(second.ctx);
    assert.equal(second.active.includes("plan-enter"), true);
    onSessionShutdownPlan(second.ctx);
  } finally {
    onSessionShutdownPlan(first.ctx);
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});
