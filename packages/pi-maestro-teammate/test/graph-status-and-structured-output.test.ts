import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerStructuredOutput from "../src/extension/structured-output.ts";
import registerTeammateExtension, {
  buildAgentList,
  buildWatchOutput,
  renderAgentStatusWidget,
  resolveWatchTarget,
  switchConversationSession,
} from "../src/extension/index.ts";
import { buildPiArgs, resolveVariables, sendRpcMessage } from "../src/runs/execution.ts";
import {
  confirmChildReloaded,
  confirmParked,
  canChildWrite,
  buildFenceRecoveryMessages,
  cancelPark,
  createChildLease,
  fenceLease,
  handoffBarrierReached,
  isSessionPathContained,
  leaseToken,
  ownsLease,
  requestHandback,
  requestPark,
  restoreMainOwnership,
  sameLeaseToken,
  transferToMain,
  unwrapLeasedMessage,
  wrapLeasedMessage,
} from "../src/runs/session-handoff.ts";
import { buildProgressTree } from "../src/tui/progress-tree.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import { renderTeammateResult } from "../src/tui/render.ts";
import type { SingleResult, TeammateState } from "../src/shared/types.ts";

test("root and proxy teammate initialization use their own request params", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  const rootStart = source.indexOf("const activeAgent: ActiveAgent = {");
  const rootEnd = source.indexOf("state.activeRuns.set(correlationId, activeAgent);", rootStart);
  assert.ok(rootStart >= 0 && rootEnd > rootStart);

  const rootInitialization = source.slice(rootStart, rootEnd);
  assert.match(rootInitialization, /promptSeq:\s*params\.task \? 1 : 0/);
  assert.doesNotMatch(rootInitialization, /\bp\.task\b/);
  assert.equal(rootInitialization.match(/lease:\s*createChildLease\(\)/g)?.length, 1);

  const proxyStart = source.indexOf("const activeAgent: ActiveAgent = {", rootEnd);
  const proxyEnd = source.indexOf("state.activeRuns.set(cid, activeAgent);", proxyStart);
  assert.ok(proxyStart > rootEnd && proxyEnd > proxyStart);

  const proxyInitialization = source.slice(proxyStart, proxyEnd);
  assert.match(proxyInitialization, /promptSeq:\s*p\.task \? 1 : 0/);
  assert.doesNotMatch(proxyInitialization, /promptSeq:\s*params\.task/);
  assert.equal(proxyInitialization.match(/lease:\s*createChildLease\(\)/g)?.length, 1);
});

