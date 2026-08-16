import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import { resolveBackendConfig } from "pi-maestro-backends";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDshBackend, type DshDriverFactory, type DshHarnessDriver } from "pi-maestro-backends/dsh";

const CONFIG = {
  command: "dsh-jsonrpc-agent",
  cordisConfig: "/etc/dsh/cordis.yml",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  requestTimeoutMs: 300_000,
};

interface FakeDriver extends DshHarnessDriver {
  prompts: string[];
  closed: number;
}

function fakeDriver(overrides: Partial<{
  finalResponse: string;
  events: Record<string, unknown>[];
  fail: Error;
  closeFails: boolean;
}> = {}): FakeDriver {
  const prompts: string[] = [];
  let closed = 0;
  return {
    prompts,
    get closed() { return closed; },
    async run(input) {
      prompts.push(input);
      if (overrides.fail) throw overrides.fail;
      return {
        sessionId: "s-1",
        finalResponse: overrides.finalResponse ?? "SEAM",
        events: overrides.events ?? [{ type: "turn/start" }, { type: "turn/end" }],
      };
    },
    async close() {
      closed += 1;
      if (overrides.closeFails) throw new Error("child would not die");
    },
  } as FakeDriver;
}

function runOptions(config: Record<string, string | number | boolean> = CONFIG): BackendRunOptions {
  return { correlationId: "c-1", baseCwd: "/work", host: {}, config };
}

const SPEC = { agent: "general", task: "do the thing" };

test("dsh declares only the capabilities its SDK actually serves", () => {
  const backend = createDshBackend(async () => fakeDriver());
  assert.equal(backend.capabilities({}).forkContext, "unsupported");
  assert.equal(backend.capabilities({}).thinkingLevel, "unsupported");
  assert.equal(backend.capabilities({}).toolFilter, "unsupported");
  assert.equal(backend.capabilities({}).steer, "unsupported");
  // outputSchema is emulated now that the extraction and validation exist.
  // todoBinding is not stated here at all: it varies per registration, and the
  // case that both settings decide it correctly is its own test below.
  assert.equal(backend.capabilities({}).outputSchema, "emulated");
  assert.equal(backend.capabilities({}).modelSelection, "native");
  assert.equal(backend.capabilities({}).followUp, "native");
});

test("a message arriving after a FAILED run is refused, like one after success", async () => {
  const backend = createDshBackend(async () => fakeDriver({ fail: new Error("stream died") }));
  const run = await backend.start(SPEC, runOptions());
  await run.outcome;
  assert.equal(run.send("too late", "follow_up"), false);
});

test("tool calls from every turn are counted, not just the last", async () => {
  // The follow-up has to arrive while turn 1 is still running, so turn 1 blocks
  // until the test releases it. Queueing after settlement is a different case,
  // covered by the "refused" tests above.
  let turn = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const backend = createDshBackend(async () => ({
    async run() {
      turn += 1;
      if (turn === 1) {
        started();
        await held;
        return { sessionId: "s", finalResponse: "first", events: [{ type: "tool/result" }, { type: "tool/result" }, { type: "tool/result" }] };
      }
      return { sessionId: "s", finalResponse: "second", events: [{ type: "tool/result" }, { type: "turn/end" }] };
    },
    async close() {},
  }));
  const run = await backend.start(SPEC, runOptions());
  await begun;
  assert.equal(run.send("more", "follow_up"), true);
  release();
  const outcome = await run.outcome;
  assert.equal(outcome.result.toolCount, 4);
  assert.equal(outcome.recovery.completedToolCount, 4);
  assert.deepEqual(outcome.result.messages.map((m) => m.content), ["first", "second"]);
});

test("an aborted run settles as terminated even when the close makes the turn reject", async () => {
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const backend = createDshBackend(async () => ({
    async run() {
      started();
      await running;
      throw new Error("client closed");
    },
    async close() { release(); },
  }));
  const run = await backend.start(SPEC, runOptions());
  await begun;
  run.abort();
  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "terminated");
  assert.equal(outcome.result.wakeable, false);
  assert.match(outcome.result.messages[0]!.content, /dsh run aborted/);
});

