import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import registerMaestroExtension, {
  CHINESE_RESPONSE_PROMPT,
  appendChineseResponsePrompt,
  chineseGlobalStatePath,
  isWorkflowOptInCommand,
  registerChineseResponseMode,
  shouldActivateWorkflowSession,
  shouldAttachWorkflowSession,
  shouldRestoreWorkflowGoal,
  todoActorFromTeammateStarted,
  workflowSnapshotForAttachedSession,
} from "../src/extension/index.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";
import { isRunControlReadAction } from "../src/tools/run-control.ts";
import { PLAN_TOGGLE_KEY } from "../src/tools/plan.ts";
import {
  MAESTRO_GLOBAL_SHORTCUTS,
  auditShortcutConflicts,
  executeKeybindingsCommand,
} from "../src/keybindings-command.ts";
import {
  getTeammateChildExtensions,
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
} from "pi-maestro-teammate/v1/child-extensions";

type ChineseCommand = { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
type ChineseEntry = { type: "custom"; customType: string; data: { enabled: boolean } };

function createChineseHarness(entries: ChineseEntry[], cwd: string, homeDir: string) {
  const commands = new Map<string, ChineseCommand>();
  const sessionStartHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }) => unknown> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const api = {
    registerCommand(name: string, command: ChineseCommand) { commands.set(name, command); },
    appendEntry(customType: string, data: { enabled: boolean }) {
      entries.push({ type: "custom", customType, data });
    },
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStartHandlers.push(handler as (event: unknown, ctx: ExtensionContext) => unknown);
      } else if (event === "before_agent_start") {
        beforeAgentStartHandlers.push(handler as (event: { systemPrompt: string }) => unknown);
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => entries },
    ui: { notify(message: string, type: string) { notifications.push({ message, type }); } },
  } as unknown as ExtensionContext;
  const mode = registerChineseResponseMode(api, { homeDir });
  return { commands, sessionStartHandlers, beforeAgentStartHandlers, notifications, ctx, mode };
}

test("Chinese response mode restores, persists, and appends its prompt once", async () => {
  const home = mkdtempSync(join(tmpdir(), "chinese-home-"));
  const entries: ChineseEntry[] = [{
    type: "custom",
    customType: "maestro-chinese-response-mode",
    data: { enabled: true },
  }];
  const h = createChineseHarness(entries, process.cwd(), home);
  await h.sessionStartHandlers[0]?.({}, h.ctx);
  assert.equal(h.mode.isEnabled(), true);

  const injected = h.beforeAgentStartHandlers[0]?.({ systemPrompt: "base" }) as { systemPrompt: string };
  assert.equal(injected.systemPrompt, `base\n\n${CHINESE_RESPONSE_PROMPT}`);
  assert.equal(appendChineseResponsePrompt(injected.systemPrompt), injected.systemPrompt);
  assert.match(injected.systemPrompt, /所有回复使用简体中文/);
  assert.match(injected.systemPrompt, /使用中文提交信息/);

  await h.commands.get("chinese")?.handler("off", h.ctx);
  assert.equal(h.mode.isEnabled(), false);
  assert.deepEqual(entries.at(-1)?.data, { enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(chineseGlobalStatePath(home), "utf8")), { version: 1, enabled: false });
  assert.equal(h.beforeAgentStartHandlers[0]?.({ systemPrompt: "base" }), undefined);
  assert.match(h.notifications.at(-1)?.message ?? "", /已关闭/);
});

test("Chinese response mode stays enabled globally across workspaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "chinese-global-"));
  const workspaceA = join(home, "workspace-a");
  const workspaceB = join(home, "workspace-b");

  // Fresh session without a global state file starts disabled.
  const h1 = createChineseHarness([], workspaceA, home);
  await h1.sessionStartHandlers[0]?.({}, h1.ctx);
  assert.equal(h1.mode.isEnabled(), false);

  // Toggle on writes the global state file.
  await h1.commands.get("chinese")?.handler("on", h1.ctx);
  assert.equal(h1.mode.isEnabled(), true);
  assert.deepEqual(JSON.parse(readFileSync(chineseGlobalStatePath(home), "utf8")), { version: 1, enabled: true });

  // A different workspace with a fresh empty session restores the global state.
  const h2 = createChineseHarness([], workspaceB, home);
  await h2.sessionStartHandlers[0]?.({}, h2.ctx);
  assert.equal(h2.mode.isEnabled(), true);
  const injected = h2.beforeAgentStartHandlers[0]?.({ systemPrompt: "base" }) as { systemPrompt: string };
  assert.match(injected.systemPrompt, /所有回复使用简体中文/);

  // Toggle off updates the global state; the next fresh session anywhere starts disabled.
  await h2.commands.get("chinese")?.handler("off", h2.ctx);
  assert.equal(h2.mode.isEnabled(), false);
  assert.deepEqual(JSON.parse(readFileSync(chineseGlobalStatePath(home), "utf8")), { version: 1, enabled: false });
  const h3 = createChineseHarness([], workspaceA, home);
  await h3.sessionStartHandlers[0]?.({}, h3.ctx);
  assert.equal(h3.mode.isEnabled(), false);
});

