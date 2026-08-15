/**
 * The dsh backend against a real dsh runtime.
 *
 * Every other dsh test injects a fake driver, so the whole SDK path — process
 * launch, JSON-RPC framing, session reuse across turns, notification delivery,
 * and shutdown — has never been exercised by this package. That gap is exactly
 * where the seam's remaining risk sits: a capability table can be verified by
 * reading, a transport cannot.
 *
 * Self-skips unless a runtime is configured, so the ordinary suite stays keyless
 * and offline. Point it at a deployment with:
 *
 *   DSH_E2E_CORDIS=~/.dsh/smoke/cordis.yml \
 *   DSH_E2E_COMMAND=~/.dsh/smoke/node_modules/.bin/dsh-jsonrpc-agent \
 *   node --experimental-transform-types --test test/dsh-runtime.e2e.test.ts
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
