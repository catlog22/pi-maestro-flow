import assert from "node:assert/strict";
import test from "node:test";
import { runTeammateVerifierWithDeadline } from "../src/tools/goal-verification.ts";

test("Goal verifier deadline aborts a direct teammate run", async () => {
  let observedSignal: AbortSignal | undefined;
  const runner = (_params: unknown, options: { signal?: AbortSignal }) => {
    observedSignal = options.signal;
    return new Promise<never>((_resolve, reject) => {
      const signal = options.signal;
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  await assert.rejects(
    runTeammateVerifierWithDeadline(
      runner as never,
      { tasks: [{ prompt: "verify" }] },
      { baseCwd: process.cwd() },
      10,
    ),
    /Goal verifier timed out after 10ms/,
  );
  assert.equal(observedSignal?.aborted, true);
});

test("Goal verifier deadline is cleared after a fast result", async () => {
  const expected = { exitCode: 0, messages: [] };
  const result = await runTeammateVerifierWithDeadline(
    async () => expected,
    { tasks: [{ prompt: "verify" }] },
    { baseCwd: process.cwd() },
    1_000,
  );
  assert.equal(result, expected);
});
