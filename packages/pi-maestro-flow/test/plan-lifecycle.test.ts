import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CompactionArbiter } from "../src/compaction/compaction-arbiter.ts";
import {
  getMode,
  getPlanHandoffStatus,
  initPlan,
  onAgentEndPlan,
  onBeforeAgentStartPlan,
  onSessionShutdownPlan,
  onSessionStartPlan,
  onToolCallPlan,
  registerPlanCommand,
  registerPlanTools,
  setPlanModeChangeListener,
} from "../src/tools/plan.ts";
import { PlanStore } from "../src/tools/plan-store.ts";
import {
  addGoal,
  executeGoal,
  initGoal,
  onSessionShutdown as goalOnSessionShutdown,
  onSessionStart as goalOnSessionStart,
  setGoalVerifierRunnerForTest,
  type GoalContext,
} from "../src/tools/goal.ts";

interface ToolLike {
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<any>;
}

interface CommandLike {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
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
  handoff: { todoKeys: string[] } = { todoKeys: [] },
  replacementFailure?: "approval" | "send",
  runtime: {
    contextPercent?: number;
    discussionInput?: string;
    idle?: boolean;
    arbiter?: CompactionArbiter;
  } = {},
) {
  let active = ["Read", "Write", "Bash", "todo", "custom-tool"];
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, CommandLike>();
  const messages: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const compactions: Array<{ customInstructions?: string; onComplete?: (result: unknown) => void }> = [];
  let newSessions = 0;
  let aborts = 0;
  const tui = { requestRender() {} };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ui = {
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    notify(message: string) { notifications.push(message); },
    async input() { return runtime.discussionInput; },
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
    registerCommand(name: string, command: CommandLike) { commands.set(name, command); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; },
    sendUserMessage(message: string) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: join(root, "workspace"),
    hasUI: true,
    isIdle: () => runtime.idle ?? true,
    abort() { aborts++; },
    getContextUsage: () => ({ percent: runtime.contextPercent ?? 0 }),
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
          async newSession(options?: { withSession?: (ctx: ExtensionContext & { sendUserMessage(message: string): Promise<void> }) => Promise<void> }) {
            newSessions++;
            const replacementSessionId = `${sessionId}-replacement`;
            const replacementCtx = {
              ...ctx,
              sessionManager: {
                getSessionId: () => replacementSessionId,
                getSessionFile: () => join(root, `${replacementSessionId}.jsonl`),
                getSessionName: () => replacementSessionId,
              },
              async sendUserMessage(message: string) {
                if (replacementFailure === "send") throw new Error("replacement send failed");
                messages.push(message);
              },
            } as ExtensionContext & { sendUserMessage(message: string): Promise<void> };
            onSessionShutdownPlan(ctx);
            await onSessionStartPlan(replacementCtx);
            await options?.withSession?.(replacementCtx);
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
      if (replacementFailure === "approval" && session.id.endsWith("-replacement")) {
        return new PlanStore(cwd, {
          rootDir: join(root, "global"),
          session,
          approvalCommitHook: async () => { throw new Error("replacement approval failed"); },
        });
      }
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
    hasExecutableTodo: (handoffKey) => handoff.todoKeys.includes(handoffKey),
    compactionArbiter: runtime.arbiter,
  });
  registerPlanTools(pi);
  registerPlanCommand(pi);
  return {
    pi,
    ctx,
    tools,
    commands,
    messages,
    notifications,
    statuses,
    compactions,
    get aborts() { return aborts; },
    get newSessions() { return newSessions; },
    get active() { return active; },
    handoff,
  };
}

async function execute(harness: ReturnType<typeof createHarness>, name: string, params: Record<string, unknown> = {}) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(name, params, undefined, undefined, harness.ctx);
}

async function executeCommand(harness: ReturnType<typeof createHarness>, name: string, args = "") {
  const command = harness.commands.get(name);
  assert.ok(command, `missing command ${name}`);
  await command.handler(args, harness.ctx);
}

