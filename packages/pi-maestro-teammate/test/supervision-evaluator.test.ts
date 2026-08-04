import assert from "node:assert/strict";
import test from "node:test";
import {
  runSupervisedEvaluation,
  type SupervisedEvaluationContext,
  type SupervisionDispatch,
} from "../src/supervision/evaluator.ts";
import type { SingleResult } from "../src/shared/types.ts";

function fakeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "analyst",
    task: "verify",
    exitCode: 0,
    messages: [{ role: "assistant", content: "ok" }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "test",
    correlationId: "c1",
    durationMs: 1,
    ...overrides,
  };
}

function captureSignalDispatch(observed: { signal?: AbortSignal }): SupervisionDispatch {
  return (ctx: SupervisedEvaluationContext) => {
    observed.signal = ctx.signal;
    return new Promise<SingleResult>((_resolve, reject) => {
      const signal = ctx.signal;
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

test("deadline aborts the dispatch signal", async () => {
  const observed: { signal?: AbortSignal } = {};
  const result = await runSupervisedEvaluation(
    captureSignalDispatch(observed),
    { task: "verify", deadlineMs: 10, maxFailures: 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /Supervised evaluation timed out after 10ms/);
  assert.equal(observed.signal?.aborted, true);
});

test("fast result clears the deadline", async () => {
  const expected = fakeResult({ structuredOutput: { status: "pass" } });
  const result = await runSupervisedEvaluation(
    async () => expected,
    { task: "verify", deadlineMs: 1_000 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.verdict, { status: "pass" });
});

test("structured output becomes the verdict", async () => {
  const expected = fakeResult({ structuredOutput: { status: "drift", action: "send" } });
  const result = await runSupervisedEvaluation<{ status: string; action: string }>(
    async () => expected,
    { task: "analyze", outputSchema: { type: "object" } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.verdict, { status: "drift", action: "send" });
});

test("fallback text parser is used without structured output", async () => {
  const expected = fakeResult({ messages: [{ role: "assistant", content: '{"status":"on-track"}' }] });
  const result = await runSupervisedEvaluation<{ status: string }>(
    async () => expected,
    { task: "analyze", fallbackTextParser: (text) => JSON.parse(text) },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.verdict, { status: "on-track" });
});

test("no structured output and no parseable text yields ok:false", async () => {
  const result = await runSupervisedEvaluation(
    async () => fakeResult(),
    { task: "analyze" },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /no structured output/i);
});

test("beforeVerdict gate rejects a result", async () => {
  const result = await runSupervisedEvaluation(
    async () => fakeResult({ exitCode: 1, structuredOutput: { status: "pass" } }),
    {
      task: "verify",
      beforeVerdict: (r) => (r.exitCode !== 0 ? `Verifier exit status was ${r.exitCode}` : undefined),
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /exit status was 1/);
});

test("retries consecutive failures up to maxFailures then gives up", async () => {
  let attempts = 0;
  const result = await runSupervisedEvaluation(
    async () => {
      attempts++;
      throw new Error(`boom ${attempts}`);
    },
    { task: "verify", maxFailures: 3 },
  );
  assert.equal(attempts, 3);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /failed after 3 attempt\(s\).*boom 3/);
});

test("non-retryable failure stops immediately", async () => {
  let attempts = 0;
  const result = await runSupervisedEvaluation(
    async () => {
      attempts++;
      throw new Error("permanent");
    },
    { task: "verify", maxFailures: 3, isRetryable: () => false },
  );
  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /permanent/);
});

test("parent signal cascades into the internal controller", async () => {
  const parent = new AbortController();
  const observed: { signal?: AbortSignal } = {};
  const dispatch = captureSignalDispatch(observed);
  const run = runSupervisedEvaluation(dispatch, { task: "verify", signal: parent.signal, maxFailures: 1 });
  parent.abort(new Error("parent cancelled"));
  const result = await run;
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /parent cancelled/);
  assert.equal(observed.signal?.aborted, true);
});
