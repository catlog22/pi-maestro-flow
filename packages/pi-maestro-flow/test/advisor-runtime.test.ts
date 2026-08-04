import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdvisorPrompt,
  DEFAULT_ADVISOR_CONFIG,
  formatAdvisory,
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
  serializeTranscriptTail,
  verdictDeliveryMode,
} from "../src/advisor/runtime.ts";

function message(role: string, content: string, extra: Record<string, unknown> = {}): unknown {
  return { role, content, ...extra };
}

test("serializeTranscriptTail extracts text and collapses to one line per message", () => {
  const messages = [
    message("user", "Fix the leak"),
    message("assistant", "Looking at src/auth.ts"),
    message("tool", "12:34 found", { name: "read" }),
  ] as never;
  const out = serializeTranscriptTail(messages);
  assert.match(out, /USER: Fix the leak/);
  assert.match(out, /ASSISTANT: Looking at src\/auth.ts/);
  assert.match(out, /TOOL read: 12:34 found/);
  assert.equal(out.split("\n").length, 3);
});

test("serializeTranscriptTail handles content blocks and custom entries", () => {
  const messages = [
    message("user", [{ text: "part1" }, { text: " part2" }]),
    message("assistant", "ok", { customType: undefined }),
  ] as never;
  const out = serializeTranscriptTail(messages);
  assert.match(out, /USER: part1 part2/);
});

test("serializeTranscriptTail bounds by message count and total chars", () => {
  const messages = Array.from({ length: 20 }, (_, i) => message("user", `msg ${i}`)) as never;
  const byCount = serializeTranscriptTail(messages, 3, 10_000);
  assert.equal(byCount.split("\n").length, 3);
  const byChars = serializeTranscriptTail(messages, 20, 40);
  assert.ok(byChars.length <= 40, `expected <= 40 chars, got ${byChars.length}`);
});

test("buildAdvisorPrompt includes guide block, tail and JSON constraint", () => {
  const prompt = buildAdvisorPrompt({ ...DEFAULT_ADVISOR_CONFIG, guide: "watch for bypassing the queue" }, "USER: x\nASSISTANT: y");
  assert.match(prompt, /<attention>/);
  assert.match(prompt, /watch for bypassing the queue/);
  assert.match(prompt, /<transcript-tail>/);
  assert.match(prompt, /USER: x/);
  assert.match(prompt, /"on-track" \| "concern" \| "blocker"/);
});

test("buildAdvisorPrompt omits the attention block without a guide", () => {
  const prompt = buildAdvisorPrompt(DEFAULT_ADVISOR_CONFIG, "USER: x");
  assert.doesNotMatch(prompt, /<attention>/);
});

test("normalizeAdvisorVerdict accepts valid verdicts and rejects garbage", () => {
  assert.deepEqual(normalizeAdvisorVerdict({ status: "on-track" }), { status: "on-track", reason: undefined, message: undefined });
  assert.equal(normalizeAdvisorVerdict({ status: "warning" }), undefined);
  assert.equal(normalizeAdvisorVerdict(null), undefined);
  assert.equal(normalizeAdvisorVerdict("on-track"), undefined);
});

test("parseAdvisorVerdictText extracts JSON from markdown fences", () => {
  const verdict = parseAdvisorVerdictText('```json\n{ "status": "blocker", "reason": "r", "message": "m" }\n```');
  assert.deepEqual(verdict, { status: "blocker", reason: "r", message: "m" });
  assert.equal(parseAdvisorVerdictText("no json here"), undefined);
});

test("verdictDeliveryMode maps severity to delivery mode", () => {
  assert.equal(verdictDeliveryMode({ status: "on-track" }), undefined);
  assert.equal(verdictDeliveryMode({ status: "concern" }), "interrupt");
  assert.equal(verdictDeliveryMode({ status: "blocker" }), "interrupt");
});

test("formatAdvisory wraps with severity and guidance, XML-escapes body", () => {
  const advisory = formatAdvisory('Do not use `a < b` & keep "quotes"', "concern");
  assert.match(advisory, /^<advisory severity="concern" guidance="weigh, don't blindly obey">\n/);
  assert.match(advisory, /a &lt; b/);
  assert.match(advisory, /&amp; keep/);
  assert.match(advisory, /<\/advisory>$/);
});
