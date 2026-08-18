/**
 * The dsh backend against a real dsh runtime.
 *
 * Every other dsh test injects a fake driver, so the whole SDK path — process
 * launch, JSON-RPC framing, session reuse across turns, notification delivery,
 * and shutdown — has never been exercised by this package. That gap is exactly
 * where the seam's remaining risk sits: a capability table can be verified by
 * reading, a transport cannot.
 *
 * This file owns the wire-vocabulary assertions. The public name a bridged host
 * tool reaches the model under is decided by the runtime's own mcp-client, so
 * `mcp__` names are asserted here and nowhere else: a fake driver can prove the
 * host-side mapping and never that the runtime publishes what the host expects.
 * The precedent is `completedTools`, which once filtered `tool/end` while the
 * runtime emitted `tool/result` — every unit test green, every real run
 * counting zero.
 *
 * Self-skips unless a runtime is configured, so the ordinary suite stays keyless
 * and offline. Point it at a deployment with:
 *
 *   DSH_E2E_CORDIS=~/.dsh/smoke/cordis.yml \
 *   DSH_E2E_COMMAND=~/.dsh/smoke/node_modules/.bin/dsh-jsonrpc-agent \
 *   node --experimental-transform-types --test test/dsh-runtime.e2e.test.ts
 *
 * The bridged cases need more. `DSH_E2E_CORDIS` must name a deployment whose
 * cordis.yml carries the mcp-client entry from
 * `docs/dsh-todo-bridge-deployment.md`, and the fail-loud case needs
 * `DSH_E2E_CORDIS_NO_BRIDGE` pointing at a copy of that file with the entry
 * removed. That second variable is not optional once the first is set: running
 * only the bridged half is how the bridge-only defect passed review, so the
 * case fails on a missing config rather than skipping past it.
 *
 * The runtime resolves its own credential from its own configuration; this test
 * neither reads nor forwards a key, which is the property the credential
 * boundary claims and the reason it is worth running for real.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import { createDshBackend } from "pi-maestro-backends/dsh";
import { createDshDriver } from "pi-maestro-backends/dsh/driver";
import { TODO_ENDPOINT_ENV, TODO_PUBLIC_TOOL_NAME } from "pi-maestro-backends/dsh/todo-endpoint";

/** Expand a leading `~` so the documented invocation works from a shell. */
function expand(path: string): string {
  return path.startsWith("~/")
    ? resolve(process.env.HOME ?? "", path.slice(2))
    : resolve(path);
}

const cordisConfig = process.env.DSH_E2E_CORDIS === undefined
  ? undefined
  : expand(process.env.DSH_E2E_CORDIS);
const command = process.env.DSH_E2E_COMMAND === undefined
  ? "dsh-jsonrpc-agent"
  : expand(process.env.DSH_E2E_COMMAND);

/** Why this file is skipping, or undefined when it can run. */
const skip = ((): string | undefined => {
  if (cordisConfig === undefined) return "DSH_E2E_CORDIS is unset";
  if (!existsSync(cordisConfig)) return `no runtime config at ${cordisConfig}`;
  return undefined;
})();

const CONFIG = {
  command,
  cordisConfig: cordisConfig ?? "",
  // The turn is a real model call; the default 300s is far more than a one-line
  // answer needs, and a shorter bound turns a hung transport into a test failure
  // instead of a hung suite.
  requestTimeoutMs: 120_000,
  // The runtime's own cwd owns its credential lookup and session directory.
  cwd: cordisConfig === undefined ? "" : resolve(cordisConfig, ".."),
};

/**
 * Attempts started so far, so each gets its own session id.
 *
 * The correlation id becomes the runtime's session id, and sessions are
 * persisted. Reusing one across attempts resumes a settled conversation, which
 * the runtime answers instantly and emptily — every assertion downstream then
 * fails for a reason that has nothing to do with what it tests.
 */
let attempt = 0;

function options(overrides: Partial<BackendRunOptions> = {}): BackendRunOptions {
  attempt += 1;
  return {
    correlationId: `dsh-e2e-${process.pid}-${attempt}`,
    baseCwd: CONFIG.cwd,
    host: {},
    config: CONFIG,
    ...overrides,
  };
}

