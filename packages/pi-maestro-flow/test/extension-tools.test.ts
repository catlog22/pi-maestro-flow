import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import registerMaestroExtension, {
  CHINESE_RESPONSE_PROMPT,
  appendChineseResponsePrompt,
  chineseGlobalStatePath,
  currentWorkflowPlanTarget,
  isWorkflowOptInCommand,
  isWorkflowSessionMatchable,
  MAESTRO_CHILD_TOOL_NAMES,
  registerChineseResponseMode,
  sealedWorkflowExecutionTransition,
  shouldActivateWorkflowSession,
  shouldAttachWorkflowSession,
  shouldRestoreWorkflowGoal,
  settleFailedCompaction,
  todoActorFromTeammateStarted,
  workflowArtifactKnowledgeSessionId,
  workflowSnapshotForAttachedSession,
} from "../src/extension/index.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";
import { readAgentOutput } from "../src/teammate/agent-output-store.ts";
import { isRunControlReadAction } from "../src/tools/run-control.ts";
import { setTodoDurationChartEnabled } from "../src/todo-chart-state.ts";
import { PLAN_TOGGLE_KEY } from "../src/tools/plan.ts";
import { CompactionArbiter, NATIVE_FALLBACK_COMPACTION_MARKER } from "../src/compaction/compaction-arbiter.ts";
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

