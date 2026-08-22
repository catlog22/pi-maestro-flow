import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerStructuredOutput from "../src/extension/structured-output.ts";
import registerTeammateExtension, {
  applyAgentRetryState,
  applyAgentResultReadyState,
  buildAgentList,
  buildAgentSelectorRows,
  buildWatchOutput,
  concurrencyWaitWindowMs,
  correlationIdPrefix,
  emitTeammateResultPublished,
  handleProxyRequest,
  handleChildLifecycleEvent,
  renderAgentSelectorPanel,
  renderAgentStatusWidget,
  resolveProxyParentCorrelationId,
  restoreMainOwnershipIfHandbackPending,
  resolveWatchTarget,
  registerForegroundDetach,
  setPersistentUi,
  settleAgent,
  switchConversationSession,
  toStructuredResults,
  waitForTeammate,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import {
  appendDistinctAssistantMessage,
  buildPiArgs,
  createUtf8LineDecoder,
  extractValidatedStructuredOutput,
  normalizeGraphConcurrency,
  resolveVariables,
  runGraph,
  runSingleTeammate,
  sendRpcMessage,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
} from "../src/runs/execution.ts";
import { registerTeammateChildExtension } from "../src/runs/child-extensions.ts";
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
  leaseSelection,
  leaseToken,
  ownsLease,
  requestHandback,
  requestPark,
  restoreMainOwnership,
  sameLeaseSelection,
  sameLeaseToken,
  transitionLeaseIfCurrent,
  transferToMain,
  unwrapLeasedMessage,
  wrapLeasedMessage,
} from "../src/runs/session-handoff.ts";
import { buildProgressTree } from "../src/tui/progress-tree.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import { renderTeammateResult } from "../src/tui/render.ts";
import type {
  ActiveAgent,
  AgentProgress,
  ChildAgentCallSnapshot,
  Details,
  SingleResult,
  TeammateState,
} from "../src/shared/types.ts";
import type { NormalizedTask } from "../src/runs/execution-infra.ts";

type PublicToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Details;
};

type RegisteredTeammateTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((result: PublicToolResult) => void) | undefined,
    ctx: Record<string, unknown>,
  ): Promise<PublicToolResult>;
};

function createScriptedSpawn(
  diagnostic: keyof typeof STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  providerCause: string,
): NonNullable<TeammateRuntimeOptions["spawnChildProcess"]> {
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
      stdout.write(`${JSON.stringify({ type: "error", error: providerCause })}\n`);
      if (diagnostic === "agentEnd") {
        stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
        return;
      }
      if (diagnostic === "close") {
        stdout.end();
        child.emit("close", 0, null);
        return;
      }
      const message = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "provider returned no usable structured value" }],
      };
      stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn_end", message, toolResults: [] })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
}

function createStructuredSpawn(
  values: readonly unknown[],
): NonNullable<TeammateRuntimeOptions["spawnChildProcess"]> {
  let index = 0;
  return (() => {
    const value = values[index++];
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
      stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read" })}\n`);
      if (value !== undefined) {
        stdout.write(`${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "structured-call", name: "structured_output", arguments: value }],
          },
        })}\n`);
        stdout.write(`${JSON.stringify({
          type: "tool_execution_end",
          toolName: "structured_output",
          toolCallId: "structured-call",
          isError: false,
        })}\n`);
      }
      stdout.write(`${JSON.stringify({
        type: "agent_end",
        message: {
          role: "assistant",
          content: value === undefined
            ? [{ type: "text", text: "plain result" }]
            : [],
        },
      })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
}

function createAbortAwareStructuredSpawn(
  values: readonly unknown[],
): NonNullable<TeammateRuntimeOptions["spawnChildProcess"]> {
  let index = 0;
  return (() => {
    const value = values[index++];
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    let killed = false;
    let settled = false;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() {
        if (settled) return true;
        killed = true;
        queueMicrotask(() => child.emit("close", 1, null));
        return true;
      },
    });
    queueMicrotask(() => {
      if (killed) return;
      settled = true;
      if (value !== undefined) {
        stdout.write(`${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "structured-call", name: "structured_output", arguments: value }],
          },
        })}\n`);
        stdout.write(`${JSON.stringify({
          type: "tool_execution_end",
          toolName: "structured_output",
          toolCallId: "structured-call",
          isError: false,
        })}\n`);
      }
      stdout.write(`${JSON.stringify({
        type: "agent_end",
        message: {
          role: "assistant",
          content: value === undefined
            ? [{ type: "text", text: "consumer completed" }]
            : [],
        },
      })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
}

function createRootTool(
  runtimeOptions: TeammateRuntimeOptions,
  sentMessages?: Array<{ customType?: string; content?: string }>,
): RegisteredTeammateTool {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
  let teammateTool: RegisteredTeammateTool | undefined;
  const events = { on: () => () => {}, emit() {} };
  const pi = new Proxy({
    events,
    registerTool(tool: RegisteredTeammateTool & { name: string }) {
      if (tool.name === "teammate") teammateTool = tool;
    },
    sendMessage(message: { customType?: string; content?: string }) {
      sentMessages?.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  registerTeammateExtension(pi as unknown as ExtensionAPI, runtimeOptions);
  assert.ok(teammateTool);
  return teammateTool;
}

function rootToolContext(): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => undefined },
  };
}

function lateProgress(status: AgentProgress["status"] = "running"): AgentProgress {
  const now = Date.now();
  return {
    agent: "general",
    correlationId: "late-progress",
    taskIndex: 0,
    dependencies: [],
    status,
    recentTools: [{ name: "read", status: "running" }],
    toolCount: 1,
    tokens: 1,
    durationMs: 1,
    lastActivityAt: now,
    startedAt: now,
    lastMessage: "late callback",
  };
}

test("UTF-8 line decoding preserves characters split across stdout chunks", () => {
  const decoder = createUtf8LineDecoder();
  const encoded = Buffer.from("压力测试完成\n下一行", "utf8");
  const split = 2;

  assert.deepEqual(decoder.write(encoded.subarray(0, split)), []);
  assert.deepEqual(decoder.write(encoded.subarray(split)), ["压力测试完成"]);
  assert.deepEqual(decoder.end(), ["下一行"]);
});

test("assistant event accumulation ignores duplicate terminal events", () => {
  const messages: Array<{ role: string; content: string }> = [];
  assert.equal(appendDistinctAssistantMessage(messages, "verdict ready"), true);
  assert.equal(appendDistinctAssistantMessage(messages, "verdict ready"), false);
  assert.equal(messages.length, 1);
});

test("assistant structured_output calls provide a schema-validated settlement fallback", () => {
  const schema = {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      reasoning: { type: "string" },
      unmet: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
    },
    required: ["pass", "reasoning", "unmet", "evidence"],
    additionalProperties: false,
  };
  const verdict = { pass: false, reasoning: "clear was not tested", unmet: ["clear"], evidence: ["no clear call"] };
  const event = {
    type: "agent_end",
    message: {
      content: [
        { type: "text", text: "Checking each action." },
        { type: "toolCall", name: "structured_output", arguments: verdict },
      ],
    },
  };

  assert.deepEqual(extractValidatedStructuredOutput(event, schema), verdict);
  assert.equal(extractValidatedStructuredOutput({
    ...event,
    message: { content: [{ type: "toolCall", name: "structured_output", arguments: { ...verdict, pass: "no" } }] },
  }, schema), undefined);
});