test("abort plus settlement close the runtime exactly once", async () => {
  let closes = 0;
  const backend = createDshBackend(async () => ({
    async run() { return { sessionId: "s", finalResponse: "ok", events: [{ type: "turn/end" }] }; },
    async close() { closes += 1; },
  }));
  const run = await backend.start(SPEC, runOptions());
  const outcome = await run.outcome;
  run.abort();
  await outcome.reclamation;
  assert.equal(closes, 1);
});

test("dsh recovers in place, so the host replay fence does not gate it", () => {
  assert.equal(createDshBackend(async () => fakeDriver()).recoveryShape, "in-context-continuation");
});

test("the credential field rejects a pasted key instead of storing it", () => {
  const backend = createDshBackend(async () => fakeDriver());
  const resolved = resolveBackendConfig(backend, {
    ...CONFIG,
    apiKeyEnv: "sk-0123456789abcdef",
  });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /names the environment variable holding the key, not the key itself/);
});

test("a conventional variable name is accepted", () => {
  const backend = createDshBackend(async () => fakeDriver());
  assert.deepEqual(resolveBackendConfig(backend, CONFIG).errors, []);
});

test("cordisConfig is required because the runtime has no built-in fallback", () => {
  const backend = createDshBackend(async () => fakeDriver());
  const { cordisConfig: _omitted, ...rest } = CONFIG;
  const resolved = resolveBackendConfig(backend, rest);
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /requires setting "cordisConfig"/);
});

test("a settled turn reports the runtime's own turn-end as authoritative", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const run = await backend.start(SPEC, runOptions());
  const outcome = await run.outcome;
  assert.equal(outcome.result.messages[0]?.content, "SEAM");
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("a turn ending without the runtime's marker is only inferred", async () => {
  const backend = createDshBackend(async () => fakeDriver({ events: [{ type: "turn/start" }] }));
  const outcome = await (await backend.start(SPEC, runOptions())).outcome;
  assert.equal(outcome.recovery.settlementAuthority, "inferred");
});

test("completed tool calls are counted for the host's fence", async () => {
  const backend = createDshBackend(async () => fakeDriver({
    events: [{ type: "tool/result" }, { type: "tool/result" }, { type: "turn/end" }],
  }));
  const outcome = await (await backend.start(SPEC, runOptions())).outcome;
  assert.equal(outcome.result.toolCount, 2);
  assert.equal(outcome.recovery.completedToolCount, 2);
});

test("a transport failure reports its effects as unobserved rather than clean", async () => {
  const backend = createDshBackend(async () => fakeDriver({ fail: new Error("stream died") }));
  const outcome = await (await backend.start(SPEC, runOptions())).outcome;
  assert.equal(outcome.result.terminalStatus, "failed");
  assert.equal(outcome.recovery.settlementAuthority, "unknown");
  assert.equal(outcome.recovery.externalReplayRisk, true);
});

test("a runtime that will not close is reported unreaped, not silently reclaimed", async () => {
  const backend = createDshBackend(async () => fakeDriver({ closeFails: true }));
  const outcome = await (await backend.start(SPEC, runOptions())).outcome;
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.match((reclamation as { reason: string }).reason, /child would not die/);
});

test("steering is refused rather than delivered late under its name", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const run = await backend.start(SPEC, runOptions());
  assert.equal(run.send("stop that", "steer"), false);
  await run.outcome;
});

test("a follow-up arriving mid-turn is answered on the same session", async () => {
  const prompts: string[] = [];
  let releaseFirstTurn!: () => void;
  const firstTurnRunning = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
  let firstTurnStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstTurnStarted = resolve; });

  const backend = createDshBackend(async () => ({
    async run(input) {
      prompts.push(input);
      if (prompts.length === 1) {
        firstTurnStarted();
        await firstTurnRunning;
      }
      return { sessionId: "s", finalResponse: "ok", events: [{ type: "turn/end" }] };
    },
    async close() {},
  }));

  const run = await backend.start(SPEC, runOptions());
  await started;
  assert.equal(run.send("and also this", "follow_up"), true);
  releaseFirstTurn();
  await run.outcome;
  assert.deepEqual(prompts, ["do the thing", "and also this"]);
});