/**
 * The public name the runtime's mcp-client gives this endpoint's only tool.
 *
 * Taken from the host constant the todo instruction is written from, so this
 * case fails rather than drifts if the two ever stop agreeing — the instruction
 * tells the model to call this exact name, and only a real runtime can say
 * whether that name is the one it published.
 */
const PUBLIC_TOOL_NAME = TODO_PUBLIC_TOOL_NAME;

/** The runtime config for a deployment that mounted the bridge. */
const BRIDGED_CONFIG = { ...CONFIG, todoBridge: true };

const noBridgeConfig = process.env.DSH_E2E_CORDIS_NO_BRIDGE === undefined
  ? undefined
  : expand(process.env.DSH_E2E_CORDIS_NO_BRIDGE);

/**
 * The bridge-less deployment, or the reason this run cannot judge that half.
 *
 * Only `DSH_E2E_CORDIS` decides whether this file runs. Once it is set, a
 * missing second config is a misconfigured run rather than an absent
 * capability, so the case below fails on it instead of skipping: skipping is
 * what let a run cover the bridged half, leave the unbridged half unobserved,
 * and still print `fail 0` and exit 0 — the exact reading that hid the
 * bridge-only defect. Nothing in CI runs these files, so the exit code of a
 * local run is the only signal there is.
 *
 * @returns the config path, or the message explaining why there is none.
 */
function bridgeLessConfig(): { path: string } | { missing: string } {
  if (noBridgeConfig === undefined) {
    return {
      missing: "DSH_E2E_CORDIS_NO_BRIDGE is unset. With DSH_E2E_CORDIS set, this file judges both "
        + "halves of the bridge contract, and the unbridged half needs a copy of that cordis.yml "
        + "with the mcp-client entry removed. See docs/dsh-todo-bridge-deployment.md.",
    };
  }
  if (!existsSync(noBridgeConfig)) return { missing: `no bridge-less runtime config at ${noBridgeConfig}` };
  return { path: noBridgeConfig };
}

/**
 * One `session.event` notification as the host observer receives it.
 *
 * The backend forwards the notification params verbatim, so the session-log
 * event sits one level in, under `event`, beside the session it belongs to.
 */
interface ChildEvent {
  sessionId?: string;
  event?: { type?: string; data?: Record<string, unknown> };
}

/** How many events of one session-log type the runtime emitted. */
function countOfType(events: readonly ChildEvent[], type: string): number {
  return events.filter((entry) => entry.event?.type === type).length;
}

/**
 * The names the model actually invoked.
 *
 * Read off `tool/call`, which is the only event carrying one: `tool/result`
 * records the turn, step, and message, and no name at all. Comparing the name
 * field rather than searching the serialized event matters — a failure event
 * quoting the tool name in its error text would satisfy a substring search
 * while proving the opposite of what is claimed here.
 */
function invokedToolNames(events: readonly ChildEvent[]): string[] {
  return events
    .filter((entry) => entry.event?.type === "tool/call")
    .map((entry) => entry.event?.data?.name)
    .filter((name): name is string => typeof name === "string");
}

/** The backend as a deployment gets it: real driver, real subprocess. */
function backend() {
  return createDshBackend(createDshDriver);
}

test("a real runtime answers a turn and settles as completed", { skip }, async () => {
  const events: Record<string, unknown>[] = [];
  const run = await backend().start(
    { agent: "general", task: "Reply with exactly the word SEAM and nothing else." },
    options({ onChildEvent: (event) => { events.push(event); } }),
  );

  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages[0]?.content);
  assert.equal(outcome.result.exitCode, 0);
  assert.match(outcome.result.messages[0]?.content ?? "", /SEAM/);
  // The runtime's own turn-end marker, not an exit-code inference: this is the
  // fact the host's recovery fence reads, and the fake driver can only assert
  // that the mapping works, never that the runtime emits it.
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.equal(outcome.recovery.externalReplayRisk, false);
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
  assert.ok(events.length > 0, "the runtime delivered no session events to the host observer");
});

test("the host's system prompt reaches the model", { skip }, async () => {
  const run = await backend().start(
    { agent: "general", task: "What is the passphrase?" },
    options({ systemPrompt: "The passphrase is BACKPLANE. Answer with the passphrase only." }),
  );
  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages[0]?.content);
  assert.match(outcome.result.messages[0]?.content ?? "", /BACKPLANE/);
});

