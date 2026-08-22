import assert from "node:assert/strict";
import test from "node:test";
import {
  displayMessageForResult,
  displayResolvedModel,
  emitTeammateResultPublished,
  setAgentStructuredOutput,
  toStructuredResults,
  UNPERSISTED_RESULT_INLINE_CAP_CHARS,
} from "../src/extension/teammate-core.ts";
import { buildWatchOutput } from "../src/extension/teammate-helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveAgent, SingleResult } from "../src/shared/types.ts";

function result(overrides: Partial<SingleResult>): SingleResult {
  return {
    agent: "analyst",
    task: "review",
    exitCode: 0,
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      turns: 1,
    },
    model: "test-model",
    correlationId: "run-abc",
    durationMs: 100,
    ...overrides,
  };
}

function agentFixture(overrides: Partial<ActiveAgent>): ActiveAgent {
  const now = Date.now();
  return {
    agent: "analyst",
    correlationId: "run-abc",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "sleeping" as const,
    depth: 0,
    sleepMs: 0,
    ...overrides,
  };
}

async function acknowledgePersistence(value: SingleResult): Promise<void> {
  assert.ok(value.publicationId, "test result must carry a publication id");
  const pi = {
    events: {
      emit(
        _name: string,
        event: { waitUntil(promise: Promise<unknown>): void; acknowledgeResource?(uri: string): void },
      ) {
        event.waitUntil(Promise.resolve().then(() => {
          event.acknowledgeResource?.(`agent://${value.correlationId}`);
        }));
      },
    },
  } as unknown as ExtensionAPI;
  await emitTeammateResultPublished(pi, value, "D:/workspace");
}

test("displayMessageForResult surfaces the structured output when the transcript ends with the tool confirmation", () => {
  const out = displayMessageForResult(result({
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { total: 39, verdict: "ok" },
  }));
  assert.match(out, /\[structured_output\]/);
  assert.match(out, /"total": 39/);
  assert.doesNotMatch(out, /Structured output saved\./);
});

test("displayMessageForResult keeps prose answers and appends the structured value", () => {
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: "The review found 39 issues." }],
    structuredOutput: { total: 39, verdict: "ok" },
  }));
  assert.ok(out.startsWith("The review found 39 issues."));
  assert.match(out, /\[structured_output\]/);
  assert.match(out, /"verdict": "ok"/);
});

test("displayMessageForResult leaves non-structured results unchanged without persistence acknowledgement", () => {
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: "Plain answer" }],
  }));
  assert.equal(out, "Plain answer");
});

test("displayMessageForResult keeps small persisted results inline and adds the canonical id", async () => {
  const persisted = result({
    publicationId: "publication-small",
    messages: [{ role: "assistant", content: "Plain answer" }],
  });
  await acknowledgePersistence(persisted);
  assert.equal(displayMessageForResult(persisted), "Plain answer\n\nFull result: agent://run-abc");
});

test("displayMessageForResult delivers large structured outputs in full without persistence acknowledgement", () => {
  const data = "x".repeat(20_000);
  const out = displayMessageForResult(result({
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { data },
  }));
  assert.doesNotMatch(out, /truncated/);
  assert.ok(out.includes(data), "full structured value must remain when no durable reference exists");
  assert.ok(out.endsWith(`${data}"\n}`), "value must not be cut off");
});

test("displayMessageForResult replaces large persisted structured outputs with a description and id", async () => {
  const data = "x".repeat(20_000);
  const persisted = result({
    publicationId: "publication-large",
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { data },
  });
  await acknowledgePersistence(persisted);
  const out = displayMessageForResult(persisted);
  assert.match(out, /^Structured result saved \(19\.6K chars; fields: data\)\./);
  assert.match(out, /Full result: agent:\/\/run-abc$/);
  assert.equal(out.includes(data), false);
});

test("displayMessageForResult keeps the full result when durable persistence is rejected", async () => {
  const data = "x".repeat(20_000);
  const rejected = result({
    publicationId: "publication-rejected",
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { data },
  });
  const pi = {
    events: {
      emit(
        _name: string,
        event: { waitUntil(promise: Promise<unknown>): void; acknowledgeResource?(uri: string): void },
      ) {
        event.acknowledgeResource?.("agent://run-abc");
        event.waitUntil(Promise.reject(new Error("store unavailable")));
      },
    },
  } as unknown as ExtensionAPI;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await emitTeammateResultPublished(pi, rejected, "D:/workspace");
  } finally {
    console.warn = originalWarn;
  }
  const out = displayMessageForResult(rejected);
  assert.ok(out.includes(data));
  assert.doesNotMatch(out, /agent:\/\//);
});

test("displayMessageForResult caps an unpersisted result above the inline hard ceiling", () => {
  const data = "line\n".repeat(Math.ceil((UNPERSISTED_RESULT_INLINE_CAP_CHARS * 2) / 5));
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: data }],
  }));
  assert.ok(
    out.length < UNPERSISTED_RESULT_INLINE_CAP_CHARS + 500,
    `capped output must stay near the ceiling (got ${out.length})`,
  );
  assert.match(out, /\[Teammate output capped at .* result persistence was unavailable/s);
  assert.doesNotMatch(out, /Full result: agent:\/\//);
});

test("displayMessageForResult keeps an unpersisted result at the ceiling untouched", () => {
  const data = "x".repeat(UNPERSISTED_RESULT_INLINE_CAP_CHARS);
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: data }],
  }));
  assert.equal(out, data);
});