test("workspace extension path loads before runtime actions are bound", () => {
  const extensionUrl = new URL("../src/extension/index.ts", import.meta.url).href;
  const script = `
    import { fileURLToPath } from "node:url";
    import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
    const loaderUrl = new URL(
      "./core/extensions/loader.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const { loadExtensions } = await import(loaderUrl.href);
    const result = await loadExtensions(
      [fileURLToPath(${JSON.stringify(extensionUrl)})],
      process.cwd(),
      createEventBus(),
      createExtensionRuntime(),
    );
    if (result.errors.length > 0) throw new Error(result.errors.map((entry) => entry.error).join("\\n"));
    if (result.extensions.length !== 1) throw new Error("workspace extension did not load exactly once");
    if (!result.extensions[0].tools.has("lsp")) throw new Error("lsp was not registered");
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

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

test("statusline snapshot is filtered to the Workflow Session the Pi session leases", () => {
  const snapshot = workflowAttachSnapshot();
  assert.equal(
    workflowSnapshotForAttachedSession(snapshot, "session-1"),
    snapshot,
    "the leased Session must reach the statusline",
  );
  assert.equal(
    workflowSnapshotForAttachedSession(snapshot, "session-other"),
    undefined,
    "a Session owned by another Pi session must stay hidden",
  );
  assert.equal(workflowSnapshotForAttachedSession(snapshot, undefined), undefined);
  assert.equal(workflowSnapshotForAttachedSession(undefined, "session-1"), undefined);
  assert.equal(workflowSnapshotForAttachedSession({ ...snapshot, session: undefined }, "session-1"), undefined);
});

test("teammate started events expose a Todo actor before the teammate calls Todo", () => {
  assert.deepEqual(todoActorFromTeammateStarted({
    correlationId: "worker-correlation",
    name: "worker-alpha",
    agent: "general",
  }), {
    kind: "teammate",
    id: "worker-correlation",
    label: "worker-alpha",
    agentType: "general",
  });
  assert.equal(todoActorFromTeammateStarted({ correlationId: "unknown", agent: "general" }), undefined);
});

test("Workflow writer attachment and Todo projection require local Workflow opt-in", () => {
  const snapshot = workflowAttachSnapshot();
  assert.equal(shouldAttachWorkflowSession(snapshot), true);
  assert.equal(
    shouldActivateWorkflowSession(snapshot, false),
    false,
    "a fresh or forked Pi session must retain its own Todo state",
  );
  assert.equal(shouldActivateWorkflowSession(snapshot, true), true);
  assert.equal(shouldAttachWorkflowSession({
    ...snapshot,
    session: undefined,
    canonicalClaim: { activeSessionId: "session-1", status: "invalid", error: "missing session.json" },
  }), false);
  assert.equal(shouldActivateWorkflowSession({
    ...snapshot,
    session: undefined,
    canonicalClaim: { activeSessionId: "session-1", status: "invalid", error: "missing session.json" },
  }, true), false);
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

test("shortcut audit covers built-in, configured, and companion extension collisions", () => {
  assert.equal(PLAN_TOGGLE_KEY, "alt+shift+p");
  assert.equal(matchesKey("\x1b[112;4u", PLAN_TOGGLE_KEY), true);
  assert.deepEqual(
    MAESTRO_GLOBAL_SHORTCUTS.find((shortcut) => shortcut.owner === "Maestro Plan mode"),
    { key: PLAN_TOGGLE_KEY, owner: "Maestro Plan mode" },
  );
  assert.deepEqual(auditShortcutConflicts({ "app.thinking.cycle": "ctrl+shift+e" }), []);

  const defaults = auditShortcutConflicts({});
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]?.key, "shift+tab");
  assert.deepEqual(defaults[0]?.owners, ["Maestro approval mode", "Pi app.thinking.cycle"]);

  for (const shortcut of MAESTRO_GLOBAL_SHORTCUTS) {
    const custom = auditShortcutConflicts({
      "app.thinking.cycle": "ctrl+shift+e",
      "app.model.select": shortcut.key,
    });
    assert.deepEqual(custom, [{
      key: shortcut.key,
      owners: [shortcut.owner, "Pi app.model.select"],
    }]);
  }
});

test("shortcut command menu fixes, re-audits, and restores without touching other actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-command-"));
  const configPath = join(root, "keybindings.json");
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    ui: {
      async select(_title: string, options: string[]) { return options[1]; },
      notify(message: string, type: string) { notifications.push({ message, type }); },
    },
  } as unknown as ExtensionContext;

  await executeKeybindingsCommand("", ctx, configPath);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { "app.thinking.cycle": "ctrl+shift+e" });
  assert.match(notifications.at(-1)?.message ?? "", /未发现其他冲突/);

  writeFileSync(configPath, JSON.stringify({
    "app.thinking.cycle": "shift+tab",
    "app.model.select": "alt+shift+p",
  }));
  await executeKeybindingsCommand("fix", ctx, configPath);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    "app.thinking.cycle": "ctrl+shift+e",
    "app.model.select": "alt+shift+p",
  });
  assert.equal(notifications.at(-1)?.type, "warning");
  assert.match(notifications.at(-1)?.message ?? "", /仍有 1 个冲突.*alt\+shift\+p/);

  await executeKeybindingsCommand("restore", ctx, configPath);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { "app.model.select": "alt+shift+p" });
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
      if (property === "events") return {
        on(event: string, handler: (...args: unknown[]) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        emit() {},
      };
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
  assert.equal(names.includes("swarm_runtime"), false);
  assert.ok(commands.includes("maestro-session"));
  assert.ok(commands.includes("maestro-todo"));
  assert.ok(commands.includes("maestro-keybindings"));
  assert.equal(commands.includes("swarm"), false);
  assert.ok(renderers.includes("run-event"));

  const runControl = tools.find((tool) => tool.name === "run-control");
  const runControlProperties = (runControl?.parameters as {
    properties?: Record<string, { description?: string; anyOf?: Array<{ const?: string }> }>;
  })?.properties;
  const actionSchema = runControlProperties?.action;
  assert.deepEqual(actionSchema?.anyOf?.map((item) => item.const), [
    "status", "brief", "prepare", "check", "next", "done", "edit",
  ]);
  assert.match(runControl?.description ?? "", /status: read the current projected Session snapshot/);
  assert.match(runControl?.description ?? "", /next: allocate the next chain Run/);
  assert.match(runControl?.description ?? "", /done: seal a Run with a verdict/);
  assert.match(runControl?.description ?? "", /edit: modify future chain steps/);
  assert.match(actionSchema?.description ?? "", /Read: status, brief, prepare, check/);
  assert.match(runControlProperties?.runId?.description ?? "", /Required for done/);
  assert.match(runControlProperties?.step?.description ?? "", /required for prepare/);
  assert.match(runControlProperties?.verdict?.description ?? "", /defaults to done/);
  assert.match(runControlProperties?.commands?.description ?? "", /Supply one command for replace/);
  assert.match(runControlProperties?.args?.description ?? "", /exactly one command/);

  const maestro = tools.find((tool) => tool.name === "maestro");
  const maestroProperties = (maestro?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(maestroProperties?.name, "maestro general schema should expose a stable task name");
  assert.ok(maestroProperties?.concurrency, "maestro explore schema should expose a concurrency bound");

  const askTool = tools.find((tool) => tool.name === "ask-user-question");
  assert.ok(askTool?.renderResult);
  const renderAskResult = askTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string },
    context: { args: { questions: unknown[] } },
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
  const askArgs = { questions: [{}, {}] };
  const collapsed = renderAskResult(askResult, { expanded: false, isPartial: false }, theme, { args: askArgs }).render(120).map((line) => line.trimEnd());
  const expanded = renderAskResult(askResult, { expanded: true, isPartial: false }, theme, { args: askArgs }).render(120).map((line) => line.trimEnd());
  assert.deepEqual(collapsed, ["  ✓ ask 2 questions · 2 answers"]);
  assert.deepEqual(expanded, [
    "  ✓ ask 2 questions · 2 answers",
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
    properties?: Record<string, { enum?: string[]; description?: string }>;
    anyOf?: unknown;
  };
  assert.equal(goalSchema.type, "object", "provider function schemas must have an object root");
  assert.equal(goalSchema.anyOf, undefined, "provider function schemas must not use a root-level anyOf");
  assert.equal(goalSchema.additionalProperties, false);
  assert.deepEqual(goalSchema.required, ["action"]);
  assert.deepEqual(goalSchema.properties?.action?.enum, ["get", "create", "update", "complete"]);
  assert.ok(goalSchema.properties?.objective);
  assert.ok(goalSchema.properties?.tokenBudget);
  assert.match(String(goalSchema.properties?.tokenBudget?.description), /omit for no budget/i);
  assert.match(String(goalSchema.properties?.summary?.description), /complete/i);
  const renderGoalCall = goalTool.renderCall as unknown as (
    args: Record<string, unknown>,
    theme: { fg(name: string, text: string): string; bold(text: string): string },
  ) => { render(width: number): string[] };
  const renderGoalResult = goalTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string; bold(text: string): string },
    context: { args: Record<string, unknown> },
  ) => { render(width: number): string[] };
  const goalTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const goalArgs = {
    action: "create",
    objective: "完成 Git 仓库配置整理：这段长目标不应破坏 call 行宽度",
  };
  const goalCallComponent = renderGoalCall(goalArgs, goalTheme);
  const call = goalCallComponent.render(120).map((line) => line.trimEnd());
  assert.match(call[0] ?? "", /^  ⋯ goal create/);
  const goalResult = {
    content: [{ type: "text", text: "Goal started: 完成 Git 仓库配置整理" }],
    isError: false,
  };
  const collapsedGoalComponent = renderGoalResult(goalResult, { expanded: false, isPartial: false }, goalTheme, { args: goalArgs });
  const expandedGoalComponent = renderGoalResult(goalResult, { expanded: true, isPartial: false }, goalTheme, { args: goalArgs });
  const collapsedGoal = collapsedGoalComponent.render(120).map((line) => line.trimEnd());
  const expandedGoal = expandedGoalComponent.render(120).map((line) => line.trimEnd());
  assert.match(collapsedGoal[0] ?? "", /^  ✓ goal create/);
  assert.match(collapsedGoal[0] ?? "", /Goal started/);
  assert.ok(expandedGoal.slice(1).some((line) => /完成 Git 仓库配置整理/.test(line)));
  for (let width = 1; width <= 120; width++) {
    for (const component of [goalCallComponent, collapsedGoalComponent, expandedGoalComponent]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }

  // The host adds a renderer's return value straight into a pi-tui Box, and only
  // guards against renderers that throw. Returning a non-Component therefore
  // escapes as an uncaughtException and kills the TUI.
  const todoTool = tools.find((tool) => tool.name === "todo");
  assert.match(todoTool?.description ?? "", /blockedBy integer N means the earlier array item tasks\[N\]/);
  assert.match(todoTool?.description ?? "", /blockedBy: \[0\]/);
  const todoSchema = todoTool?.parameters as {
    properties?: {
      tasks?: {
        description?: string;
        items?: { properties?: { blockedBy?: { items?: { description?: string; type?: string; minimum?: number } } } };
      };
    };
  } | undefined;
  assert.match(todoSchema?.properties?.tasks?.description ?? "", /0 <= N < i/);
  assert.match(
    todoSchema?.properties?.tasks?.items?.properties?.blockedBy?.items?.description ?? "",
    /index must be less than i/,
  );
  assert.equal(todoSchema?.properties?.tasks?.items?.properties?.blockedBy?.items?.type, "integer");
  assert.equal(todoSchema?.properties?.tasks?.items?.properties?.blockedBy?.items?.minimum, 0);
  assert.ok(todoTool?.renderResult);
  const renderTodoResult = todoTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string; bold(text: string): string },
    context: { args: Record<string, unknown> },
  ) => { render(width: number): string[] };
  const todoTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const todoTasks = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, status: "pending" }));
  const todoListComponent = renderTodoResult({
    content: [{ type: "text", text: todoTasks.map((_, index) => `- [ ] Task ${index + 1}`).join("\n") }],
    details: { action: "list", tasks: todoTasks },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "list" } });
  assert.equal(typeof todoListComponent.render, "function", "todo list result must be a TUI Component");
  const todoListLines = todoListComponent.render(80).map((line) => line.trimEnd());
  assert.deepEqual(todoListLines, ["  ✓ todo list · 9 tasks (9 open)"]);
  for (let width = 1; width <= 120; width++) {
    for (const line of todoListComponent.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
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
  assert.equal(permissionPrompts, 0, "default YOLO mode must not open a permission prompt");
  assert.equal(toolResult, undefined);
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
  assert.match(source, /pi\.events\.on\(TEAMMATE_STARTED_EVENT[\s\S]*?registerTodoActor\(actor\)/);
});

test("teammate child registers interaction, local Bash, and parent-permission surfaces", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); };
      if (property === "events") return { on: () => () => undefined, emit: () => undefined };
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

  assert.deepEqual(tools.map((tool) => tool.name), ["ask-user-question", "bash_bg", "todo"]);
  assert.deepEqual([...handlers.keys()], ["session_compact", "session_shutdown", "tool_call"]);
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
