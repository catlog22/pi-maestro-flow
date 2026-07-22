import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerMaestroExtension, {
  isWorkflowOptInCommand,
  shouldAttachWorkflowSession,
  shouldRestoreWorkflowGoal,
} from "../src/extension/index.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";
import { isRunControlReadAction } from "../src/tools/run-control.ts";
import {
  getTeammateChildExtensions,
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
} from "pi-maestro-teammate/v1/child-extensions";

test("Workflow Goal restore requires a workflow-owned Goal matching the canonical Session", () => {
  const snapshot = workflowAttachSnapshot();
  const owned = { workflowSessionId: "session-1" };
  assert.equal(shouldRestoreWorkflowGoal("startup", undefined, snapshot), false);
  const unrelatedOptIn = shouldRestoreWorkflowGoal("startup", {}, snapshot);
  assert.equal(unrelatedOptIn, false, "an unrelated user Goal must stay read-only");
  assert.equal(shouldAttachWorkflowSession(snapshot), true, "canonical Session attachment must not depend on Goal restoration");
  assert.equal(shouldRestoreWorkflowGoal("startup", owned, snapshot), true);
  assert.equal(shouldRestoreWorkflowGoal("reload", owned, snapshot), true);
  assert.equal(shouldRestoreWorkflowGoal("resume", owned, snapshot), true);
  assert.equal(shouldRestoreWorkflowGoal("resume", { workflowSessionId: "session-other" }, snapshot), false);
  assert.equal(shouldRestoreWorkflowGoal("new", owned, snapshot), false);
  assert.equal(shouldRestoreWorkflowGoal("fork", owned, snapshot), false);
});

test("Workflow writer attachment follows a valid canonical Session independently of Goal opt-in", () => {
  const snapshot = workflowAttachSnapshot();
  assert.equal(shouldAttachWorkflowSession(snapshot), true);
  assert.equal(shouldAttachWorkflowSession({
    ...snapshot,
    session: undefined,
    canonicalClaim: { activeSessionId: "session-1", status: "invalid", error: "missing session.json" },
  }), false);
  assert.equal(isWorkflowOptInCommand("maestro run brief run-1"), false);
  assert.equal(isWorkflowOptInCommand("maestro run status"), false);
  assert.equal(isWorkflowOptInCommand("maestro run prepare analyze"), false);
  assert.equal(isWorkflowOptInCommand("maestro run list"), false);
  assert.equal(isWorkflowOptInCommand("maestro run show run-1"), false);
  assert.equal(isWorkflowOptInCommand("maestro run create analyze"), true);
  assert.equal(isWorkflowOptInCommand("maestro ralph next"), true);
  for (const action of ["status", "brief", "prepare", "list", "show"]) {
    assert.equal(isRunControlReadAction(action), true, action);
  }
});