test("a message arriving after settlement is refused, never silently dropped", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const run = await backend.start(SPEC, runOptions());
  await run.outcome;
  assert.equal(run.send("too late", "follow_up"), false);
});

test("the system prompt the host assembled is prepended when supplied", async () => {
  const driver = fakeDriver();
  const backend = createDshBackend(async () => driver);
  await (await backend.start(SPEC, { ...runOptions(), systemPrompt: "You are terse." })).outcome;
  assert.equal(driver.prompts[0], "You are terse.\n\ndo the thing");
});

test("child events reach the host observer", async () => {
  const seen: Record<string, unknown>[] = [];
  const backend = createDshBackend(async () => ({
    async run(_input, options) {
      options.onNotification?.({ method: "session.event", params: { type: "turn/start" } });
      options.onNotification?.({ method: "other.method", params: { ignored: true } });
      return { sessionId: "s", finalResponse: "ok", events: [{ type: "turn/end" }] };
    },
    async close() {},
  }));
  await (await backend.start(SPEC, {
    ...runOptions(),
    onChildEvent: (event) => { seen.push(event); },
  })).outcome;
  assert.deepEqual(seen, [{ type: "turn/start" }]);
});

/** Config for a registration that mounted the bridge. */
const BRIDGED = { ...CONFIG, todoBridge: true };

/** A host that can serve the todo tool, recording what it was asked for. */
function bridgedHost(calls: unknown[] = []): BackendRunOptions["host"] {
  return {
    proxyToolCall: async (request) => {
      calls.push(request);
      return { content: [{ type: "text", text: "[]" }] };
    },
  };
}

/** A driver that reports the per-run variables it was handed. */
function envRecordingDriver(seen: (NodeJS.ProcessEnv | undefined)[]): DshDriverFactory {
  return async (_config, options) => {
    seen.push(options.envExtras);
    return fakeDriver();
  };
}

/** Whether anything still answers on that endpoint's port. */
async function stillListening(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return true;
  } catch {
    // Connection refused is the only outcome that distinguishes a closed
    // endpoint from a live one; a rejected request would still be an answer.
    return false;
  }
}

test("todoBridge decides todoBinding per registration", () => {
  const backend = createDshBackend(async () => fakeDriver());
  assert.equal(backend.capabilities({ todoBridge: true }).todoBinding, "native");
  assert.equal(backend.capabilities({}).todoBinding, "unsupported");
  assert.equal(backend.capabilities({ todoBridge: false }).todoBinding, "unsupported");
});

test("two concurrent bridged attempts each carry their own endpoint URL", async () => {
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const backend = createDshBackend(envRecordingDriver(seen));
  const runs = await Promise.all([
    backend.start(SPEC, { ...runOptions(BRIDGED), correlationId: "a", host: bridgedHost() }),
    backend.start(SPEC, { ...runOptions(BRIDGED), correlationId: "b", host: bridgedHost() }),
  ]);
  await Promise.all(runs.map(async (run) => { await run.outcome; }));

  assert.equal(seen.length, 2);
  const [first, second] = seen.map((extras) => extras?.PI_MAESTRO_TODO_MCP_URL);
  assert.ok(first !== undefined && second !== undefined, "an attempt was told no endpoint");
  // The URL carries the token an attempt acts under, so sharing one would let
  // either attempt act as the other.
  assert.notEqual(first, second);
});

test("a bridged run with no host proxyToolCall refuses to start", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  await assert.rejects(
    backend.start(SPEC, runOptions(BRIDGED)),
    /supplied no proxyToolCall/,
  );
});

test("an unbridged run is given no endpoint at all", async () => {
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const backend = createDshBackend(envRecordingDriver(seen));
  await (await backend.start(SPEC, runOptions())).outcome;
  assert.equal(seen[0]?.PI_MAESTRO_TODO_MCP_URL, undefined);
});

