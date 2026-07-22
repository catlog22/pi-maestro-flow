import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
} from "../src/tools/plan.ts";
import { PlanStore } from "../src/tools/plan-store.ts";

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
  handoff: { goalKey?: string; todoKeys: string[] } = { todoKeys: [] },
  replacementFailure?: "approval" | "send",
) {
  let active = ["Read", "Write", "todo", "custom-tool"];
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, CommandLike>();
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
    registerCommand(name: string, command: CommandLike) { commands.set(name, command); },
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
    activeGoalHandoffKey: () => handoff.goalKey,
    hasExecutableTodo: (handoffKey) => handoff.todoKeys.includes(handoffKey),
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

test("Plan lifecycle keeps non-editing tools and restores the exact Act snapshot", async () => {
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
      "Read", "todo", "custom-tool", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status",
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
    assert.equal(confirmed.details.handoffStatus, "goal-required");
    assert.equal(getMode(), "act");
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.deepEqual(harness.active, actSnapshot);
    assert.equal(harness.messages.length, 0);
    const toolText = confirmed.content[0]?.text ?? "";
    assert.doesNotMatch(toolText, /# Approved/);
    assert.match(toolText, /already in the current context/);
    assert.match(toolText, /Todo dependency graph/);
    assert.match(toolText, /one active Goal/);
    assert.match(toolText, /locked boundaries and acceptance checks/);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.ok(loaded.manifest.handoffKey);
    assert.ok(loaded.manifest.approvedPath);
    assert.equal(await readFile(join(store.plansDir, loaded.manifest.approvedPath!), "utf8"), "# Approved\n\nImplement safely");

    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /Approved Plan handoff/);
    assert.equal(onToolCallPlan({ toolName: "goal", input: { action: "get" } }), undefined);
    const goalCreate = { action: "create", objective: "Execute approved plan" };
    assert.equal(onToolCallPlan({ toolName: "goal", input: goalCreate }), undefined);
    assert.equal(goalCreate.planHandoffKey, loaded.manifest.handoffKey);
    assert.match(onToolCallPlan({ toolName: "todo", input: { action: "create", subject: "Implement" } })?.reason ?? "", /active Goal/);
    harness.handoff.goalKey = "unrelated-goal";
    harness.handoff.todoKeys.push("unrelated-goal");
    assert.equal(getPlanHandoffStatus(), "goal-required");
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /Approved Plan handoff/);
    harness.handoff.goalKey = loaded.manifest.handoffKey;
    assert.equal(getPlanHandoffStatus(), "todo-required");
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /Approved Plan handoff/);
    const todoCreate = { action: "create", subject: "Implement" };
    assert.equal(onToolCallPlan({ toolName: "todo", input: todoCreate }), undefined);
    assert.equal(todoCreate.planHandoffKey, loaded.manifest.handoffKey);
    harness.handoff.todoKeys.push(loaded.manifest.handoffKey!);
    assert.equal(getPlanHandoffStatus(), "ready");
    assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan approve compacts with an explicit approved-Plan link before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-compact-"));
  const harness = createHarness(root, false, false, false, false, "compact-chat", ["\x1b[B", "\x1b[B", "\r"]);
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

test("plan-confirm tool keeps compact execution out of the follow-up queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-tool-compact-"));
  const harness = createHarness(root, false, false, false, false, "compact-tool-chat", ["\x1b[B", "\x1b[B", "\r", "\x1b"]);
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Tool Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, false);
    assert.equal(harness.compactions.length, 0);
    assert.equal(harness.messages.length, 0);
    assert.match(harness.notifications.join("\n"), /draft preserved without approval/);
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
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages.at(-1) ?? "", /# Clean Context Plan/);
    assert.equal(getPlanHandoffStatus(), "goal-required");
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /Approved Plan handoff/);
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
      ["\x1b[B", "\r"],
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
      assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /blocks|handoff/i);
      assert.match(
        harness.notifications.join("\n"),
        failure === "approval" ? /failed closed in Plan mode/ : /write-gated.*prompt could not be delivered/,
      );
    } finally {
      onSessionShutdownPlan(harness.ctx);
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    assert.equal(onToolCallPlan({ toolName: "custom-tool", input: {} }), undefined);
    assert.equal(onToolCallPlan({ toolName: "search_tool_bm25", input: { query: "browser" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "lsp", input: { action: "diagnostics", file: "src/app.ts" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "lsp", input: { action: "code_actions", file: "src/app.ts", apply: false } }), undefined);
    assert.match(onToolCallPlan({ toolName: "lsp", input: { action: "rename", file: "src/app.ts", new_name: "next" } })?.reason ?? "", /may modify files/);
    assert.match(onToolCallPlan({ toolName: "lsp", input: { action: "code_actions", file: "src/app.ts", apply: true } })?.reason ?? "", /may modify files/);
    assert.match(onToolCallPlan({ toolName: "browser", input: { action: "open", url: "https:\/\/example.com" } })?.reason ?? "", /blocks browser control/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git status" } })?.reason ?? "allowed", /allowed/);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro load --type project --list" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro search \"Plan Mode\" --code" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro explore \"FIND: plan hooks\\nSCOPE: packages/pi-maestro-flow/src/tools/plan.ts\"" } }), undefined);
    for (const action of ["status", "brief", "prepare", "check"]) {
      assert.equal(onToolCallPlan({ toolName: "run-control", input: { action } }), undefined, action);
    }
    for (const action of ["next", "done", "edit", "pause", "resume"]) {
      assert.match(onToolCallPlan({ toolName: "run-control", input: { action } })?.reason ?? "", /blocks/, action);
    }
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro run prepare analyze" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro run brief run-1" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro run recall execute --intent x --json" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro run skill execute" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "maestro run mutations" } }), undefined);
    const activeLifecycleMutations = [
      "next",
      "next --session s1",
      "create execute",
      "check run-1",
      "complete run-1",
      "decide point-1 --session s1 --verdict proceed",
      "seal-session session-1",
      "log-mutation file",
      "retry run-1",
      "cancel run-1",
    ];
    // These commands remain denylisted for Plan compatibility only. Pi coordinator
    // Skills must not recommend them as part of the normal Topic Session flow.
    const legacyMutationDenylist = [
      "rebind run-1 --reason x",
      "recall-confirm fork",
      "fork --token t",
      "import --token t",
      "new --token t",
    ];
    for (const subcommand of [...activeLifecycleMutations, ...legacyMutationDenylist]) {
      assert.match(
        onToolCallPlan({ toolName: "bash", input: { command: `maestro run ${subcommand}` } })?.reason ?? "",
        /modify files/,
        subcommand,
      );
    }
    for (const subcommand of ["resolve --session s1 --reason x --evidence y", "resume --session s1 --reason x --evidence y", "create feature --intent x", "chain insert --session s1", "migrate --session s1", "meta update --session s1"]) {
      assert.match(
        onToolCallPlan({ toolName: "bash", input: { command: `maestro session ${subcommand}` } })?.reason ?? "",
        /modify files/,
        subcommand,
      );
    }
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "maestro install" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git commit -am x" } })?.reason ?? "", /modify files/);
    for (const command of [
      "git rm src/app.ts",
      "git mv src/app.ts src/renamed.ts",
      "git update-index --assume-unchanged src/app.ts",
      "git update-ref refs/heads/main HEAD",
      "git tag release-candidate",
      "install source.txt target.txt",
      "tar -xf archive.tar",
      "patch -p1 < change.patch",
      "sort -o output.txt input.txt",
      "date --set tomorrow",
      "hostname renamed-host",
      "node scripts/prepare-package-skills.mjs",
      "unknown-read-command src/app.ts",
    ]) {
      assert.match(
        onToolCallPlan({ toolName: "bash", input: { command } })?.reason ?? "",
        /modify files/,
        command,
      );
    }
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "git status; node --version" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "npm test" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "npm run check:types" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "node scripts/check.mjs" } }), undefined);
    for (const command of [
      "git diff -- src/app.ts",
      "git log -n 1",
      "git branch --list main",
      "git tag --list 'v*'",
      "git worktree list",
      "find . -name '*.ts'",
      "tsc --noEmit",
      "prettier --check src/app.ts",
    ]) {
      assert.equal(onToolCallPlan({ toolName: "bash", input: { command } }), undefined, command);
    }
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "kill 1234" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "rg '\\brm\\b|cp|mv' packages/pi-maestro-flow/src" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "echo 'rm cp mv are write commands'" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "rg '\\$\\(|`|>|sh -c' packages/pi-maestro-flow/src" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "bash", input: { command: "rg \"\\$\\(\" packages/pi-maestro-flow/src" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "PowerShell", input: { command: "Select-String -Pattern '\\$\\(|>|pwsh -Command' src/app.ts" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "PowerShell", input: { command: "Get-Content x | Select-String plan" } }), undefined);
    assert.match(onToolCallPlan({ toolName: "PowerShell", input: { command: "Get-Content x | Set-Content y" } })?.reason ?? "", /modify files/);
    assert.equal(onToolCallPlan({ toolName: "PowerShell", input: { command: "Get-Content x" } }), undefined);
    assert.match(onToolCallPlan({ toolName: "bash", input: {} })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "find . -delete" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "find . -exec rm {} ;" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git diff --output=review.patch" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git log --ext-diff" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git branch -D old" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git remote set-url origin evil" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git grep x --open-files-in-pager=sh" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "fd pattern -x rm" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "rg pattern --pre 'rm file'" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "npm audit --fix" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "git status && rm src/app.ts" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "bash", input: { command: "sed -i 's/a/b/' src/app.ts" } })?.reason ?? "", /modify files/);
    assert.match(onToolCallPlan({ toolName: "PowerShell", input: { command: "Remove-Item src/app.ts" } })?.reason ?? "", /modify files/);
    for (const command of [
      "sh -c \"rm src/app.ts\"",
      "bash -lc 'touch src/app.ts'",
      "/bin/sh -c \"rm src/app.ts\"",
      "/bin/rm src/app.ts",
      "env bash -c \"rm src/app.ts\"",
      "env -S bash -c \"rm src/app.ts\"",
      "bash -O extglob -c \"rm src/app.ts\"",
      "bash -xec 'rm src/app.ts'",
      "command rm src/app.ts",
      "xargs -0 sh -c \"rm src/app.ts\"",
      "find . -exec /bin/sh -c \"rm src/app.ts\" ;",
      "cmd /c \"del src\\app.ts\"",
      "cmd /d /c \"del src\\app.ts\"",
      "pwsh -NoProfile -Command \"Set-Content src/app.ts x\"",
      "pwsh -ExecutionPolicy Bypass -Command \"Set-Content src/app.ts x\"",
      "eval 'rm src/app.ts'",
      "source 'scripts/write.sh'",
      ". 'scripts/write.sh'",
      "iex 'Set-Content src/app.ts x'",
      "Invoke-Expression 'Set-Content src/app.ts x'",
      "node --eval \"require('fs').writeFileSync('src/app.ts', 'x')\"",
      "node --input-type=module -e \"require('fs').writeFileSync('src/app.ts', 'x')\"",
      "python3 -c \"open('src/app.ts', 'w').write('x')\"",
      "python3 -I -c \"open('src/app.ts', 'w').write('x')\"",
      "echo $(printf safe)",
      "echo \"$(rm src/app.ts)\"",
      "echo `rm src/app.ts`",
      "Get-Content source.txt > copy.txt",
      "Get-Content < source.txt",
    ]) {
      assert.match(
        onToolCallPlan({ toolName: "bash", input: { command } })?.reason ?? "",
        /modify files/,
        command,
      );
    }
    assert.match(
      onToolCallPlan({
        toolName: "PowerShell",
        input: { command: '& "$env:SystemRoot\\System32\\cmd.exe" /c del src\\app.ts' },
      })?.reason ?? "",
      /modify files/,
    );
    assert.equal(
      onToolCallPlan({
        toolName: "bash",
        input: { command: "rg '/bin/rm|bash -xec|env -S bash -c|command rm|eval|source' packages/pi-maestro-flow/src" },
      }),
      undefined,
    );
    assert.equal(
      onToolCallPlan({
        toolName: "PowerShell",
        input: { command: "Select-String -Pattern '& \\\"cmd.exe\\\" /c del|iex|Invoke-Expression' src/app.ts" },
      }),
      undefined,
    );

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
  const binding: { goalKey?: string; todoKeys: string[] } = { todoKeys: [] };
  const first = createHarness(root, true, false, false, false, "handoff-chat", undefined, false, binding);
  try {
    await onSessionStartPlan(first.ctx);
    await execute(first, "plan-enter");
    await execute(first, "plan-update", { markdown: "# Restart handoff" });
    const confirmed = await execute(first, "plan-confirm");
    assert.equal(getPlanHandoffStatus(), "goal-required");
    const handoffKey = confirmed.details.handoffKey as string;
    onSessionShutdownPlan(first.ctx);

    const second = createHarness(root, false, false, false, false, "handoff-chat", undefined, false, binding);
    await onSessionStartPlan(second.ctx);
    assert.equal(getMode(), "act");
    assert.equal(getPlanHandoffStatus(), "goal-required");
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /Approved Plan handoff/);
    binding.goalKey = handoffKey;
    assert.equal(getPlanHandoffStatus(), "todo-required");
    binding.todoKeys.push(handoffKey);
    assert.equal(getPlanHandoffStatus(), "ready");
    assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);
    onSessionShutdownPlan(second.ctx);
  } finally {
    onSessionShutdownPlan(first.ctx);
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