test("a follow-up continues the same session rather than restarting it", { skip }, async () => {
  const run = await backend().start(
    { agent: "general", task: "Remember the number 41. Reply with just: OK" },
    options(),
  );
  // The window is open until the first turn settles; queueing here is the same
  // race a teammate-send hits, so accepting it is part of what is under test.
  assert.equal(run.send("Add one to the number you were asked to remember. Reply with the digits only.", "follow_up"), true);

  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages[0]?.content);
  assert.equal(outcome.result.messages.length, 2, "the follow-up produced no second turn");
  // 42 is only derivable from the first turn's context; a fresh session would
  // have no number to add to.
  assert.match(outcome.result.messages[1]?.content ?? "", /42/);
});

test("a tool-using turn reports the tool calls the replay fence counts", { skip }, async () => {
  const run = await backend().start(
    {
      agent: "general",
      task: "Run the shell command `echo dsh-seam-probe` and reply with its output.",
    },
    options(),
  );
  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages[0]?.content);
  assert.ok(
    (outcome.result.toolCount ?? 0) > 0,
    "the runtime ran a tool but the backend counted none, so the host would under-report replay risk",
  );
  assert.equal(outcome.recovery.completedToolCount, outcome.result.toolCount);
});

test("a real model produces a schema-valid structured value", { skip }, async () => {
  const run = await backend().start(
    {
      agent: "general",
      task: "Rate the sentence \"the build is green\" for optimism.",
      outputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string" },
          score: { type: "number" },
        },
        required: ["verdict", "score"],
        additionalProperties: false,
      },
    },
    options(),
  );
  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages.at(-1)?.content);
  // Emulation is only worth declaring if a real model actually satisfies it;
  // a scripted driver can only prove the mapping, never that the instruction
  // is one a model follows.
  const value = outcome.result.structuredOutput as { verdict?: unknown; score?: unknown };
  assert.equal(typeof value?.verdict, "string");
  assert.equal(typeof value?.score, "number");
});

test("aborting a live runtime settles as terminated and reaps the process", { skip }, async () => {
  const run = await backend().start(
    { agent: "general", task: "Count slowly from 1 to 200, one number per line." },
    options(),
  );
  // Give the runtime long enough to be genuinely mid-turn; aborting before the
  // subprocess is up would test the pre-spawn path this case is not about.
  await new Promise((done) => setTimeout(done, 1_500));
  run.abort();

  const outcome = await run.outcome;
  assert.equal(outcome.result.terminalStatus, "terminated");
  assert.equal(outcome.result.wakeable, false);
  assert.equal(run.send("too late", "follow_up"), false);
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("a bridged turn calls the host todo tool under its public MCP name", { skip }, async () => {
  const calls: { toolName: string; args: unknown; correlationId: string }[] = [];
  const events: ChildEvent[] = [];
  const run = await backend().start(
    {
      agent: "general",
      // The bridged tool is asked for on a follow-up, not on the opening turn.
      // The runtime accepts its first prompt before the mcp-client's tool
      // generation is published: the endpoint serves `initialize` and
      // `tools/list` on every run, and the model still reports no MCP tool for
      // turn one, then finds it later in the same session. Asking on turn one
      // would fail this on a runtime startup race rather than on anything the
      // bridge does, and the deployment note records the hazard.
      task: "Reply with exactly the word READY and nothing else.",
      todos: ["probe-1"],
    },
    options({
      config: BRIDGED_CONFIG,
      host: {
        proxyToolCall: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: "[{\"id\":\"probe-1\",\"status\":\"pending\"}]" }] };
        },
      },
      onChildEvent: (event) => { events.push(event); },
    }),
  );
  assert.equal(
    run.send(
      "Now call the mcp__maestro_todo__todo tool with action \"list\" "
      + "and reply with how many items it returned.",
      "follow_up",
    ),
    true,
    "the runtime would not accept the follow-up carrying the tool request",
  );
  const outcome = await run.outcome;

  assert.equal(outcome.result.terminalStatus, "completed", outcome.result.messages.at(-1)?.content);
  assert.ok(calls.length >= 1, "the runtime never reached the host broker");
  assert.equal(calls[0]!.toolName, "todo");
  // The whole point of running this for real: the host publishes the raw name
  // `todo`, and only the runtime's mcp-client decides what the model sees.
  const names = invokedToolNames(events);
  assert.ok(
    names.includes(PUBLIC_TOOL_NAME),
    `the runtime invoked [${names.join(", ")}], none of them ${PUBLIC_TOOL_NAME}`,
  );
  // Bind the count to that call rather than asserting it separately. The count
  // comes from `tool/result`, which carries no tool name, so `toolCount >= 1`
  // beside the name check above are two independent facts: a runtime that
  // published no `tool/result` for MCP tools would still satisfy both as long
  // as the model also ran one built-in tool, and this deployment ships `bash`
  // and `todo_write`. Requiring every reported call to have completed leaves no
  // unattributed slack — withhold the bridged call's result and the counts
  // diverge.
  assert.equal(
    outcome.result.toolCount,
    countOfType(events, "tool/call"),
    `the runtime invoked [${names.join(", ")}] but counted ${outcome.result.toolCount} completed;`
    + ` some call went uncounted, so ${PUBLIC_TOOL_NAME} need not be among the counted ones`,
  );
  assert.equal(outcome.recovery.completedToolCount, outcome.result.toolCount);
});