test("structured_output writes the validated tool payload for field references", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-test-"));
  const schemaPath = path.join(tmpDir, "schema.json");
  const outputPath = path.join(tmpDir, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify({
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    required: ["routes"],
  }));

  const previousSchema = process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH;
  const previousOutput = process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH;
  process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = schemaPath;
  process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = outputPath;

  let registeredTool: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
  const pi = {
    registerTool(tool: typeof registeredTool) {
      registeredTool = tool;
    },
  } as unknown as ExtensionAPI;

  try {
    registerStructuredOutput(pi);
    assert.ok(registeredTool);
    await registeredTool.execute("call-1", { routes: [{ path: "/health" }] });
    const structured = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    assert.deepEqual(structured, { routes: [{ path: "/health" }] });

    const resolved = resolveVariables(
      "Check {api.routes[0].path}",
      new Map([["api", { text: "fallback", structured }]]),
      new Set(["api"]),
    );
    assert.equal(resolved, "Check /health");
  } finally {
    if (previousSchema === undefined) delete process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH;
    else process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = previousSchema;
    if (previousOutput === undefined) delete process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH;
    else process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = previousOutput;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("outputSchema enables the child extension and structured_output tool", () => {
  const args = buildPiArgs(
    { tools: ["read"] } as never,
    { agent: "scout" },
    "prompt.md",
    undefined,
    undefined,
    undefined,
    "schema.json",
  );
  const tools = args[args.indexOf("--tools") + 1];
  assert.match(tools, /structured_output/);
  const extensionPath = args[args.indexOf("--extension") + 1];
  assert.match(extensionPath.replaceAll("\\", "/"), /extension\/structured-output\.ts$/);
});

test("session ownership handoff fences stale writers and requires reload before child resumes", () => {
  let lease = createChildLease();
  const staleChild = leaseToken(lease);
  assert.equal(ownsLease(lease, staleChild), true);

  lease = requestPark(lease);
  assert.equal(lease.state, "parking");
  assert.equal(cancelPark(lease).state, "active");
  lease = confirmParked(lease);
  assert.equal(lease.state, "parked");
  lease = transferToMain(lease);
  assert.equal(lease.owner, "main");
  assert.equal(ownsLease(lease, staleChild), false);

  const mainToken = leaseToken(lease);
  assert.equal(ownsLease(lease, mainToken), true);
  lease = requestHandback(lease);
  assert.equal(lease.state, "reloading");
  assert.equal(restoreMainOwnership(lease).owner, "main");
  assert.equal(ownsLease(lease, mainToken), false);
  lease = confirmChildReloaded(lease);
  assert.equal(lease.owner, "child");
  assert.equal(lease.state, "active");

  const fenced = fenceLease(lease);
  assert.equal(fenced.state, "fenced");
  assert.equal(ownsLease(fenced, leaseToken(fenced)), false);
  assert.equal(canChildWrite(fenced), false);

  const currentToken = leaseToken(lease);
  const wrapped = wrapLeasedMessage("continue", currentToken);
  const decoded = unwrapLeasedMessage(wrapped);
  assert.equal(decoded.message, "continue");
  assert.equal(sameLeaseToken(currentToken, decoded.token), true);
  assert.equal(sameLeaseToken(staleChild, decoded.token), false);
  assert.equal(handoffBarrierReached(1, 0, 2), false);
  assert.equal(handoffBarrierReached(1, 1, 1), false);
  assert.equal(handoffBarrierReached(1, 1, 2), true);
  assert.deepEqual(
    buildFenceRecoveryMessages(fenced, "old-handback-nonce").map((message) => message.type),
    ["teammate_handoff_cancel", "teammate_lease_update"],
  );
});

test("session identity is accepted only inside the canonical child session directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-root-"));
  const childDir = path.join(root, "child");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-outside-"));
  fs.mkdirSync(childDir);
  const inside = path.join(childDir, "session.jsonl");
  const outside = path.join(outsideDir, "session.jsonl");
  fs.writeFileSync(inside, "{}\n");
  fs.writeFileSync(outside, "{}\n");
  try {
    assert.equal(isSessionPathContained(childDir, inside), true);
    assert.equal(isSessionPathContained(childDir, outside), false);
    assert.equal(isSessionPathContained(undefined, inside), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("conversation switch helper invokes the native switchSession replacement path", async () => {
  const calls: string[] = [];
  await switchConversationSession({
    async switchSession(sessionFile, options) {
      calls.push(sessionFile);
      await options?.withSession?.({} as never);
      return { cancelled: false };
    },
  }, "C:/sessions/agent.jsonl", async () => { calls.push("switched"); });
  assert.deepEqual(calls, ["C:/sessions/agent.jsonl", "switched"]);
});

test("idle teammate wake-up uses the RPC prompt command", async () => {
  const stdin = new PassThrough();
  let written = "";
  stdin.on("data", (chunk) => { written += chunk.toString(); });
  assert.equal(sendRpcMessage(stdin, "continue the task", "prompt"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(written.trim()), { type: "prompt", message: "continue the task" });
});

test("parallel graph rows keep independent IDs in the split tree", () => {
  const plain = (text: string) => text;
  const rows = buildProgressTree([
    {
      agent: "scout",
      name: "api",
      correlationId: "11111111-aaaa",
      taskIndex: 0,
      dependencies: [],
      status: "running",
    },
    {
      agent: "scout",
      name: "db",
      correlationId: "22222222-bbbb",
      taskIndex: 1,
      dependencies: [],
      status: "pending",
    },
  ], {
    dim: plain,
    accent: plain,
    running: plain,
    success: plain,
    error: plain,
    bold: plain,
  });

  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /@api.*#11111111/);
  assert.match(rows[1].text, /@db.*#22222222/);
  assert.match(rows[0].text, /├─/);
  assert.match(rows[1].text, /└─/);
});

test("teammate-list expands graph tasks and watch keeps sleeping messages visible", () => {
  const parentId = "aaaaaaaa-parent";
  const taskId = "11111111-child";
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["review", parentId]]),
    activeRuns: new Map([[parentId, {
      agent: "graph(2)",
      name: "review",
      correlationId: parentId,
      startedAt: now - 5000,
      abortController: new AbortController(),
      inbox: [],
      outputLog: [`[10:00:00] @api#11111111 │ found /health`],
      lastActivityAt: now - 1000,
      status: "sleeping",
      sleptAt: now - 1000,
      sleepMs: 0,
      progress: [{
        agent: "scout",
        name: "api",
        correlationId: taskId,
        taskIndex: 0,
        dependencies: [],
        status: "completed",
        startedAt: new Date(now - 4000).toISOString(),
        completedAt: new Date(now - 1500).toISOString(),
        lastMessage: "found /health",
      }],
    }]]),
  };

  const listed = buildAgentList(state, "active");
  assert.match(listed.text, /◉ \[graph\(2\)\].*id=aaaaaaaa/);
  assert.match(listed.text, /└─ ✓ \[scout\] name="api".*id=11111111/);

  const resolved = resolveWatchTarget(state, "11111111");
  assert.equal(resolved.match?.kind, "graph-task");
  assert.ok(resolved.match);
  const watched = buildWatchOutput(resolved.match, 20).join("\n");
  assert.match(watched, /found \/health/);
  assert.match(watched, /graph is sleeping/);
});

test("agent conversation expands in overlay and sends composed messages", async () => {
  const now = Date.now();
  const active = {
    agent: "graph(2)",
    name: "review",
    correlationId: "aaaaaaaa-parent",
    startedAt: now - 5000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    sleepMs: 0,
    progress: [
      {
        agent: "scout",
        name: "api",
        correlationId: "11111111-child",
        taskIndex: 0,
        dependencies: [],
        status: "completed" as const,
        lastMessage: "api complete",
      },
      {
        agent: "builder",
        name: "ui",
        correlationId: "22222222-child",
        taskIndex: 1,
        dependencies: [0],
        status: "running" as const,
        lastMessage: Array.from({ length: 30 }, (_, index) => `live line ${index + 1}`).join("\n"),
      },
    ],
  };
  const sent: Array<{ id: string; message: string }> = [];
  const overlay = new AttachOverlay(
    active,
    () => {},
    undefined,
    async (id, message) => {
      sent.push({ id, message });
      return { ok: true, message: "Queued" };
    },
  );
  try {
    for (const width of [20, 40, 80, 120]) {
      const lines = overlay.render(width, 10);
      assert.ok(lines.length <= 10);
    }
    overlay.handleInput("2");
    const selected = overlay.render(80, 10).join("\n");
    assert.match(selected, /@ui/);
    assert.match(selected, /live line 30/);
    overlay.handleInput("0");
    assert.match(overlay.render(80, 10).join("\n"), /graph\(2\)/);

    for (let index = 1; index <= 20; index++) {
      overlay.appendLog(active.correlationId, `detail line ${index}`, "output");
    }
    const expanded = overlay.render(100, 26);
    assert.ok(expanded.length > 10);
    assert.match(expanded.join("\n"), /detail line 20/);
    assert.match(expanded.join("\n"), /Enter.*message/);

    overlay.handleInput("\r");
    for (const character of "please inspect the failing test") overlay.handleInput(character);
    assert.match(overlay.render(100, 26).join("\n"), /please inspect the failing test/);
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, [{ id: active.correlationId, message: "please inspect the failing test" }]);
  } finally {
    overlay.dispose();
  }
});

test("persistent agent widget renders a bounded below-editor style status list", () => {
  const now = Date.now();
  const active = {
    agent: "graph(5)",
    name: "ants",
    correlationId: "aaaaaaaa-parent",
    startedAt: now - 5000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    sleepMs: 0,
    progress: [
      {
        agent: "ant",
        name: "ant-1-1",
        correlationId: "11111111-child",
        taskIndex: 0,
        dependencies: [],
        status: "running" as const,
        recentTools: [],
        toolCount: 22,
        tokens: 70_400,
      },
      {
        agent: "ant",
        name: "ant-1-2",
        correlationId: "22222222-child",
        taskIndex: 1,
        dependencies: [],
        status: "running" as const,
        recentTools: [{ name: "write", status: "running" }],
        toolCount: 18,
        tokens: 89_800,
      },
      {
        agent: "ant",
        name: "ant-1-3",
        correlationId: "33333333-child",
        taskIndex: 2,
        dependencies: [],
        status: "pending" as const,
        toolCount: 0,
        tokens: 0,
      },
      {
        agent: "ant",
        name: "ant-1-4",
        correlationId: "44444444-child",
        taskIndex: 3,
        dependencies: [],
        status: "running" as const,
        lastMessage: "partial output",
        toolCount: 21,
        tokens: 51_200,
      },
      {
        agent: "ant",
        name: "ant-1-5",
        correlationId: "55555555-child",
        taskIndex: 4,
        dependencies: [],
        status: "failed" as const,
        toolCount: 28,
        tokens: 67_900,
      },
    ],
  };
  const plain = (text: string) => text;
  const theme = { fg: (_name: string, text: string) => text, bold: plain };

  const full = renderAgentStatusWidget([active], 100, theme);
  assert.ok(full.length > 2);
  assert.match(full.join("\n"), /@ant-1-1.*waiting for model.*↑ 70\.4k tokens.*22 tools/);
  assert.match(full.join("\n"), /@ant-1-2.*writing file.*↓ 89\.8k tokens.*18 tools/);
  assert.match(full.join("\n"), /@ant-1-4.*streaming/);
  assert.match(full.join("\n"), /@ant-1-3.*waiting for dependencies/);

  for (const width of [1, 8, 12, 19, 20, 40, 80, 120]) {
    const lines = renderAgentStatusWidget([active], width, theme);
    assert.ok(lines.length <= (width < 20 ? 4 : 7));
    for (const line of lines) assert.ok(visibleWidth(line) <= Math.max(1, width));
  }
});

function makeResult(agent: string, content: string): SingleResult {
  return {
    agent,
    task: "inspect output",
    exitCode: 0,
    messages: [{ role: "assistant", content }],
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      turns: 1,
    },
    model: "test-model",
    correlationId: `${agent}-correlation`,
    durationMs: 1000,
  };
}

