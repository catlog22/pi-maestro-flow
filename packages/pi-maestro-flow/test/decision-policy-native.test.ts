import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completePolicyStructured } from "../src/decision-policy/service.ts";

const value = { owner: "internal", candidateType: "unknown", worthCapturing: false, confidence: .95, matchedRuleIds: ["local"], rationale: "Reuse existing code" };
function fixture(response: unknown = { provider: "native", model: "resolved-model", stopReason: "toolUse", content: [{ type: "toolCall", name: "policy_result", arguments: value }] }) {
  const calls: Array<{ model: unknown; context: { tools: Array<{ name: string }> }; options: { signal: AbortSignal; sessionId: string } }> = [];
  const model = { provider: "native", id: "selected-model" };
  const ctx = {
    model, sessionManager: { getSessionId: () => "native-policy-test" },
    modelRegistry: {
      getAvailable: () => [model],
      getApiKeyAndHeaders: () => { throw new Error("native auth belongs to facade, not extension"); },
      streamSimple(selected: unknown, context: { tools: Array<{ name: string }> }, options: { signal: AbortSignal; sessionId: string }) {
        calls.push({ model: selected, context, options });
        return { result: async () => response };
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}
const request = (ctx: ExtensionContext) => ({ ctx, modelRef: "inherit", prompt: "Confirmed policy + untrusted input", kind: "classification" as const, signal: new AbortController().signal, hostVersion: "0.99.2" });

test("native policy completion uses authenticated host stream facade and records resolved model", async () => {
  const { ctx, calls } = fixture();
  const input = request(ctx);
  const reply = await completePolicyStructured(input);
  assert.deepEqual(reply.value, value); assert.equal(reply.model, "native/resolved-model");
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal, input.signal);
  assert.equal(calls[0].options.sessionId, "native-policy-test"); assert.equal(calls[0].context.tools[0].name, "policy_result");
});
test("native host without stream facade never falls back to environment-key completion", async () => {
  const { ctx } = fixture();
  const noRuntime = { ...ctx, modelRegistry: { getAvailable: ctx.modelRegistry.getAvailable, getApiKeyAndHeaders: () => { throw new Error("must not request legacy auth"); } } } as unknown as ExtensionContext;
  await assert.rejects(completePolicyStructured(request(noRuntime)), /Native policy LLM runtime unavailable/);
});
test("unknown host and unavailable pinned model fail closed without calling native or legacy transport", async () => {
  const { ctx, calls } = fixture();
  await assert.rejects(completePolicyStructured({ ...request(ctx), hostVersion: "unknown" }), /runtime unavailable/);
  await assert.rejects(completePolicyStructured({ ...request(ctx), modelRef: "native/missing-model" }), /No authenticated LLM/);
  assert.equal(calls.length, 0);
});
test("native plain JSON is parsed strictly, not stripped from prose", async () => {
  const valid = fixture({ provider: "native", model: "selected-model", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }] });
  assert.deepEqual((await completePolicyStructured(request(valid.ctx))).value, value);
  const invalid = fixture({ provider: "native", model: "selected-model", stopReason: "stop", content: [{ type: "text", text: `Advice: ${JSON.stringify(value)}` }] });
  await assert.rejects(completePolicyStructured(request(invalid.ctx)), SyntaxError);
});
test("native cancellation/error/truncation and unexpected tool calls are rejected", async () => {
  for (const stopReason of ["aborted", "error", "length"]) {
    const { ctx } = fixture({ provider: "native", model: "selected-model", stopReason, errorMessage: "native failed", content: [] });
    await assert.rejects(completePolicyStructured(request(ctx)), /native failed/);
  }
  const { ctx } = fixture({ provider: "native", model: "selected-model", stopReason: "toolUse", content: [{ type: "toolCall", name: "write", arguments: value }] });
  await assert.rejects(completePolicyStructured(request(ctx)), /unexpected tool calls/);
});