test("the endpoint is closed on both settlement and abort", async () => {
  const settled: (NodeJS.ProcessEnv | undefined)[] = [];
  const settledBackend = createDshBackend(envRecordingDriver(settled));
  const settledRun = await settledBackend.start(SPEC, {
    ...runOptions(BRIDGED),
    host: bridgedHost(),
  });
  const settledOutcome = await settledRun.outcome;
  await settledOutcome.reclamation;
  assert.equal(await stillListening(settled[0]!.PI_MAESTRO_TODO_MCP_URL!), false);

  const aborted: (NodeJS.ProcessEnv | undefined)[] = [];
  const abortedBackend = createDshBackend(envRecordingDriver(aborted));
  const abortedRun = await abortedBackend.start(SPEC, {
    ...runOptions(BRIDGED),
    host: bridgedHost(),
  });
  abortedRun.abort();
  await (await abortedRun.outcome).reclamation;
  assert.equal(await stillListening(aborted[0]!.PI_MAESTRO_TODO_MCP_URL!), false);
});

/** A bridged registration naming a cordis.yml the diagnostic must quote back. */
const PROBE_CORDIS = "/tmp/probe/cordis.yml";
const BRIDGED_PROBE = { ...CONFIG, cordisConfig: PROBE_CORDIS, todoBridge: true };
const WITH_TODOS = { agent: "general", task: "do the thing", todos: ["t1"] };
const MISSING_ENTRY = "add an mcp-client entry with transport: streamable-http, serverName: maestro_todo";

test("a bridged run whose runtime never connected fails with the cordis.yml entry it is missing", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const run = await backend.start(WITH_TODOS, {
    ...runOptions(BRIDGED_PROBE),
    host: bridgedHost(),
  });
  const outcome = await run.outcome;

  assert.equal(outcome.result.terminalStatus, "failed");
  const diagnostic = outcome.result.warnings?.find((warning) => warning.includes(MISSING_ENTRY));
  assert.ok(diagnostic !== undefined, "no warning named the missing cordis.yml entry");
  assert.ok(diagnostic.includes(PROBE_CORDIS), "the diagnostic does not say which cordis.yml");
  // The token in the endpoint URL is what an attempt acts under; a diagnostic
  // reaches logs and transcripts, so it must not carry one.
  assert.equal(diagnostic.includes("token="), false);
  // `messages` is the model transcript. A host diagnostic placed there would
  // read as something the agent said.
  assert.ok(outcome.result.messages.every((message) => !message.content.includes(MISSING_ENTRY)));
});

test("a bridged run whose runtime did connect is not failed by the bridge assertion", async () => {
  // The only handle on this attempt's endpoint is the URL its driver was given,
  // and the assertion is evaluated as soon as the first turn settles — so the
  // handshake has to happen inside the turn, not after `start()` resolves.
  const backend = createDshBackend(async (_config, options) => {
    const url = options.envExtras?.PI_MAESTRO_TODO_MCP_URL;
    assert.ok(url !== undefined, "a bridged run was given no endpoint");
    const driver = fakeDriver();
    return {
      ...driver,
      async run(input: string) {
        const client = new Client({ name: "runtime-stand-in", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        await client.callTool({ name: "todo", arguments: { action: "list" } });
        await client.close();
        return driver.run(input);
      },
    };
  });
  const outcome = await (await backend.start(WITH_TODOS, {
    ...runOptions(BRIDGED_PROBE),
    host: bridgedHost(),
  })).outcome;

  assert.equal(outcome.result.terminalStatus, "completed");
  assert.equal(outcome.result.warnings?.some((warning) => warning.includes(MISSING_ENTRY)) ?? false, false);
});

test("a bridged task carrying no todos never needed the route and is not failed", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const outcome = await (await backend.start(SPEC, {
    ...runOptions(BRIDGED_PROBE),
    host: bridgedHost(),
  })).outcome;
  assert.equal(outcome.result.terminalStatus, "completed");
});

test("an unbridged registration with todos is left to graph validation, not failed here", async () => {
  const backend = createDshBackend(async () => fakeDriver());
  const outcome = await (await backend.start(WITH_TODOS, runOptions())).outcome;
  assert.equal(outcome.result.terminalStatus, "completed");
});
