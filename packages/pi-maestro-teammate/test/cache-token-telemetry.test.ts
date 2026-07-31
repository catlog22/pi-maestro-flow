import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension, {
  renderAgentStatusWidget,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import { setQuietMode } from "../src/quiet-state.ts";
import type { AgentProgress, Details, SingleResult, Usage } from "../src/shared/types.ts";
import { buildProgressTree, type ProgressPalette } from "../src/tui/progress-tree.ts";
import { renderTeammateResult } from "../src/tui/render.ts";

afterEach(() => setQuietMode(false, "check"));

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

const palette: ProgressPalette = {
  dim: (text) => text,
  accent: (text) => text,
  running: (text) => text,
  success: (text) => text,
  error: (text) => text,
  bold: (text) => text,
};

function cacheUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 900,
    cacheWriteTokens: 300,
    cost: 0,
    turns: 1,
    ...overrides,
  };
}

function singleResult(usage: Usage): SingleResult {
  return {
    agent: "scout",
    task: "inspect",
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage,
    model: "test-model",
    correlationId: "scout-correlation",
    durationMs: 1000,
  };
}

// ---------------------------------------------------------------------------
// End-to-end: child usage events survive to results, snapshots and callbacks
// ---------------------------------------------------------------------------

type RegisteredTeammateTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((result: { details?: Details }) => void) | undefined,
    ctx: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details: Details }>;
};

function createUsageSpawn(usage: Record<string, unknown>): NonNullable<TeammateRuntimeOptions["spawnChildProcess"]> {
  return (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
          usage,
        },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
}

function createRootTool(
  runtimeOptions: TeammateRuntimeOptions,
): RegisteredTeammateTool {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
  // When the suite runs inside a teammate child process the inherited flag
  // would register the child proxy tool instead of the root tool.
  const savedChildFlag = process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_CHILD;
  let teammateTool: RegisteredTeammateTool | undefined;
  const events = { on: () => () => {}, emit() {} };
  const pi = new Proxy({
    events,
    registerTool(tool: RegisteredTeammateTool & { name: string }) {
      if (tool.name === "teammate") teammateTool = tool;
    },
    sendMessage() {},
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI, runtimeOptions);
  } finally {
    if (savedChildFlag === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = savedChildFlag;
  }
  assert.ok(teammateTool);
  return teammateTool;
}

test("nonzero child cache counters propagate to results, progress snapshots and live callbacks", async () => {
  const progressEvents: AgentProgress[] = [];
  const tool = createRootTool({
    spawnChildProcess: createUsageSpawn({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 300,
    }),
    onRunOptionsCreated(options) {
      const original = options.onProgress;
      options.onProgress = (data) => {
        progressEvents.push({ ...data, recentTools: [...data.recentTools] });
        original?.(data);
      };
    },
  });

  const result = await tool.execute(
    "cache-telemetry",
    {
      tasks: [
        { agent: "general", name: "scan", prompt: "report cache usage" },
        { agent: "general", name: "confirm", prompt: "confirm {scan}" },
      ],
      background: false,
    },
    new AbortController().signal,
    undefined,
    {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: { getSessionFile: () => undefined },
    },
  );

  // Final SingleResult usage (pre-existing) plus the new snapshot fields.
  assert.equal(result.details.results.length, 2);
  for (const entry of result.details.results) {
    assert.equal(entry.usage.cacheReadTokens, 900);
    assert.equal(entry.usage.cacheWriteTokens, 300);
  }

  // Graph dispatches publish per-task progress snapshots.
  assert.equal(result.details.progress?.length, 2);
  for (const snapshot of result.details.progress ?? []) {
    assert.equal(snapshot.inputTokens, 100);
    assert.equal(snapshot.outputTokens, 40);
    assert.equal(snapshot.cacheReadTokens, 900, "progress snapshot must carry cache reads");
    assert.equal(snapshot.cacheWriteTokens, 300, "progress snapshot must carry cache writes");
  }

  // Live progress callbacks observed the same counters while running.
  const withCache = progressEvents.filter((event) => (event.cacheReadTokens ?? 0) > 0);
  assert.ok(withCache.length > 0, "expected at least one live progress event with cache counters");
  assert.equal(Math.max(...withCache.map((event) => event.cacheReadTokens ?? 0)), 900);
  assert.equal(Math.max(...withCache.map((event) => event.cacheWriteTokens ?? 0)), 300);
});

// ---------------------------------------------------------------------------
// Rendering: nonzero counters surface, zero counters stay byte-stable
// ---------------------------------------------------------------------------

test("progress tree rows show cache reads/writes only when nonzero", () => {
  const base = {
    agent: "worker",
    correlationId: "worker-1",
    taskIndex: 0,
    dependencies: [],
    status: "completed" as const,
    inputTokens: 100,
    outputTokens: 40,
  };

  const withCache = buildProgressTree(
    [{ ...base, cacheReadTokens: 900, cacheWriteTokens: 300 }],
    palette,
  );
  assert.match(withCache[0].text, /in 100 · out 40 · cache 900r\/300w/);

  const withoutCache = buildProgressTree([{ ...base }], palette);
  assert.doesNotMatch(withoutCache[0].text, /cache/);
  assert.match(withoutCache[0].text, /in 100 · out 40/);
});

test("expanded single result renders cache counters and the read hit ratio", () => {
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: { mode: "single", results: [singleResult(cacheUsage())] },
  }, { expanded: true }, theme as never).render(120);

  const text = rendered.join("\n");
  // hit ratio = 900 / (100 + 900 + 300) = 69%
  assert.match(text, /900cache-read/);
  assert.match(text, /300cache-write/);
  assert.match(text, /69% cache hit/);
});