test("root and proxy single/graph paths preserve provider cause before every schema settlement diagnostic", async () => {
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const scenarios = Object.entries(STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS) as Array<
    [keyof typeof STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS, string]
  >;

  for (const [diagnostic, expectedSchemaText] of scenarios) {
    for (const mode of ["single", "graph"] as const) {
      for (const publicPath of ["root", "proxy"] as const) {
        const providerCause = `Authentication failed in ${publicPath}/${mode}/${diagnostic}`;
        const runtimeOptions = {
          spawnChildProcess: createScriptedSpawn(diagnostic, providerCause),
          resultReadyGraceMs: 1,
        };
        const params = mode === "single"
          ? { tasks: [{ agent: "general", prompt: "diagnose", outputSchema: schema }], background: false }
          : {
              tasks: [
                { agent: "general", name: "diagnose", prompt: "diagnose", outputSchema: schema },
                { agent: "general", name: "confirm", prompt: "confirm", outputSchema: schema },
              ],
              background: false,
            };
        let result: Awaited<ReturnType<RegisteredTeammateTool["execute"]>>;
        const childStatuses: string[] = [];

        if (publicPath === "root") {
          result = await createRootTool(runtimeOptions).execute(
            `root-${mode}-${diagnostic}`,
            params,
            new AbortController().signal,
            undefined,
            rootToolContext(),
          );
          delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
            Symbol.for("pi-maestro-teammate.root-registry")
          ];
        } else {
          const state: TeammateState = {
            baseCwd: process.cwd(),
            currentSessionId: null,
            activeRuns: new Map(),
            namedAgents: new Map(),
          };
          let replyMessage: {
            result: Awaited<ReturnType<RegisteredTeammateTool["execute"]>>;
          } | undefined;
          await handleProxyRequest(
            new Proxy({ events: { on: () => () => {}, emit() {} }, sendMessage() {} }, {
              get(target, property) {
                if (property in target) return target[property as keyof typeof target];
                return () => {};
              },
            }) as unknown as ExtensionAPI,
            state,
            { tool: "teammate", requestId: `proxy-${mode}-${diagnostic}`, params },
            (message) => { replyMessage = message as typeof replyMessage; },
            undefined,
            [],
            undefined,
            (child) => childStatuses.push(child.status),
            runtimeOptions,
          );
          assert.ok(replyMessage);
          result = replyMessage.result;
        }

        const text = result.content.map((item) => item.text).join("\n");
        assert.equal(result.isError, true, `${publicPath}/${mode}/${diagnostic} must fail closed`);
        assert.ok(
          text.indexOf(providerCause) >= 0 && text.indexOf(providerCause) < text.indexOf("Structured output:"),
          `${publicPath}/${mode}/${diagnostic} must show the provider cause first`,
        );
        assert.match(
          text,
          new RegExp(`Structured output: ${expectedSchemaText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
        assert.equal(result.details?.results.length, mode === "graph" ? 2 : 1);
        assert.equal(result.details?.results[0]?.exitCode, 1);
        if (mode === "graph") assert.equal(result.details?.progress?.[0]?.status, "failed");
        if (publicPath === "proxy") assert.equal(childStatuses.at(-1), "failed");
      }
    }
  }
});

test("runGraph results carry the task name for agent:// persistence", async () => {
  const tasks: NormalizedTask[] = [{
    agent: "general",
    name: "named-producer",
    prompt: "structured",
    outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
  }];
  const results = await runGraph(tasks, 1, {
    baseCwd: process.cwd(),
    spawnChildProcess: createStructuredSpawn([{ value: 3 }]),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "named-producer");
  assert.deepEqual(results[0].structuredOutput, { value: 3 });
});

test("runGraph forwards briefing into the child task prompt", async () => {
  let stdin = "";
  const baseSpawn = createStructuredSpawn([undefined]);
  const spawn = ((...args: Parameters<typeof baseSpawn>) => {
    const child = baseSpawn(...args);
    child.stdin?.on("data", (chunk) => {
      stdin += String(chunk);
    });
    return child;
  }) as typeof baseSpawn;
  const tasks: NormalizedTask[] = [{
    agent: "general",
    prompt: "review the module",
    briefing: ["agent://parent-result", "file:docs/contract.md", "keep compatibility"],
  }];

  const results = await runGraph(tasks, 1, {
    baseCwd: process.cwd(),
    spawnChildProcess: spawn,
  });

  assert.equal(results[0]?.exitCode, 0);
  assert.match(stdin, /review the module/);
  assert.match(stdin, /## Briefing/);
  assert.match(stdin, /\[agent\] agent:\/\/parent-result/);
  assert.match(stdin, /\[file\] docs\/contract\.md/);
  assert.match(stdin, /\[text\] keep compatibility/);
});

test("runGraph rejects a dependent prompt that resolves to empty text", async () => {
  let spawns = 0;
  const baseSpawn = createStructuredSpawn([{ value: "" }]);
  const spawn = ((...args: Parameters<typeof baseSpawn>) => {
    spawns += 1;
    return baseSpawn(...args);
  }) as typeof baseSpawn;
  const tasks: NormalizedTask[] = [
    {
      agent: "general",
      name: "producer",
      prompt: "produce empty value",
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    {
      agent: "general",
      name: "consumer",
      prompt: "{producer.value}",
      dependsOn: ["producer"],
    },
  ];

  const results = await runGraph(tasks, 1, {
    baseCwd: process.cwd(),
    spawnChildProcess: spawn,
  });

  assert.equal(spawns, 1, "the dependent must fail before child launch");
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[1].exitCode, 1);
  assert.match(results[1].messages[0].content, /Resolved task prompt requires non-empty text/);
});

test("direct failed runs retain the resolved task cwd without a completion observer", async () => {
  const taskCwd = path.join(process.cwd(), "packages", "pi-maestro-teammate");
  const result = await runSingleTeammate({
    agent: "general",
    task: "fail",
    cwd: taskCwd,
    outputSchema: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
  }, {
    baseCwd: process.cwd(),
    spawnChildProcess: createScriptedSpawn("agentEnd", "provider failed"),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.originCwd, taskCwd);
});

test("runGraph awaits result publication before releasing a dependent", async () => {
  const taskCwd = path.join(process.cwd(), "packages", "pi-maestro-teammate");
  const tasks: NormalizedTask[] = [
    {
      agent: "general",
      name: "producer",
      prompt: "produce",
      cwd: taskCwd,
      outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
    },
    {
      agent: "general",
      name: "consumer",
      prompt: "consume {producer.value}",
      cwd: taskCwd,
      outputSchema: { type: "object", properties: { seen: { type: "integer" } }, required: ["seen"], additionalProperties: false },
    },
  ];
  const baseSpawn = createStructuredSpawn([{ value: 7 }, { seen: 7 }]);
  const childStarts: boolean[] = [];
  const publicationCwds: string[] = [];
  let producerPersisted = false;
  const spawn = ((...args: Parameters<typeof baseSpawn>) => {
    childStarts.push(producerPersisted);
    return baseSpawn(...args);
  }) as typeof baseSpawn;

  const results = await runGraph(tasks, 2, {
    baseCwd: process.cwd(),
    spawnChildProcess: spawn,
    onResultPublished: async (result, originCwd) => {
      publicationCwds.push(originCwd);
      if (result.name !== "producer") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      producerPersisted = true;
    },
  });

  assert.deepEqual(childStarts, [false, true]);
  assert.deepEqual(publicationCwds, [taskCwd, taskCwd]);
  assert.equal(results[0].originCwd, taskCwd);
  assert.equal(results[1].originCwd, taskCwd);
  assert.ok(results[0].publicationId);
  assert.ok(results[1].publicationId);
  assert.notEqual(results[0].publicationId, results[1].publicationId);
  assert.deepEqual(
    toStructuredResults(results, process.cwd())?.map((entry) => ({
      publicationId: entry.publicationId,
      originCwd: entry.originCwd,
    })),
    results.map((result) => ({
      publicationId: result.publicationId,
      originCwd: taskCwd,
    })),
  );
  assert.deepEqual(results[1].structuredOutput, { seen: 7 });
});

test("publication observer failures stay non-fatal and are visible", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const results = await runGraph([{
      agent: "general",
      name: "producer",
      prompt: "produce",
      outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
    }], 1, {
      baseCwd: process.cwd(),
      spawnChildProcess: createStructuredSpawn([{ value: 9 }]),
      onResultPublished() {
        throw new Error("persistence unavailable");
      },
    });
    assert.equal(results[0].exitCode, 0);
    assert.deepEqual(results[0].structuredOutput, { value: 9 });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => line.includes("persistence unavailable")), warnings.join("\n"));
});

test("result publication waits for synchronously claimed durable work", async () => {
  let durable = false;
  const pi = {
    events: {
      emit(name: string, event: { waitUntil(promise: Promise<unknown>): void }) {
        assert.equal(name, "teammate:result-published");
        event.waitUntil(new Promise<void>((resolve) => {
          setTimeout(() => {
            durable = true;
            resolve();
          }, 10);
        }));
      },
    },
  } as unknown as ExtensionAPI;
  const result: SingleResult = {
    agent: "general",
    name: "producer",
    task: "produce",
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test/model",
    correlationId: "published-result",
    durationMs: 1,
  };

  const publication = emitTeammateResultPublished(pi, result, process.cwd());
  assert.equal(durable, false);
  await publication;
  assert.equal(durable, true);
});

test("result publication drains claimed work when an event listener throws", async () => {
  let durable = false;
  const pi = {
    events: {
      emit(_name: string, event: { waitUntil(promise: Promise<unknown>): void }) {
        event.waitUntil(new Promise<void>((resolve) => {
          setTimeout(() => {
            durable = true;
            resolve();
          }, 10);
        }));
        throw new Error("listener failed");
      },
    },
  } as unknown as ExtensionAPI;
  const result: SingleResult = {
    agent: "general",
    task: "produce",
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test/model",
    correlationId: "published-listener-error",
    durationMs: 1,
  };

  await assert.rejects(
    () => emitTeammateResultPublished(pi, result, process.cwd()),
    /listener failed/,
  );
  assert.equal(durable, true);
});

test("root and proxy expose identical validated structuredOutput projections", async () => {
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const execute = async (
    publicPath: "root" | "proxy",
    params: Record<string, unknown>,
    values: readonly unknown[],
  ) => {
    const runtimeOptions = { spawnChildProcess: createStructuredSpawn(values) };
    if (publicPath === "root") {
      const result = await createRootTool(runtimeOptions).execute(
        `structured-${publicPath}`,
        params,
        new AbortController().signal,
        undefined,
        rootToolContext(),
      );
      delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
        Symbol.for("pi-maestro-teammate.root-registry")
      ];
      return result;
    }

    const state: TeammateState = {
      baseCwd: process.cwd(),
      currentSessionId: null,
      activeRuns: new Map(),
      namedAgents: new Map(),
    };
    let replyMessage: {
      result: Awaited<ReturnType<RegisteredTeammateTool["execute"]>>;
    } | undefined;
    await handleProxyRequest(
      new Proxy({ events: { on: () => () => {}, emit() {} }, sendMessage() {} }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => {};
        },
      }) as unknown as ExtensionAPI,
      state,
      { tool: "teammate", requestId: `structured-${publicPath}`, params },
      (message) => { replyMessage = message as typeof replyMessage; },
      undefined,
      [],
      undefined,
      undefined,
      runtimeOptions,
    );
    assert.ok(replyMessage);
    return replyMessage.result;
  };

  for (const publicPath of ["root", "proxy"] as const) {
    const single = await execute(
      publicPath,
      { tasks: [{ agent: "general", prompt: "single", outputSchema: schema }], background: false },
      [{ value: "single" }],
    );
    assert.deepEqual(single.details?.structuredOutput, { value: "single" });

    const singleOmitted = await execute(
      publicPath,
      { tasks: [{ agent: "general", prompt: "single omitted" }], background: false },
      [undefined],
    );
    assert.equal(Object.hasOwn(singleOmitted.details ?? {}, "structuredOutput"), false);

    const graph = await execute(
      publicPath,
      {
        tasks: [
          { agent: "general", name: "named", prompt: "named", outputSchema: schema },
          { agent: "general", prompt: "indexed", outputSchema: schema },
          { agent: "general", name: "omitted", prompt: "omitted" },
        ],
        concurrency: 1,
        background: false,
      },
      [{ value: "named" }, { value: "indexed" }, undefined],
    );
    assert.deepEqual(graph.details?.structuredOutput, {
      named: { value: "named" },
      "1": { value: "indexed" },
    });

    const graphOmitted = await execute(
      publicPath,
      {
        tasks: [{ agent: "general", name: "omitted", prompt: "omitted" }],
        background: false,
      },
      [undefined],
    );
    assert.equal(Object.hasOwn(graphOmitted.details ?? {}, "structuredOutput"), false);
  }
});

test("structured graph producers do not cancel dependent tasks on root or proxy paths", async () => {
  const schema = {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  };

  for (const publicPath of ["root", "proxy"] as const) {
    for (const reference of ["{producer.value}", "{producer}"] as const) {
      const params = {
        tasks: [
          { agent: "general", name: "producer", prompt: "produce", outputSchema: schema },
          { agent: "general", name: "consumer", prompt: `consume ${reference}` },
        ],
        concurrency: 1,
        background: false,
      };
      const runtimeOptions = {
        spawnChildProcess: createAbortAwareStructuredSpawn([{ value: 3 }, undefined]),
      };
      let result: Awaited<ReturnType<RegisteredTeammateTool["execute"]>>;

      if (publicPath === "root") {
        result = await createRootTool(runtimeOptions).execute(
          `structured-dependency-${reference}`,
          params,
          new AbortController().signal,
          undefined,
          rootToolContext(),
        );
        delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
          Symbol.for("pi-maestro-teammate.root-registry")
        ];
      } else {
        const state: TeammateState = {
          baseCwd: process.cwd(),
          currentSessionId: null,
          activeRuns: new Map(),
          namedAgents: new Map(),
        };
        let replyMessage: {
          result: Awaited<ReturnType<RegisteredTeammateTool["execute"]>>;
        } | undefined;
        await handleProxyRequest(
          new Proxy({ events: { on: () => () => {}, emit() {} }, sendMessage() {} }, {
            get(target, property) {
              if (property in target) return target[property as keyof typeof target];
              return () => {};
            },
          }) as unknown as ExtensionAPI,
          state,
          { tool: "teammate", requestId: `structured-dependency-${reference}`, params },
          (message) => { replyMessage = message as typeof replyMessage; },
          undefined,
          [],
          undefined,
          undefined,
          runtimeOptions,
        );
        assert.ok(replyMessage);
        result = replyMessage.result;
      }

      assert.equal(result.isError, false, `${publicPath} ${reference}`);
      assert.deepEqual(result.details.results.map((entry) => entry.exitCode), [0, 0]);
      assert.deepEqual(result.details.structuredOutput, { producer: { value: 3 } });
      assert.equal(
        result.details.results[1]?.task,
        reference === "{producer.value}" ? "consume 3" : 'consume {"value":3}',
      );
    }
  }
});

test("foreground updates close before every public settlement and reject late callbacks", async () => {
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const cases = [
    { name: "single success", mode: "single", outcome: "success", params: { tasks: [{ agent: "general", prompt: "ok" }] } },
    {
      name: "single failed",
      mode: "single",
      outcome: "failed",
      params: { tasks: [{ agent: "general", prompt: "fail", outputSchema: schema }], background: false },
    },
    { name: "single throw", mode: "single", outcome: "throw", params: { tasks: [{ agent: "general", prompt: "throw" }] } },
    {
      name: "graph success",
      mode: "graph",
      outcome: "success",
      params: {
        tasks: [
          { agent: "general", name: "ok", prompt: "ok" },
          { agent: "general", name: "ok2", prompt: "ok again" },
        ],
        background: false,
      },
    },
    {
      name: "graph failed",
      mode: "graph",
      outcome: "failed",
      params: {
        tasks: [
          { agent: "general", name: "fail", prompt: "fail", outputSchema: schema },
          { agent: "general", name: "fail2", prompt: "fail again", outputSchema: schema },
        ],
        background: false,
      },
    },
    {
      name: "graph throw",
      mode: "graph",
      outcome: "throw",
      params: {
        tasks: [
          { agent: "general", name: "throw", prompt: "throw" },
          { agent: "general", name: "throw2", prompt: "throw again" },
        ],
        background: false,
      },
    },
  ] as const;

  for (const entry of cases) {
    let capturedOptions: Parameters<NonNullable<TeammateRuntimeOptions["onRunOptionsCreated"]>>[0] | undefined;
    const updates: PublicToolResult[] = [];
    const runtimeOptions: TeammateRuntimeOptions = {
      spawnChildProcess: createStructuredSpawn([undefined, undefined]),
      onRunOptionsCreated(options) {
        capturedOptions ??= options;
        if (entry.outcome === "throw") throw new Error(`forced ${entry.name}`);
      },
    };
    const execution = createRootTool(runtimeOptions).execute(
      `settlement-${entry.name}`,
      entry.params,
      new AbortController().signal,
      (update) => updates.push(update),
      rootToolContext(),
    );

    let result: PublicToolResult | undefined;
    if (entry.outcome === "throw") {
      await assert.rejects(execution, new RegExp(`forced ${entry.name}`));
    } else {
      result = await execution;
      assert.ok(updates.length > 0, `${entry.name} must stream before settlement`);
      assert.equal(result.isError, entry.outcome === "failed");
      assert.equal(result.details?.results[0]?.exitCode, entry.outcome === "failed" ? 1 : 0);
      if (entry.mode === "graph" && entry.outcome === "failed") {
        assert.equal(result.details?.progress?.[0]?.status, "failed");
      }
    }

    assert.ok(capturedOptions);
    const settledUpdateCount = updates.length;
    capturedOptions.onProgress?.(lateProgress());
    capturedOptions.onChildRequest?.(
      {
        tool: "teammate",
        requestId: `late-${entry.name}`,
        params: { tasks: [{ agent: "general", prompt: "late" }], background: true },
      },
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(updates.length, settledUpdateCount, `${entry.name} must ignore late callbacks`);
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("shared Alt+B dispatcher uses one listener and detaches owners outermost first", () => {
  let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const ui = {
    onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
      subscriptions += 1;
      terminalInput = handler;
      return () => {
        unsubscriptions += 1;
        if (terminalInput === handler) terminalInput = undefined;
      };
    },
  } as unknown as ExtensionUIContext;

  setPersistentUi(ui);
  try {
    const detached: string[] = [];
    const releaseOuter = registerForegroundDetach(() => detached.push("outer"));
    const releaseNested = registerForegroundDetach(() => detached.push("nested"));

    assert.equal(subscriptions, 1, "all foreground owners must share one TUI listener");
    assert.ok(terminalInput);
    assert.deepEqual(terminalInput("\x1bb"), { consume: true });
    assert.deepEqual(detached, ["outer"]);
    assert.equal(unsubscriptions, 0, "the listener stays installed for the nested owner");

    assert.deepEqual(terminalInput("\x1bb"), { consume: true });
    assert.deepEqual(detached, ["outer", "nested"]);
    assert.equal(unsubscriptions, 1, "the last owner removes the shared listener");

    releaseOuter();
    releaseNested();
    assert.equal(unsubscriptions, 1, "owner unregister must be idempotent after detach");

    const releasePreviousSessionOwner = registerForegroundDetach(() => detached.push("stale"));
    assert.equal(subscriptions, 2);
    assert.ok(terminalInput);
    const previousSessionInput = terminalInput;
    setPersistentUi(ui, true);
    assert.equal(unsubscriptions, 2, "session replacement must remove the previous listener even when UI identity is reused");
    assert.equal(previousSessionInput("\x1bb"), undefined, "a new session must clear previous foreground owners");
    assert.deepEqual(detached, ["outer", "nested"]);
    releasePreviousSessionOwner();

    const releaseShutdownOwner = registerForegroundDetach(() => detached.push("shutdown-stale"));
    assert.equal(subscriptions, 3);
    assert.ok(terminalInput);
    const shutdownInput = terminalInput;
    setPersistentUi(undefined);
    assert.equal(unsubscriptions, 3, "session teardown must remove the shared listener");
    assert.equal(shutdownInput("\x1bb"), undefined, "teardown must clear pending foreground owners");
    assert.deepEqual(detached, ["outer", "nested"]);
    releaseShutdownOwner();
    assert.equal(unsubscriptions, 3, "teardown makes later unregister a no-op");
  } finally {
    setPersistentUi(undefined);
  }
});

test("shared Alt+B dispatcher rolls back owner when terminal listener registration fails", () => {
  let staleDetach = 0;
  let goodDetach = 0;
  let terminalInput: ((data: string) => void) | undefined;
  setPersistentUi({
    onTerminalInput() {
      throw new Error("terminal unavailable");
    },
  } as unknown as ExtensionUIContext);

  assert.throws(
    () => registerForegroundDetach(() => { staleDetach += 1; }),
    /terminal unavailable/,
  );

  setPersistentUi({
    onTerminalInput(handler: (data: string) => void) {
      terminalInput = handler;
      return () => {};
    },
  } as unknown as ExtensionUIContext);
  try {
    const release = registerForegroundDetach(() => { goodDetach += 1; });
    assert.ok(terminalInput);
    terminalInput("\x1bb");
    assert.equal(staleDetach, 0, "failed registration must not leave a stale owner");
    assert.equal(goodDetach, 1);
    release();
  } finally {
    setPersistentUi(undefined);
  }
});

test("foreground listener setup failure starts no work or deadline", async () => {
  let scheduledTimeouts = 0;
  let spawns = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    scheduledTimeouts += 1;
    return realSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  const throwingUi = {
    onTerminalInput() {
      throw new Error("terminal unavailable");
    },
  } as unknown as ExtensionUIContext;
  const spawnChildProcess = (() => {
    spawns += 1;
    throw new Error("foreground work must not start");
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  try {
    for (const taskCount of [1, 2]) {
      const tasks = Array.from({ length: taskCount }, (_, index) => ({
        agent: "general",
        name: `setup-failure-${index}`,
        prompt: `setup failure ${index}`,
      }));
      await assert.rejects(
        createRootTool({ spawnChildProcess }).execute(
          `setup-failure-${taskCount}`,
          { tasks, background: false, timeoutMs: 60_000 },
          new AbortController().signal,
          undefined,
          { ...rootToolContext(), hasUI: true, ui: throwingUi },
        ),
        /terminal unavailable/,
      );
    }

    const state: TeammateState = {
      baseCwd: process.cwd(),
      currentSessionId: null,
      activeRuns: new Map(),
      namedAgents: new Map(),
    };
    const replies: Array<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }> = [];
    setPersistentUi(throwingUi);
    await handleProxyRequest(
      new Proxy({ events: { on: () => () => {}, emit() {} } }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => {};
        },
      }) as unknown as ExtensionAPI,
      state,
      {
        type: "teammate_proxy_request",
        tool: "teammate",
        requestId: "nested-setup-failure",
        params: {
          tasks: [{ agent: "general", name: "nested-setup-failure-agent", prompt: "must not start" }],
          background: false,
        },
      },
      (message) => replies.push(message as typeof replies[number]),
      undefined,
      [],
      undefined,
      undefined,
      { spawnChildProcess },
    );

    assert.equal(spawns, 0, "listener setup must complete before root or nested work starts");
    assert.equal(scheduledTimeouts, 0, "listener setup failure must not retain a foreground deadline");
    assert.equal(state.activeRuns.size, 0, "failed admission must release the active-agent budget slot");
    assert.equal(state.namedAgents.size, 0, "failed admission must release its name binding");
    assert.equal(state.proxyDispatchByRequest?.size ?? 0, 0, "failed admission must release its request mapping");
    assert.equal(state.cancelledProxyDispatches?.size ?? 0, 0, "pre-execution cleanup needs no retained tombstone");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result?.isError, true);
    assert.match(replies[0].result?.content?.[0]?.text ?? "", /terminal unavailable/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    setPersistentUi(undefined);
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("detach and background acknowledgement never publish post-settlement updates", async () => {
  let rootStdout: PassThrough | undefined;
  const hangingSpawn = (() => {
    const child = new EventEmitter() as ChildProcess;
    rootStdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: rootStdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  let capturedOptions: Parameters<NonNullable<TeammateRuntimeOptions["onRunOptionsCreated"]>>[0] | undefined;
  let terminalInput: ((data: string) => void) | undefined;
  let removed = 0;
  const updates: PublicToolResult[] = [];
  const tool = createRootTool({
    spawnChildProcess: hangingSpawn,
    onRunOptionsCreated: (options) => { capturedOptions = options; },
  });
  const execution = tool.execute(
    "detach",
    { tasks: [{ agent: "general", prompt: "detach" }], background: false },
    new AbortController().signal,
    (update) => updates.push(update),
    {
      ...rootToolContext(),
      hasUI: true,
      ui: {
        onTerminalInput(handler: (data: string) => void) {
          terminalInput = handler;
          return () => { removed += 1; };
        },
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(terminalInput);
  terminalInput("\x1bb");
  const detached = await execution;
  assert.match(detached.content[0]?.text ?? "", /detached/);
  assert.equal(removed, 1, "manual detach must remove the shared terminal listener once");
  assert.ok(capturedOptions);
  const detachedCount = updates.length;
  capturedOptions.onProgress?.(lateProgress());
  assert.equal(updates.length, detachedCount);
  rootStdout?.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  setPersistentUi(undefined);
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];

  let backgroundOptions: Parameters<NonNullable<TeammateRuntimeOptions["onRunOptionsCreated"]>>[0] | undefined;
  const backgroundUpdates: PublicToolResult[] = [];
  const background = await createRootTool({
    spawnChildProcess: createStructuredSpawn([undefined]),
    onRunOptionsCreated: (options) => { backgroundOptions = options; },
  }).execute(
    "background",
    { tasks: [{ agent: "general", prompt: "background" }], background: true },
    new AbortController().signal,
    (update) => backgroundUpdates.push(update),
    rootToolContext(),
  );
  assert.match(background.content[0]?.text ?? "", /running in background/);
  assert.ok(backgroundOptions);
  backgroundOptions.onProgress?.(lateProgress());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(backgroundUpdates, []);
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
});

test("foreground timeout moves single and graph dispatches to background without killing children", async () => {
  for (const taskCount of [1, 2]) {
    const stdouts: PassThrough[] = [];
    let killed = 0;
    let removed = 0;
    const sentMessages: Array<{ customType?: string; content?: string }> = [];
    const spawnChildProcess = (() => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      stdouts.push(stdout);
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        connected: false,
        exitCode: null,
        signalCode: null,
        pid: undefined,
        kill() { killed += 1; return true; },
      });
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "reviewing" }] },
        })}\n`);
      });
      return child;
    }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      agent: "general",
      name: `review-${index}`,
      prompt: `review ${index}`,
    }));
    const result = await createRootTool({ spawnChildProcess }, sentMessages).execute(
      `timed-detach-${taskCount}`,
      { tasks, background: false, timeoutMs: 30 },
      new AbortController().signal,
      undefined,
      {
        ...rootToolContext(),
        hasUI: true,
        ui: {
          onTerminalInput() {
            return () => { removed += 1; };
          },
        },
      },
    );

    assert.match(result.content[0]?.text ?? "", /moved to background after 30ms/);
    assert.equal(result.isError, false);
    assert.deepEqual(result.details.results, []);
    assert.equal(stdouts.length, taskCount);
    assert.equal(killed, 0, "foreground timeout must not terminate any child");
    assert.equal(removed, 1, "foreground timeout must remove the shared listener once");

    for (const stdout of stdouts) {
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(killed, 0);
    assert.equal(
      sentMessages.filter((message) => message.customType === "teammate-complete").length,
      1,
      "detached dispatch must publish exactly one completion notification",
    );

    setPersistentUi(undefined);
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("graph concurrencyWaitMs overrides shorter task detach windows without cancellation", async () => {
  const stdouts: PassThrough[] = [];
  let killed = 0;
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    stdouts.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const result = await createRootTool({ spawnChildProcess }, sentMessages).execute(
    "graph-concurrency-wait",
    {
      tasks: [
        { agent: "general", name: "left", prompt: "left", timeoutMs: 5 },
        { agent: "general", name: "right", prompt: "right", timeoutMs: 10 },
      ],
      background: false,
      concurrencyWaitMs: 40,
    },
    new AbortController().signal,
    undefined,
    rootToolContext(),
  );

  assert.match(result.content[0]?.text ?? "", /moved to background after 40ms/);
  assert.equal(result.isError, false);
  assert.equal(stdouts.length, 2);
  assert.equal(killed, 0);

  for (const stdout of stdouts) stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0);
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
});