test("Plan lifecycle leaves the tool surface untouched across every transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-lifecycle-"));
  const harness = createHarness(root);
  try {
    await onSessionStartPlan(harness.ctx);
    assert.equal(harness.statuses.at(-1), "ACT");
    const actSnapshot = [...harness.active];
    // Session start is the one point that touches the surface, and it only tops
    // up the Plan tools so all six stay callable in both modes.
    for (const tool of ["plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status"]) {
      assert.ok(actSnapshot.includes(tool), `expected ${tool} on the Act surface`);
    }
    assert.ok(actSnapshot.includes("Write"));

    await execute(harness, "plan-enter");
    assert.equal(getMode(), "plan");
    assert.equal(harness.statuses.at(-1), "PLAN");
    // 2e7c19b2 made Plan mode prompt-only: swapping the surface here would
    // invalidate the cached prompt prefix, so Write stays callable and the
    // editing constraint is carried by the mode note instead of by a block.
    assert.deepEqual(harness.active, actSnapshot);
    assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);

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

test("plan-enter ignores prompt parameters instead of queuing follow-up work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-enter-prompt-"));
  const harness = createHarness(root);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    const entered = await execute(harness, "plan-enter", { prompt: "Draft a follow-up plan" });
    assert.equal(entered.details.mode, "plan");
    assert.equal(harness.messages.length, 0);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan prompt refuses to queue while the agent is busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-command-busy-"));
  const harness = createHarness(root);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    await executeCommand(harness, "plan", "基于缺口分析报告，制定修复方案。");
    assert.equal(getMode(), "plan");
    assert.equal(harness.messages.length, 0);
    assert.match(harness.notifications.join("\n"), /prompt was not queued/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation archives the exact draft before restoring Act and injecting work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-"));
  const harness = createHarness(root, true);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    const actSnapshot = [...harness.active];
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nImplement safely" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.details.handoffStatus, "todo-required");
    assert.equal(getMode(), "act");
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.deepEqual(harness.active, actSnapshot);
    assert.equal(harness.messages.length, 0);
    const toolText = confirmed.content[0]?.text ?? "";
    assert.match(toolText, /Prefer the teammate tool/);
    assert.doesNotMatch(toolText, /# Approved/);
    assert.match(toolText, /already in the current context/);
    assert.match(toolText, /Todo dependency graph/);
    assert.match(toolText, /quality gate/);
    assert.match(toolText, /acceptance criteria/);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.ok(loaded.manifest.handoffKey);
    assert.ok(loaded.manifest.approvedPath);
    assert.equal(await readFile(join(store.plansDir, loaded.manifest.approvedPath!), "utf8"), "# Approved\n\nImplement safely");

    // The handoff gate reports readiness, it no longer enforces it: a5b0d8b7 made
    // Plan mode advisory and onToolCallPlan blocks nothing. What survives is the
    // discrimination itself — only a todo carrying this approval's handoff key
    // satisfies the gate, and an unrelated one must not.
    assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);
    assert.equal(getPlanHandoffStatus(), "todo-required");
    harness.handoff.todoKeys.push("unrelated-handoff");
    assert.equal(getPlanHandoffStatus(), "todo-required");
    harness.handoff.todoKeys.push(loaded.manifest.handoffKey!);
    assert.equal(getPlanHandoffStatus(), "ready");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-confirm execute fires the mode-change listener so the approval statusline re-syncs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-listener-"));
  const harness = createHarness(root, true);
  harness.ctx.isIdle = () => false;
  let listenerCalls = 0;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nSync statusline" });
    setPlanModeChangeListener(() => { listenerCalls++; });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(getMode(), "act");
    assert.ok(listenerCalls >= 1, "mode-change listener must fire on confirm-execute so approval-mode status is restored");
  } finally {
    setPlanModeChangeListener(undefined);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-enter fires the mode-change listener so cockpit fields follow the transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-enter-listener-"));
  const harness = createHarness(root, true);
  harness.ctx.isIdle = () => false;
  let listenerCalls = 0;
  try {
    await onSessionStartPlan(harness.ctx);
    setPlanModeChangeListener(() => { listenerCalls++; });
    await execute(harness, "plan-enter");
    assert.equal(getMode(), "plan");
    assert.ok(listenerCalls >= 1, "mode-change listener must fire on plan-enter so cockpit fields re-sync");
  } finally {
    setPlanModeChangeListener(undefined);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan approve fires the mode-change listener so the approval statusline re-syncs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-approve-listener-"));
  const harness = createHarness(root, true);
  harness.ctx.isIdle = () => false;
  let listenerCalls = 0;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nSync statusline" });
    setPlanModeChangeListener(() => { listenerCalls++; });
    await executeCommand(harness, "plan", "approve");
    assert.equal(getMode(), "act");
    assert.ok(listenerCalls >= 1, "mode-change listener must fire on /plan approve so approval-mode status is restored");
  } finally {
    setPlanModeChangeListener(undefined);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

// Was "Approved Plan handoff lets goal update resume a paused bound Goal", which
// 39a5f2dc invalidated by decoupling the gate from Goal state. Inverted rather than
// deleted: the gate reads todos and nothing else, and that is worth pinning.
test("Approved Plan handoff is decided by todos alone, not by Goal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-handoff-resume-"));
  const harness = createHarness(root, true);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nResume safely" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    const handoffKey = loaded.manifest.handoffKey!;
    assert.ok(handoffKey);

    // Goal state cannot move the gate: plan.ts no longer has a hook that reads it.
    assert.equal(getPlanHandoffStatus(), "todo-required");

    // Only an executable todo carrying the handoff key does.
    harness.handoff.todoKeys.push(handoffKey);
    assert.equal(getPlanHandoffStatus(), "ready");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan approve compacts with an explicit approved-Plan link before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-compact-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-chat",
    ["2"],
    false,
    { todoKeys: [] },
    undefined,
    { contextPercent: 75 },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Plan\n\nKeep boundary A" });
    await executeCommand(harness, "plan", "approve");
    assert.equal(harness.compactions.length, 1);
    assert.match(harness.compactions[0].customInstructions ?? "", /authoritative execution contract/);
    assert.match(harness.compactions[0].customInstructions ?? "", /# Compact Plan/);
    assert.match(harness.compactions[0].customInstructions ?? "", /current\.md/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.messages.length, 1);
    assert.doesNotMatch(harness.messages.at(-1) ?? "", /# Compact Plan/);
    assert.match(harness.messages.at(-1) ?? "", /already in the current context/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-confirm tool keeps unavailable context execution in Plan mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-tool-compact-"));
  const harness = createHarness(root, false, false, false, false, "compact-tool-chat", ["2", "\x1b"]);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Tool Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(harness.compactions.length, 0);
    assert.equal(harness.messages.length, 0);
    assert.equal(getMode(), "plan");
    assert.equal(harness.aborts, 1);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation can execute in a new session from command-capable context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-clear-"));
  const harness = createHarness(root, false, false, false, false, "clear-chat", ["2"], true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Clean Context Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(harness.newSessions, 1);
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages.at(-1) ?? "", /# Clean Context Plan/);
    assert.equal(getPlanHandoffStatus(), "todo-required");
    const replacementStore = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: "clear-chat-replacement" },
    });
    const replacement = await replacementStore.load();
    assert.equal(replacement.manifest.status, "approved");
    assert.ok(replacement.manifest.handoffKey);
    const sourceStore = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: "clear-chat" },
    });
    const sourceHandoffKey = (await sourceStore.load()).manifest.handoffKey;
    assert.equal(replacement.manifest.handoffKey, sourceHandoffKey);
    await rm(replacementStore.manifestPath, { force: true });
    assert.equal((await replacementStore.load()).manifest.handoffKey, sourceHandoffKey);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["approval", "send"] as const) {
  test(`Plan execute-clear fails closed inside the replacement session when ${failure} fails`, async () => {
    const root = await mkdtemp(join(tmpdir(), `pi-plan-confirm-clear-${failure}-`));
    const harness = createHarness(
      root,
      false,
      false,
      false,
      false,
      `clear-${failure}-chat`,
      ["2"],
      true,
      { todoKeys: [] },
      failure,
    );
    try {
      await onSessionStartPlan(harness.ctx);
      await execute(harness, "plan-enter");
      await execute(harness, "plan-update", { markdown: `# Replacement ${failure} failure` });
      const confirmed = await execute(harness, "plan-confirm");
      assert.equal(confirmed.details.approved, true);
      assert.equal(harness.newSessions, 1);
      // "Fails closed" no longer means a Write block — a5b0d8b7 removed those. For
      // an approval failure it means the replacement lands back in Plan mode with no
      // handoff key; for a send failure the approval stands but the gate cannot be
      // satisfied, because no todo ever received the key the undelivered prompt carried.
      assert.notEqual(getPlanHandoffStatus(), "ready");
      assert.equal(getMode(), failure === "approval" ? "plan" : "act");
      assert.match(
        harness.notifications.join("\n"),
        failure === "approval"
          ? /failed closed in Plan mode/
          : /holds the approved Plan.*prompt could not be delivered/,
      );
    } finally {
      onSessionShutdownPlan(harness.ctx);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Esc closes Plan confirmation, interrupts the turn, and preserves Plan mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-cancel-"));
  const harness = createHarness(root, false, false, false, false, "cancel-chat", ["\x1b"]);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Preserved Draft" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(getMode(), "plan");
    assert.equal(harness.aborts, 1);
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

test("plan handoff yields to an in-flight native or mid-turn compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-arbitration-"));
  const arbiter = new CompactionArbiter();
  const native = arbiter.observeStart();
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-race-chat",
    ["2"],
    false,
    { todoKeys: [] },
    undefined,
    { contextPercent: 75, arbiter },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Arbitrated Plan" });
    await executeCommand(harness, "plan", "approve");
    assert.equal(harness.compactions.length, 0);
    assert.equal(harness.messages.length, 1);
    assert.ok(harness.notifications.some((message) => /already in progress/.test(message)));
  } finally {
    native.releaseIfNative();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan confirmation exits intentionally and injects the Act transition once at the next agent start", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-exit-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "exit-chat",
    ["5"],
    false,
    { todoKeys: [] },
    undefined,
    { idle: false },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    const actSnapshot = [...harness.active];
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Preserved Draft" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(confirmed.details.mode, "act");
    assert.equal(getMode(), "act");
    assert.deepEqual(harness.active, actSnapshot);
    assert.match(confirmed.content[0]?.text ?? "", /intentionally exited Plan mode without approving/);
    assert.match(confirmed.content[0]?.text ?? "", /Act mode is now active/);
    assert.equal(harness.messages.length, 0);
    assert.equal(harness.aborts, 0);
    const exitPrompt = onBeforeAgentStartPlan({ systemPrompt: "base" })?.systemPrompt ?? "";
    assert.match(exitPrompt, /^base/);
    assert.match(exitPrompt, /## Exited Plan Mode/);
    assert.match(exitPrompt, /intentionally exited Plan mode without approving/);
    assert.match(exitPrompt, /Act mode is now active/);
    assert.match(exitPrompt, /not an approval failure/);
    assert.equal(onBeforeAgentStartPlan({ systemPrompt: "base" }), undefined);
    assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);

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

test("Continue discussion opens text input, queues the response, and interrupts the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-discuss-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "discuss-chat",
    ["4"],
    false,
    { todoKeys: [] },
    undefined,
    { discussionInput: "Keep the API compatible", idle: false },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Discuss Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(getMode(), "plan");
    assert.deepEqual(harness.messages, ["Keep the API compatible"]);
    assert.equal(harness.aborts, 1);
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
    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    assert.equal((await store.load()).markdown, "must survive");
    // The draft demonstrably survived on disk, so the notice has to say so. A bare
    // "approval failed" reads as "your plan is gone" and invites the user to retype it.
    const failure = harness.notifications.find((message) => /Plan approval failed/.test(message));
    assert.ok(failure, `expected an approval failure notice, got ${JSON.stringify(harness.notifications)}`);
    assert.match(failure, /draft is intact at revision 2/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan hooks keep compatibility capture and gate nothing at the tool-call layer", async () => {
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
    assert.match(planPrompt, /quality gates to key Todos/);
    // a5b0d8b7 removed every hard block: the editing constraint now lives only in
    // the prompt above. The hook stays wired so the extension keeps a seam, but it
    // must pass everything through — including the tools it used to reject, since a
    // partial block would be worse than none (the model would learn the wrong rule).
    for (const toolName of ["Write", "Edit", "NotebookEdit", "custom-tool", "bash", "Bash", "browser"]) {
      assert.equal(onToolCallPlan({ toolName, input: {} }), undefined, toolName);
    }
    for (const action of ["status", "next", "done", "edit", "pause", "resume"]) {
      assert.equal(onToolCallPlan({ toolName: "run-control", input: { action } }), undefined, action);
    }

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

test("Approved Plan handoff gate is restored from the manifest after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-handoff-restart-"));
  const binding: { todoKeys: string[] } = { todoKeys: [] };
  const first = createHarness(root, true, false, false, false, "handoff-chat", undefined, false, binding);
  try {
    await onSessionStartPlan(first.ctx);
    await execute(first, "plan-enter");
    await execute(first, "plan-update", { markdown: "# Restart handoff" });
    const confirmed = await execute(first, "plan-confirm");
    assert.equal(getPlanHandoffStatus(), "todo-required");
    const handoffKey = confirmed.details.handoffKey as string;
    onSessionShutdownPlan(first.ctx);

    const second = createHarness(root, false, false, false, false, "handoff-chat", undefined, false, binding);
    await onSessionStartPlan(second.ctx);
    assert.equal(getMode(), "act");
    // The point of the test: the restart recovers the handoff key from the manifest,
    // so the gate is still unsatisfied afterwards rather than silently reset to "none".
    assert.equal(getPlanHandoffStatus(), "todo-required");
    binding.todoKeys.push(handoffKey);
    assert.equal(getPlanHandoffStatus(), "ready");
    onSessionShutdownPlan(second.ctx);
  } finally {
    onSessionShutdownPlan(first.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Approved Plan handoff stays satisfied after execution switches to a quality-gate Goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-handoff-qgate-"));
  initGoal({ appendEntry() {} } as never);
  const goalCtx: GoalContext = {
    cwd: root,
    ui: { notify() {}, setStatus() {} },
    isIdle: () => false,
    abort() {},
  };
  goalOnSessionStart(goalCtx, { reason: "new" });
  setGoalVerifierRunnerForTest(() => Promise.resolve({
    exitCode: 0,
    messages: [{ role: "assistant", content: "ok" }],
    structuredOutput: { pass: true, reasoning: "verified", unmet: [], evidence: ["gate evidence"] },
  }));
  // The trailing `realGoalBinding` argument is gone: the gate no longer has a Goal hook
  // to override, so the real (todo-only) binding is the only behavior there is.
  const harness = createHarness(root, true, false, false, false, "qgate-chat", undefined, false, { todoKeys: [] }, undefined, {});
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved\n\nShip it" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    const handoffKey = loaded.manifest.handoffKey!;
    assert.ok(handoffKey);

    addGoal("Plan handoff goal", goalCtx, { planHandoffKey: handoffKey });
    const completion = await executeGoal({ action: "complete", summary: "plan goal done" }, goalCtx);
    assert.match(completion.text, /done/i);
    addGoal("Quality-gate goal", goalCtx);

    harness.handoff.todoKeys.push(handoffKey);
    assert.equal(getPlanHandoffStatus(), "ready");
  } finally {
    setGoalVerifierRunnerForTest(undefined);
    goalOnSessionShutdown(goalCtx);
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
    // A restart tops the Plan tools up onto whatever surface the host declares; it
    // never removes anything, so Write survives here exactly as it does in Plan mode.
    assert.ok(second.active.includes("Write"));
    for (const tool of ["plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status"]) {
      assert.ok(second.active.includes(tool), `expected ${tool} after restart`);
    }
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
