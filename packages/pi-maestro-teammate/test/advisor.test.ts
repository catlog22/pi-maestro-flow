import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ADVISOR_CONFIG,
  buildAdvisorPrompt,
  createAdvisorState,
  extractAdvisorTranscript,
  normalizeAdvisorConfig,
  parseAdvisorVerdict,
  shouldReview,
} from "../src/extension/advisor.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("normalizeAdvisorConfig defaults to disabled", () => {
  const config = normalizeAdvisorConfig(undefined, { env: {} });
  assert.equal(config.enabled, false, "advisor is opt-in by default");
  assert.equal(config.cooldownMs, 5 * 60_000);
  assert.equal(config.maxReviewsPerSession, 20);
});

test("normalizeAdvisorConfig merges settings and env", () => {
  const config = normalizeAdvisorConfig(
    { enabled: true, cooldownMs: 60_000, maxReviewsPerSession: 5 },
    { env: { PI_ADVISOR_COOLDOWN_MS: "30000", PI_ADVISOR_MAX_REVIEWS: "3" } },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.cooldownMs, 30_000, "env wins");
  assert.equal(config.maxReviewsPerSession, 3);

  const off = normalizeAdvisorConfig({ enabled: true }, { env: { PI_ADVISOR: "off" } });
  assert.equal(off.enabled, false, "env off wins");
});

// ---------------------------------------------------------------------------
// State gating
// ---------------------------------------------------------------------------

test("shouldReview gates by enabled, budget, and cooldown", () => {
  const config = { ...DEFAULT_ADVISOR_CONFIG, enabled: true, cooldownMs: 1_000, maxReviewsPerSession: 2 };
  const state = createAdvisorState(config);
  const now = 1_000_000;

  // Disabled state → no.
  const disabled = createAdvisorState({ ...DEFAULT_ADVISOR_CONFIG, enabled: false });
  assert.equal(shouldReview(disabled, config, now), false);

  // Fresh enabled → yes.
  assert.equal(shouldReview(state, config, now), true);

  // Cooldown not elapsed → no.
  state.lastReviewAt = now - 500;
  assert.equal(shouldReview(state, config, now), false);
  state.lastReviewAt = now - 1_500;
  assert.equal(shouldReview(state, config, now), true);

  // Budget exhausted → no.
  state.reviews = 2;
  assert.equal(shouldReview(state, config, now), false);
});

// ---------------------------------------------------------------------------
// Transcript extraction
// ---------------------------------------------------------------------------

test("extractAdvisorTranscript takes objective + tail", () => {
  const { objective, transcript } = extractAdvisorTranscript([
    { role: "user", content: "Fix the race condition in dispatch" },
    { role: "assistant", content: "I'll trace the locking path first." },
    { role: "user", content: "Keep it minimal" },
    { role: "assistant", content: "Done — one lock around claim release." },
  ], { tailMessages: 3, maxMessageChars: 100 });
  assert.equal(objective, "Keep it minimal", "latest user message is the objective");
  assert.deepEqual(transcript, [
    "assistant: I'll trace the locking path first.",
    "user: Keep it minimal",
    "assistant: Done — one lock around claim release.",
  ]);
});

test("extractAdvisorTranscript truncates and skips empty content", () => {
  const { objective, transcript } = extractAdvisorTranscript([
    { role: "user", content: "Short" },
    { role: "assistant", content: "x".repeat(500) },
    { role: "assistant", content: "   " },
  ], { tailMessages: 10, maxMessageChars: 100 });
  assert.equal(objective, "Short");
  assert.equal(transcript.length, 2, "empty assistant message skipped");
  assert.equal(transcript[0]!, "user: Short");
  assert.equal(transcript[1]!.length, 111, "truncated to maxMessageChars + role prefix");
  assert.match(transcript[1]!, /^assistant: x{100}$/);
});

test("buildAdvisorPrompt includes objective, transcript, and JSON contract", () => {
  const prompt = buildAdvisorPrompt("Ship safer coordination", ["assistant: added lock"]);
  assert.match(prompt, /Ship safer coordination/);
  assert.match(prompt, /added lock/);
  assert.match(prompt, /"status": "on-track" \| "concern" \| "blocker"/);
  assert.match(prompt, /under 2 sentences/);
});

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

test("parseAdvisorVerdict extracts status and guidance", () => {
  const verdict = parseAdvisorVerdict('{"status":"concern","reason":"No verification run","guidance":"Run the test suite before claiming done."}');
  assert.equal(verdict?.status, "concern");
  assert.equal(verdict?.reason, "No verification run");
  assert.equal(verdict?.guidance, "Run the test suite before claiming done.");
});

test("parseAdvisorVerdict tolerates markdown fences and garbage", () => {
  const fenced = parseAdvisorVerdict('```json\n{"status":"blocker","guidance":"Stop and check facts"}\n```');
  assert.equal(fenced?.status, "blocker");
  assert.equal(fenced?.guidance, "Stop and check facts");

  const garbage = parseAdvisorVerdict("not json at all");
  assert.equal(garbage, undefined);

  const unknown = parseAdvisorVerdict('{"status":"maybe","reason":"x"}');
  assert.equal(unknown?.status, "on-track", "unknown status defaults to on-track");
});
