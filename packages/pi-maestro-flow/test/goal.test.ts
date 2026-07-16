import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildCanonicalEvidence,
  canonicalCompletionBlockers,
  collectVerifierEvidence,
  executeGoal,
  executeGoalCommand,
  getActiveGoal,
  goalArgumentCompletions,
  initGoal,
  onAgentEnd,
  onBeforeAgentStart,
  onInput,
  parseVerifierOutput,
  parseGoalCommand,
  reconcileWorkflowGoal,
  setGoalVerifierRunnerForTest,
  onSessionShutdown,
  onSessionStart,
  type GoalContext,
} from "../src/tools/goal.ts";
import { buildTodoMirrorSpecs } from "../src/session/bridge.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import { renderGoalWidget, type GoalWidgetModel } from "../src/tui/goal-widget.ts";

function createContext(overrides: Partial<GoalContext> = {}): GoalContext {
  return {
    cwd: "D:/workspace",
    ui: {
      notify() {},
      setStatus() {},
    },
    ...overrides,
  };
}

const goalWidgetTheme = {
  fg: (_color: "accent" | "success" | "warning" | "error" | "dim", text: string) => text,
  bold: (text: string) => text,
};

test("goal widget renders explicit lifecycle states within widths 1 through 120", () => {
  const base: GoalWidgetModel = {
    objective: "Implement and verify the Goal lifecycle visualization",
    status: "active",
    iteration: 2,
    tokensUsed: 13_800,
    tokenBudget: 50_000,
    timeUsedSeconds: 125,
  };
  const variants: Array<{ goal: GoalWidgetModel; phase: "normal" | "waiting" | "verifying" | "verified"; label: RegExp }> = [
    { goal: base, phase: "normal", label: /ACTIVE/ },
    { goal: base, phase: "waiting", label: /WAITING/ },
    { goal: base, phase: "verifying", label: /VERIFYING/ },
    { goal: { ...base, status: "done" }, phase: "verified", label: /VERIFIED/ },
    { goal: { ...base, status: "paused", pauseReason: "user" }, phase: "normal", label: /STOPPED/ },
    { goal: { ...base, status: "paused", pauseReason: "budget" }, phase: "normal", label: /BUDGET/ },
    { goal: { ...base, status: "paused", pauseReason: "gate" }, phase: "normal", label: /BLOCKED/ },
    { goal: { ...base, status: "paused", pauseReason: "error" }, phase: "normal", label: /ERROR/ },
  ];

  for (const variant of variants) {
    assert.match(renderGoalWidget(variant.goal, variant.phase, 120, goalWidgetTheme).join("\n"), variant.label);
    for (let width = 1; width <= 120; width++) {
      const lines = renderGoalWidget(variant.goal, variant.phase, width, goalWidgetTheme);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${variant.label} exceeded width ${width}: ${lines.join(" | ")}`,
      );
      assert.ok(lines.length <= 2);
    }
  }
});

test("goal widget omits Token metrics when no budget was explicitly set", () => {
  const goal: GoalWidgetModel = {
    objective: "Run without an implicit budget",
    status: "active",
    iteration: 1,
    tokensUsed: 13_800,
    timeUsedSeconds: 75,
  };

  const rendered = renderGoalWidget(goal, "normal", 120, goalWidgetTheme).join("\n");
  assert.match(rendered, /ACTIVE/);
  assert.doesNotMatch(rendered, /13\.8k|tok|\[█|\[░/i);
});

test("goal lifecycle keeps an above-editor widget synchronized", async () => {
  let widgetKey: string | undefined;
  let widgetContent: unknown;
  let widgetPlacement: string | undefined;
  initGoal({ appendEntry() {} } as never);
  const ctx = createContext({
    ui: {
      notify() {},
      setStatus() {},
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        widgetKey = key;
        widgetContent = content;
        widgetPlacement = options?.placement;
      },
    },
  });
  const renderCurrent = () => {
    assert.equal(typeof widgetContent, "function");
    const component = (widgetContent as (
      tui: unknown,
      theme: typeof goalWidgetTheme,
    ) => { render(width: number): string[] })(undefined, goalWidgetTheme);
    return component.render(100).join("\n");
  };

  onSessionStart(ctx);
  try {
    await executeGoal({ action: "create", objective: "Show Goal above the editor", tokenBudget: "50k" }, ctx);
    assert.equal(widgetKey, "goal-panel");
    assert.equal(widgetPlacement, "aboveEditor");
    assert.match(renderCurrent(), /ACTIVE/);
    assert.match(renderCurrent(), /Show Goal above the editor/);

    await executeGoalCommand({ action: "stop" }, ctx);
    assert.match(renderCurrent(), /STOPPED/);
    assert.match(renderCurrent(), /\/goal resume/);

    await executeGoalCommand({ action: "resume" }, ctx);
    assert.match(renderCurrent(), /ACTIVE/);

    await executeGoalCommand({ action: "clear" }, ctx);
    assert.equal(widgetContent, undefined);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("goal widget transitions through verifying and verified states", async () => {
  let widgetContent: unknown;
  let settleVerifier!: (result: {
    exitCode: number;
    messages: Array<{ role: string; content: string }>;
    structuredOutput: { pass: boolean; reasoning: string; unmet: string[]; evidence: string[] };
  }) => void;
  setGoalVerifierRunnerForTest(() => new Promise((resolve) => { settleVerifier = resolve; }));
  initGoal({ appendEntry() {} } as never);
  const ctx = createContext({
    isIdle: () => false,
    sessionManager: { getEntries: () => [] },
    ui: {
      notify() {},
      setStatus() {},
      setWidget(_key: string, content: unknown) { widgetContent = content; },
    },
  });
  const renderCurrent = () => {
    assert.equal(typeof widgetContent, "function");
    const component = (widgetContent as (
      tui: unknown,
      theme: typeof goalWidgetTheme,
    ) => { render(width: number): string[] })(undefined, goalWidgetTheme);
    return component.render(100).join("\n");
  };

  onSessionStart(ctx);
  try {
    await executeGoal({ action: "create", objective: "Verify the live Goal widget" }, ctx);
    const ending = onAgentEnd({
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented and tested." }] }],
    }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(renderCurrent(), /VERIFYING/);

    settleVerifier({
      exitCode: 0,
      messages: [{ role: "assistant", content: "Structured output saved." }],
      structuredOutput: {
        pass: true,
        reasoning: "The supplied evidence proves the widget lifecycle.",
        unmet: [],
        evidence: ["Focused lifecycle test passed"],
      },
    });
    await ending;
    assert.match(renderCurrent(), /VERIFIED/);
    assert.equal(getActiveGoal(), undefined);
  } finally {
    onSessionShutdown(ctx);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("Goal state is session-scoped and ordinary inputs do not acquire Goal loop ownership", async () => {
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  let verifierCalls = 0;
  initGoal({
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as never);
  setGoalVerifierRunnerForTest(async () => {
    verifierCalls++;
    return {
      exitCode: 0,
      messages: [{ role: "assistant", content: "Structured output saved." }],
      structuredOutput: {
        pass: false,
        reasoning: "A focused requirement remains.",
        unmet: ["Finish the remaining requirement"],
        evidence: ["Focused session ownership check"],
      },
    };
  });
  const sessionA = createContext({
    isIdle: () => false,
    sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
  });

  onSessionStart(sessionA, { reason: "startup" });
  try {
    await executeGoal({ action: "create", objective: "Goal owned by session A" }, sessionA);
    assert.equal(getActiveGoal()?.text, "Goal owned by session A");
    onSessionShutdown(sessionA);
    assert.equal(getActiveGoal(), undefined, "shutdown must release module-local Goal state");

    for (const reason of ["new", "fork"] as const) {
      const fresh = createContext({
        sessionManager: {
          getSessionId: () => `session-${reason}`,
          getEntries: () => entries,
        },
      });
      onSessionStart(fresh, { reason });
      assert.equal(getActiveGoal(), undefined, `${reason} session must not inherit Goal entries`);
      onInput({ source: "user", text: "An unrelated ordinary prompt" });
      await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, fresh);
      assert.equal(verifierCalls, 0, "ordinary input without Goal ownership must not run the verifier");
      onSessionShutdown(fresh);
    }

    const mismatchedResume = createContext({
      sessionManager: { getSessionId: () => "session-b", getEntries: () => entries },
    });
    onSessionStart(mismatchedResume, { reason: "resume" });
    assert.equal(getActiveGoal(), undefined, "resume must reject Goal entries from a different session identity");
    onSessionShutdown(mismatchedResume);

    const resumedA = createContext({
      isIdle: () => false,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => entries },
    });
    onSessionStart(resumedA, { reason: "resume" });
    assert.equal(getActiveGoal()?.text, "Goal owned by session A", "same-session resume should restore its Goal");

    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, resumedA);
    assert.equal(verifierCalls, 0, "a restored Goal must wait for explicit /goal resume");

    await executeGoalCommand({ action: "resume" }, resumedA);
    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, resumedA);
    assert.equal(verifierCalls, 1, "explicit /goal resume should own exactly one agent loop");
    await executeGoalCommand({ action: "clear" }, resumedA);
    onSessionShutdown(resumedA);
  } finally {
    if (getActiveGoal()) await executeGoalCommand({ action: "clear" }, sessionA);
    onSessionShutdown(sessionA);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("slash Goal commands keep lifecycle control user-owned", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand("status"), { action: "status" });
  assert.deepEqual(parseGoalCommand("stop"), { action: "stop" });
  assert.deepEqual(parseGoalCommand("resume --tokens 50k"), { action: "resume", tokenBudget: "50k" });
  assert.deepEqual(parseGoalCommand("clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("create --tokens 10k ship it"), {
    action: "create",
    objective: "ship it",
    tokenBudget: "10k",
  });
  assert.deepEqual(parseGoalCommand("ship it"), { action: "create", objective: "ship it", tokenBudget: undefined });
  for (const legacyCommand of ["pause", "set old objective", "done", "complete"]) {
    assert.match(String(parseGoalCommand(legacyCommand)), /legacy Goal command is no longer supported/i);
  }
});

test("slash Goal argument hints make an explicit budget discoverable", () => {
  const createHints = goalArgumentCompletions("create ");
  assert.ok(createHints?.some((item) => item.value === "create --tokens 100k "));
  assert.match(
    createHints?.find((item) => item.value === "create ")?.description ?? "",
    /without a Token budget \(default\)/,
  );

  const resumeHints = goalArgumentCompletions("resume --");
  assert.deepEqual(resumeHints?.map((item) => item.value), ["resume --tokens 100k"]);
  assert.equal(goalArgumentCompletions("unknown"), null);
});

test("goal create has no budget unless tokenBudget is explicitly provided", async () => {
  initGoal({ appendEntry() {} } as never);
  const ctx = createContext({ isIdle: () => false });
  onSessionStart(ctx);

  try {
    const result = await executeGoal({ action: "create", objective: "Run without a default budget" }, ctx);
    assert.equal(result.isError, false);
    assert.equal(getActiveGoal()?.tokenBudget, undefined);
    assert.doesNotMatch((await executeGoal({ action: "get" }, ctx)).text, /token budget|tokens:/i);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("goal create rejects a missing or blank objective after flat schema validation", async () => {
  const ctx = createContext();
  assert.match(
    (await executeGoal({ action: "create", objective: "" }, ctx)).text,
    /requires a non-empty objective/i,
  );
  assert.equal(
    (await executeGoal({ action: "create" } as never, ctx)).isError,
    true,
  );
});

test("user resume can raise an exhausted Goal token budget", async () => {
  let tokens = 0;
  initGoal({ appendEntry() {} } as never);
  const ctx = createContext({
    isIdle: () => false,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        message: { role: "assistant", usage: { input: tokens, output: 0 } },
      }],
    },
  });
  onSessionStart(ctx);

  try {
    await executeGoal({ action: "create", objective: "Finish within budget", tokenBudget: "10k" }, ctx);
    tokens = 13_800;
    await executeGoalCommand({ action: "stop" }, ctx);
    const blocked = await executeGoalCommand({ action: "resume" }, ctx);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /13\.8k\/10k/);
    assert.equal(getActiveGoal()?.status, "paused");

    const resumed = await executeGoalCommand({ action: "resume", tokenBudget: "50k" }, ctx);
    assert.equal(resumed.isError, false);
    assert.equal(getActiveGoal()?.status, "active");
    assert.equal(getActiveGoal()?.tokenBudget, 50_000);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("verifier parsing is fail-closed and requires consistent concrete evidence", () => {
  const prose = parseVerifierOutput("The goal is incomplete and does not pass verification.");
  assert.equal(prose.pass, false);
  assert.equal(prose.status, "inconclusive");

  const contradictory = parseVerifierOutput(JSON.stringify({
    pass: true,
    reasoning: "Looks complete",
    unmet: ["Missing runtime verification"],
    evidence: ["npm test passed"],
  }));
  assert.equal(contradictory.pass, false);
  assert.match(contradictory.reasoning, /contradictory/);

  const grounded = parseVerifierOutput(JSON.stringify({
    pass: true,
    reasoning: "All requested paths are covered",
    unmet: [],
    evidence: ["npm run test:goal: 3 tests passed"],
  }));
  assert.equal(grounded.pass, true);
});

test("verifier receives bounded raw tool evidence produced after the goal started", () => {
  const since = Date.parse("2026-07-15T00:00:00.000Z");
  const ctx = createContext({
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          timestamp: "2026-07-14T23:59:59.000Z",
          message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "stale output" }] },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:01.000Z",
          message: { role: "user", content: "Run the automatic Goal verifier pressure test." },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:01.500Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Executing the requested pressure-test sequence." },
              {
                type: "toolCall",
                name: "goal",
                arguments: {
                  action: "get",
                  apiKey: "must-not-leak",
                },
              },
            ],
          },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:02.000Z",
          message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "3 tests passed" }] },
        },
        {
          type: "message",
          timestamp: "2026-07-15T00:00:03.000Z",
          message: { role: "toolResult", toolName: "goal", isError: true, content: [{ type: "text", text: "verifier feedback" }] },
        },
      ],
    },
  });

  const evidence = collectVerifierEvidence(ctx, since);
  assert.doesNotMatch(evidence, /stale output/);
  assert.match(evidence, /\[USER\]\nRun the automatic Goal verifier pressure test\./);
  assert.match(evidence, /\[ASSISTANT\]\nExecuting the requested pressure-test sequence\./);
  assert.match(evidence, /\[CALL\] goal .*\"action\":\"get\"/);
  assert.doesNotMatch(evidence, /must-not-leak/);
  assert.match(evidence, /\[REDACTED\]/);
  assert.match(evidence, /\[OK\] bash\n3 tests passed/);
  assert.match(evidence, /\[ERROR\] goal\nverifier feedback/);
});

test("automatic verification holds an active Goal when both verdict attempts are inconclusive", async () => {
  const calls: Array<{ agent: string; task?: string; timeoutMs?: number }> = [];
  const sent: string[] = [];
  setGoalVerifierRunnerForTest(async (params) => {
    calls.push(params);
    return {
      exitCode: 0,
      messages: [{ role: "assistant", content: "I'll inspect the repository and run tests." }],
    };
  });
  initGoal({
    appendEntry() {},
    sendMessage(message: { content: string }) { sent.push(message.content); },
  } as never);
  let idle = false;
  const ctx = createContext({ isIdle: () => idle, sessionManager: { getEntries: () => [] } });

  try {
    await executeGoal({ action: "create", objective: "Exercise the goal verification lifecycle" }, ctx);
    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Work is complete." }] }] }, ctx);

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.agent === "goal-verifier"));
    assert.ok((calls[1]?.timeoutMs ?? 0) < (calls[0]?.timeoutMs ?? 0));
    assert.match(calls[1]?.task ?? "", /Do not run commands/i);
    assert.match(calls[0]?.task ?? "", /Final assistant message:\nWork is complete\./);
    assert.equal(getActiveGoal()?.status, "active");
    assert.deepEqual(sent, []);
    idle = true;
    assert.match((await executeGoalCommand({ action: "resume" }, ctx)).text, /continuation requested/i);
    assert.equal(sent.length, 1);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("automatic verification completes a Goal from a valid bounded-recovery verdict", async () => {
  let callCount = 0;
  setGoalVerifierRunnerForTest(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: "Verification is complete, preparing the verdict." }],
      };
    }
    return {
      exitCode: 0,
      messages: [{ role: "assistant", content: "Structured output saved." }],
      structuredOutput: {
        pass: true,
        reasoning: "The requested pressure-test calls are present in the supplied transcript.",
        unmet: [],
        evidence: ["[CALL] goal {\"action\":\"get\"}"],
      },
    };
  });
  initGoal({ appendEntry() {} } as never);
  const ctx = createContext({ isIdle: () => false, sessionManager: { getEntries: () => [] } });

  try {
    await executeGoal({ action: "create", objective: "Exercise the automatic Goal verifier" }, ctx);
    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);

    assert.equal(callCount, 2);
    assert.equal(getActiveGoal(), undefined);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("automatic verification starts the next agent loop only for a valid fail verdict", async () => {
  const sent: string[] = [];
  setGoalVerifierRunnerForTest(async () => ({
    exitCode: 0,
    messages: [{ role: "assistant", content: "Structured output saved." }],
    structuredOutput: {
      pass: false,
      reasoning: "The fourth pressure-test call is missing.",
      unmet: ["Finish the fourth lifecycle requirement"],
      evidence: ["Only three [CALL] goal entries were supplied"],
    },
  }));
  initGoal({
    appendEntry() {},
    sendMessage(message: { content: string }) { sent.push(message.content); },
  } as never);
  const ctx = createContext({ isIdle: () => false, sessionManager: { getEntries: () => [] } });

  try {
    await executeGoal({ action: "create", objective: "Exercise four lifecycle requirements" }, ctx);
    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /^Continue the active goal:/);
    assert.equal(getActiveGoal()?.status, "active");
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("canonical Workflow state rebuilds Goal projection and blocks premature completion", async () => {
  const ctx = createContext({ sessionManager: { getEntries: () => [] } });
  initGoal({ appendEntry() {} } as never);
  onSessionStart(ctx);
  const snapshot = workflowSnapshot();
  try {
    const goal = reconcileWorkflowGoal(snapshot, ctx);
    assert.equal(goal?.workflowSessionId, "session-1");
    assert.match(getActiveGoal()?.text ?? "", /Definition of done: all gates pass/);
    assert.deepEqual(canonicalCompletionBlockers(snapshot), [
      "Step execute (execute) is running",
      "Active Run run-1 is running",
      "Gate gate-1 is pending",
    ]);
    const evidence = buildCanonicalEvidence(snapshot);
    assert.match(evidence, /Session session-1: running/);
    assert.match(evidence, /Run run-1 \(execute\): running/);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("failed exit gate leaves Run and Todo unsealed and pauses the canonical Goal", async () => {
  const ctx = createContext({ sessionManager: { getEntries: () => [] } });
  initGoal({ appendEntry() {} } as never);
  onSessionStart(ctx);
  const snapshot = workflowSnapshot();
  const session = snapshot.session!;
  const run = session.runs[0]!;
  session.chain[0]!.status = "completed";
  run.status = "completed";
  run.endedAt = "2026-07-15T00:01:00.000Z";
  run.gates = [{ id: "gate-exit", phase: "exit", blocking: true, status: "failed" }];

  try {
    const specs = buildTodoMirrorSpecs(snapshot);
    const goal = reconcileWorkflowGoal(snapshot, ctx);

    assert.equal(run.status, "completed");
    assert.notEqual(run.status, "sealed");
    assert.equal(specs[0]?.status, "blocked");
    assert.notEqual(specs[0]?.status, "completed");
    assert.equal(goal?.status, "paused");
    assert.equal(goal?.pauseReason, "gate");
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("goal create is exclusive and user stop/resume controls the active agent loop", async () => {
  const sent: Array<{
    message: { customType: string; content: string; display: boolean };
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  initGoal({
    appendEntry() {},
    sendMessage(
      message: { customType: string; content: string; display: boolean },
      options?: { deliverAs?: string; triggerTurn?: boolean },
    ) {
      sent.push({ message, options });
    },
  } as never);
  let aborts = 0;
  setGoalVerifierRunnerForTest(async () => ({
    exitCode: 0,
    messages: [{ role: "assistant", content: "Structured output saved." }],
    structuredOutput: {
      pass: false,
      reasoning: "One requirement remains.",
      unmet: ["Finish the last requirement"],
      evidence: ["Focused check"],
    },
  }));
  const ctx = createContext({
    isIdle: () => false,
    hasPendingMessages: () => false,
    abort: () => { aborts++; },
  });

  try {
    const result = await executeGoal({ action: "create", objective: "Verify the Goal lifecycle" }, ctx);
    assert.equal(result.isError, false);
    assert.deepEqual(sent, []);

    const duplicate = await executeGoal({ action: "create", objective: "Replace the Goal" }, ctx);
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.text, /already exists/);
    assert.match((await executeGoal({ action: "get" }, ctx)).text, /Verify the Goal lifecycle/);

    await executeGoalCommand({ action: "stop" }, ctx);
    assert.equal(getActiveGoal()?.status, "paused");
    assert.equal(aborts, 1);
    await executeGoalCommand({ action: "resume" }, ctx);
    assert.equal(getActiveGoal()?.status, "active");
    assert.deepEqual(sent, []);

    await onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message.content ?? "", /^Continue the active goal:/);
    assert.equal(sent[0]?.message.customType, "maestro-goal-internal");
    assert.equal(sent[0]?.message.display, false);
    assert.equal(sent[0]?.options?.deliverAs, "followUp");
    assert.equal(sent[0]?.options?.triggerTurn, true);

    const continuation = sent[0]?.message.content ?? "";
    assert.deepEqual(onInput({ source: "extension", text: continuation }), { action: "handled" });
    assert.deepEqual(onInput({ source: "extension", text: continuation }), { action: "handled" });
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
    setGoalVerifierRunnerForTest(undefined);
  }
});

test("goal create from an idle command starts the agent loop immediately", async () => {
  const sent: Array<{
    message: { customType: string; content: string; display: boolean };
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  initGoal({
    appendEntry() {},
    sendMessage(
      message: { customType: string; content: string; display: boolean },
      options?: { deliverAs?: string; triggerTurn?: boolean },
    ) {
      sent.push({ message, options });
    },
  } as never);
  const ctx = createContext({ isIdle: () => true });

  try {
    await executeGoal({ action: "create", objective: "Verify the idle command path" }, ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message.content ?? "", /^Goal mode is active\./);
    assert.equal(sent[0]?.message.display, false);
    assert.equal(sent[0]?.options?.deliverAs, "followUp");
    assert.equal(sent[0]?.options?.triggerTurn, true);
  } finally {
    await executeGoalCommand({ action: "clear" }, ctx);
    onSessionShutdown(ctx);
  }
});

test("active Goal does not rewrite the per-turn system prompt", () => {
  initGoal({ appendEntry() {} } as never);
  const ctx = {
    cwd: "D:/workspace",
    ui: {
      notify() {},
      setStatus() {},
    },
    sessionManager: {
      getEntries: () => [{
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            text: "Finish the implementation",
            status: "active",
            startedAt: 1,
            updatedAt: 2,
            iteration: 3,
            tokenBudget: 100_000,
            tokensUsed: 42_000,
            timeUsedSeconds: 60,
            baselineTokens: 0,
          },
        },
      }],
    },
  } as unknown as GoalContext;

  onSessionStart(ctx);
  try {
    assert.equal(onBeforeAgentStart({ prompt: "continue" }), undefined);
  } finally {
    onSessionShutdown(ctx);
  }
});

function workflowSnapshot(): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "goal-workflow" },
    diagnostics: [],
    session: {
      sessionId: "session-1",
      intent: "Execute integration",
      status: "running",
      revision: 1,
      activeRunId: "run-1",
      definitionOfDone: "all gates pass",
      gates: [],
      chain: [{ step: "execute", command: "execute", status: "running", runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status: "running",
        goal: "Execute",
        args: [],
        gates: [{ id: "gate-1", blocking: true, status: "pending" }],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}