test("expanded teammate results keep the complete agent output", () => {
  const plain = (text: string) => text;
  const theme = { fg: (_name: string, text: string) => text, bold: plain };
  const longResult = makeResult(
    "scout",
    Array.from({ length: 30 }, (_, index) => `single line ${index + 1}`).join("\n"),
  );

  const collapsed = renderTeammateResult({
    content: [{ type: "text", text: longResult.messages[0].content }],
    details: { mode: "single", results: [longResult] },
  }, { expanded: false }, theme as never).render(80);
  assert.equal(collapsed.length, 1);

  const expanded = renderTeammateResult({
    content: [{ type: "text", text: longResult.messages[0].content }],
    details: { mode: "single", results: [longResult] },
  }, { expanded: true }, theme as never).render(80).join("\n");
  assert.match(expanded, /single line 1/);
  assert.match(expanded, /single line 30/);
  assert.doesNotMatch(expanded, /more lines/);

  const first = makeResult("api", "api line 1\napi line 2\napi line 3");
  const second = makeResult("ui", "ui line 1\nui line 2\nui line 3");
  const multi = renderTeammateResult({
    content: [{ type: "text", text: "complete" }],
    details: {
      mode: "parallel",
      results: [first, second],
      progress: [
        { agent: "api", name: "api", correlationId: "api", taskIndex: 0, dependencies: [], status: "completed" },
        { agent: "ui", name: "ui", correlationId: "ui", taskIndex: 1, dependencies: [], status: "completed" },
      ],
    },
  }, { expanded: true }, theme as never).render(80).join("\n");
  assert.match(multi, /api line 3/);
  assert.match(multi, /ui line 3/);
});