test("explicit background ignores the foreground timeout window", async () => {
  let stdoutRef: PassThrough | undefined;
  let killed = 0;
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdoutRef = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: stdoutRef,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const result = await createRootTool({ spawnChildProcess }, sentMessages).execute(
    "explicit-background-timeout",
    {
      tasks: [{ agent: "general", name: "background-review", prompt: "review" }],
      background: true,
      timeoutMs: 1,
    },
    new AbortController().signal,
    undefined,
    rootToolContext(),
  );

  assert.match(result.content[0]?.text ?? "", /running in background/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0, "timeoutMs must not apply to explicit background work");

  stdoutRef?.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sentMessages.filter((message) => message.customType === "teammate-complete").length, 1);

  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
});

test("foreground completion removes the shared Alt+B listener for single and graph", async () => {
  for (const taskCount of [1, 2]) {
    let subscriptions = 0;
    let removed = 0;
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      agent: "general",
      name: `complete-${index}`,
      prompt: `complete ${index}`,
    }));
    const result = await createRootTool({
      spawnChildProcess: createStructuredSpawn(Array.from({ length: taskCount }, () => undefined)),
    }).execute(
      `foreground-complete-${taskCount}`,
      { tasks, background: false, timeoutMs: 60_000 },
      new AbortController().signal,
      undefined,
      {
        ...rootToolContext(),
        hasUI: true,
        ui: {
          onTerminalInput() {
            subscriptions += 1;
            return () => { removed += 1; };
          },
        },
      },
    );

    assert.equal(result.isError, false);
    assert.equal(result.details.results.length, taskCount);
    assert.equal(subscriptions, 1);
    assert.equal(removed, 1, "foreground completion must remove the shared listener once");

    setPersistentUi(undefined);
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("foreground rejection cleans its deadline and terminal listener", async () => {
  for (const taskCount of [1, 2]) {
    let removed = 0;
    const tool = createRootTool({
      onRunOptionsCreated() {
        throw new Error(`forced rejection ${taskCount}`);
      },
    });
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      agent: "general",
      name: `reject-${index}`,
      prompt: `reject ${index}`,
    }));

    await assert.rejects(
      tool.execute(
        `reject-cleanup-${taskCount}`,
        { tasks, background: false, timeoutMs: 60_000 },
        new AbortController().signal,
        undefined,
        {
          ...rootToolContext(),
          hasUI: true,
          ui: {
            onTerminalInput() {
              return () => { removed += 1; };
            },
          },
        },
      ),
      new RegExp(`forced rejection ${taskCount}`),
    );
    // Both single-task and graph foreground paths register (and must clean up)
    // the Alt+B terminal listener.
    assert.equal(removed, 1, "foreground rejection must unregister the terminal listener");

    setPersistentUi(undefined);
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("graph foreground Alt+B detach keeps children running and publishes one background completion", async () => {
  const stdouts: PassThrough[] = [];
  let killed = 0;
  let terminalInput: ((data: string) => void) | undefined;
  let removed = 0;
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    stdouts.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const execution = createRootTool({ spawnChildProcess }, sentMessages).execute(
    "graph-alt-b-detach",
    {
      tasks: [
        { agent: "general", name: "detach-0", prompt: "detach 0" },
        { agent: "general", name: "detach-1", prompt: "detach 1" },
      ],
      background: false,
      timeoutMs: 60_000,
    },
    new AbortController().signal,
    undefined,
    {
      ...rootToolContext(),
      hasUI: true,
      ui: {
        onTerminalInput(handler: (data: string) => void) {
          terminalInput = handler;
          return () => { removed += 1; };
        },
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(terminalInput, "graph foreground must register the Alt+B terminal listener");
  terminalInput("\x1bb");
  const detached = await execution;
  assert.match(detached.content[0]?.text ?? "", /2 tasks \(.*\) detached\./);
  assert.equal(detached.isError, false);
  assert.equal(stdouts.length, 2, "graph must spawn both children");
  assert.equal(killed, 0, "Alt+B detach must not terminate any child");
  assert.equal(removed, 1, "manual graph detach must remove the shared listener once");

  // Children finish in the background; the aggregate publishes exactly one
  // teammate-complete notification.
  for (const stdout of stdouts) {
    const terminal = `${JSON.stringify({ type: "agent_end" })}\n`;
    stdout.write(terminal);
    stdout.write(terminal);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0);
  assert.equal(
    sentMessages.filter((message) => message.customType === "teammate-complete").length,
    1,
    "detached graph dispatch must publish exactly one completion notification",
  );

  setPersistentUi(undefined);
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
});

test("foreground nested dispatch timeout acknowledges background work and preserves the child", async () => {
  let stdoutRef: PassThrough | undefined;
  let killed = 0;
  let removed = 0;
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdoutRef = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: stdoutRef,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    queueMicrotask(() => {
      stdoutRef?.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "nested review" }] },
      })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  let replyMessage: { result: PublicToolResult } | undefined;
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    sendMessage(message: { customType?: string; content?: string }) {
      sentMessages.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;

  setPersistentUi({
    onTerminalInput() {
      return () => { removed += 1; };
    },
  } as unknown as ExtensionUIContext);

  await handleProxyRequest(
    pi,
    state,
    {
      tool: "teammate",
      requestId: "nested-timeout",
      params: {
        tasks: [{ agent: "general", name: "nested-review", prompt: "review" }],
        background: false,
        timeoutMs: 30,
      },
    },
    (message) => { replyMessage = message as typeof replyMessage; },
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess },
  );

  assert.ok(replyMessage);
  assert.match(replyMessage.result.content[0]?.text ?? "", /moved to background after 30ms/);
  assert.equal(killed, 0);
  assert.equal(removed, 1, "nested timeout must remove the shared listener once");
  stdoutRef?.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0);
  assert.equal(sentMessages.filter((message) => message.customType === "teammate-complete").length, 1);
  setPersistentUi(undefined);
});