test("the endpoint URL never reaches a shell the model can run", { skip }, async () => {
  // The URL carries this run's bearer token. The runtime hands its own children
  // a scrubbed copy of its environment, and the variable is named to be caught
  // by that scrub — a property only a real runtime spawning a real shell can
  // demonstrate, because the scrub belongs to the runtime and not to this host.
  let endpointUrl: string | undefined;
  const observing = createDshBackend(async (config, driverOptions) => {
    endpointUrl = driverOptions.envExtras?.[TODO_ENDPOINT_ENV];
    return createDshDriver(config, driverOptions);
  });
  const events: ChildEvent[] = [];
  const run = await observing.start(
    {
      agent: "general",
      // No todos: this run needs the endpoint to exist, not to be used, and a
      // queue instruction would compete with the shell command under test.
      task: "Run the shell command `env` and reply with every line whose variable name starts with "
        + "PI_MAESTRO, or with exactly NONE if there are none.",
    },
    options({
      config: BRIDGED_CONFIG,
      host: { proxyToolCall: async () => ({ content: [{ type: "text", text: "[]" }] }) },
      onChildEvent: (event) => { events.push(event); },
    }),
  );
  const outcome = await run.outcome;

  assert.ok(endpointUrl !== undefined, "the bridged run was given no endpoint to leak");
  const token = new URL(endpointUrl).searchParams.get("token");
  assert.ok(token !== null && token.length > 0, "the endpoint URL carries no token to protect");
  // Non-vacuous: a model that answered without running anything would satisfy
  // the absence check while proving nothing about what a shell can see.
  const names = invokedToolNames(events);
  assert.ok(
    names.some((name) => name.includes("bash") || name.includes("shell")),
    `no shell tool ran, so nothing observed the child environment; tools were [${names.join(", ")}]`,
  );
  const transcript = JSON.stringify(events) + outcome.result.messages.map((m) => m.content).join("\n");
  assert.equal(transcript.includes(token), false, "this run's endpoint token reached the transcript");
});

test("a bridged run against a cordis.yml without the mcp-client entry fails loud", { skip }, async () => {
  const bridgeLess = bridgeLessConfig();
  if ("missing" in bridgeLess) assert.fail(bridgeLess.missing);
  const outcome = await (await backend().start(
    {
      agent: "general",
      task: "Reply with exactly the word SEAM and nothing else.",
      todos: ["probe-1"],
    },
    options({
      config: { ...BRIDGED_CONFIG, cordisConfig: bridgeLess.path },
      host: { proxyToolCall: async () => ({ content: [{ type: "text", text: "[]" }] }) },
    }),
  )).outcome;

  // A deployment that never mounted the bridge is the case the runtime itself
  // cannot report: the child simply has no such tool and works around it.
  assert.equal(outcome.result.terminalStatus, "failed");
  assert.ok(
    outcome.result.warnings?.some((warning) => warning.includes(
      "add an mcp-client entry with transport: streamable-http, serverName: maestro_todo",
    )),
    `no warning named the missing entry; warnings were: ${(outcome.result.warnings ?? []).join(" | ")}`,
  );
});