test("extension registers LSP, browser, and BM25 discovery", async () => {
  const tools: ToolDefinition[] = [];
  const active: string[] = [];
  const commands: string[] = [];
  const renderers: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); };
      if (property === "registerCommand") return (name: string) => { commands.push(name); };
      if (property === "registerMessageRenderer") return (name: string) => { renderers.push(name); };
      if (property === "getAllTools") return () => tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { path: "test", type: "extension" } }));
      if (property === "getActiveTools") return () => [...active];
      if (property === "setActiveTools") return (names: string[]) => { active.splice(0, active.length, ...names); };
      if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      };
      if (property === "getFlag") return () => undefined;
      if (property === "exec") return async () => ({ code: 0, stdout: "", stderr: "" });
      return () => undefined;
    },
  });

  registerMaestroExtension(api);
  assert.equal(getTeammateChildToolBroker("todo"), undefined, "Todo authority must not outlive a root session");
  assert.equal(getTeammatePermissionBroker(), undefined, "permission authority must not outlive a root session");
  assert.equal(
    getTeammateChildExtensions().some((registration) => registration.tools.includes("todo")),
    false,
    "child extension inheritance must be session-owned",
  );
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("lsp"));
  assert.ok(names.includes("browser"));
  assert.ok(names.includes("search_tool_bm25"));
  assert.equal(names.filter((name) => name === "lsp").length, 1);
  assert.equal(names.filter((name) => name === "browser").length, 1);
  assert.equal(names.filter((name) => name === "search_tool_bm25").length, 1);
  assert.ok(names.includes("run-control"));
  assert.ok(names.includes("swarm_runtime"));
  assert.ok(commands.includes("maestro-session"));
  assert.ok(commands.includes("maestro-todo"));
  assert.ok(commands.includes("swarm"));
  assert.ok(renderers.includes("run-event"));

  const swarmRuntime = tools.find((tool) => tool.name === "swarm_runtime");
  const swarmSchema = swarmRuntime?.parameters as { type?: string; additionalProperties?: boolean; properties?: Record<string, unknown>; anyOf?: unknown };
  assert.equal(swarmSchema.type, "object");
  assert.equal(swarmSchema.additionalProperties, false);
  assert.equal(swarmSchema.anyOf, undefined);
  assert.ok(swarmSchema.properties?.plan);

  const runControl = tools.find((tool) => tool.name === "run-control");
  const actionSchema = (runControl?.parameters as { properties?: { action?: { anyOf?: Array<{ const?: string }> } } })
    ?.properties?.action;
  assert.deepEqual(actionSchema?.anyOf?.map((item) => item.const), [
    "status", "brief", "prepare", "advance", "complete", "retry", "cancel",
  ]);

  const maestro = tools.find((tool) => tool.name === "maestro");
  const maestroProperties = (maestro?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(maestroProperties?.name, "maestro delegate schema should expose a stable task name");
  assert.ok(maestroProperties?.concurrency, "maestro explore schema should expose a concurrency bound");

  const askTool = tools.find((tool) => tool.name === "ask-user-question");
  assert.ok(askTool?.renderResult);
  const renderAskResult = askTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string },
  ) => { render(width: number): string[] };
  const askResult = {
    content: [{ type: "text", text: "ok" }],
    details: {
      answers: [
        { question: "First question?", selected: ["Alpha"] },
        { question: "Second question?", selected: ["Beta"], text: "with detail" },
      ],
    },
  };
  const theme = { fg: (_name: string, text: string) => text };
  const collapsed = renderAskResult(askResult, { expanded: false, isPartial: false }, theme).render(120);
  const expanded = renderAskResult(askResult, { expanded: true, isPartial: false }, theme).render(120);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /First question\?.*Alpha/);
  assert.doesNotMatch(collapsed[0], /Second question/);
  assert.deepEqual(expanded.slice(1), [
    "1. First question? → Alpha",
    "2. Second question? → Beta — with detail",
  ]);

  const goalTool = tools.find((tool) => tool.name === "goal");
  assert.ok(goalTool?.renderCall);
  assert.ok(goalTool?.renderResult);
  const goalSchema = goalTool?.parameters as {
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, { enum?: string[] }>;
    anyOf?: unknown;
  };
  assert.equal(goalSchema.type, "object", "provider function schemas must have an object root");
  assert.equal(goalSchema.anyOf, undefined, "provider function schemas must not use a root-level anyOf");
  assert.equal(goalSchema.additionalProperties, false);
  assert.deepEqual(goalSchema.required, ["action"]);
  assert.deepEqual(goalSchema.properties?.action?.enum, ["get", "create", "update"]);
  assert.ok(goalSchema.properties?.objective);
  assert.ok(goalSchema.properties?.tokenBudget);
  assert.match(String(goalSchema.properties?.tokenBudget?.description), /omit for no budget/i);
  assert.equal(goalSchema.properties?.summary, undefined);
  const renderGoalCall = goalTool.renderCall as unknown as (
    args: Record<string, unknown>,
    theme: { fg(name: string, text: string): string; bold(text: string): string },
  ) => { render(width: number): string[] };
  const renderGoalResult = goalTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string; bold(text: string): string },
  ) => { render(width: number): string[] };
  const goalTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const goalCallComponent = renderGoalCall({
    action: "create",
    objective: "完成 Git 仓库配置整理：这段长目标不应破坏 call 行宽度",
  }, goalTheme);
  const call = goalCallComponent.render(120);
  assert.match(call[0] ?? "", /^goal create/);
  const goalResult = {
    content: [{ type: "text", text: "Goal started: 完成 Git 仓库配置整理" }],
    isError: false,
  };
  const collapsedGoalComponent = renderGoalResult(goalResult, { expanded: false, isPartial: false }, goalTheme);
  const expandedGoalComponent = renderGoalResult(goalResult, { expanded: true, isPartial: false }, goalTheme);
  const collapsedGoal = collapsedGoalComponent.render(120);
  const expandedGoal = expandedGoalComponent.render(120);
  assert.deepEqual(collapsedGoal, ["✓ goal created"]);
  assert.equal(expandedGoal.filter((line) => /完成 Git 仓库配置整理/.test(line)).length, 1);
  for (let width = 1; width <= 120; width++) {
    for (const component of [goalCallComponent, collapsedGoalComponent, expandedGoalComponent]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }

  let permissionPrompts = 0;
  const ctx = {
    cwd: "D:/workspace",
    hasUI: true,
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
      async select() {
        permissionPrompts++;
        return "Deny";
      },
    },
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined },
  } as unknown as ExtensionContext;
  let toolResult: unknown;
  const toolEvent = { type: "tool_call", toolName: "bash", toolCallId: "permission-1", input: { command: "npm test" } };
  for (const handler of handlers.get("tool_call") ?? []) {
    toolResult = await handler(toolEvent, ctx);
    if ((toolResult as { block?: boolean } | undefined)?.block) break;
  }
  assert.equal(permissionPrompts, 1);
  assert.match((toolResult as { reason?: string }).reason ?? "", /denied by user/i);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
  assert.equal(getTeammateChildToolBroker("todo"), undefined);
  assert.equal(getTeammatePermissionBroker(), undefined);
});

