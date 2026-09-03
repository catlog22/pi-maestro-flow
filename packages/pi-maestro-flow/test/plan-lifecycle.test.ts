import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CompactionArbiter } from "../src/compaction/compaction-arbiter.ts";
import {
  consumePlanCleanContextCompaction,
  getMode,
  getPlanArtifactSummary,
  getPlanHandoffStatus,
  getPlanText,
  initPlan,
  isPlanCleanContextCompactionInstructions,
  onAgentEndPlan,
  onBeforeAgentStartPlan,
  onContextPlan,
  onAgentSettledPlan,
  onSessionShutdownPlan,
  onSessionStartPlan,
  onToolCallPlan,
  registerPlanCommand,
  registerPlanTools,
  setPlanModeChangeListener,
  PLAN_CLEAN_CONTEXT_COMPACTION_MARKER,
  type PlanWorkflowPublicationResult,
} from "../src/tools/plan.ts";
import {
  PlanStore,
  type LoadedPlan,
  type PlanExecutionChoice,
  type PlanWorkflowBinding,
} from "../src/tools/plan-store.ts";
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
  description?: string;
  parameters?: unknown;
  executionMode?: "parallel" | "sequential";
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<any>;
}

interface CommandLike {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

const COMPACT_EXECUTION_INPUTS = ["\x1b[B", "\x1b[C", "\x1b[13;5u"];
const WORKFLOW_CURRENT_EXECUTION_INPUTS = ["\x1b[C", "\x1b[13;5u"];
const WORKFLOW_NEW_COMPACT_EXECUTION_INPUTS = [
  "\x1b[C",
  "\x1b[B",
  "\x1b[C",
  "\x1b[B",
  "\x1b[C",
  "\x1b[13;5u",
];

test("clean-context compaction marker is recognized only as a leading instruction token", () => {
  assert.equal(isPlanCleanContextCompactionInstructions(PLAN_CLEAN_CONTEXT_COMPACTION_MARKER), true);
  assert.equal(
    isPlanCleanContextCompactionInstructions(` \n${PLAN_CLEAN_CONTEXT_COMPACTION_MARKER}\napproved`),
    true,
  );
  assert.equal(
    isPlanCleanContextCompactionInstructions(`User content ${PLAN_CLEAN_CONTEXT_COMPACTION_MARKER}`),
    false,
  );
});

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
    compactionHandoffTimeoutMs?: number;
    deferCompactionComplete?: boolean;
    onCompactionRequested?: () => void;
    sendUserMessageError?: string;
    confirmationResult?: unknown;
    workflowConfirmation?: () => {
      current?: { sessionId: string; intent: string; available: boolean; reason?: string };
      allowNew: boolean;
    };
    publishWorkflowPlan?: (
      approved: LoadedPlan,
      execution: PlanExecutionChoice,
    ) => Promise<PlanWorkflowPublicationResult>;
    storeFactory?: (
      cwd: string,
      session: { id: string; file?: string; name?: string },
    ) => PlanStore;
  } = {},
) {
  let active = ["Read", "Write", "Bash", "todo", "custom-tool"];
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, CommandLike>();
  const messages: string[] = [];
  const messageOptions: Array<{ deliverAs?: string } | undefined> = [];
  const notifications: string[] = [];
  const inputSignals: Array<AbortSignal | undefined> = [];
  const attentionRequests: Array<{ id: string; kind: string; subject?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const compactions: Array<{
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }> = [];
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
    async input(_title: string, _placeholder: string, options?: { signal?: AbortSignal }) {
      inputSignals.push(options?.signal);
      return runtime.discussionInput;
    },
    async custom(factory: Function) {
      if (Object.prototype.hasOwnProperty.call(runtime, "confirmationResult")) {
        return runtime.confirmationResult;
      }
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
    sendUserMessage(message: string, options?: { deliverAs?: string }) {
      if (runtime.sendUserMessageError) throw new Error(runtime.sendUserMessageError);
      messages.push(message);
      messageOptions.push(options);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: join(root, "workspace"),
    hasUI: true,
    isIdle: () => runtime.idle ?? true,
    abort() { aborts++; },
    getContextUsage: () => ({ percent: runtime.contextPercent ?? 0 }),
    compact(options: {
      customInstructions?: string;
      onComplete?: (result: unknown) => void;
      onError?: (error: Error) => void;
    }) {
      compactions.push(options);
      runtime.onCompactionRequested?.();
      if (!runtime.deferCompactionComplete) setImmediate(() => options.onComplete?.({}));
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
    storeFactory: runtime.storeFactory ?? ((cwd, session) => {
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
    }),
    hasExecutableTodo: (handoffKey) => handoff.todoKeys.includes(handoffKey),
    compactionArbiter: runtime.arbiter,
    ...(runtime.compactionHandoffTimeoutMs !== undefined
      ? { compactionHandoffTimeoutMs: runtime.compactionHandoffTimeoutMs }
      : {}),
    ...(runtime.workflowConfirmation
      ? { workflowConfirmation: () => runtime.workflowConfirmation!() }
      : {}),
    ...(runtime.publishWorkflowPlan
      ? { publishWorkflowPlan: (_ctx, approved, execution) => runtime.publishWorkflowPlan!(approved, execution) }
      : {}),
  });
  registerPlanTools(pi, {
    onUserAttention(request) { attentionRequests.push(request); },
  });
  registerPlanCommand(pi);
  return {
    pi,
    ctx,
    tools,
    commands,
    messages,
    messageOptions,
    notifications,
    inputSignals,
    attentionRequests,
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

test("Plan tool descriptions match the prompt-only mode lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-tool-contract-"));
  const harness = createHarness(root);
  try {
    assert.match(harness.tools.get("plan-enter")?.description ?? "", /load this chat session's current\.md draft/);
    assert.doesNotMatch(harness.tools.get("plan-enter")?.description ?? "", /activate Plan-only tools/);
    assert.match(harness.tools.get("plan-exit")?.description ?? "", /return to Act mode/);
    assert.doesNotMatch(harness.tools.get("plan-exit")?.description ?? "", /restore the exact prior active tool set/);
    assert.match(harness.tools.get("plan-status")?.description ?? "", /while Plan mode is active/);
    assert.match(harness.tools.get("plan-review")?.description ?? "", /interactive UI/);
    assert.equal(harness.tools.get("plan-review")?.executionMode, "sequential");
    assert.equal(harness.tools.get("plan-confirm")?.executionMode, "sequential");
    assert.match(harness.tools.get("plan-decompose")?.description ?? "", /main-flow decomposition prompt/);
    assert.match(harness.tools.get("plan-decompose")?.description ?? "", /exact approved handoff key/);
    assert.match(harness.tools.get("plan-decompose")?.description ?? "", /creates no files, Todos, messages, or agents/);
    const updateParams = harness.tools.get("plan-update")?.parameters as { properties?: Record<string, { description?: string }> };
    assert.match(updateParams?.properties?.expectedRevision?.description ?? "", /optimistic concurrency/);
    assert.match(updateParams?.properties?.expectedRevision?.description ?? "", /currently loaded revision/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-decompose requires Act plus exact approval and returns a side-effect-free main-flow prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-decompose-contract-"));
  const harness = createHarness(root, true);
  try {
    await onSessionStartPlan(harness.ctx);
    const beforeApproval = await execute(harness, "plan-decompose", {
      planHandoffKey: "not-approved",
    });
    assert.equal(beforeApproval.details.error, "E_PLAN_APPROVAL_REQUIRED");

    await execute(harness, "plan-enter");
    const whilePlanning = await execute(harness, "plan-decompose", {
      planHandoffKey: "not-approved",
    });
    assert.equal(whilePlanning.details.error, "E_PLAN_ACT_MODE_REQUIRED");

    await execute(harness, "plan-update", { markdown: "# Approved decomposition\n\nTwo ordered steps" });
    const confirmed = await execute(harness, "plan-confirm");
    const handoffKey = confirmed.details.handoffKey as string;
    assert.ok(handoffKey);
    assert.equal(getMode(), "act");

    const wrongKey = await execute(harness, "plan-decompose", {
      planHandoffKey: `${handoffKey}-wrong`,
    });
    assert.equal(wrongKey.details.error, "E_PLAN_HANDOFF_KEY_MISMATCH");

    const activeBefore = [...harness.active];
    const statusesBefore = [...harness.statuses];
    const decomposed = await execute(harness, "plan-decompose", {
      planHandoffKey: handoffKey,
    });
    const text = decomposed.content[0]?.text ?? "";
    assert.equal(decomposed.details.error, undefined);
    assert.equal(decomposed.details.mode, "act");
    assert.equal(decomposed.details.status, "approved");
    assert.equal(decomposed.details.handoffKey, handoffKey);
    assert.match(text, /converts it into the execution plan/);
    assert.match(text, /Approved Plan source:/);
    assert.match(text, /Approved checksum:/);
    assert.match(text, new RegExp(handoffKey));
    assert.match(text, /this batch IS the execution plan and the authoritative persisted record/);
    assert.match(text, /executing agent's independent work document/);
    assert.match(text, /do not delegate the decomposition step to a planner, decomposer, teammate/);
    assert.match(text, /has not created files, Todos, messages, or agents/);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.active, activeBefore);
    assert.deepEqual(harness.statuses, statusesBefore);
    assert.equal(getPlanHandoffStatus(), "todo-required");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-decompose fences a contract superseded by a newer Plan operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-decompose-fence-"));
  const harness = createHarness(root, true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved decomposition" });
    const confirmed = await execute(harness, "plan-confirm");
    const handoffKey = confirmed.details.handoffKey as string;

    let reads = 0;
    let supersedingOperation: Promise<unknown> | undefined;
    const stale = await execute(harness, "plan-decompose", {
      get planHandoffKey() {
        reads++;
        if (reads === 2) supersedingOperation = execute(harness, "plan-enter");
        return handoffKey;
      },
    });
    await supersedingOperation;

    assert.equal(stale.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(getMode(), "plan");
    assert.deepEqual(harness.messages, []);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan lifecycle leaves the tool surface untouched across every transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-lifecycle-"));
  const harness = createHarness(root);
  try {
    await onSessionStartPlan(harness.ctx);
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.equal(getPlanArtifactSummary().available, false);
    const actSnapshot = [...harness.active];
    // Session start is the one point that touches the surface, and it only tops
    // up the Plan tools so all seven stay callable on the stable surface.
    for (const tool of ["plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-decompose", "plan-exit", "plan-status"]) {
      assert.ok(actSnapshot.includes(tool), `expected ${tool} on the Act surface`);
    }
    assert.ok(actSnapshot.includes("Write"));

    await execute(harness, "plan-enter");
    assert.equal(getMode(), "plan");
    assert.equal(harness.statuses.at(-1), "PLAN");
    // The tool surface stays stable for prompt-cache reuse, while the tool-call hook
    // enforces the read-only boundary until approval.
    assert.deepEqual(harness.active, actSnapshot);
    assert.match(onToolCallPlan({ toolName: "Write", input: {} })?.reason ?? "", /read-only before approval/);

    const updated = await execute(harness, "plan-update", { markdown: "# Durable plan" });
    assert.equal(updated.details.revision, 1);
    assert.equal(harness.statuses.at(-1), "READY");
    assert.deepEqual(getPlanArtifactSummary(), { available: true, revision: 1, status: "draft" });
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
    assert.equal(getPlanArtifactSummary().available, true);
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
    assert.equal(harness.attentionRequests.length, 1);
    assert.equal(harness.attentionRequests[0]?.kind, "plan-confirm");
    assert.match(harness.attentionRequests[0]?.id ?? "", /plan-confirm:session-main/);
    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.details.handoffStatus, "todo-required");
    assert.equal(getMode(), "act");
    assert.equal(harness.statuses.at(-1), "ACT");
    assert.deepEqual(harness.active, actSnapshot);
    assert.equal(harness.messages.length, 0);
    assert.deepEqual(harness.messageOptions, []);
    const toolText = confirmed.content[0]?.text ?? "";
    assert.doesNotMatch(toolText, /Execution handoff queued/);
    assert.match(toolText, /selected Execute/);
    assert.match(toolText, /without another user prompt|Do not ask the user/);
    assert.match(toolText, /Prefer the teammate tool/);
    assert.doesNotMatch(toolText, /# Approved/);
    assert.match(toolText, /already in the current context/);
    assert.match(toolText, /Knowledge Gate/);
    assert.match(toolText, /maestro search/);
    assert.match(toolText, /maestro load/);
    assert.match(toolText, /Todo dependency graph/);
    assert.match(toolText, /Goal creation is optional/);
    assert.match(toolText, /Do not create a Goal solely because the Plan was approved/);
    assert.match(toolText, /A Todo without a Goal completes through its own acceptance criteria/);
    assert.match(toolText, /After implementation and verification, assess the task execution for reusable knowledge/);
    assert.match(toolText, /explicitly report zero knowledge candidates/);
    assert.match(toolText, /Never fabricate a candidate/);

    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: harness.ctx.sessionManager.getSessionId() },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.ok(loaded.manifest.handoffKey);
    assert.ok(loaded.manifest.approvedPath);
    assert.equal(await readFile(join(store.plansDir, loaded.manifest.approvedPath!), "utf8"), "# Approved\n\nImplement safely");

    // Approval returns to Act mode, so the pre-approval read-only hook is inactive.
    // The handoff gate remains advisory and is satisfied only by the matching Todo key.
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
    COMPACT_EXECUTION_INPUTS,
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
    assert.match(harness.compactions[0].customInstructions ?? "", /approvals[\\/].*\.md/);
    assert.doesNotMatch(harness.compactions[0].customInstructions ?? "", /current\.md/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.messages.length, 1);
    assert.doesNotMatch(harness.messages.at(-1) ?? "", /# Compact Plan/);
    assert.match(harness.messages.at(-1) ?? "", /already in the current context/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-confirm tool defers compact until the current Pi turn settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-tool-compact-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-tool-chat",
    COMPACT_EXECUTION_INPUTS,
  );
  harness.ctx.isIdle = () => false;
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Tool Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    const toolText = confirmed.content[0]?.text ?? "";
    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.terminate, true);
    assert.equal(harness.compactions.length, 0, "the active plan-confirm tool must return before compact starts");
    assert.equal(harness.messages.length, 0);
    assert.match(toolText, /after this turn settles/);
    assert.match(toolText, /resumes automatically/);

    harness.ctx.isIdle = () => true;
    onAgentSettledPlan(harness.ctx);
    assert.equal(harness.compactions.length, 1);
    assert.match(harness.compactions[0]?.customInstructions ?? "", /authoritative execution contract/);
    assert.doesNotMatch(harness.compactions[0]?.customInstructions ?? "", /maestro-plan-clean-context/);
    harness.compactions[0]?.onComplete?.({});
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /selected Execute/);
    assert.match(harness.messages[0] ?? "", /Knowledge Gate/);
    assert.equal(getMode(), "act");
    assert.equal(harness.aborts, 1, "compact approval aborts the remaining mixed tool batch");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan approval never creates a new Pi session even when the host exposes newSession", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-no-new-session-"));
  const harness = createHarness(root, true, false, false, false, "same-session-chat", undefined, true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Same Pi Session Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);
    assert.equal(harness.newSessions, 0);
    assert.equal(getMode(), "act");
    const store = new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: "same-session-chat" },
    });
    const loaded = await store.load();
    assert.equal(loaded.manifest.status, "approved");
    assert.deepEqual(loaded.manifest.execution, { backend: "standalone", context: "current" });
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow-backed approval persists a bound result before delivering the Run brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-workflow-bound-"));
  let publications = 0;
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "workflow-bound-chat",
    WORKFLOW_CURRENT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      workflowConfirmation: () => ({
        current: { sessionId: "workflow-1", intent: "Execute approved Plan", available: true },
        allowNew: true,
      }),
      async publishWorkflowPlan(approved, execution) {
        publications++;
        assert.deepEqual(execution, { backend: "workflow", context: "current", workflowTarget: "current" });
        assert.equal(approved.manifest.workflowBinding?.status, "pending");
        return {
          binding: {
            status: "bound",
            handoffKey: approved.manifest.handoffKey!,
            sourceChecksum: approved.manifest.approvedChecksum!,
            workflowSessionId: "workflow-1",
            workflowSessionGeneration: "canonical:valid:workflow-1:2",
            artifactId: "ART-001-001",
            producerRunId: "run-plan-publish",
            executionRunId: "run-execute",
            requestId: "req-plan-publish",
            updatedAt: "2026-08-02T12:00:00.000Z",
          },
          executionMessage: "WORKFLOW RUN BRIEF",
        };
      },
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Workflow Bound Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    const text = confirmed.content[0]?.text ?? "";
    assert.equal(publications, 1);
    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.details.workflowBinding?.status, "bound");
    assert.equal(confirmed.details.workflowBinding?.deliveryStatus, "delivered");
    assert.match(text, /WORKFLOW RUN BRIEF/);
    assert.match(text, /workflow/);
    assert.match(text, /selected Execute/);
    assert.equal(harness.messages.length, 0);
    assert.deepEqual(harness.messageOptions, []);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow new-session compact returns before settlement and resumes after compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-workflow-new-compact-"));
  let signalCompactionStarted: (() => void) | undefined;
  const compactionStarted = new Promise<void>((resolve) => { signalCompactionStarted = resolve; });
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "workflow-new-compact-chat",
    WORKFLOW_NEW_COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      arbiter: new CompactionArbiter(),
      deferCompactionComplete: true,
      onCompactionRequested: () => signalCompactionStarted?.(),
      workflowConfirmation: () => ({
        current: { sessionId: "workflow-current", intent: "Current work", available: true },
        allowNew: true,
      }),
      async publishWorkflowPlan(approved, execution) {
        assert.deepEqual(execution, { backend: "workflow", context: "compact", workflowTarget: "new" });
        return {
          binding: {
            status: "bound",
            handoffKey: approved.manifest.handoffKey!,
            sourceChecksum: approved.manifest.approvedChecksum!,
            workflowSessionId: "workflow-new",
            workflowSessionGeneration: "canonical:valid:workflow-new:1",
            artifactId: "ART-001-001",
            producerRunId: "run-plan-publish",
            executionRunId: "run-execute",
            requestId: "req-plan-new-compact",
            updatedAt: "2026-08-27T12:00:00.000Z",
          },
          executionMessage: "WORKFLOW NEW SESSION RUN BRIEF",
        };
      },
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Workflow New Compact Plan" });
    const confirmed = await execute(harness, "plan-confirm");

    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.terminate, true);
    assert.equal(confirmed.details.workflowBinding?.workflowSessionId, "workflow-new");
    assert.equal(confirmed.details.workflowBinding?.deliveryStatus, "pending");
    assert.equal(harness.compactions.length, 0);
    assert.equal(harness.messages.length, 0);

    onAgentSettledPlan(harness.ctx);
    await compactionStarted;
    assert.equal(harness.compactions.length, 1);
    harness.compactions[0]?.onComplete?.({});
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /WORKFLOW NEW SESSION RUN BRIEF/);
    assert.match(harness.messages[0] ?? "", /selected Execute/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow publication failure preserves approval and never falls back to standalone execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-workflow-failed-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "workflow-failed-chat",
    WORKFLOW_CURRENT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      workflowConfirmation: () => ({
        current: { sessionId: "workflow-1", intent: "Execute approved Plan", available: true },
        allowNew: false,
      }),
      async publishWorkflowPlan() {
        throw new Error("publisher unavailable");
      },
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Workflow Failure Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    const text = confirmed.content[0]?.text ?? "";
    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.details.workflowBinding?.status, "failed");
    assert.match(text, /binding failed/i);
    assert.match(text, /execution was not started/i);
    assert.equal(harness.messages.length, 0);
    assert.match(harness.notifications.join("\n"), /publisher unavailable/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

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
    COMPACT_EXECUTION_INPUTS,
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
    const exitResult = onBeforeAgentStartPlan({ systemPrompt: "base" });
    const exitPrompt = exitResult?.message?.content ?? "";
    assert.equal(exitResult?.message?.customType, "plan-mode-reminder");
    assert.equal(exitResult?.message?.display, false);
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

test("Continue discussion returns feedback through the tool result without injection", async () => {
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
    const controller = new AbortController();
    const confirmTool = harness.tools.get("plan-confirm");
    assert.ok(confirmTool);
    const confirmed = await confirmTool.execute(
      "plan-confirm",
      {},
      controller.signal,
      undefined,
      harness.ctx,
    );
    assert.equal(harness.inputSignals.at(-1), controller.signal);
    assert.equal(confirmed.details.approved, false);
    assert.equal(getMode(), "plan");
    assert.deepEqual(harness.messages, []);
    assert.equal(harness.aborts, 0);
    assert.match(confirmed.content[0]?.text ?? "", /Plan feedback returned/);
    assert.match(confirmed.content[0]?.text ?? "", /Keep the API compatible/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed confirmation UI results cannot approve a Plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-confirm-malformed-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "malformed-confirmation",
    undefined,
    false,
    { todoKeys: [] },
    undefined,
    { confirmationResult: {} },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Unapproved Plan" });
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
    assert.deepEqual(loaded.manifest.approvals, []);
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

test("Plan hooks preserve read-only discovery and block mutations before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-hooks-"));
  const harness = createHarness(root);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    const planResult = onBeforeAgentStartPlan({ systemPrompt: "base" });
    const planPrompt = planResult?.message?.content ?? "";
    assert.equal(planResult?.message?.customType, "plan-mode-reminder");
    assert.match(planPrompt, /Align every user requirement/);
    assert.match(planPrompt, /verifiable acceptance check/);
    for (const role of ["explorer", "planner"]) {
      assert.ok(planPrompt.includes(`\`${role}\``), role);
    }
    assert.doesNotMatch(planPrompt, /`analyst`/);
    assert.doesNotMatch(planPrompt, /`research`/);
    assert.match(planPrompt, /dispatch `explorer` ONCE with batched parallel/);
    assert.match(planPrompt, /unless the cross-module escalation below applies, dispatch one `planner`/);
    assert.match(planPrompt, /exact `agent:\/\/` publication ID as an immutable briefing reference/);
    assert.match(planPrompt, /correlation ID only when latest-turn semantics are intentional/);
    assert.match(planPrompt, /Never use plan-exit to bypass a blocked role or tool/);
    assert.match(planPrompt, /moves to background or a bounded\s+wait times out/);
    assert.match(planPrompt, /do not begin final synthesis or call plan-update \/ plan-confirm/);
    assert.match(planPrompt, /until every required result is result-ready/);
    assert.match(planPrompt, /each result's content is present in the current context/);
    assert.match(planPrompt, /Lightweight flow \(small, well-understood task\): skip agent exploration entirely/);
    assert.match(planPrompt, /at most ONE nested read-only agent/);
    assert.match(planPrompt, /revising its own draft/);
    assert.match(planPrompt, /Multi-planner escalation \(cross-module scope only\)/);
    assert.match(planPrompt, /up to 3\s+planners in parallel/);
    assert.match(planPrompt, /maxNestingDepth: 0 \(sub-planners get no nested/);
    assert.match(planPrompt, /briefing carrying only that module's exact immutable explorer publication IDs/);
    assert.match(planPrompt, /never use a task-name URI as durable briefing/);
    assert.match(planPrompt, /evidence spot-checking, contract validation, plan-update, and plan-confirm/);
    assert.match(planPrompt, /persist the returned\s+Markdown only after checking it against the planner role contract/);
    assert.match(planPrompt, /targeted revision/);
    assert.doesNotMatch(planPrompt, /Required Plan document contract/);
    assert.doesNotMatch(planPrompt, /## Objective/);
    assert.doesNotMatch(planPrompt, /Files \/ symbols/);
    assert.match(planPrompt, /Use ask-user-question for every user question/);
    assert.match(planPrompt, /Ask 2-4 related questions per call/);
    assert.match(planPrompt, /Root performs one contract spot-check/);
    assert.match(planPrompt, /without starting\s+another review chain/);
    assert.match(planPrompt, /scope, boundaries, non-goals/);
    assert.match(planPrompt, /end-of-execution knowledge outcome/);
    assert.match(planPrompt, /explicit zero-candidate result/);
    assert.match(planPrompt, /Actual knowledge writes happen after approval in Act\/Run mode/);
    assert.match(planPrompt, /Goal creation is optional/);
    assert.match(planPrompt, /never create one solely because the Plan was approved/);
    assert.match(planPrompt, /most\s+Todos should complete without one/);
    for (const toolName of ["Read", "ffgrep", "fffind", "smart_search", "session_history"]) {
      assert.equal(onToolCallPlan({ toolName, input: {} }), undefined, toolName);
    }
    assert.match(onToolCallPlan({ toolName: "custom-tool", input: {} })?.reason ?? "", /blocked/);
    for (const toolName of ["Write", "Edit", "NotebookEdit"]) {
      assert.match(onToolCallPlan({ toolName, input: {} })?.reason ?? "", /read-only before approval/);
    }
    // Bash is default-allow in Plan mode: read-only discovery stays available...
    for (const command of [
      "rg -n Plan src",
      "rg -ln persistAgentOutput packages",
      "diff -u a.txt b.txt",
      "find . -name '*.ts'",
      "du -sh .",
      "ls -la | head -20",
      "ls -la && git status --short",
      "git log --oneline -5",
      "git -C src status",
      "git --no-pager diff HEAD~1",
      "git grep -n foo src",
      "git branch -a",
      "git rev-parse HEAD",
      "node --version",
      "npm ls --depth=0",
      "curl -sI https://example.com",
      "sed -n '1,5p' file.txt",
      "grep -rn \"rm -rf\" docs",
      "cat file > /dev/null",
      "cd /tmp && ls -la",
      "maestro search \"plan mode\" --json",
      "maestro knowledge review --json",
      "maestro run status --json",
      "$(date)",
    ]) {
      assert.equal(
        onToolCallPlan({ toolName: "bash", input: { command } }),
        undefined,
        command,
      );
    }
    // ... only clearly mutating commands are blocked.
    for (const command of [
      "rm -rf src",
      "xargs rm -f",
      "; rm -rf src",
      "(rm src) || true",
      "mv a b",
      "sed -i 's/a/b/' src/app.ts",
      "git diff --output=review.patch",
      "git show --ext-diff HEAD",
      "rg --pre 'touch modified.txt' Plan src",
      "echo hi > f.txt",
      "git add .",
      "git commit -m x",
      "git push origin main",
      "git branch -d old",
      "git config user.name me",
      "npm install lodash",
      "npm run build",
      "bash -c \"rm -rf src\"",
      "find . -name '*.tmp' -delete",
      "tee out.txt",
      "curl -o f https://x",
      "wget https://x",
      "mkdir -p dist",
      "maestro knowledge stage spec x",
      "maestro run next",
    ]) {
      assert.match(onToolCallPlan({ toolName: "bash", input: { command } })?.reason ?? "", /blocked/, command);
    }
    assert.equal(onToolCallPlan({ toolName: "run-control", input: { action: "status" } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "run-control", input: { action: "brief" } }), undefined);
    for (const action of ["next", "done", "edit"]) {
      assert.match(onToolCallPlan({ toolName: "run-control", input: { action } })?.reason ?? "", /blocked/, action);
    }
    assert.equal(onToolCallPlan({ toolName: "run-control", input: { argv: ["session", "status"] } }), undefined);
    assert.equal(onToolCallPlan({ toolName: "run-control", input: { argv: ["run", "brief", "run-1"] } }), undefined);
    for (const argv of [
      ["session", "next"],
      ["run", "done", "run-1"],
      ["run", "edit", "verify"],
      ["session", "create", "topic"],
    ]) {
      assert.match(onToolCallPlan({ toolName: "run-control", input: { argv } })?.reason ?? "", /blocked/, argv.join(" "));
    }
    assert.equal(onToolCallPlan({ toolName: "todo", input: { action: "list" } }), undefined);
    assert.match(onToolCallPlan({ toolName: "todo", input: { action: "create" } })?.reason ?? "", /blocked/);
    // Plan mode dispatch allowlist: explorer and planner pass; other roles are blocked at root.
    assert.equal(onToolCallPlan({
      toolName: "teammate",
      input: { tasks: [{ prompt: "find entry points", agent: "explorer" }] },
    }), undefined);
    assert.equal(onToolCallPlan({
      toolName: "teammate",
      input: { tasks: [{ prompt: "author the Plan", agent: "planner" }] },
    }), undefined);
    for (const role of ["analyst", "research", "general"]) {
      assert.match(onToolCallPlan({
        toolName: "teammate",
        input: { tasks: [{ prompt: "work", agent: role }] },
      })?.reason ?? "", /blocked/, role);
    }
    // Plan mode allows targeted revision of a read-only planner/explorer via teammate-send
    // (steer/follow_up are message injections), but blocks abort (terminates the agent).
    assert.equal(onToolCallPlan({
      toolName: "teammate-send",
      input: { to: "planner-1", message: "revise section 3", mode: "follow_up" },
    }), undefined);
    assert.equal(onToolCallPlan({
      toolName: "teammate-send",
      input: { to: "planner-1", message: "stop and rewrite", mode: "steer" },
    }), undefined);
    assert.match(onToolCallPlan({
      toolName: "teammate-send",
      input: { to: "planner-1", mode: "abort" },
    })?.reason ?? "", /blocked/);
    // Default mode (omitted) is steer — allowed.
    assert.equal(onToolCallPlan({
      toolName: "teammate-send",
      input: { to: "planner-1", message: "revise section 3" },
    }), undefined);
    assert.match(onToolCallPlan({ toolName: "computer_use", input: { action: "guide" } })?.reason ?? "", /blocked/);
    assert.match(onToolCallPlan({ toolName: "computer_use", input: { action: "capabilities" } })?.reason ?? "", /blocked/);
    assert.equal(onToolCallPlan({ toolName: "goal", input: { action: "get" } }), undefined);
    assert.match(onToolCallPlan({ toolName: "goal", input: { action: "create" } })?.reason ?? "", /blocked/);
    assert.match(onToolCallPlan({
      toolName: "teammate",
      input: { tasks: [{ prompt: "write", mode: "write" }] },
    })?.reason ?? "", /blocked/);

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
  const goalCtx = {
    cwd: root,
    modelRegistry: {
      getAvailable: () => [{ provider: "provider", id: "verifier-model" }],
    },
    ui: { notify() {}, setStatus() {} },
    isIdle: () => false,
    abort() {},
  } as GoalContext;
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

test("compatibility capture cannot downgrade an approved Plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-approved-capture-"));
  const harness = createHarness(root, true);
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approved" });
    await execute(harness, "plan-confirm");
    await execute(harness, "plan-enter");
    await onAgentEndPlan({
      messages: [{ role: "assistant", content: "<proposed_plan># Replacement</proposed_plan>" }],
    }, harness.ctx);
    const status = await execute(harness, "plan-status");
    assert.equal(status.details.status, "approved");
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

test("Session restart idempotently recovers a pending Workflow binding and resumes the Run brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-workflow-recovery-"));
  const sessionId = "workflow-recovery-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  const initial = await store.load();
  const draft = await store.saveDraft("# Recover Workflow Binding", initial.manifest.revision);
  const approved = await store.approve(draft.markdown, draft.manifest.revision, {
    execution: { backend: "workflow", context: "current", workflowTarget: "current" },
  });
  await store.updateWorkflowBinding(approved.manifest.handoffKey!, {
    status: "failed",
    handoffKey: approved.manifest.handoffKey!,
    sourceChecksum: approved.manifest.approvedChecksum!,
    error: "interrupted before binding commit",
    updatedAt: "2026-08-02T12:00:00.000Z",
  });

  let publications = 0;
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    sessionId,
    undefined,
    false,
    { todoKeys: [] },
    undefined,
    {
      async publishWorkflowPlan(loaded, execution) {
        publications++;
        assert.equal(loaded.manifest.workflowBinding?.status, "pending");
        assert.equal(loaded.manifest.handoffKey, approved.manifest.handoffKey);
        assert.equal(loaded.manifest.approvedChecksum, approved.manifest.approvedChecksum);
        assert.deepEqual(execution, { backend: "workflow", context: "current", workflowTarget: "current" });
        return {
          binding: {
            status: "bound",
            handoffKey: approved.manifest.handoffKey!,
            sourceChecksum: approved.manifest.approvedChecksum!,
            workflowSessionId: "workflow-recovered",
            artifactId: "ART-001-001",
            producerRunId: "run-plan-publish",
            executionRunId: "run-execute",
            requestId: "req-replayed",
            updatedAt: "2026-08-02T12:01:00.000Z",
          },
          executionMessage: "RECOVERED WORKFLOW RUN BRIEF",
        };
      },
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    const recovered = await store.load();
    assert.equal(publications, 1);
    assert.equal(recovered.manifest.status, "approved");
    assert.equal(recovered.manifest.workflowBinding?.status, "bound");
    assert.equal(recovered.manifest.workflowBinding?.deliveryStatus, "delivered");
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /RECOVERED WORKFLOW RUN BRIEF/);
    assert.match(harness.notifications.join("\n"), /Recovered approved Plan binding/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Session restart delivers a bound Workflow handoff that was interrupted before prompt enqueue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-workflow-delivery-recovery-"));
  const sessionId = "workflow-delivery-recovery-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  const draft = await store.saveDraft("# Recover Bound Delivery", 0);
  const approved = await store.approve(draft.markdown, draft.manifest.revision, {
    execution: { backend: "workflow", context: "current", workflowTarget: "current" },
  });
  const coreBinding: PlanWorkflowBinding = {
    status: "bound",
    handoffKey: approved.manifest.handoffKey!,
    sourceChecksum: approved.manifest.approvedChecksum!,
    workflowSessionId: "workflow-bound",
    artifactId: "ART-001-001",
    producerRunId: "run-plan-publish",
    executionRunId: "run-execute",
    requestId: "req-bound-delivery",
    updatedAt: "2026-08-02T12:00:00.000Z",
  };
  await store.updateWorkflowBinding(coreBinding.handoffKey, {
    ...coreBinding,
    deliveryId: "req-bound-delivery:implementation",
    deliveryStatus: "pending",
  });

  let replays = 0;
  const harness = createHarness(
    root, false, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      async publishWorkflowPlan(loaded) {
        replays++;
        assert.equal(loaded.manifest.workflowBinding?.status, "bound");
        assert.equal(loaded.manifest.workflowBinding?.deliveryStatus, "pending");
        return { binding: coreBinding, executionMessage: "BOUND WORKFLOW RUN BRIEF" };
      },
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    const recovered = await store.load();
    assert.equal(replays, 1);
    assert.equal(recovered.manifest.workflowBinding?.status, "bound");
    assert.equal(recovered.manifest.workflowBinding?.deliveryStatus, "delivered");
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /BOUND WORKFLOW RUN BRIEF/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order shutdown/start ignores a stale Plan load from the prior lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-load-"));
  const sessionId = "reverse-load-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  await store.saveDraft("# Older draft", 0);

  let releaseLoad!: () => void;
  let markLoadCaptured!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const loadCaptured = new Promise<void>((resolve) => { markLoadCaptured = resolve; });
  let stores = 0;
  class DeferredLoadStore extends PlanStore {
    override async load(): Promise<LoadedPlan> {
      const loaded = await super.load();
      markLoadCaptured();
      await loadGate;
      return loaded;
    }
  }
  const harness = createHarness(
    root, false, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      storeFactory(cwd, session) {
        if (stores++ === 0) return new DeferredLoadStore(cwd, { rootDir: join(root, "global"), session });
        return new PlanStore(cwd, { rootDir: join(root, "global"), session });
      },
    },
  );

  try {
    const staleStart = onSessionStartPlan(harness.ctx);
    await loadCaptured;
    await store.saveDraft("# Newer draft", 1);

    onSessionShutdownPlan(harness.ctx);
    await onSessionStartPlan(harness.ctx);
    assert.equal(getPlanText(), "# Newer draft");

    releaseLoad();
    await staleStart;
    assert.equal(getPlanText(), "# Newer draft", "the old load must not overwrite the restarted lifecycle");
    assert.doesNotMatch(harness.notifications.join("\n"), /Plan draft unavailable/);
  } finally {
    releaseLoad();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order shutdown/start fences stale Workflow recovery publication results", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-recovery-"));
  const sessionId = "reverse-recovery-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  const draft = await store.saveDraft("# Recover once", 0);
  const approved = await store.approve(draft.markdown, draft.manifest.revision, {
    execution: { backend: "workflow", context: "current", workflowTarget: "current" },
  });
  await store.updateWorkflowBinding(approved.manifest.handoffKey!, {
    status: "failed",
    handoffKey: approved.manifest.handoffKey!,
    sourceChecksum: approved.manifest.approvedChecksum!,
    error: "retry",
    updatedAt: "2026-08-03T00:00:00.000Z",
  });

  let releaseFirstPublication!: () => void;
  let markFirstPublication!: () => void;
  const firstPublicationGate = new Promise<void>((resolve) => { releaseFirstPublication = resolve; });
  const firstPublicationStarted = new Promise<void>((resolve) => { markFirstPublication = resolve; });
  let publications = 0;
  const binding = (requestId: string): PlanWorkflowBinding => ({
    status: "bound",
    handoffKey: approved.manifest.handoffKey!,
    sourceChecksum: approved.manifest.approvedChecksum!,
    workflowSessionId: `workflow-${requestId}`,
    artifactId: "ART-001-001",
    producerRunId: "run-publish",
    executionRunId: "run-execute",
    requestId,
    updatedAt: "2026-08-03T00:01:00.000Z",
  });
  const harness = createHarness(
    root, false, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      async publishWorkflowPlan() {
        publications++;
        if (publications === 1) {
          markFirstPublication();
          await firstPublicationGate;
          return { binding: binding("stale"), executionMessage: "STALE RUN BRIEF" };
        }
        return { binding: binding("current"), executionMessage: "CURRENT RUN BRIEF" };
      },
    },
  );

  try {
    const staleStart = onSessionStartPlan(harness.ctx);
    await firstPublicationStarted;
    onSessionShutdownPlan(harness.ctx);
    await onSessionStartPlan(harness.ctx);

    releaseFirstPublication();
    await staleStart;
    const recovered = await store.load();
    assert.equal(publications, 2);
    assert.equal(recovered.manifest.workflowBinding?.requestId, "current");
    assert.equal(recovered.manifest.workflowBinding?.deliveryStatus, "delivered");
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /CURRENT RUN BRIEF/);
    assert.doesNotMatch(harness.messages.join("\n"), /STALE RUN BRIEF/);
    assert.equal(
      harness.notifications.filter((message) => /Recovered approved Plan binding/.test(message)).length,
      1,
    );
  } finally {
    releaseFirstPublication();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order plan-enter keeps the newer loaded draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-enter-"));
  const sessionId = "reverse-enter-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  await store.saveDraft("# Older enter draft", 0);

  let releaseFirstLoad!: () => void;
  let markFirstLoad!: () => void;
  const firstLoadGate = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
  const firstLoadCaptured = new Promise<void>((resolve) => { markFirstLoad = resolve; });
  let quickLoads = 0;
  class DeferredQuickLoadStore extends PlanStore {
    override async loadQuick(): Promise<LoadedPlan> {
      const loaded = await super.loadQuick();
      if (quickLoads++ === 0) {
        markFirstLoad();
        await firstLoadGate;
      }
      return loaded;
    }
  }
  const harness = createHarness(
    root, false, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      storeFactory: (cwd, session) => new DeferredQuickLoadStore(cwd, { rootDir: join(root, "global"), session }),
    },
  );

  try {
    await onSessionStartPlan(harness.ctx);
    const staleEnter = execute(harness, "plan-enter");
    await firstLoadCaptured;
    await store.saveDraft("# Newer enter draft", 1);

    const currentEnter = await execute(harness, "plan-enter");
    assert.equal(currentEnter.details.error, undefined);
    assert.equal(getPlanText(), "# Newer enter draft");

    releaseFirstLoad();
    const staleResult = await staleEnter;
    assert.equal(staleResult.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(getPlanText(), "# Newer enter draft");
    assert.equal(getMode(), "plan");
  } finally {
    releaseFirstLoad();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order plan-update keeps the newer save result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-update-"));
  const sessionId = "reverse-update-chat";
  const store = new PlanStore(join(root, "workspace"), {
    rootDir: join(root, "global"),
    session: { id: sessionId },
  });
  await store.saveDraft("# Initial draft", 0);

  let releaseFirstSave!: () => void;
  let markFirstSave!: () => void;
  const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  const firstSaveCaptured = new Promise<void>((resolve) => { markFirstSave = resolve; });
  let saves = 0;
  class DeferredSaveStore extends PlanStore {
    override async saveDraft(markdown: string, expectedRevision?: number): Promise<LoadedPlan> {
      const saved = await super.saveDraft(markdown, expectedRevision);
      if (saves++ === 0) {
        markFirstSave();
        await firstSaveGate;
      }
      return saved;
    }
  }
  const harness = createHarness(
    root, false, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      storeFactory: (cwd, session) => new DeferredSaveStore(cwd, { rootDir: join(root, "global"), session }),
    },
  );

  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    const staleUpdate = execute(harness, "plan-update", { markdown: "# Stale save" });
    await firstSaveCaptured;

    const currentUpdate = await execute(harness, "plan-update", {
      markdown: "# Newer save",
      expectedRevision: 2,
    });
    assert.equal(currentUpdate.details.revision, 3);
    assert.equal(getPlanText(), "# Newer save");

    releaseFirstSave();
    const staleResult = await staleUpdate;
    assert.equal(staleResult.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(getPlanText(), "# Newer save");
    assert.equal((await store.load()).markdown, "# Newer save");
  } finally {
    releaseFirstSave();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order approval cannot restore stale approved state or deliver execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-approval-"));
  const sessionId = "reverse-approval-chat";
  let releaseApproval!: () => void;
  let markApproval!: () => void;
  const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  const approvalCaptured = new Promise<void>((resolve) => { markApproval = resolve; });
  let capturedApproval: LoadedPlan | undefined;
  class DeferredApprovalStore extends PlanStore {
    override async approve(...args: Parameters<PlanStore["approve"]>): Promise<LoadedPlan> {
      capturedApproval = await super.approve(...args);
      markApproval();
      await approvalGate;
      return capturedApproval;
    }
  }
  const harness = createHarness(
    root, true, false, false, false, sessionId, undefined, false, { todoKeys: [] }, undefined,
    {
      storeFactory: (cwd, session) => new DeferredApprovalStore(cwd, { rootDir: join(root, "global"), session }),
    },
  );

  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Approval candidate" });
    const staleApproval = execute(harness, "plan-confirm");
    await approvalCaptured;
    assert.ok(capturedApproval);

    await execute(harness, "plan-update", {
      markdown: "# Newer post-approval draft",
      expectedRevision: capturedApproval.manifest.revision,
    });
    releaseApproval();

    const staleResult = await staleApproval;
    assert.equal(staleResult.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(getMode(), "plan");
    assert.equal(getPlanText(), "# Newer post-approval draft");
    assert.equal(harness.messages.length, 0);
  } finally {
    releaseApproval();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse-order Workflow publication cannot bind or deliver after a newer Plan operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-publication-"));
  const sessionId = "reverse-publication-chat";
  let releasePublication!: () => void;
  let markPublication!: () => void;
  const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
  const publicationStarted = new Promise<void>((resolve) => { markPublication = resolve; });
  const harness = createHarness(
    root, false, false, false, false, sessionId, WORKFLOW_CURRENT_EXECUTION_INPUTS,
    false, { todoKeys: [] }, undefined,
    {
      workflowConfirmation: () => ({
        current: { sessionId: "workflow-current", intent: "execute", available: true },
        allowNew: false,
      }),
      async publishWorkflowPlan(approved) {
        markPublication();
        await publicationGate;
        return {
          binding: {
            status: "bound",
            handoffKey: approved.manifest.handoffKey!,
            sourceChecksum: approved.manifest.approvedChecksum!,
            workflowSessionId: "workflow-stale",
            artifactId: "ART-001-001",
            producerRunId: "run-publish",
            executionRunId: "run-execute",
            requestId: "request-stale",
            updatedAt: "2026-08-03T01:00:00.000Z",
          },
          executionMessage: "STALE NORMAL RUN BRIEF",
        };
      },
    },
  );

  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Workflow publication candidate" });
    const stalePublication = execute(harness, "plan-confirm");
    await publicationStarted;

    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Newer draft after publication" });
    releasePublication();

    const staleResult = await stalePublication;
    assert.equal(staleResult.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(getPlanText(), "# Newer draft after publication");
    assert.equal(harness.messages.length, 0);
    assert.doesNotMatch(harness.notifications.join("\n"), /workflow-stale/);
    const persisted = await new PlanStore(harness.ctx.cwd, {
      rootDir: join(root, "global"),
      session: { id: sessionId },
    }).load();
    assert.equal(persisted.manifest.workflowBinding, undefined);
  } finally {
    releasePublication();
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("newer Plan operation fences a deferred compact delivery callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reverse-delivery-"));
  let signalCompactionStarted: (() => void) | undefined;
  const compactionStarted = new Promise<void>((resolve) => { signalCompactionStarted = resolve; });
  const harness = createHarness(
    root, false, false, false, false, "reverse-delivery-chat", COMPACT_EXECUTION_INPUTS,
    false, { todoKeys: [] }, undefined,
    {
      arbiter: new CompactionArbiter(),
      deferCompactionComplete: true,
      onCompactionRequested: () => signalCompactionStarted?.(),
    },
  );

  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact delivery candidate" });
    const approved = await execute(harness, "plan-confirm");
    assert.equal(approved.details.approved, true);
    assert.equal(approved.terminate, true);
    assert.equal(harness.compactions.length, 0);

    onAgentSettledPlan(harness.ctx);
    await compactionStarted;
    assert.equal(harness.compactions.length, 1);

    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Newer draft before delivery" });
    harness.compactions[0]?.onComplete?.({});

    assert.equal(harness.messages.length, 0);
    assert.equal(getMode(), "plan");
    assert.equal(getPlanText(), "# Newer draft before delivery");
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
    for (const tool of ["plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-decompose", "plan-exit", "plan-status"]) {
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

test("Plan compact execution keeps the current Pi session and creates no clean-context replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-compact-current-session-"));
  let signalCompactionStarted: (() => void) | undefined;
  const compactionStarted = new Promise<void>((resolve) => { signalCompactionStarted = resolve; });
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-current-chat",
    COMPACT_EXECUTION_INPUTS,
    true,
    { todoKeys: [] },
    undefined,
    {
      arbiter: new CompactionArbiter(),
      deferCompactionComplete: true,
      onCompactionRequested: () => signalCompactionStarted?.(),
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Current Session Plan" });
    const confirmed = await execute(harness, "plan-confirm");

    assert.equal(confirmed.details.approved, true);
    assert.equal(confirmed.terminate, true);
    assert.equal(harness.newSessions, 0);
    assert.equal(harness.compactions.length, 0);
    onAgentSettledPlan(harness.ctx);
    await compactionStarted;

    assert.equal(harness.compactions.length, 1);
    assert.match(harness.compactions[0]?.customInstructions ?? "", /maestro-compaction-owner:plan-handoff/);
    assert.match(harness.compactions[0]?.customInstructions ?? "", /authoritative execution contract/);
    assert.equal(consumePlanCleanContextCompaction(), undefined);

    harness.compactions[0]?.onComplete?.({});
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /selected Execute/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Nothing to compact resumes execution after the settled Plan handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-small-context-"));
  let signalCompactionStarted: (() => void) | undefined;
  const compactionStarted = new Promise<void>((resolve) => { signalCompactionStarted = resolve; });
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "small-context-chat",
    COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      arbiter: new CompactionArbiter(),
      deferCompactionComplete: true,
      onCompactionRequested: () => signalCompactionStarted?.(),
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Small Session Plan" });
    const confirmed = await execute(harness, "plan-confirm");
    assert.equal(confirmed.terminate, true);
    assert.equal(harness.compactions.length, 0);

    onAgentSettledPlan(harness.ctx);
    await compactionStarted;
    harness.compactions[0]?.onError?.(new Error("Nothing to compact (session too small)"));

    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0] ?? "", /selected Execute/);
    assert.match(harness.notifications.join("\n"), /executing with the current context/);
    assert.equal(onContextPlan([{ role: "user", content: "old", timestamp: 1 }] as never), undefined);
    assert.equal(consumePlanCleanContextCompaction(), undefined);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale settlement context cannot consume the current Plan compact handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-stale-settlement-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "current-settlement-chat",
    COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    { arbiter: new CompactionArbiter(), deferCompactionComplete: true },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Current Settlement Plan" });
    await execute(harness, "plan-confirm");

    const staleCtx = {
      ...harness.ctx,
      sessionManager: {
        getSessionId: () => "stale-settlement-chat",
        getSessionFile: () => join(root, "stale-settlement-chat.jsonl"),
        getSessionName: () => "stale-settlement-chat",
      },
    } as ExtensionContext;
    onAgentSettledPlan(staleCtx);
    assert.equal(harness.compactions.length, 0);

    onAgentSettledPlan(harness.ctx);
    assert.equal(harness.compactions.length, 1);
    harness.compactions[0]?.onComplete?.({});
    assert.equal(harness.messages.length, 1);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("a hung Plan compaction falls back once and ignores its late callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-compact-watchdog-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-watchdog-chat",
    COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      arbiter: new CompactionArbiter(),
      compactionHandoffTimeoutMs: 10,
      deferCompactionComplete: true,
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Watchdog Plan" });
    await execute(harness, "plan-confirm");
    onAgentSettledPlan(harness.ctx);
    assert.equal(harness.compactions.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.messages.length, 1);
    assert.match(harness.notifications.join("\n"), /did not finish in time/);
    harness.compactions[0]?.onComplete?.({});
    assert.equal(harness.messages.length, 1, "a late compaction callback cannot duplicate execution");
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronous Plan execution enqueue failure is reported without escaping the callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-compact-send-failure-"));
  const harness = createHarness(
    root,
    false,
    false,
    false,
    false,
    "compact-send-failure-chat",
    COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    {
      arbiter: new CompactionArbiter(),
      deferCompactionComplete: true,
      sendUserMessageError: "enqueue unavailable",
    },
  );
  try {
    await onSessionStartPlan(harness.ctx);
    await execute(harness, "plan-enter");
    await execute(harness, "plan-update", { markdown: "# Compact Send Failure Plan" });
    await execute(harness, "plan-confirm");
    onAgentSettledPlan(harness.ctx);
    harness.compactions[0]?.onComplete?.({});

    assert.equal(harness.messages.length, 0);
    assert.match(harness.notifications.join("\n"), /could not be queued: enqueue unavailable/);
  } finally {
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("stale compact-before-execute callback cannot inject into a replacement session", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "pi-plan-compact-stale-first-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "pi-plan-compact-stale-second-"));
  const first = createHarness(
    firstRoot,
    false,
    false,
    false,
    false,
    "compact-stale-first",
    COMPACT_EXECUTION_INPUTS,
    false,
    { todoKeys: [] },
    undefined,
    { contextPercent: 75, arbiter: new CompactionArbiter(), deferCompactionComplete: true },
  );
  let second: ReturnType<typeof createHarness> | undefined;
  try {
    await onSessionStartPlan(first.ctx);
    await execute(first, "plan-enter");
    await execute(first, "plan-update", { markdown: "# Old Compact Plan" });
    await executeCommand(first, "plan", "approve");
    assert.equal(first.compactions.length, 1);

    onSessionShutdownPlan(first.ctx);
    second = createHarness(secondRoot, false, false, false, false, "compact-stale-second");
    await onSessionStartPlan(second.ctx);

    first.compactions[0]?.onError?.(new Error("stale failure"));
    first.compactions[0]?.onComplete?.({});
    assert.equal(second.messages.length, 0);
    assert.doesNotMatch(first.notifications.join("\n"), /stale failure/);
  } finally {
    if (second) onSessionShutdownPlan(second.ctx);
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});