test("teammate-watch can recover a sleeping agent's complete last result", () => {
  const correlationId = "aaaaaaaa-result";
  const lastResult = Array.from({ length: 30 }, (_, index) => `result line ${index + 1}`).join("\n");
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["review", correlationId]]),
    activeRuns: new Map([[correlationId, {
      agent: "reviewer",
      name: "review",
      correlationId,
      startedAt: now - 5000,
      abortController: new AbortController(),
      inbox: [],
      outputLog: [],
      lastActivityAt: now - 1000,
      status: "sleeping",
      lastResult,
      sleptAt: now - 1000,
      sleepMs: 0,
    }]]),
  };

  const resolved = resolveWatchTarget(state, "review");
  assert.equal(resolved.match?.kind, "agent");
  assert.ok(resolved.match);
  const watched = buildWatchOutput(resolved.match, 100).join("\n");
  assert.match(watched, /--- last result ---/);
  assert.match(watched, /result line 1/);
  assert.match(watched, /result line 30/);
});

test("background completion renderer stays compact but expands to the full result", () => {
  type CompletionRenderer = (
    message: { content: string; details: { mode: "single"; results: SingleResult[] } },
    options: { expanded: boolean },
    theme: { fg: (name: string, text: string) => string; bold: (text: string) => string },
  ) => { render(width: number): string[] };

  const renderers = new Map<string, CompletionRenderer>();
  const events = { on: () => () => {}, emit() {} };
  const pi = new Proxy({ events }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      if (property === "registerMessageRenderer") {
        return (type: string, renderer: CompletionRenderer) => renderers.set(type, renderer);
      }
      return () => {};
    },
  });

  registerTeammateExtension(pi as unknown as ExtensionAPI);
  const renderer = renderers.get("teammate-complete");
  assert.ok(renderer);

  const content = Array.from({ length: 30 }, (_, index) => `background line ${index + 1}`).join("\n");
  const result = makeResult("reviewer", content);
  const message = { content, details: { mode: "single" as const, results: [result] } };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

  const collapsed = renderer(message, { expanded: false }, theme).render(80);
  assert.equal(collapsed.length, 1);
  const expanded = renderer(message, { expanded: true }, theme).render(80).join("\n");
  assert.match(expanded, /background line 30/);
  assert.equal(message.content, content);
});

test("Alt+R routes through the command context required for real session switching", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let shortcut: (() => void) | undefined;
  const sentMessages: string[] = [];
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    registerShortcut(key: string, entry: { handler: () => void }) {
      if (key === "alt+r") shortcut = entry.handler;
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  registerTeammateExtension(pi as unknown as ExtensionAPI);
  assert.ok(commands.has("teammate-session"));
  assert.ok(shortcut);
  shortcut();
  assert.deepEqual(sentMessages, ["/teammate-session"]);
});