test("results without cache activity keep the usage line unchanged", () => {
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: { mode: "single", results: [singleResult(cacheUsage({ cacheReadTokens: 0, cacheWriteTokens: 0 }))] },
  }, { expanded: true }, theme as never).render(120);

  const text = rendered.join("\n");
  assert.doesNotMatch(text, /cache/);
  assert.match(text, /100in · 40out · 1 turns/);
});

test("quiet summaries keep cache telemetry next to the token total", () => {
  setQuietMode(true);
  const rendered = renderTeammateResult({
    content: [{ type: "text", text: "done" }],
    details: { mode: "single", results: [singleResult(cacheUsage())] },
  }, { expanded: false }, theme as never).render(160);

  const text = rendered.join("\n");
  assert.match(text, /140 tokens/);
  assert.match(text, /900cache-read/);
  assert.match(text, /300cache-write/);
  assert.match(text, /69% cache hit/);
});

test("child agent lines show cache counters only when reported", () => {
  const child = {
    agent: "helper",
    name: "helper",
    correlationId: "child-1",
    status: "running" as const,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 900,
    cacheWriteTokens: 300,
  };
  const plainChild = { ...child, cacheReadTokens: undefined, cacheWriteTokens: undefined };

  const withCache = renderTeammateResult({
    content: [{ type: "text", text: "" }],
    details: { mode: "single", results: [], childCalls: [child] },
  }, { expanded: true }, theme as never).render(160);
  assert.match(withCache.join("\n"), /in 100 · out 40 · cache 900r\/300w/);

  const withoutCache = renderTeammateResult({
    content: [{ type: "text", text: "" }],
    details: { mode: "single", results: [], childCalls: [plainChild] },
  }, { expanded: true }, theme as never).render(160);
  assert.doesNotMatch(withoutCache.join("\n"), /cache/);
});

test("agent status widget surfaces cache metrics from progress snapshots", () => {
  const now = Date.now();
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now - 5_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "worker",
      name: "worker-live",
      correlationId: "worker-live",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 300,
      tokens: 140,
      lastActivityAt: now,
    }],
  };

  const text = renderAgentStatusWidget([parent], 100, theme).join("\n");
  assert.match(text, /in 100 · out 40 · cache 900r\/300w/);
});