function registerRootMaestroExtension(api: ExtensionAPI): void {
  const previous = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  try {
    registerMaestroExtension(api);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previous;
  }
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

  h.mode.toggle(h.ctx);
  assert.equal(h.mode.isEnabled(), true);
  assert.deepEqual(entries.at(-1)?.data, { enabled: true });
  assert.deepEqual(JSON.parse(readFileSync(chineseGlobalStatePath(home), "utf8")), { version: 1, enabled: true });
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

test("Workflow Goal restore reconciles any workflow-owned Goal against valid canonical authority", () => {
  const snapshot = workflowAttachSnapshot();
  const owned = { workflowSessionId: "session-1" };
  assert.equal(shouldRestoreWorkflowGoal("startup", undefined, snapshot), false);
  const unrelatedOptIn = shouldRestoreWorkflowGoal("startup", {}, snapshot);
  assert.equal(unrelatedOptIn, false, "an unrelated user Goal must stay read-only");
  assert.equal(shouldAttachWorkflowSession(snapshot), true, "canonical Session attachment must not depend on Goal restoration");
  assert.equal(shouldRestoreWorkflowGoal("startup", owned, snapshot), true);
  assert.equal(shouldRestoreWorkflowGoal("reload", owned, snapshot), true);
  assert.equal(shouldRestoreWorkflowGoal("resume", owned, snapshot), true);
  assert.equal(
    shouldRestoreWorkflowGoal("resume", { workflowSessionId: "session-other" }, snapshot),
    true,
    "a stale workflow-owned Goal must enter reconciliation so the canonical Session can replace it",
  );
  const inconsistent = structuredClone(snapshot);
  inconsistent.canonicalClaim = { activeSessionId: "session-other", status: "valid" };
  assert.equal(shouldRestoreWorkflowGoal("resume", owned, inconsistent), false);
  const invalid = structuredClone(snapshot);
  invalid.canonicalClaim = { activeSessionId: "session-1", status: "invalid", error: "broken" };
  assert.equal(shouldRestoreWorkflowGoal("resume", owned, invalid), false);
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

test("Artifact Knowledge resolves only from the Workflow Session attached to this Pi session", () => {
  const snapshot = workflowAttachSnapshot();
  assert.equal(workflowArtifactKnowledgeSessionId(snapshot, true, "session-1"), "session-1");
  assert.equal(workflowArtifactKnowledgeSessionId(snapshot, false, "session-1"), undefined);
  assert.equal(workflowArtifactKnowledgeSessionId(snapshot, true, "session-other"), undefined);
  assert.equal(workflowArtifactKnowledgeSessionId(snapshot, true, undefined), undefined);
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

test("statusless Workflow lifecycle separates Session matching, Execution attachment, and seal release", () => {
  const active = statuslessWorkflowAttachSnapshot("active");
  assert.equal(isWorkflowSessionMatchable(active), true);
  assert.equal(shouldAttachWorkflowSession(active), true);
  assert.equal(shouldActivateWorkflowSession(active, true), true);

  const paused = statuslessWorkflowAttachSnapshot("paused");
  assert.equal(isWorkflowSessionMatchable(paused), true);
  assert.equal(shouldAttachWorkflowSession(paused), false);
  assert.equal(shouldActivateWorkflowSession(paused, true), true);

  const idle = statuslessWorkflowAttachSnapshot();
  idle.session!.latestExecutionId = "execution-2";
  assert.equal(isWorkflowSessionMatchable(idle), true, "idle Session identity remains matchable");
  assert.equal(shouldAttachWorkflowSession(idle), false, "no current Execution has no attachable lease");
  assert.equal(shouldActivateWorkflowSession(idle, true), true);

  const sealed = statuslessWorkflowAttachSnapshot("sealed");
  assert.equal(shouldAttachWorkflowSession(sealed), false);
  assert.deepEqual(sealedWorkflowExecutionTransition(active, sealed), {
    sessionId: "session-2",
    executionId: "execution-2",
  });
  assert.deepEqual(sealedWorkflowExecutionTransition(active, idle), {
    sessionId: "session-2",
    executionId: "execution-2",
  }, "clearing current_execution_id on seal still releases the observed Execution");

  idle.session!.archivedAt = "2026-07-18T03:00:00.000Z";
  idle.session!.archivedBy = "pi-owner";
  assert.equal(isWorkflowSessionMatchable(idle), false);
  assert.equal(shouldActivateWorkflowSession(idle, true), false);
});

test("statusless Plan current target uses Execution lifecycle and chain authority", () => {
  const pending = statuslessWorkflowAttachSnapshot("active");
  pending.session!.chain = [{ step: "stale-review", command: "review", status: "pending", runId: null }];
  pending.execution!.chain = [{ step: "execute", command: "execute", status: "pending", runId: null }];
  assert.deepEqual(currentWorkflowPlanTarget(pending), { available: true, hasActiveWork: false });

  const paused = structuredClone(pending);
  paused.execution!.status = "paused";
  assert.match(currentWorkflowPlanTarget(paused).reason ?? "", /Execution is paused/);

  const blocked = structuredClone(pending);
  blocked.execution!.chain[0]!.status = "blocked";
  assert.match(currentWorkflowPlanTarget(blocked).reason ?? "", /Execution is blocked/);

  const sealed = structuredClone(pending);
  sealed.execution!.status = "sealed";
  assert.match(currentWorkflowPlanTarget(sealed).reason ?? "", /Execution is sealed/);

  const idle = statuslessWorkflowAttachSnapshot("active");
  assert.match(currentWorkflowPlanTarget(idle).reason ?? "", /no pending execution step/);

  const archived = structuredClone(pending);
  archived.session!.archivedAt = "2026-07-18T03:00:00.000Z";
  assert.match(currentWorkflowPlanTarget(archived).reason ?? "", /Session is archived/);

  const legacy = workflowAttachSnapshot();
  legacy.session!.chain = [{ step: "execute", command: "execute", status: "pending", runId: null }];
  assert.deepEqual(currentWorkflowPlanTarget(legacy), { available: true, hasActiveWork: false });
});

test("shortcut audit covers built-in, configured, and companion extension collisions", () => {
  assert.equal(PLAN_TOGGLE_KEY, "alt+shift+p");
  assert.equal(matchesKey("\x1b[112;4u", PLAN_TOGGLE_KEY), true);
  assert.deepEqual(
    MAESTRO_GLOBAL_SHORTCUTS.find((shortcut) => shortcut.owner === "Maestro Plan mode"),
    { key: PLAN_TOGGLE_KEY, owner: "Maestro Plan mode" },
  );
  for (const cockpitKey of ["alt+r", "alt+w", "alt+e", "alt+l", "ctrl+shift+r", "alt+j", "alt+shift+t"]) {
    assert.ok(
      MAESTRO_GLOBAL_SHORTCUTS.some((shortcut) => shortcut.key === cockpitKey),
      `missing Cockpit shortcut ${cockpitKey}`,
    );
  }
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

test("session_compact_failed settles only the extension compaction that owns the active lease", () => {
  const arbiter = new CompactionArbiter();
  arbiter.observeStart();
  assert.equal(
    settleFailedCompaction(arbiter, { aborted: true, fromExtension: false }),
    false,
    "a denied hook emits a host cancellation event but must preserve the existing owner",
  );
  assert.equal(arbiter.currentOwner(), "native");
  assert.equal(settleFailedCompaction(arbiter, { aborted: false, fromExtension: true }), true);
  assert.equal(arbiter.currentOwner(), undefined);
  assert.equal(
    settleFailedCompaction(arbiter, { aborted: true, fromExtension: true }),
    false,
    "duplicate failure events are idempotent",
  );

  arbiter.observeStart();
  assert.equal(settleFailedCompaction(arbiter, { aborted: true, fromExtension: true }), true);
  assert.equal(arbiter.currentOwner(), undefined);
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

  registerRootMaestroExtension(api);
  assert.equal(handlers.get("session_compact_failed")?.length, 1, "root compaction failures release lifecycle state");
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
  assert.ok(names.includes("computer_use"));
  assert.ok(names.includes("search_tool_bm25"));
  assert.equal(names.filter((name) => name === "lsp").length, 1);
  assert.equal(names.filter((name) => name === "browser").length, 1);
  assert.equal(names.filter((name) => name === "computer_use").length, 1);
  assert.equal(names.filter((name) => name === "search_tool_bm25").length, 1);
  assert.ok(names.includes("run-control"));
  assert.equal(names.includes("compact_history"), false, "opt-in compact tools must not register before enable");
  assert.equal(names.includes("session_history"), false);
  assert.equal(names.includes("new_context"), false, "opt-in compact tools must not register before enable");
  assert.equal(names.includes("swarm_runtime"), false);
  assert.ok(commands.includes("maestro-session"));
  assert.ok(commands.includes("maestro-todo"));
  assert.ok(commands.includes("maestro-knowledge"));
  assert.ok(commands.includes("maestro-knowledge-stage"));
  assert.ok(commands.includes("maestro-knowledge-from-window"));
  assert.ok(commands.includes("maestro-knowledge-record"));
  assert.ok(commands.includes("maestro-skills"));
  assert.ok(commands.includes("maestro-keybindings"));
  assert.ok(commands.includes("export-session-info"));
  assert.equal(commands.includes("swarm"), false);
  assert.ok(renderers.includes("run-event"));
  assert.ok(renderers.includes("maestro-session-info"));

  const runControl = tools.find((tool) => tool.name === "run-control");
  const runControlProperties = (runControl?.parameters as {
    properties?: Record<string, { description?: string; anyOf?: Array<{ const?: string }> }>;
  })?.properties;
  const argvSchema = runControlProperties?.argv;
  assert.ok(argvSchema, "run-control exposes a single argv passthrough parameter");
  assert.match(argvSchema?.description ?? "", /Maestro CLI arguments/);
  assert.match(runControl?.description ?? "", /Transparent argv shell over the canonical Maestro CLI/);
  assert.match(runControl?.description ?? "", /single LLM surface for lifecycle/);
  assert.match(runControl?.description ?? "", /do not hand-write/);
  assert.match(runControl?.description ?? "", /there is no workflow mutation lease/);
  assert.match(runControl?.description ?? "", /blocked in Plan mode/);
  assert.match(runControl?.description ?? "", /Opening a new Session/);
  assert.match(runControl?.description ?? "", /already active Session is not required/);
  assert.match(runControl?.description ?? "", /identical --participant and --actor/);
  assert.match(runControl?.description ?? "", /exact --session/);
  assert.match(runControl?.description ?? "", /--expected-orchestration-revision/);
  assert.match(runControl?.description ?? "", /--expected-run-revision/);
  assert.match(runControl?.description ?? "", /legacy --expected-identity-revision and --expected-activity-revision/);
  assert.match(runControl?.description ?? "", /session","chain","update/);
  assert.match(runControl?.description ?? "", /artifact inspect|Artifact compatibility/);
  assert.match(runControl?.description ?? "", /Artifact republish is a capability-gated registry mutation/);
  assert.match(runControl?.description ?? "", /fresh inspect-derived CAS fence/);
  assert.match(argvSchema?.description ?? "", /without the leading executable/);
  assert.match(argvSchema?.description ?? "", /\["session","status"/);
  assert.match(argvSchema?.description ?? "", /\["run","brief"/);
  assert.match(argvSchema?.description ?? "", /\["run","check"/);
  assert.match(argvSchema?.description ?? "", /\["run","next"/);
  assert.match(argvSchema?.description ?? "", /\["run","complete"/);
  assert.match(argvSchema?.description ?? "", /\["session","chain","insert"/);
  assert.match(argvSchema?.description ?? "", /\["session","chain","update"/);
  assert.doesNotMatch(argvSchema?.description ?? "", /session","next|run","done|run","edit/);
  assert.equal(runControlProperties?.step, undefined, "typed per-action params are removed in the shell surface");
  assert.equal(runControlProperties?.verdict, undefined);
  assert.equal(runControlProperties?.commands, undefined);
  assert.equal(runControlProperties?.args, undefined);

  const maestro = tools.find((tool) => tool.name === "maestro");
  const maestroProperties = (maestro?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(maestroProperties?.name, "maestro general schema should expose a stable task name");
  assert.ok(maestroProperties?.concurrency, "maestro explore schema should expose a concurrency bound");

  const askTool = tools.find((tool) => tool.name === "ask-user-question");
  assert.equal(askTool?.executionMode, "sequential");
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
  assert.match(call[0] ?? "", /^  [⋯…] goal create/);
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
  assert.match(todoTool?.description ?? "", /advance: omit id\/summary/);
  assert.match(todoTool?.description ?? "", /update \(batch\).*commits atomically/);
  assert.match(todoTool?.description ?? "", /delete: use id for one task or ids for an atomic batch/);
  const todoParametersJson = JSON.stringify(todoTool?.parameters);
  assert.match(todoParametersJson, /advance/);
  assert.match(todoParametersJson, /"ids"/);
  assert.match(todoParametersJson, /"updates"/);
  const todoGuidelines = todoTool?.promptGuidelines?.join("\n") ?? "";
  assert.match(todoGuidelines, /live execution state machine/);
  assert.match(todoGuidelines, /before any tool call or work belonging to another Todo/);
  assert.match(todoGuidelines, /never batch-complete/);
  assert.match(todoGuidelines, /actor-scoped/);
  assert.match(todoGuidelines, /\[context-pressure-advisory\]/);
  assert.match(todoGuidelines, /task activated in that same result/);
  assert.match(todoGuidelines, /standalone new_context tool/);
  assert.match(todoGuidelines, /cannot change the completed advance retroactively/);
  assert.match(todoGuidelines, /critical means do not reset/);
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
  assert.ok(todoTool?.renderCall);
  assert.ok(todoTool?.renderResult);
  const renderTodoCall = todoTool.renderCall as unknown as (
    args: Record<string, unknown>,
    theme: { fg(name: string, text: string): string; bold(text: string): string },
    context: { isPartial: boolean },
  ) => { render(width: number): string[] };
  const renderTodoResult = todoTool.renderResult as unknown as (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(name: string, text: string): string; bold(text: string): string },
    context: { args: Record<string, unknown> },
  ) => { render(width: number): string[] };
  const todoTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const todoCallLines = renderTodoCall(
    { action: "create", subject: "hidden\tTodo\u001b[31m\nsubject" },
    todoTheme,
    { isPartial: true },
  ).render(80);
  assert.match(todoCallLines.join(""), /todo/);
  assert.doesNotMatch(todoCallLines.join(""), /create|hidden|subject|[\r\n\t\x1b]/, "Working renderer exposes only the tool name");

  const todoTasks = Array.from({ length: 15 }, (_, index) => ({
    id: `t${index}`,
    subject: index === 8 ? "Task 9\t\u001b[31m\nowned\r" : `Task ${index + 1}`,
    status: index === 8 ? "in_progress" : "pending",
  }));
  const todoListComponent = renderTodoResult({
    content: [{ type: "text", text: todoTasks.map((task) => `- ${task.subject}`).join("\n") }],
    details: { action: "list", tasks: todoTasks, displayTaskIds: todoTasks.map((task) => task.id) },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "list" } });
  assert.equal(typeof todoListComponent.render, "function", "todo list result must be a TUI Component");
  const todoListLines = todoListComponent.render(80).map((line) => line.trimEnd());
  assert.equal(todoListLines.length, 12, "card + earlier marker + 8-task window + later marker");
  assert.equal(visibleWidth(todoListLines[0]), 79, "Todo card leaves the terminal autowrap column unused");
  assert.match(todoListLines.join("\n"), /↑ 4 earlier tasks/);
  assert.match(todoListLines.join("\n"), /↓ 3 later tasks/);
  assert.match(todoListLines.join("\n"), /▶ in progress\s+#t8\s+Task 9\s+\[31m owned/);
  assert.doesNotMatch(todoListLines.join(""), /[\r\n\x1b]/, "Todo rendering strips C0 controls at the card boundary");
  for (let width = 1; width <= 120; width++) {
    for (const line of todoListComponent.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }

  const filteredComponent = renderTodoResult({
    content: [{ type: "text", text: "▶ #t8 Task 9" }],
    details: { action: "list", tasks: todoTasks, displayTaskIds: ["t8"] },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "list", filter: { status: "in_progress" } } });
  const filteredLines = filteredComponent.render(100).join("\n");
  assert.match(filteredLines, /1 task.*1 in progress/);
  assert.match(filteredLines, /#t8/);
  assert.doesNotMatch(filteredLines, /#t(?:7|9)\b/, "filtered list renders only action-scoped task IDs");

  const emptyFilterComponent = renderTodoResult({
    content: [{ type: "text", text: "No tasks found." }],
    details: { action: "list", tasks: todoTasks, displayTaskIds: [] },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "list", filter: { status: "completed" } } });
  const emptyFilterLines = emptyFilterComponent.render(100).join("\n");
  assert.match(emptyFilterLines, /No tasks found\./);
  assert.doesNotMatch(emptyFilterLines, /#t\d+/, "zero-match filter never falls back to the global snapshot");

  const completedHistory = Array.from({ length: 3 }, (_, index) => ({
    id: `old${index}`,
    subject: `Completed ${index + 1}`,
    status: "completed",
  }));
  const createComponent = renderTodoResult({
    content: [{ type: "text", text: "Created 15 tasks." }],
    details: {
      action: "create",
      tasks: [...completedHistory, ...todoTasks],
      displayTaskIds: todoTasks.map((task) => task.id),
    },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "create", tasks: todoTasks } });
  const createLines = createComponent.render(100);
  assert.equal(createLines.length, 19, "create renders all 15 new tasks plus two recent completed tasks");
  assert.match(createLines[0], /15 created.*2 recent done/);
  assert.doesNotMatch(createLines.join("\n"), /earlier tasks|later tasks/);
  assert.match(createLines.join("\n"), /Task 1/);
  assert.match(createLines.join("\n"), /Task 15/);
  assert.match(createLines.join("\n"), /#old1.*Completed 2/);
  assert.match(createLines.join("\n"), /#old2.*Completed 3/);
  assert.doesNotMatch(createLines.join("\n"), /#old0\b/, "create limits completed context to the two most recent tasks");

  const createBacklogTasks = todoTasks.map((task, index) => ({
    ...task,
    status: index === 10 || index === 11 ? "completed" : task.status,
  }));
  const createOverBacklog = renderTodoResult({
    content: [{ type: "text", text: "Created 2 tasks." }],
    details: { action: "create", tasks: createBacklogTasks, displayTaskIds: ["t13", "t14"] },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "create", tasks: [{}, {}] } });
  const backlogCreateLines = createOverBacklog.render(100);
  assert.equal(backlogCreateLines.length, 6, "create shows new tasks and only two recent completed backlog tasks");
  assert.match(backlogCreateLines[0], /2 created.*2 recent done/);
  assert.match(backlogCreateLines.join("\n"), /#t(?:10|11|13|14)\b/);
  assert.doesNotMatch(backlogCreateLines.join("\n"), /#t12\b/, "pending backlog remains hidden");

  const initialAdvanceTasks = todoTasks.map((task, index) => ({
    ...task,
    status: index === 0 ? "in_progress" : index === 14 ? "deleted" : "pending",
  }));
  const initialAdvanceLines = renderTodoResult({
    content: [{ type: "text", text: "Activated #t0." }],
    details: { action: "advance", tasks: initialAdvanceTasks },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "advance" } }).render(100);
  assert.equal(initialAdvanceLines.filter((line) => /#t\d+/.test(line)).length, 8);
  assert.match(initialAdvanceLines.join("\n"), /#t0.*Task 1/);
  assert.doesNotMatch(initialAdvanceLines.join("\n"), /✓ completed/);
  assert.match(initialAdvanceLines.join("\n"), /↓ 6 later tasks/);

  const advanceTasks = todoTasks.map((task, index) => ({
    ...task,
    status: index < 5 ? "completed" : index === 5 ? "in_progress" : index === 14 ? "deleted" : "pending",
    assignee: index === 5
      ? { kind: "teammate", id: "builder-correlation", label: "builder" }
      : { kind: "root", id: "root", label: "root" },
    summary: index === 4 ? "Finished task five" : undefined,
    durationMs: index === 4 ? 65_000 : undefined,
  }));
  const advanceComponent = renderTodoResult({
    content: [{ type: "text", text: "Completed #t4. Activated #t5." }],
    details: { action: "advance", tasks: advanceTasks },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "advance", id: "t4" } });
  const advanceLines = advanceComponent.render(100);
  assert.match(advanceLines[0], /9 remaining.*5 done/);
  assert.match(advanceLines.join("\n"), /▶ in progress\s+#t5\s+Task 6\s+@builder/);
  assert.match(advanceLines.join("\n"), /✓ completed\s+#t3\s+Task 4/);
  assert.match(advanceLines.join("\n"), /✓ completed\s+#t4\s+Task 5/);
  assert.match(advanceLines.join("\n"), /↳ Finished task five · active 1m5s/, "advance shows completion information for the task named by args.id");
  assert.doesNotMatch(advanceLines.join("\n"), /#t(?:[0-2]|14)\b/);
  assert.equal(advanceLines.filter((line) => /#t\d+/.test(line)).length, 8, "advance reserves two of eight slots for recent completed tasks");
  assert.match(advanceLines.join("\n"), /↑ 3 earlier tasks/);
  assert.match(advanceLines.join("\n"), /↓ 3 later tasks/);

  const tailAdvanceTasks = todoTasks.map((task, index) => ({
    ...task,
    status: index < 12 ? "completed" : index === 12 ? "in_progress" : index === 14 ? "deleted" : "pending",
  }));
  const tailAdvanceLines = renderTodoResult({
    content: [{ type: "text", text: "Completed #t11. Activated #t12." }],
    details: { action: "advance", tasks: tailAdvanceTasks },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "advance" } }).render(100);
  assert.equal(tailAdvanceLines.filter((line) => /#t\d+/.test(line)).length, 4);
  assert.match(tailAdvanceLines.join("\n"), /#t10.*Task 11/);
  assert.match(tailAdvanceLines.join("\n"), /#t11.*Task 12/);
  assert.match(tailAdvanceLines.join("\n"), /#t12.*Task 13/);
  assert.match(tailAdvanceLines.join("\n"), /#t13.*Task 14/);
  assert.equal(tailAdvanceLines.filter((line) => /✓ completed/.test(line)).length, 2);
  assert.match(tailAdvanceLines.join("\n"), /↑ 10 earlier tasks/);
  assert.doesNotMatch(tailAdvanceLines.join("\n"), /later tasks/);

  const allCompletedTasks = todoTasks.map((task, index) => ({
    ...task,
    status: "completed",
    summary: index === 13 ? "Finished\tpenultimate\u001b[31m" : index === 14 ? "Finished final task" : undefined,
    durationMs: index === 13 ? 123_000 : index === 14 ? 3_600_000 : undefined,
    completedAt: index + 1,
  }));
  const allCompletedComponent = renderTodoResult({
    content: [{ type: "text", text: "Completed #t14. All tasks completed." }],
    details: { action: "advance", tasks: allCompletedTasks },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "advance" } });
  const allCompletedLines = allCompletedComponent.render(500);
  assert.match(allCompletedLines[0], /0 remaining.*15 done/);
  assert.match(allCompletedLines.join("\n"), /✓ all tasks complete/);
  assert.doesNotMatch(
    allCompletedLines.join("\n"),
    /✓ completed|Task 14|Task 15|Finished penultimate|Finished final task/,
    "terminal advance omits individual completed-task rows and details",
  );
  assert.doesNotMatch(allCompletedLines.join("\n"), /Task time · Y=time · X=task/);
  const yRows = allCompletedLines.filter((line) => line.includes("┤"));
  assert.equal(yRows.length, 4, "duration chart has a bounded four-level Y axis");
  assert.match(yRows[0], /1h\s+┤/);
  assert.equal((yRows[0].match(/█/g) ?? []).length, 1, "only the longest task reaches the top tick");
  assert.equal((yRows[3].match(/█/g) ?? []).length, 2, "short positive durations retain a visible minimum column");
  assert.ok(allCompletedLines.some((line) => /0s\s+┼\s+─+/.test(line)), "chart renders the zero baseline");
  assert.ok(allCompletedLines.some((line) => /#t0.*#t13.*#t14/.test(line)), "X axis renders task sequence labels");
  assert.doesNotMatch(allCompletedLines.join(""), /[\r\n\t\x1b]/);
  const compactChartLines = allCompletedComponent.render(70);
  assert.equal(compactChartLines.filter((line) => line.includes("┼")).length, 2, "overflowing tasks split into aligned chart bands");
  assert.ok(compactChartLines.every((line) => visibleWidth(line) <= 70));
  setTodoDurationChartEnabled(false);
  const hiddenChartLines = allCompletedComponent.render(100);
  assert.match(hiddenChartLines.join("\n"), /✓ all tasks complete/);
  assert.doesNotMatch(hiddenChartLines.join("\n"), /[┤┼█]/, "Cockpit can hide an already-rendered terminal advance chart");
  setTodoDurationChartEnabled(true);
  for (let width = 1; width <= 120; width++) {
    for (const line of renderTodoResult({
      content: [{ type: "text", text: "Completed #t14. All tasks completed." }],
      details: { action: "advance", tasks: allCompletedTasks },
    }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "advance", id: "t14" } }).render(width)) {
      assert.ok(visibleWidth(line) <= width, `final chart width ${width}: ${line}`);
    }
  }
  const ansiTodoTheme = {
    fg: (_name: string, text: string) => `\x1b[31m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const ansiCompletedLines = renderTodoResult({
    content: [{ type: "text", text: "Completed #t14. All tasks completed." }],
    details: { action: "advance", tasks: allCompletedTasks },
  }, { expanded: false, isPartial: false }, ansiTodoTheme, { args: { action: "advance", id: "t14" } }).render(500);
  assert.ok(ansiCompletedLines.some((line) => line.includes("\x1b[31m█\x1b[0m")), "ANSI-colored bars render without falling back to raw result text");
  assert.ok(ansiCompletedLines.every((line) => visibleWidth(line) <= 500));

  const blockedSummaryLines = renderTodoResult({
    content: [{ type: "text", text: "Blocked task" }],
    details: {
      action: "list",
      tasks: [{ id: "blocked", subject: "Waiting", status: "blocked", blockedBy: ["1", "#upstream"] }],
    },
  }, { expanded: false, isPartial: false }, todoTheme, { args: { action: "list" } }).render(100);
  assert.doesNotMatch(blockedSummaryLines[0], /blocked/, "Todo headers omit blocked counts and member noise");
  assert.match(blockedSummaryLines.join("\n"), /! blocked.*#blocked.*Waiting.*← #1, #upstream/, "blocked rows show dependency IDs once with # sequence labels");

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
  assert.match(source, /Artifact republish is a capability-gated registry mutation/);
  assert.match(source, /fresh inspect-derived CAS fence/);
  assert.match(source, /maestro\\s\+\(\?:run\|session\|execution\|artifact\|ralph\)/);
  assert.match(
    source,
    /pi\.on\("session_start"[\s\S]*?disposeTeammateSessionRegistrations\(\)[\s\S]*?activateTeammateSessionRegistrations\(ctx\)/,
  );
  assert.match(
    source,
    /pi\.on\("session_shutdown"[\s\S]*?await disposeTeammateSessionRegistrations\(\)/,
  );
  assert.match(source, /trackChildBrowserCleanup\(childBrowserBroker\.closeActor\(cid\)\)/);
  assert.match(source, /async function disposeTeammateSessionRegistrations[\s\S]*?await Promise\.all/);
  assert.match(source, /generation !== teammateRegistrationGeneration/);
  assert.match(source, /pi\.events\.on\(TEAMMATE_STARTED_EVENT[\s\S]*?registerTodoActor\(actor\)/);
});

test("teammate tool_result persistence backfills graph task names from progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-tool-result-capture-"));
  try {
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
    registerRootMaestroExtension(api);

    const toolResultHandlers = handlers.get("tool_result") ?? [];
    assert.ok(toolResultHandlers.length > 0, "tool_result hook must be registered");
    const toolResultEvent = {
      type: "tool_result",
      toolName: "teammate",
      details: {
        mode: "graph",
        // Graph SingleResult intentionally carries no name; progress backfills it.
        results: [{ correlationId: "flow-capture-cid", agent: "general", structuredOutput: { ok: true } }],
        progress: [{
          correlationId: "flow-capture-cid",
          name: "flow-graph-task",
          agent: "general",
          status: "completed",
          taskIndex: 0,
          dependencies: [],
        }],
      },
    };
    for (const handler of toolResultHandlers) {
      try {
        await handler(toolResultEvent, { cwd: root });
      } catch {
        // Unrelated tool_result hooks may require their subsystem's full ctx.
      }
    }
    // Persistence is fire-and-forget inside the hook; wait elastically for the
    // record instead of racing a fixed sleep against the loaded event loop.
    const deadline = Date.now() + 5_000;
    let record: Awaited<ReturnType<typeof readAgentOutput>> | undefined;
    for (;;) {
      try {
        record = await readAgentOutput("flow-graph-task", root);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(record.correlationId, "flow-capture-cid");
    assert.deepEqual(record.output, { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("teammate complete event listener persists background structured results", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-complete-capture-"));
  try {
    const tools: ToolDefinition[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const api = new Proxy({} as ExtensionAPI, {
      get(_target, property) {
        if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); };
        if (property === "events") return {
          on: (event: string, handler: (...args: unknown[]) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
          },
          emit: () => undefined,
        };
        if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        };
        return () => undefined;
      },
    });
    registerRootMaestroExtension(api);

    // GUI forwarder + persistence listener both subscribe to the completion event.
    const completeHandlers = handlers.get("teammate:complete") ?? [];
    assert.ok(completeHandlers.length >= 2, "completion event must have a persistence listener");

    // Completion results carry their originating workspace explicitly; empty
    // background acknowledgements no longer establish a separate cwd binding.
    for (const handler of completeHandlers) {
      await handler({
        correlationId: "flow-bg-cid",
        agent: "general",
        exitCode: 0,
        durationMs: 5,
        structuredResults: [{
          correlationId: "flow-bg-cid",
          name: "flow-bg-task",
          agent: "general",
          originCwd: root,
          structuredOutput: { bg: true },
        }],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const record = await readAgentOutput("flow-bg-task", root);
    assert.equal(record.correlationId, "flow-bg-cid");
    assert.deepEqual(record.output, { bg: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("teammate child registers interaction, local Bash, and parent-permission surfaces", async () => {
  const tools: ToolDefinition[] = [];
  const active: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      if (property === "registerTool") return (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); };
      if (property === "getActiveTools") return () => [...active];
      if (property === "setActiveTools") return (names: string[]) => { active.splice(0, active.length, ...names); };
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

  assert.deepEqual(
    tools.map((tool) => tool.name),
    MAESTRO_CHILD_TOOL_NAMES.filter((name) => name !== "compact_history" && name !== "new_context"),
  );
  assert.equal(tools.some((tool) => tool.name === "compact_history"), false);
  assert.equal(tools.some((tool) => tool.name === "new_context"), false);
  const childTodo = tools.find((tool) => tool.name === "todo");
  assert.match(childTodo?.description ?? "", /immediately finish it with `todo advance`/);
  assert.match(JSON.stringify(childTodo?.parameters), /advance/);
  const childTodoGuidelines = childTodo?.promptGuidelines?.join("\n") ?? "";
  assert.match(childTodoGuidelines, /immediately when your active task finishes/);
  assert.match(childTodoGuidelines, /never defer several completions until your final answer/);
  assert.match(childTodoGuidelines, /actor-scoped/);
  assert.match(childTodoGuidelines, /\[context-pressure-advisory\]/);
  assert.match(childTodoGuidelines, /task activated in that same result/);
  assert.match(childTodoGuidelines, /standalone new_context tool/);
  assert.match(childTodoGuidelines, /cannot change the completed advance retroactively/);
  assert.match(childTodoGuidelines, /critical means do not reset/);
  const workflowMirrorSkill = readFileSync(join(import.meta.dirname, "../../../.pi/skills/maestro/SKILL.md"), "utf8");
  assert.match(workflowMirrorSkill, /Advance only with `todo\(\{ action: "next" \}\)`/);
  assert.deepEqual([...handlers.keys()], [
    "tool_result",
    "session_shutdown",
    "session_start",
    "before_agent_start",
    "tool_call",
    "context",
    "before_provider_request",
    "agent_end",
    "agent_settled",
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
  ]);
  assert.equal(handlers.get("tool_call")?.length, 2, "compaction guard precedes child permission handling");
  assert.equal(handlers.get("before_agent_start")?.length, 1, "child only uses before_agent_start to sync opt-in compact tools");
  let providerAborts = 0;
  const providerCtx = {
    cwd: "D:/workspace",
    model: { provider: "test", id: "child", contextWindow: 10_000, maxTokens: 4_000 },
    abort() { providerAborts++; },
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {}, notify() {} },
  } as ExtensionContext;
  await handlers.get("context")?.[0]?.({
    type: "context",
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  }, providerCtx);
  const guardedPayload = await handlers.get("before_provider_request")?.[0]?.({
    type: "before_provider_request",
    payload: { max_tokens: 1, thinking: { type: "enabled", budget_tokens: 1024 } },
  }, providerCtx);
  assert.equal(guardedPayload, undefined, "child aborts invalid thinking instead of degrading it");
  assert.equal(providerAborts, 1);
  await handlers.get("session_start")?.[0]?.({ reason: "new" }, providerCtx);
  const structuredOutputDecision = await handlers.get("tool_call")?.[1]?.({
    type: "tool_call",
    toolName: "structured_output",
    toolCallId: "verdict-1",
    input: { pass: false },
  }, {} as ExtensionContext);
  assert.equal(structuredOutputDecision, undefined, "child-local verdicts must not wait for parent permission RPC");

  const childNotifications: string[] = [];
  const childCtx = {
    cwd: "D:/workspace",
    model: { contextWindow: 400_000 },
    abort() {},
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {}, notify(message: string) { childNotifications.push(message); } },
  } as ExtensionContext;
  await handlers.get("context")?.[0]?.({
    type: "context",
    messages: [{
      role: "assistant",
      content: [{ type: "toolCall", id: "critical-call", name: "read", arguments: {} }],
      usage: { input: 398_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 398_000 },
    }, {
      role: "toolResult",
      toolCallId: "critical-call",
      toolName: "read",
      content: [{ type: "text", text: "done" }],
      isError: false,
    }],
  }, childCtx);
  await handlers.get("agent_end")?.[0]?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
  }, childCtx);
  const completedTurnResult = await handlers.get("session_before_compact")?.[0]?.({ reason: "threshold" }, childCtx);
  assert.notDeepEqual(completedTurnResult, { cancel: true }, "exhausted output headroom keeps native ownership");
  assert.ok(
    childNotifications.some((message) => /Native threshold compaction retained/.test(message)),
    "the child explains why native ownership was retained",
  );
  await handlers.get("session_compact")?.[0]?.({}, childCtx);

  await handlers.get("agent_end")?.[0]?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
  }, childCtx);
  const fallbackResult = await handlers.get("session_before_compact")?.[0]?.({
    reason: "threshold",
    customInstructions: NATIVE_FALLBACK_COMPACTION_MARKER,
  }, childCtx);
  assert.notDeepEqual(fallbackResult, { cancel: true }, "child permits the exhausted recovery fallback");

  const endFailureNotifications: string[] = [];
  const endFailureCtx = {
    cwd: "D:/workspace",
    get model() { throw new Error("model lookup failed"); },
    ui: { setStatus() {}, notify(message: string) { endFailureNotifications.push(message); } },
  } as ExtensionContext;
  await assert.doesNotReject(() => handlers.get("agent_end")?.[0]?.({ messages: [] }, endFailureCtx) as Promise<unknown>);
  assert.match(endFailureNotifications[0] ?? "", /Child output-limit compaction failed/);

  const settledFailureNotifications: string[] = [];
  const settledFailureCtx = {
    cwd: "D:/workspace",
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus() { throw new Error("status sink failed"); },
      notify(message: string) { settledFailureNotifications.push(message); },
    },
  } as ExtensionContext;
  await assert.doesNotReject(() => handlers.get("agent_settled")?.[0]?.({}, settledFailureCtx) as Promise<unknown>);
  assert.match(settledFailureNotifications[0] ?? "", /Child settled context compaction failed/);
});

test("intelligence shutdown closes browser entries before the process-owned bridge and contains cleanup failures", async () => {
  const calls: string[] = [];
  await shutdownIntelligenceTools({
    lsp: { async shutdown() { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push("lsp"); } },
    browser: { async closeAll() { calls.push("browser"); throw new Error("close failed"); } },
    bridge: { async shutdown() { calls.push("bridge"); } },
    computerUse: { async shutdown() { calls.push("computer_use"); } },
  }, 100);
  assert.deepEqual([...calls].sort(), ["bridge", "browser", "computer_use", "lsp"]);
  assert.ok(calls.indexOf("bridge") > calls.indexOf("browser"), "owned extension tabs must close before bridge shutdown");
});

function statuslessWorkflowAttachSnapshot(
  executionStatus?: "active" | "paused" | "sealed",
): WorkflowSnapshot {
  const snapshot = workflowAttachSnapshot();
  const executionId = "execution-2";
  snapshot.session = {
    ...snapshot.session!,
    schemaVersion: "session/2.0",
    lifecycleAuthority: "execution-derived",
    sessionId: "session-2",
    intent: "Statusless attachment",
    identityRevision: 2,
    activityRevision: 4,
    currentExecutionId: executionStatus ? executionId : null,
    latestExecutionId: executionStatus ? executionId : null,
    latestCompletedRunId: null,
    archivedAt: null,
    archivedBy: null,
    activeRunId: null,
    chain: [],
  };
  delete (snapshot.session as { status?: string }).status;
  snapshot.canonicalClaim = { activeSessionId: "session-2", status: "valid" };
  snapshot.locator = {
    sessionId: "session-2",
    ...(executionStatus ? { executionId, generation: 2 } : {}),
  };
  snapshot.execution = executionStatus ? {
    schemaVersion: "execution/1.0",
    executionId,
    sessionId: "session-2",
    generation: 2,
    status: executionStatus,
    revision: 3,
    activeRunId: null,
    chain: [],
    decisionPoints: [],
    gatesRef: "gates.json",
    artifactsRef: "artifacts.json",
    evidenceRef: "evidence.json",
    lease: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    sealedAt: executionStatus === "sealed" ? "2026-07-18T01:00:00.000Z" : null,
    sealSummary: executionStatus === "sealed" ? "done" : null,
    finalOutcome: executionStatus === "sealed" ? "done" : null,
  } : undefined;
  return snapshot;
}

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