test("root teammate authority is fenced on session start and disposed on shutdown", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /pi\.on\("session_start"[\s\S]*?disposeTeammateSessionRegistrations\(\)[\s\S]*?activateTeammateSessionRegistrations\(ctx\)/,
  );
  assert.match(
    source,
    /pi\.on\("session_shutdown"[\s\S]*?disposeTeammateSessionRegistrations\(\)/,
  );
  assert.match(source, /generation !== teammateRegistrationGeneration/);
});

test("teammate child registers only interaction and parent-permission surfaces", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); };
      if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      };
      return () => undefined;
    },
  });
  const previous = process.env.PI_TEAMMATE_CHILD;

  try {
    process.env.PI_TEAMMATE_CHILD = "1";
    registerMaestroExtension(api);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previous;
  }

  assert.deepEqual(tools.map((tool) => tool.name), ["ask-user-question", "todo"]);
  assert.deepEqual([...handlers.keys()], ["tool_call"]);
  assert.equal(handlers.has("session_start"), false, "child must not compete for the Workflow continuation lease");
  assert.equal(handlers.has("agent_end"), false, "child must not drive the parent Goal continuation loop");
  const structuredOutputDecision = await handlers.get("tool_call")?.[0]?.({
    type: "tool_call",
    toolName: "structured_output",
    toolCallId: "verdict-1",
    input: { pass: false },
  }, {} as ExtensionContext);
  assert.equal(structuredOutputDecision, undefined, "child-local verdicts must not wait for parent permission RPC");
});

test("intelligence shutdown awaits both managers and contains cleanup failures", async () => {
  const calls: string[] = [];
  await shutdownIntelligenceTools({
    lsp: { async shutdown() { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push("lsp"); } },
    browser: { async closeAll() { calls.push("browser"); throw new Error("close failed"); } },
  }, 100);
  assert.deepEqual(calls.sort(), ["browser", "lsp"]);
});

function workflowAttachSnapshot(): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-16T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "attach" },
    sessionGeneration: "canonical:valid:session-1:1",
    canonicalClaim: { activeSessionId: "session-1", status: "valid" },
    diagnostics: [],
    session: {
      sessionId: "session-1",
      intent: "Attach only after opt-in",
      status: "running",
      revision: 1,
      identityRevision: 1,
      activeRunId: null,
      definitionOfDone: "",
      gates: [],
      chain: [],
      runs: [],
      artifacts: [],
      aliases: {},
    },
  };
}
