import assert from "node:assert/strict";
import test from "node:test";
import { runSupervisedEvaluation } from "pi-maestro-teammate/v1/supervision";

// The Goal verifier's owned deadline (previously runTeammateVerifierWithDeadline)
// is now provided by the shared runSupervisedEvaluation: deadlineMs aborts the
// dispatch signal, which runTeammate propagates to the verifier child tree.

test("Goal verifier deadline aborts a supervised evaluation dispatch", async () => {
  let observedSignal: AbortSignal | undefined;
  const result = await runSupervisedEvaluation(
    (ctx) => {
      observedSignal = ctx.signal;
      return new Promise<never>((_resolve, reject) => {
        const signal = ctx.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    { task: "verify", deadlineMs: 10, maxFailures: 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /timed out after 10ms/);
  assert.equal(observedSignal?.aborted, true);
});

test("Goal verifier deadline is cleared after a fast result", async () => {
  const expected = {
    exitCode: 0,
    messages: [{ role: "assistant", content: "Structured output saved." }],
    structuredOutput: { status: "pass" },
  };
  const result = await runSupervisedEvaluation(
    async () => expected as never,
    { task: "verify", deadlineMs: 1_000 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.raw, expected);
});
