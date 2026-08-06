import assert from "node:assert/strict";
import test from "node:test";
import {
  displayMessageForResult,
  setAgentStructuredOutput,
  toStructuredResults,
} from "../src/extension/teammate-core.ts";
import { buildWatchOutput } from "../src/extension/teammate-helpers.ts";
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

test("displayMessageForResult leaves non-structured results unchanged", () => {
  const out = displayMessageForResult(result({
    messages: [{ role: "assistant", content: "Plain answer" }],
  }));
  assert.equal(out, "Plain answer");
});

test("displayMessageForResult delivers large structured outputs in full", () => {
  const data = "x".repeat(20_000);
  const out = displayMessageForResult(result({
    messages: [{ role: "tool", content: "Structured output saved." }],
    structuredOutput: { data },
  }));
  assert.doesNotMatch(out, /truncated/);
  assert.ok(out.includes(data), "full structured value must be present");
  assert.ok(out.endsWith(`${data}"\n}`), "value must not be cut off");
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

test("structured result snapshots are cloned and retain their origin cwd", () => {
  const value = { nested: { verdict: "ok" } };
  const projected = toStructuredResults([result({
    name: "reviewer",
    structuredOutput: value,
  })], "D:/workspace");
  assert.ok(projected);
  assert.equal(projected[0].originCwd, "D:/workspace");
  assert.equal(projected[0].name, "reviewer");
  (projected[0].structuredOutput as { nested: { verdict: string } }).nested.verdict = "mutated";
  assert.equal(value.nested.verdict, "ok");
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