test("nested graph honors concurrencyWaitMs independently from task timeouts", async () => {
  const stdouts: PassThrough[] = [];
  let killed = 0;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    stdouts.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  let replyMessage: { result: PublicToolResult } | undefined;
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    sendMessage() {},
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;

  setPersistentUi({ onTerminalInput: () => () => {} } as unknown as ExtensionUIContext);
  await handleProxyRequest(
    pi,
    state,
    {
      tool: "teammate",
      requestId: "nested-graph-concurrency-wait",
      params: {
        tasks: [
          { agent: "general", name: "left", prompt: "left", timeoutMs: 5 },
          { agent: "general", name: "right", prompt: "right", timeoutMs: 10 },
        ],
        background: false,
        concurrencyWaitMs: 40,
      },
    },
    (message) => { replyMessage = message as typeof replyMessage; },
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess },
  );

  assert.ok(replyMessage);
  assert.match(replyMessage.result.content[0]?.text ?? "", /moved to background after 40ms/);
  assert.equal(stdouts.length, 2);
  assert.equal(killed, 0);
  for (const stdout of stdouts) stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0);
  setPersistentUi(undefined);
});

test("shared Alt+B dispatcher detaches outer owner before nested foreground owner", async () => {
  let stdoutRef: PassThrough | undefined;
  let killed = 0;
  let terminalInput: ((data: string) => void) | undefined;
  let subscriptions = 0;
  let removed = 0;
  let outerDetached = 0;
  let releaseOuter: (() => void) | undefined;
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdoutRef = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: stdoutRef,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed += 1; return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
  let replyMessage: { result: PublicToolResult } | undefined;
  const getReplyMessage = () => replyMessage;
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    sendMessage(message: { customType?: string; content?: string }) {
      sentMessages.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;

  try {
    setPersistentUi({
      onTerminalInput(handler: (data: string) => void) {
        subscriptions += 1;
        terminalInput = handler;
        return () => { removed += 1; };
      },
    } as unknown as ExtensionUIContext);
    releaseOuter = registerForegroundDetach(() => { outerDetached += 1; });

    const request = handleProxyRequest(
      pi,
      state,
      {
        tool: "teammate",
        requestId: "nested-alt-b",
        params: {
          tasks: [{ agent: "general", name: "nested-alt-b-worker", prompt: "review" }],
          background: false,
          timeoutMs: 60_000,
        },
      },
      (message) => { replyMessage = message as typeof replyMessage; },
      undefined,
      [],
      undefined,
      undefined,
      { spawnChildProcess },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(subscriptions, 1, "root and nested owners must share one TUI listener");
    assert.ok(terminalInput);
    terminalInput("\x1bb");
    assert.equal(outerDetached, 1, "the outer foreground owner must detach first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getReplyMessage(), undefined, "nested foreground remains blocked after outer detach");

    terminalInput("\x1bb");
    await request;
    assert.equal(removed, 1, "nested manual detach must remove the shared listener once");
  } finally {
    releaseOuter?.();
    setPersistentUi(undefined);
  }

  const completedReply = getReplyMessage();
  assert.ok(completedReply);
  assert.match(completedReply.result.content[0]?.text ?? "", /detached\./);
  assert.equal(killed, 0, "Alt+B detach must not terminate the nested child");
  const terminal = `${JSON.stringify({ type: "agent_end" })}\n`;
  stdoutRef?.write(terminal);
  stdoutRef?.write(terminal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, 0);
  assert.equal(sentMessages.filter((message) => message.customType === "teammate-complete").length, 1);
});

test("foreground nested proxy updates preserve the two allowed teammate levels", async () => {
  let spawnIndex = 0;
  let rootStdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
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
    if (spawnIndex++ === 0) {
      rootStdout = stdout;
    } else {
      queueMicrotask(() => stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`));
    }
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  let rootOptions: Parameters<NonNullable<TeammateRuntimeOptions["onRunOptionsCreated"]>>[0] | undefined;
  const updates: PublicToolResult[] = [];
  const execution = createRootTool({
    spawnChildProcess,
    onRunOptionsCreated: (options) => { rootOptions ??= options; },
  }).execute(
    "nested-tree",
    {
      tasks: [
        { agent: "general", name: "planner", prompt: "root" },
        { agent: "general", name: "peer", prompt: "peer" },
      ],
      background: false,
    },
    new AbortController().signal,
    (update) => updates.push(update),
    rootToolContext(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(rootOptions);
  rootOptions.onProgress?.({
    ...lateProgress(),
    name: "planner",
    correlationId: rootOptions.taskCorrelationIds?.[0],
  });
  rootOptions.onChildRequest?.(
    {
      tool: "teammate",
      requestId: "child",
      parentCid: rootOptions.taskCorrelationIds?.[0],
      params: { tasks: [{ agent: "general", name: "child", prompt: "child" }], background: false },
    },
    () => {},
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const treeUpdate = updates.findLast((update) => (update.details?.childCalls?.length ?? 0) >= 1);
    assert.ok(treeUpdate);
    const rendered = renderTeammateResult(
      treeUpdate,
      { expanded: false },
      { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
    ).render(120).join("\n");
    assert.match(rendered, /• 1 .*@planner/);
    assert.match(rendered, /  └─ .*@child/);
  } finally {
    rootStdout?.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    const result = await execution;
    assert.ok((result.details?.childCalls?.length ?? 0) >= 1, "terminal details retain nested topology");
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ];
  }
});

test("root and proxy teammate initialization use their own request params", () => {
  const source = fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8");
  const rootStart = source.indexOf("const activeAgent: ActiveAgent = {");
  const rootEnd = source.indexOf("state.activeRuns.set(correlationId, activeAgent);", rootStart);
  assert.ok(rootStart >= 0 && rootEnd > rootStart);

  const rootInitialization = source.slice(rootStart, rootEnd);
  assert.match(rootInitialization, /promptSeq:\s*1/);
  assert.match(rootInitialization, /singleTask\.outputSchema/);
  assert.doesNotMatch(rootInitialization, /\bp\.task\b/);
  assert.equal(rootInitialization.match(/lease:\s*createChildLease\(\)/g)?.length, 1);

  const proxyStart = source.indexOf("const activeAgent: ActiveAgent = {", rootEnd);
  const proxyEnd = source.indexOf("state.activeRuns.set(cid, activeAgent);", proxyStart);
  assert.ok(proxyStart > rootEnd && proxyEnd > proxyStart);

  const proxyInitialization = source.slice(proxyStart, proxyEnd);
  assert.match(proxyInitialization, /promptSeq:\s*1/);
  assert.match(proxyInitialization, /singleTask\.outputSchema/);
  assert.doesNotMatch(proxyInitialization, /promptSeq:\s*params\.task/);
  assert.equal(proxyInitialization.match(/lease:\s*createChildLease\(\)/g)?.length, 1);
});

test("native teammate status widget yields while another surface owns agent display", () => {
  const source = fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8");
  assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_EVENT[\s\S]*?cockpitOwnsAgents = .*?\.agents === true/);
  assert.match(source, /const foregroundToolRuns = new Set<string>\(\)/);
  assert.match(source, /if \(params\.background === false\) \{[\s\S]*?foregroundToolRuns\.add\(correlationId\)[\s\S]*?updateAgentWidget\(\)/);
  assert.match(source, /if \(foregroundToolRuns\.delete\(correlationId\)\) updateAgentWidget\(\)/);
  assert.match(source, /if \(cockpitOwnsAgents \|\| interactivePanelActive \|\| foregroundToolRuns\.size > 0\) \{[\s\S]*?setWidget\("teammate-agents", undefined\)/);
});

test("Alt+R delegates the active Agent or Window session list to Cockpit ownership", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  const events = fs.readFileSync(new URL("../src/shared/cockpit-events.ts", import.meta.url), "utf-8");
  assert.match(events, /COCKPIT_SESSION_LIST_EVENT = "cockpit:open-session-list"/);
  assert.match(source, /registerShortcut\("alt\+r"[\s\S]*?if \(cockpitOwnsSessionList\) \{[\s\S]*?events\.emit\(COCKPIT_SESSION_LIST_EVENT, \{ version: 1 \}\)[\s\S]*?return;[\s\S]*?showAgentSelector\(ctx\)/);
  assert.match(source, /cockpitOwnsAgents = ownership\.agents === true;[\s\S]*?cockpitOwnsSessionList = ownership\.sessionList === true/);
});

test("root and proxy graph normalization share one implementation that preserves thinking", () => {
  const indexSource = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");
  // Orchestration and the Pi subprocess attempt live in sibling modules. A
  // positive assertion names the module that owns the behaviour, so it cannot
  // be satisfied by the other one; a negative assertion reads both, because
  // the pattern must be absent from the whole dispatch path.
  const attemptSource = fs.readFileSync(new URL("../src/runs/pi-subprocess-attempt.ts", import.meta.url), "utf-8");
  const executionSource = fs.readFileSync(new URL("../src/runs/execution.ts", import.meta.url), "utf-8")
    + attemptSource;
  const executionInfraSource = fs.readFileSync(new URL("../src/runs/execution-infra.ts", import.meta.url), "utf-8");

  // The shared normalizer parses task thinking after applying the top-level default.
  assert.match(executionInfraSource, /thinking:\s*parseTeammateThinkingLevel\(task\.thinking \?\? params\.thinking\)/);
  assert.doesNotMatch(executionInfraSource, /params\.chain/);

  // Root and proxy paths both call the shared normalizer; the root process also
  // applies authoritative model routing before normalizing proxied input.
  assert.match(indexSource, /const normalization = normalizeTeammateParams\(params\)/);
  assert.match(indexSource, /const routedParams = applyModelRouting\([\s\S]*?const normalization = normalizeTeammateParams\(routedParams\)/);
  assert.doesNotMatch(indexSource, /thinking:\s*parseTeammateThinkingLevel\(/);
  assert.match(attemptSource, /options\.onChildEvent[\s\S]*?\.\.\.event,\s*\/\/ Lifecycle ownership is assigned by the spawning parent\.\s*correlationId,/);
  assert.doesNotMatch(executionSource, /correlationId: event\.correlationId \?\? correlationId/);

  assert.equal(indexSource.match(/applyModelRouting\(/g)?.length, 2);
});

test("v1 execution entrypoint exposes an explicit stable whitelist", async () => {
  const source = fs.readFileSync(new URL("../src/public/v1/execution.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(source, /export\s+\*/);
  const api = await import("../src/public/v1/execution.ts");
  assert.equal(typeof api.runTeammate, "function");
  assert.equal(typeof api.runGraph, "function");
  assert.equal(typeof api.normalizeTeammateParams, "function");
  assert.equal("writePrivateTextFile" in api, false);
  assert.equal("createChildTerminationController" in api, false);
});

test("child lifecycle commit wins over a later handback failure recovery", () => {
  const source = fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8");
  const handlerStart = source.indexOf("export function handleChildLifecycleEvent(");
  const registrationStart = source.indexOf("export default function registerTeammateExtension(");
  assert.ok(handlerStart >= 0 && handlerStart < registrationStart);
  assert.equal(source.match(/function handleChildLifecycleEvent\(/g)?.length, 1);
  assert.match(source, /onChildEvent: \(event: Record<string, unknown>\) => handleChildLifecycleEvent\(state, event\)/);
  assert.match(source, /onChildEvent: \(childEvent\) => handleChildLifecycleEvent\(state, childEvent\)/);
  assert.doesNotMatch(source, /handleChildLifecycleEvent\(state, \{\s*\.\.\.(?:event|childEvent),\s*correlationId(?:: cid)?,/s);

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifecycle-state-"));
  const sessionFile = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(sessionFile, "{}\n");
  let lease = createChildLease();
  lease = requestPark(lease);
  lease = confirmParked(lease);
  lease = transferToMain(lease);
  lease = requestHandback(lease);
  const correlationId = "lifecycle-agent";
  const controlMessages: Record<string, unknown>[] = [];
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map(),
    activeRuns: new Map([[correlationId, {
      agent: "general",
      correlationId,
      startedAt: Date.now(),
      abortController: new AbortController(),
      sessionDir,
      sessionId: "child-session",
      sessionFile,
      lease,
      pendingHandback: {
        nonce: "return-nonce",
        epoch: lease.epoch,
        sessionId: "child-session",
        sessionFile,
      },
      sendControl(message) {
        controlMessages.push(message);
        return true;
      },
      inbox: [],
      outputLog: [],
      lastActivityAt: Date.now(),
      status: "sleeping",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  try {
    handleChildLifecycleEvent(state, {
      type: "teammate_handoff_returned",
      correlationId,
      nonce: "return-nonce",
      sessionId: "child-session",
      sessionFile,
    });

    const agent = state.activeRuns.get(correlationId);
    assert.ok(agent);
    assert.equal(agent.status, "running");
    assert.equal(agent.pendingHandback, undefined);
    assert.equal(agent.lease?.owner, "child");
    assert.equal(agent.lease?.state, "active");
    assert.equal(controlMessages.length, 1);
    assert.equal(controlMessages[0].type, "teammate_lease_update");
    assert.equal(restoreMainOwnershipIfHandbackPending(agent), undefined);
    assert.equal(agent.lease?.owner, "child");
    assert.equal(agent.lease?.state, "active");
    assert.equal(controlMessages.length, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
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
    assert.throws(
      () => resolveVariables("Check {api}", new Map(), new Set(["api"])),
      /completed without publishing a consumable output/,
    );
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
  const extensionPaths = args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1].replaceAll("\\", "/")] : []);
  assert.ok(extensionPaths.some((extensionPath) => /extension\/index\.ts$/.test(extensionPath)));
  assert.ok(extensionPaths.some((extensionPath) => /extension\/structured-output\.ts$/.test(extensionPath)));
});

test("every teammate child explicitly loads the handoff bridge extension", () => {
  const args = buildPiArgs(
    { tools: ["read"] } as never,
    { agent: "scout" },
    "prompt.md",
  );
  const extensionPaths = args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1].replaceAll("\\", "/")] : []);
  assert.equal(extensionPaths.length, 1);
  assert.match(extensionPaths[0], /extension\/index\.ts$/);
});

test("registered parent extensions and their interaction tools reach every teammate child", () => {
  const dispose = registerTeammateChildExtension("D:\\packages\\pi-maestro-flow\\src\\extension\\index.ts", {
    tools: ["ask-user-question", "bash_bg"],
  });
  try {
    const args = buildPiArgs(
      { tools: ["read"] } as never,
      { agent: "general" },
      "prompt.md",
    );
    const extensionPaths = args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1].replaceAll("\\", "/")] : []);
    assert.equal(extensionPaths.length, 2);
    assert.ok(extensionPaths.some((extensionPath) => extensionPath === "D:/packages/pi-maestro-flow/src/extension/index.ts"));
    const childTools = args[args.indexOf("--tools") + 1];
    assert.match(childTools, /(?:^|,)ask-user-question(?:,|$)/);
    assert.match(childTools, /(?:^|,)bash_bg(?:,|$)/);
  } finally {
    dispose();
  }
});

test("nested teammate-send republishes a running lifecycle when it wakes an agent", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const target = {
    agent: "general",
    name: "worker",
    correlationId: "wake-1",
    spawnedBy: "parent-1",
    startedAt: 50,
    lastActivityAt: 90,
    status: "sleeping",
    sleptAt: 100,
    sleepMs: 25,
    promptSeq: 1,
    stdin: new PassThrough(),
    lease: createChildLease(),
    inbox: [],
    outputLog: [],
    abortController: new AbortController(),
    depth: 1,
  } as ActiveAgent;
  const parent = {
    agent: "general",
    name: "parent",
    correlationId: "parent-1",
    startedAt: 1,
    lastActivityAt: 1,
    status: "running",
    sleepMs: 0,
    inbox: [],
    outputLog: [],
    abortController: new AbortController(),
    depth: 0,
  } as ActiveAgent;
  const state = {
    activeRuns: new Map([
      [parent.correlationId, parent],
      [target.correlationId, target],
    ]),
    namedAgents: new Map([["worker", target.correlationId]]),
  } as TeammateState;
  const pi = {
    events: {
      emit(event: string, payload: Record<string, unknown>) {
        emitted.push({ event, payload });
      },
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  let reply: Record<string, unknown> | undefined;

  await handleProxyRequest(
    pi,
    state,
    {
      tool: "teammate-send",
      requestId: "send-1",
      params: { to: "worker", message: "continue" },
      correlationId: parent.correlationId,
    },
    (message) => { reply = message as Record<string, unknown>; },
    parent.correlationId,
  );

  assert.equal(target.status, "running");
  assert.equal(target.sleepMs >= 85, true);
  assert.equal(target.sleptAt, undefined);
  assert.equal(target.promptSeq, 2);
  assert.equal(emitted.filter(({ event }) => event === "teammate:started").length, 1);
  const messageEvent = emitted.find(({ event }) => event === "teammate:message");
  assert.equal(messageEvent?.payload.correlationId, target.correlationId);
  assert.equal(messageEvent?.payload.mode, "prompt");
  assert.equal(messageEvent?.payload.lastActivityAt, target.lastActivityAt);
  assert.match(JSON.stringify(reply), /queued after current turn/);

  await handleProxyRequest(
    pi,
    state,
    {
      tool: "teammate-send",
      requestId: "send-2",
      params: { to: "worker", message: "more" },
      correlationId: parent.correlationId,
    },
    () => {},
    parent.correlationId,
  );
  assert.equal(
    emitted.filter(({ event }) => event === "teammate:started").length,
    1,
    "messages to an already-running agent must not republish started",
  );
});

test("session ownership handoff fences stale writers and requires reload before child resumes", () => {
  let lease = createChildLease();
  const childEpoch = lease.epoch;
  const childNonce = lease.nonce;
  const staleChild = leaseToken(lease);
  assert.equal(ownsLease(lease, staleChild), true);
  assert.equal(canChildWrite(lease), true);

  lease = requestPark(lease);
  assert.equal(lease.state, "parking");
  assert.equal(cancelPark(lease).state, "active");
  lease = confirmParked(lease);
  assert.equal(lease.state, "parked");
  lease = transferToMain(lease);
  assert.equal(lease.owner, "main");
  assert.equal(lease.epoch, childEpoch + 1);
  assert.notEqual(lease.nonce, childNonce);
  assert.equal(ownsLease(lease, staleChild), false);
  assert.equal(canChildWrite(lease), false);

  const mainToken = leaseToken(lease);
  assert.equal(ownsLease(lease, mainToken), true);
  lease = requestHandback(lease);
  const handbackToken = leaseToken(lease);
  assert.equal(lease.owner, "none");
  assert.equal(lease.state, "reloading");
  assert.equal(lease.epoch, mainToken.epoch + 1);
  assert.notEqual(lease.nonce, mainToken.nonce);
  assert.equal(ownsLease(lease, mainToken), false);
  assert.equal(canChildWrite(lease), false);
  assert.equal(restoreMainOwnership(lease).owner, "main");
  const pendingToken = leaseToken(lease);
  const recoveringAgent = {
    lease,
    pendingHandback: {
      nonce: pendingToken.nonce,
      epoch: pendingToken.epoch,
      sessionId: "child-session",
      sessionFile: "C:/sessions/child.jsonl",
    },
  } as ActiveAgent;
  const restoredToken = restoreMainOwnershipIfHandbackPending(recoveringAgent);
  assert.equal(recoveringAgent.lease?.owner, "main");
  assert.equal(recoveringAgent.lease?.state, "main_active");
  assert.equal(recoveringAgent.pendingHandback, undefined);
  assert.deepEqual(restoredToken, leaseToken(recoveringAgent.lease!));
  assert.equal(ownsLease(lease, mainToken), false);
  lease = confirmChildReloaded(lease);
  assert.equal(lease.owner, "child");
  assert.equal(lease.state, "active");
  assert.equal(lease.epoch, handbackToken.epoch + 1);
  assert.notEqual(lease.nonce, handbackToken.nonce);
  assert.equal(canChildWrite(lease), true);
  assert.equal(ownsLease(lease, handbackToken), false);

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

test("awaited handoff transitions reject stale selections and transition no-ops", async () => {
  let lease = createChildLease();
  const selected = leaseSelection(lease);
  let release!: () => void;
  const boundary = new Promise<void>((resolve) => { release = resolve; });

  const attemptedPark = (async () => {
    await boundary;
    const next = transitionLeaseIfCurrent(lease, selected, requestPark);
    if (next) lease = next;
    return next;
  })();

  lease = fenceLease(lease);
  release();
  assert.equal(await attemptedPark, undefined);
  assert.equal(lease.state, "fenced");
  assert.equal(sameLeaseSelection(lease, selected), false);

  const active = createChildLease();
  const activeSelection = leaseSelection(active);
  assert.equal(transitionLeaseIfCurrent(active, activeSelection, transferToMain), undefined);
  assert.equal(transitionLeaseIfCurrent(active, activeSelection, requestHandback), undefined);
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

test("standalone steer transport preserves the leased RPC command", async () => {
  const stdin = new PassThrough();
  let written = "";
  stdin.on("data", (chunk) => { written += chunk.toString(); });
  const token = leaseToken(createChildLease());

  assert.equal(sendRpcMessage(stdin, "change direction", "steer", token), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const command = JSON.parse(written.trim());
  assert.equal(command.type, "steer");
  assert.deepEqual(unwrapLeasedMessage(command.message), {
    message: "change direction",
    token,
  });
});

test("RPC writes absorb an asynchronous EPIPE from closed child stdin", async () => {
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      queueMicrotask(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    },
  });
  const error = new Promise<Error>((resolve) => stdin.once("error", resolve));

  assert.equal(sendRpcMessage(stdin, "late reply", "follow_up"), true);
  assert.equal((await error as NodeJS.ErrnoException).code, "EPIPE");
  assert.equal(stdin.destroyed, true);
});

test("initial teammate prompt carries the child lease token", async () => {
  const stdin = new PassThrough();
  let written = "";
  stdin.on("data", (chunk) => { written += chunk.toString(); });
  const token = leaseToken(createChildLease());

  assert.equal(sendRpcMessage(stdin, "inspect the project", "prompt", token), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const command = JSON.parse(written.trim());
  assert.equal(command.type, "prompt");
  assert.deepEqual(unwrapLeasedMessage(command.message), {
    message: "inspect the project",
    token,
  });
});

test("parallel graph rows keep independent IDs without implying an agent hierarchy", () => {
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
  assert.match(rows[0].text, /^• 1/);
  assert.match(rows[1].text, /^• 2/);
});

test("graph concurrency is finite, positive, and bounded by task count", () => {
  assert.equal(normalizeGraphConcurrency(2, 5), 2);
  assert.equal(normalizeGraphConcurrency(99, 3), 3);
  assert.equal(normalizeGraphConcurrency(2.9, 5), 2);
  assert.equal(normalizeGraphConcurrency(0, 5), 1);
  assert.equal(normalizeGraphConcurrency(Number.POSITIVE_INFINITY, 5), 1);
  assert.equal(normalizeGraphConcurrency(4, 0), 1);
});

test("agent list prefers attachable physical chain children over duplicate progress rows", () => {
  const now = Date.now();
  const parentId = "parent-chain";
  const childId = "child-scout";
  const childStdin = new PassThrough();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["scan", childId]]),
    activeRuns: new Map([
      [parentId, {
        agent: "graph(1)", correlationId: parentId, startedAt: now,
        abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
        status: "running", depth: 0, sleepMs: 0,
        progress: [{ agent: "scout", name: "scan", correlationId: childId, taskIndex: 0, dependencies: [], status: "running" }],
      }],
      [childId, {
        agent: "scout", name: "scan", correlationId: childId, startedAt: now,
        abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
        spawnedBy: parentId, status: "running", depth: 0, sleepMs: 0, stdin: childStdin,
      }],
    ]),
  };

  const listed = buildAgentList(state, "all").entries.filter((entry) => entry.correlationId === childId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hasStdin, true);
  assert.equal(listed[0].depth, 1);
  assert.equal(resolveWatchTarget(state, "child").match?.kind, "agent");
  assert.equal(resolveWatchTarget(state, "@scan").match?.kind, "agent");
  assert.equal(resolveWatchTarget(state, "@scan#child").match?.kind, "agent");
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
      requestedModel: "maestro-qwen/qwen3.8-max",
      resolvedModel: "qwen3.8-max",
      attemptedModels: ["deepseek/deepseek-v4-pro", "maestro-qwen/qwen3.8-max"],
      status: "sleeping",
      sleptAt: now - 1000,
      depth: 0,
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
        requestedModel: "deepseek/deepseek-v4-pro",
        resolvedModel: "qwen3.8-max",
        attemptedModels: ["deepseek/deepseek-v4-pro", "maestro-qwen/qwen3.8-max"],
        lastMessage: "found /health",
      }],
    }]]),
  };

  const listed = buildAgentList(state, "active");
  assert.match(listed.text, /◉ \[graph\(2\)\].*id=aaaaaaaa.*model=qwen3\.8-max/);
  assert.match(listed.text, /└─ ◉ \[scout\] name="api".*id=11111111.*last=completed.*model=qwen3\.8-max/);
  assert.match(listed.text, /attempted=deepseek\/deepseek-v4-pro,maestro-qwen\/qwen3\.8-max/);

  const resolved = resolveWatchTarget(state, "11111111");
  assert.equal(resolved.match?.kind, "graph-task");
  assert.ok(resolved.match);
  const watched = buildWatchOutput(resolved.match, 20).join("\n");
  assert.match(watched, /Model: qwen3\.8-max \(requested deepseek\/deepseek-v4-pro\)/);
  assert.match(watched, /Attempted models: deepseek\/deepseek-v4-pro, maestro-qwen\/qwen3\.8-max/);
  assert.match(watched, /found \/health/);
  assert.match(watched, /graph is sleeping/);
});

test("teammate-list expands colliding short IDs until watch targets are unambiguous", () => {
  const now = Date.now();
  const firstId = "aaaaaaaa-1111";
  const secondId = "aaaaaaaa-2222";
  const makeAgent = (correlationId: string) => ({
    agent: "explorer",
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
  });
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map(),
    activeRuns: new Map([
      [firstId, makeAgent(firstId)],
      [secondId, makeAgent(secondId)],
    ]),
  };

  assert.equal(correlationIdPrefix(firstId, [firstId, secondId]), "aaaaaaaa-1");
  assert.equal(correlationIdPrefix(secondId, [firstId, secondId]), "aaaaaaaa-2");
  const listed = buildAgentList(state, "all");
  assert.match(listed.text, /id=aaaaaaaa-1/);
  assert.match(listed.text, /id=aaaaaaaa-2/);

  const ambiguous = resolveWatchTarget(state, "aaaaaaaa");
  assert.match(ambiguous.error ?? "", /ambiguous/);
  assert.deepEqual(ambiguous.available.sort(), ["aaaaaaaa-1", "aaaaaaaa-2"]);
  assert.equal(resolveWatchTarget(state, "aaaaaaaa-1").match?.kind, "agent");
});

test("teammate-watch explains provider queueing before first activity", () => {
  const now = Date.now();
  const correlationId = "waiting-model-agent";
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map(),
    activeRuns: new Map([[correlationId, {
      agent: "explorer",
      correlationId,
      startedAt: now,
      abortController: new AbortController(),
      inbox: [],
      outputLog: [],
      lastActivityAt: now,
      status: "running",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  const resolved = resolveWatchTarget(state, correlationId);
  assert.ok(resolved.match);
  assert.match(buildWatchOutput(resolved.match, 20).join("\n"), /Waiting for model capacity or first activity/);
});

test("teammate-wait settles from lifecycle events without polling teammate-watch", async () => {
  const correlationId = "wait-for-completion";
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["worker", correlationId]]),
    activeRuns: new Map([[correlationId, {
      agent: "general",
      name: "worker",
      correlationId,
      startedAt: now,
      abortController: new AbortController(),
      inbox: [],
      outputLog: [],
      lastActivityAt: now,
      status: "running",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  const waiting = waitForTeammate(state, { name: "worker", timeoutMs: 1_000 });
  settleAgent(state, correlationId, 0, "done");
  const result = await waiting;

  assert.equal(result.status, "completed");
  assert.match(result.output.join("\n"), /completed/);
});

test("teammate-wait returns result-ready when Pi has a final answer but agent_end is pending", async () => {
  const correlationId = "wait-for-pi-result-ready";
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["explorer", correlationId]]),
    activeRuns: new Map([[correlationId, {
      agent: "explorer",
      name: "explorer",
      correlationId,
      startedAt: now - 5_000,
      abortController: new AbortController(),
      inbox: [],
      outputLog: ["## Summary\nA useful result was already returned."],
      lastActivityAt: now - 5_000,
      status: "running",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  const waiting = waitForTeammate(state, { name: "explorer", timeoutMs: 1_000 });
  applyAgentResultReadyState(state, { correlationId, resultReadyAt: now });
  const result = await waiting;

  assert.equal(result.status, "result-ready");
  assert.match(result.output.join("\n"), /final no-tool assistant turn/);
  const immediate = await waitForTeammate(state, { name: "explorer" });
  assert.equal(immediate.status, "result-ready");
  assert.match(immediate.output.join("\n"), /useful result/);

  settleAgent(state, correlationId, 0, "A useful result was already returned.");
  const settled = state.activeRuns.get(correlationId);
  assert.equal(settled?.status, "sleeping");
  assert.equal(settled?.resultReadyAt, undefined);
  const plain = (text: string) => text;
  const widget = renderAgentStatusWidget(
    settled ? [settled] : [],
    100,
    { fg: (_name: string, text: string) => text, bold: plain },
  ).join("\n");
  assert.doesNotMatch(widget, /lifecycle pending/);
});

test("teammate-wait returns captured output for an agent that has stalled", async () => {
  const correlationId = "wait-for-stalled-output";
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["explorer", correlationId]]),
    activeRuns: new Map([[correlationId, {
      agent: "explorer",
      name: "explorer",
      correlationId,
      startedAt: now - 60_000,
      abortController: new AbortController(),
      inbox: [],
      outputLog: ["## Summary\nA useful result was already returned."],
      lastActivityAt: now - 30_000,
      status: "running",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  const result = await waitForTeammate(state, { name: "explorer" });

  assert.equal(result.status, "stalled");
  assert.match(result.output.join("\n"), /stopped reporting activity/);
  assert.match(result.output.join("\n"), /useful result/);
});

test("retrying agents remain distinct from sleeping and expose retry metadata", () => {
  const correlationId = "retrying-agent";
  const now = Date.now();
  const agent = {
    agent: "general",
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
  };
  const state: TeammateState = {
    baseCwd: process.cwd(), currentSessionId: null, namedAgents: new Map(),
    activeRuns: new Map([[correlationId, agent]]),
  };

  applyAgentRetryState(state, {
    correlationId, attempt: 2, maxRetries: 10, delayMs: 2_000,
    nextRetryAt: now + 2_000, error: "ECONNRESET",
  });

  assert.equal(agent.status, "retrying");
  const watched = buildWatchOutput({ kind: "agent", agent }, 20).join("\n");
  assert.match(watched, /Retry 2\/10/);
  assert.doesNotMatch(watched, /\[sleeping/);
});

test("nested proxy preserves parentage, graph children, and explicit background semantics", () => {
  const source = fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8");
  assert.equal(source.match(/emitTeammateStarted\(pi, childAgent\)/g)?.length, 2);
  // A graph task child names itself so its siblings stay distinguishable, and
  // that claim is honoured because it resolves inside the spawner's subtree.
  const graphState: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>([
      ["actual-child", { spawnedBy: "root-graph" } as ActiveAgent],
      ["explicit-parent", { spawnedBy: "actual-child" } as ActiveAgent],
      ["stranger", {} as ActiveAgent],
    ]),
    namedAgents: new Map(),
  };
  assert.equal(resolveProxyParentCorrelationId({ correlationId: "actual-child" }, "root-graph", graphState), "actual-child");
  assert.equal(
    resolveProxyParentCorrelationId({ parentCid: "explicit-parent", correlationId: "actual-child" }, "root-graph", graphState),
    "explicit-parent",
  );
  // A claim outside that subtree is a re-parent attempt: it would reset the
  // depth the child's own dispatches are measured against.
  assert.equal(resolveProxyParentCorrelationId({ parentCid: "stranger" }, "root-graph", graphState), "root-graph");
  assert.equal(resolveProxyParentCorrelationId({ parentCid: "never-seen" }, "root-graph", graphState), "root-graph");
  // Without a trusted spawner there is nothing to check the claim against.
  assert.equal(resolveProxyParentCorrelationId({ parentCid: "explicit-parent" }, undefined, graphState), "explicit-parent");
  assert.equal(resolveProxyParentCorrelationId({}, "root-graph", graphState), "root-graph");
  assert.match(source, /spawnedBy: cid,[\s\S]*if \(task\.name\) bindAgentName\(state, task\.name, childId\)/);
  // Every name binding goes through the one helper that reports collisions.
  assert.equal(source.match(/state\.namedAgents\.set\(/g)?.length, 1, "only bindAgentName may write the name map");
  assert.match(source, /normalizedTasks \? \{ taskCorrelationIds \} : \{ correlationId: cid \}/);
  assert.match(source, /if \(routedParams\.background === false\) \{[\s\S]*?createForegroundDeadline\(waitMs\)[\s\S]*?completeNestedInBackground\(nestedPromise\)/);
  assert.doesNotMatch(source, /if \(p\.background === false\)/);
  assert.match(source, /running in background\. \$\{backgroundWaitGuidance\(cid\)\}/);
  assert.match(source, /function backgroundWaitGuidance\(/);
  assert.equal(source.match(/backgroundWaitGuidance\(/g)?.length, 7);
  assert.match(source, /Do not poll observe or teammate-list/);
  assert.match(source, /call observe exactly once/);
  assert.match(source, /handleProxyRequest\([\s\S]*?publishChildCallStatus/);
  // A graph task must not inherit the parent's aggregate log: that showed every
  // sibling's output under whichever task the reader had selected.
  assert.doesNotMatch(source, /outputLog = \[\.\.\.activeAgent\.outputLog\]/);
  assert.match(source, /childStreamingLineIdx/);
  assert.match(source, /childToolLines/);
  assert.match(source, /const deliverNestedCompletion = \(\): void => \{[\s\S]*?reportChildStatus\(terminalStatus === "terminated"/);
  assert.match(source, /reportChildStatus\("running"\)/);
  assert.match(
    source,
    /const publishProxyProgress = \(data: AgentProgress\): void => \{[\s\S]*?pi\.events\.emit\(TEAMMATE_MESSAGE_EVENT,[\s\S]*?progress: currentProgress/,
    "nested progress must reach the shared event bus used by cockpit",
  );
  assert.match(source, /publishProxyProgress\(latest\);[\s\S]*?reportChildStatus/);
  assert.match(source, /progress: currentProgress,[\s\S]*?childCalls: \[\.\.\.childCalls\.values\(\)\]/);
  assert.doesNotMatch(source, /spawned @\$\{p\.name \?\? p\.agent\}/);
});

test("agent selector explains unnamed recursive agents with hierarchy and live detail", () => {
  const now = Date.now();
  const shared = {
    startedAt: now - 5_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    sleepMs: 0,
  };
  const rootId = "aaaaaaaa-root";
  const childId = "bbbbbbbb-child";
  const nestedId = "36180e85-nested";
  const agents = [{
    ...shared,
    agent: "graph(1)",
    correlationId: rootId,
    status: "running" as const,
  }, {
    ...shared,
    agent: "explorer",
    name: "session_architecture",
    correlationId: childId,
    spawnedBy: rootId,
    status: "running" as const,
  }, {
    ...shared,
    agent: "explorer",
    correlationId: nestedId,
    spawnedBy: childId,
    status: "sleeping" as const,
    progress: [{
      agent: "explorer",
      correlationId: nestedId,
      taskIndex: 0,
      dependencies: [],
      status: "completed" as const,
      recentTools: [{ name: "read", status: "completed" }],
      lastMessage: "architecture stream tail",
    }],
  }];

  const rows = buildAgentSelectorRows(agents);
  assert.deepEqual(rows.map((row) => row.label), [
    "graph#aaaaaaaa",
    "session_architecture",
    "unnamed#36180e85",
  ]);
  assert.equal(rows[1].treePrefix, "└─ ");
  assert.equal(rows[2].treePrefix, "   └─ ");
  assert.equal(rows[2].parentLabel, "session_architecture");

  const rendered = renderAgentSelectorPanel(rows, 2, "", 80).join("\n");
  assert.match(rendered, /explorer\/unnamed#36180e85/);
  assert.match(rendered, /child of session_architecture/);
  assert.match(rendered, /Tool.*✓.*read/);
  assert.match(rendered, /architecture stream tail/);
  for (let width = 1; width <= 120; width += 1) {
    for (const line of renderAgentSelectorPanel(rows, 2, "", width)) {
      assert.ok(visibleWidth(line) <= width, `selector overflowed width ${width}: ${line}`);
    }
  }
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
    depth: 0,
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

    const previousRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 60 });
    try {
      const fullscreen = overlay.render(140, 48);
      assert.ok(fullscreen.length > 30);
      assert.ok(fullscreen.length <= 48);
      assert.match(fullscreen.join("\n"), /detail line 20/);
    } finally {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: previousRows });
    }

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

test("agent overlay renders compact horizontal tabs and switches with left/right", () => {
  const now = Date.now();
  const first = {
    agent: "scout", name: "api", correlationId: "aaaaaaaa-api", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "running" as const, depth: 0, sleepMs: 0,
  };
  const second = {
    agent: "builder", name: "ui", correlationId: "bbbbbbbb-ui", startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [], lastActivityAt: now,
    status: "sleeping" as const, depth: 0, sleepMs: 0,
  };
  const activeRuns = new Map<string, ActiveAgent>([
    [first.correlationId, first],
    [second.correlationId, second],
  ]);
  const overlay = new AttachOverlay(first, () => {}, () => activeRuns);
  try {
    // The tab list always leads with the main conversation, so agent tabs
    // start at 2/3.
    const initial = overlay.render(100, 16).join("\n");
    assert.match(initial, /Agents 2\/3/);
    assert.match(initial, /● main/);
    assert.match(initial, /@api/);
    assert.match(initial, /@ui/);

    overlay.handleInput("\x1b[C");
    const next = overlay.render(100, 16).join("\n");
    assert.match(next, /Agents 3\/3/);
    assert.match(next, /builder/);
    assert.match(next, /@ui/);
    assert.match(next, /Sleeping/);

    overlay.handleInput("\x1b[D");
    assert.match(overlay.render(100, 16).join("\n"), /Agents 2\/3/);
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
    depth: 0,
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
  assert.match(full.join("\n"), /@ant-1-1.*↑ 70\.4k tokens.*22 tools.*running.*waiting for model/);
  assert.match(full.join("\n"), /@ant-1-2.*↓ 89\.8k tokens.*18 tools.*running.*writing file/);
  assert.match(full.join("\n"), /@ant-1-4.*streaming/);
  assert.match(full.join("\n"), /@ant-1-3.*waiting for dependencies/);

  for (const width of [1, 8, 12, 19, 20, 40, 80, 120]) {
    const lines = renderAgentStatusWidget([active], width, theme);
    assert.ok(lines.length <= (width < 20 ? 4 : 7));
    for (const line of lines) assert.ok(visibleWidth(line) <= Math.max(1, width));
  }
});

test("persistent agent widget deduplicates graph progress and direct child rows", () => {
  const now = Date.now();
  const childId = "11111111-child";
  const shared = {
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    sleepMs: 0,
  };
  const parent = {
    ...shared,
    agent: "graph(1)",
    correlationId: "aaaaaaaa-parent",
    status: "sleeping" as const,
    progress: [{
      agent: "general",
      name: "pkg-info",
      correlationId: childId,
      taskIndex: 0,
      dependencies: [],
      status: "completed" as const,
      toolCount: 1,
      tokens: 0,
    }],
  };
  const child = {
    ...shared,
    agent: "general",
    name: "pkg-info",
    correlationId: childId,
    spawnedBy: parent.correlationId,
    status: "sleeping" as const,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

  const output = renderAgentStatusWidget([parent, child], 100, theme).join("\n");

  assert.match(output, /Agents  1 sleeping/);
  assert.equal(output.match(/@pkg-info/g)?.length, 1);
  assert.match(output, /@pkg-info.*1 tools.*sleeping/);
});

test("persistent agent widget orders roots and siblings by latest activity without breaking parent-first traversal", () => {
  const makeAgent = (
    correlationId: string,
    name: string,
    lastActivityAt: number,
    spawnedBy?: string,
  ): ActiveAgent => ({
    agent: "general",
    name,
    correlationId,
    startedAt: 1,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt,
    ...(spawnedBy ? { spawnedBy } : {}),
    status: "running",
    depth: 0,
    sleepMs: 0,
  });
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([
    makeAgent("root-old", "root-old", 500),
    makeAgent("root-new", "root-new", 400),
    makeAgent("child-old", "child-old", 100, "root-old"),
    makeAgent("child-new", "child-new", 300, "root-old"),
    makeAgent("grandchild", "grandchild", 900, "child-new"),
  ], 200, theme).join("\n");

  assert.ok(output.indexOf("@root-old") < output.indexOf("@child-new"));
  assert.ok(output.indexOf("@child-new") < output.indexOf("@grandchild"));
  assert.ok(output.indexOf("@grandchild") < output.indexOf("@child-old"));
  assert.ok(output.indexOf("@child-old") < output.indexOf("@root-new"));

  const tied = renderAgentStatusWidget([
    makeAgent("b", "tie-b", 50),
    makeAgent("a", "tie-a", 50),
  ], 200, theme).join("\n");
  assert.ok(tied.indexOf("@tie-a") < tied.indexOf("@tie-b"));
});

test("persistent agent widget distinguishes child agents from result dependencies", () => {
  const now = Date.now();
  const parentId = "parent";
  const writerId = "writer";
  const shared = {
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    sleepMs: 0,
  };
  const parent = {
    ...shared,
    agent: "orchestrator",
    name: "plan",
    correlationId: parentId,
    status: "running" as const,
    progress: [
      { agent: "researcher", name: "research", correlationId: "research", taskIndex: 0, dependencies: [], status: "completed" as const },
      { agent: "writer", name: "write", correlationId: writerId, taskIndex: 1, dependencies: [0], status: "running" as const },
    ],
  };
  const writer = {
    ...shared,
    agent: "writer",
    name: "write",
    correlationId: writerId,
    spawnedBy: parentId,
    status: "running" as const,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

  const output = renderAgentStatusWidget([parent, writer], 120, theme).join("\n");

  assert.match(output, /@write.*child of @plan.*result from @research/);
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
      depth: 0,
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

test("teammate-watch retains the diagnostic for a failed agent", () => {
  const correlationId = "bbbbbbbb-failed";
  const now = Date.now();
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    namedAgents: new Map([["failed-review", correlationId]]),
    activeRuns: new Map([[correlationId, {
      agent: "reviewer",
      name: "failed-review",
      correlationId,
      startedAt: now - 1000,
      abortController: new AbortController(),
      inbox: [],
      outputLog: [],
      lastActivityAt: now - 100,
      status: "running",
      depth: 0,
      sleepMs: 0,
    }]]),
  };

  settleAgent(state, correlationId, 1, "provider failed after fallback exhaustion", false);

  const failed = state.activeRuns.get(correlationId);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.lastResult, "provider failed after fallback exhaustion");
  const resolved = resolveWatchTarget(state, "failed-review");
  assert.equal(resolved.match?.kind, "agent");
  assert.ok(resolved.match);
  const watched = buildWatchOutput(resolved.match, 20).join("\n");
  assert.match(watched, /provider failed after fallback exhaustion/);
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

test("Alt+R opens the native agent view without injecting a slash command", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const events = {
    on(event: string, handler: (payload: unknown) => void) {
      const handlers = eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      return () => handlers.delete(handler);
    },
    emit(event: string, payload: unknown) {
      emittedEvents.push({ event, payload });
      for (const handler of eventHandlers.get(event) ?? []) handler(payload);
    },
  };
  let shortcut: ((ctx: unknown) => Promise<void>) | undefined;
  let modelShortcut: ((ctx: unknown) => Promise<void>) | undefined;
  const sentMessages: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = new Proxy({
    events,
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    registerShortcut(key: string, entry: { handler: (ctx: unknown) => Promise<void> }) {
      if (key === "alt+r") shortcut = entry.handler;
      if (key === "alt+m") modelShortcut = entry.handler;
    },
    sendUserMessage(message: string, options?: { deliverAs?: string }) {
      sentMessages.push({ message, options });
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });

  registerTeammateExtension(pi as unknown as ExtensionAPI);
  // /teammate-session was removed: the session view is now driven by the
  // cockpit session bar (TEAMMATE_OPEN_AGENT_EVENT), not a slash command.
  assert.ok(!commands.has("teammate-session"));
  assert.ok(commands.has("teammate-models"));
  assert.ok(shortcut);
  assert.ok(modelShortcut);
  await shortcut({
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(notifications, [{
    message: "No active teammates. Start one with the teammate tool.",
    level: "warning",
  }]);

  notifications.length = 0;
  events.emit("cockpit:ui-ownership", { agents: false, sessionList: true });
  await shortcut({ ui: { notify() {} } });
  assert.deepEqual(notifications, []);
  assert.deepEqual(
    emittedEvents.filter((entry) => entry.event === "cockpit:open-session-list"),
    [{ event: "cockpit:open-session-list", payload: { version: 1 } }],
  );
});

test("multi-task foreground wait uses its dedicated concurrency window", () => {
  const tasks = [{ timeoutMs: 5_000 }, { timeoutMs: 10_000 }];
  assert.equal(concurrencyWaitWindowMs(tasks, 30_000, 60_000), 30_000);
  assert.equal(
    concurrencyWaitWindowMs(tasks, undefined, 60_000),
    5_000,
    "legacy smallest-task behavior remains the fallback",
  );
  assert.equal(concurrencyWaitWindowMs([{}, {}], undefined, 60_000), 60_000);
});

test("P0a: foreground wait window always resolves to a bounded deadline", () => {
  const source = fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8");

  // The wait-window helper must never return undefined: an undefined value
  // reached createForegroundDeadline as a never-resolving promise, so a
  // foreground call could hang the tool indefinitely instead of detaching.
  assert.match(
    source,
    /function foregroundWaitWindowMs\([\s\S]*?\): number \{/,
    "foregroundWaitWindowMs must have a non-optional number return type",
  );
  assert.match(
    source,
    /return configured\.length > 0\s*\n\s*\?\s*Math\.min\(\.\.\.configured\)\s*\n\s*:\s*\(fallbackMs \?\? TEAMMATE_FOREGROUND_DEFAULT_TIMEOUT_MS\)/,
    "an empty task timeout list must fall back to the bounded default window",
  );

  assert.match(
    source,
    /function concurrencyWaitWindowMs\([\s\S]*?return concurrencyWaitMs \?\? foregroundWaitWindowMs\(tasks, fallbackMs\)/,
    "graph wait override must fall back to the existing bounded detach window",
  );
  assert.equal(
    source.match(/concurrencyWaitWindowMs\(/g)?.length ?? 0,
    3,
    "the helper definition plus root and nested graph call sites must stay connected",
  );

  // The default must exist and be finite.
  assert.match(source, /export const TEAMMATE_FOREGROUND_DEFAULT_TIMEOUT_MS = TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS/);

  // All three foreground call sites (root single, root graph, proxy) pass the
  // resolved window into the deadline constructor.
  assert.equal(
    source.match(/createForegroundDeadline\(waitMs\)/g)?.length ?? 0,
    3,
    "every foreground path must construct its deadline from the resolved waitMs",
  );
});