test("displayMessageForResult caps the unpersisted failure fallback without touching diagnostics", () => {
  const data = "x".repeat(UNPERSISTED_RESULT_INLINE_CAP_CHARS * 2);
  const out = displayMessageForResult(result({
    exitCode: 1,
    messages: [{ role: "assistant", content: data }],
  }));
  assert.ok(out.length < UNPERSISTED_RESULT_INLINE_CAP_CHARS + 500);
  assert.match(out, /\[Teammate output capped at /);

  const diagnostic = displayMessageForResult(result({
    exitCode: 1,
    messages: [
      { role: "system", content: "Teammate child process exited abnormally (agent=analyst)" },
      { role: "assistant", content: data },
    ],
  }));
  assert.match(diagnostic, /Teammate child process exited abnormally/);
  assert.doesNotMatch(diagnostic, /\[Teammate output capped at /);
});

test("displayMessageForResult keeps failure diagnostics authoritative", () => {
  const out = displayMessageForResult(result({
    exitCode: 1,
    messages: [
      { role: "system", content: "Teammate child process exited abnormally (agent=analyst)" },
      { role: "tool", content: "Structured output saved." },
    ],
    structuredOutput: { ok: true },
  }));
  assert.match(out, /Teammate child process exited abnormally/);
});

test("a diagnostic written to both sinks is rendered once, and other warnings survive", () => {
  // The dsh backend writes a provider failure to the `system` message and to
  // the warnings: the first is where the host reads the failure class from, the
  // second is what an orchestrator scans, and neither may be dropped at the
  // source. The reader still gets one copy.
  const failure = "dsh provider failure: Insufficient Balance (code=invalid_request_error, status=402)";
  const out = displayMessageForResult(result({
    exitCode: 1,
    messages: [{ role: "system", content: failure }],
    warnings: [failure, "structured output was requested but the runtime returned none"],
  }));
  assert.equal(out.split(failure).length - 1, 1);
  assert.match(out, /\[warn\] structured output was requested but/);
});

test("a warning with no counterpart in the body is still rendered on a success", () => {
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: "done" }],
    warnings: ["structured output was requested but the runtime returned none"],
  }));
  assert.match(out, /^\[warn\] structured output was requested but/);
});

test("structured result snapshots ignore provenance that was not built by registry dispatch", () => {
  const value = { nested: { verdict: "ok" } };
  const provenance: NonNullable<SingleResult["provenance"]> = {
    registryVersion: 2,
    registryRevision: 7,
    registryHash: "sha256",
    modelRegistrationId: "registry/reviewer",
    modelId: "intrinsic/reviewer",
    deploymentId: "local-pi",
    harness: "pi",
    transport: { kind: "local-process", protocol: "pi-rpc" },
  };
  const projected = toStructuredResults([result({
    name: "reviewer",
    structuredOutput: value,
    provenance,
  })], "D:/workspace");
  assert.ok(projected);
  assert.equal(projected[0].originCwd, "D:/workspace");
  assert.equal(projected[0].name, "reviewer");
  assert.equal(projected[0].provenance, undefined);
  (projected[0].structuredOutput as { nested: { verdict: string } }).nested.verdict = "mutated";
  assert.equal(value.nested.verdict, "ok");
  assert.deepEqual(provenance.transport, { kind: "local-process", protocol: "pi-rpc" });
});

test("toStructuredResults carries the final assistant text for tasks without an outputSchema", () => {
  const projected = toStructuredResults([result({
    name: "scanner",
    messages: [
      { role: "system", content: "running" },
      { role: "assistant", content: "Found 3 issues in src/" },
    ],
  })], "D:/workspace");
  assert.ok(projected);
  assert.equal(projected[0].structuredOutput, undefined);
  assert.equal(projected[0].output, "Found 3 issues in src/");
});

test("toStructuredResults prefers structuredOutput and omits output for empty transcripts", () => {
  const structured = toStructuredResults([result({
    name: "reviewer",
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { ok: true },
  })], "D:/workspace");
  assert.ok(structured);
  assert.deepEqual(structured[0].structuredOutput, { ok: true });
  assert.equal(structured[0].output, undefined);

  assert.equal(toStructuredResults([result({ messages: [] })], "D:/workspace"), undefined);
});

test("setAgentStructuredOutput clones new values and clears stale values", () => {
  const agent = agentFixture({ structuredOutput: { previous: true } });
  const next = { nested: { value: 3 } };
  setAgentStructuredOutput(agent, next);
  (next.nested as { value: number }).value = 9;
  assert.deepEqual(agent.structuredOutput, { nested: { value: 3 } });
  setAgentStructuredOutput(agent, undefined);
  assert.equal(agent.structuredOutput, undefined);
});

test("buildWatchOutput shows the structured output of a settled agent", () => {
  const watched = buildWatchOutput({
    kind: "agent",
    agent: agentFixture({ structuredOutput: { total: 39, verdict: "ok" } }),
  }, 20).join("\n");
  assert.match(watched, /--- structured output ---/);
  assert.match(watched, /"verdict": "ok"/);
});

test("buildWatchOutput omits the structured output block when absent", () => {
  const watched = buildWatchOutput({
    kind: "agent",
    agent: agentFixture({ correlationId: "run-xyz" }),
  }, 20).join("\n");
  assert.doesNotMatch(watched, /structured output/);
});

test("the model display names what ran, keeping the dispatched route as what was requested", () => {
  // A backend that owns its model namespace: the host dispatched a route, the
  // CLI ran something inside it. Reading `model` here printed the route on both
  // halves of "Model: X (requested Y)" and told the reader nothing.
  assert.equal(
    displayResolvedModel(result({ model: "cli/cursor", executorModel: "composer-2.5[fast=true]" })),
    "composer-2.5[fast=true]",
  );
  // A backend whose namespace is the host's reports one name for both, so the
  // dispatched model stays the answer.
  assert.equal(displayResolvedModel(result({ model: "deepseek-v4" })), "deepseek-v4");
});
