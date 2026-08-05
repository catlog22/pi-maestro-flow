import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD,
  ModelCircuitBreaker,
  rankModelsByHealth,
  type AcquiredModelCandidate,
} from "../src/models/model-circuit-breaker.ts";

function acquire(breaker: ModelCircuitBreaker, model: string): AcquiredModelCandidate {
  const result = breaker.acquireCandidate(model);
  assert.equal(result.allowed, true);
  return result;
}

test("uses the default threshold and cooldown before allowing one half-open trial", () => {
  let now = 1_000;
  const breaker = new ModelCircuitBreaker({ now: () => now });
  const model = "provider/model";

  for (let failure = 0; failure < DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD; failure += 1) {
    breaker.recordRetryableFailure(acquire(breaker, model));
  }

  assert.deepEqual(breaker.acquireCandidate(model), {
    allowed: false,
    model,
    state: "OPEN",
    retryAt: now + DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS,
  });

  now += DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS;
  const trial = acquire(breaker, model);
  assert.equal(trial.state, "HALF_OPEN");
  assert.deepEqual(breaker.acquireCandidate(model), {
    allowed: false,
    model,
    state: "HALF_OPEN",
  });
});

test("success resets consecutive failures and closes a half-open circuit", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 2, cooldownMs: 10, now: () => now });
  const model = "provider/model";

  breaker.recordRetryableFailure(acquire(breaker, model));
  breaker.recordSuccess(acquire(breaker, model));
  breaker.recordRetryableFailure(acquire(breaker, model));
  assert.equal(breaker.snapshot()[0]?.state, "CLOSED");

  breaker.recordRetryableFailure(acquire(breaker, model));
  assert.equal(breaker.snapshot()[0]?.state, "OPEN");

  now = 10;
  breaker.recordSuccess(acquire(breaker, model));
  assert.deepEqual(breaker.snapshot(), [{
    model,
    state: "CLOSED",
    consecutiveFailures: 0,
    halfOpenTrialInProgress: false,
  }]);
});

test("a retryable half-open failure reopens the circuit for a fresh cooldown", () => {
  let now = 100;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 25, now: () => now });
  const model = "provider/model";

  breaker.recordRetryableFailure(acquire(breaker, model));
  now = 125;
  const trial = acquire(breaker, model);
  assert.equal(trial.state, "HALF_OPEN");

  now = 130;
  breaker.recordRetryableFailure(trial);
  assert.deepEqual(breaker.snapshot(), [{
    model,
    state: "OPEN",
    consecutiveFailures: 1,
    openedAt: 130,
    retryAt: 155,
    halfOpenTrialInProgress: false,
  }]);
});

test("circuits are isolated by the exact provider/model key", () => {
  const breaker = new ModelCircuitBreaker({ threshold: 1 });

  breaker.recordRetryableFailure(acquire(breaker, "Provider/model"));

  assert.equal(breaker.acquireCandidate("Provider/model").allowed, false);
  assert.equal(breaker.acquireCandidate("provider/model").allowed, true);
  assert.equal(breaker.acquireCandidate("Provider/other").allowed, true);
  assert.deepEqual(breaker.snapshot().map(({ model, state }) => ({ model, state })), [
    { model: "Provider/model", state: "OPEN" },
    { model: "Provider/other", state: "CLOSED" },
    { model: "provider/model", state: "CLOSED" },
  ]);
});

test("snapshot is frozen and does not advance an expired open circuit", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 5, now: () => now });
  const model = "provider/model";

  breaker.recordRetryableFailure(acquire(breaker, model));
  now = 5;

  const before = breaker.snapshot();
  const after = breaker.snapshot();
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before[0]), true);
  assert.deepEqual(after, before);
  assert.equal(after[0]?.state, "OPEN");
  assert.equal(after[0]?.halfOpenTrialInProgress, false);

  assert.equal(acquire(breaker, model).state, "HALF_OPEN");
  assert.equal(breaker.snapshot()[0]?.halfOpenTrialInProgress, true);
});

test("releasing an inconclusive half-open trial reopens it with a fresh cooldown", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
  const model = "provider/model";
  breaker.recordRetryableFailure(acquire(breaker, model));
  now = 10;
  const trial = acquire(breaker, model);
  now = 12;
  breaker.releaseCandidate(trial);

  assert.deepEqual(breaker.acquireCandidate(model), {
    allowed: false,
    model,
    state: "OPEN",
    retryAt: 22,
  });
});

test("late closed-generation results cannot alter an open or recovered circuit", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 1, now: () => now });
  const model = "provider/model";
  const late = acquire(breaker, model);

  breaker.recordRetryableFailure(late);
  breaker.recordSuccess(late);
  assert.equal(breaker.snapshot()[0]?.state, "OPEN");

  now = 1;
  const trial = acquire(breaker, model);
  breaker.recordSuccess(trial);
  breaker.recordRetryableFailure(late);
  assert.deepEqual(breaker.snapshot(), [{
    model,
    state: "CLOSED",
    consecutiveFailures: 0,
    halfOpenTrialInProgress: false,
  }]);
});

test("rejects invalid configuration and empty model keys", () => {
  assert.throws(() => new ModelCircuitBreaker({ threshold: 0 }), RangeError);
  assert.throws(() => new ModelCircuitBreaker({ threshold: 1.5 }), RangeError);
  assert.throws(() => new ModelCircuitBreaker({ cooldownMs: -1 }), RangeError);
  assert.throws(() => new ModelCircuitBreaker().acquireCandidate(""), TypeError);
});

test("cooldown of zero allows an immediate half-open trial and preserves single-trial invariant", () => {
  let now = 100;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 0, now: () => now });
  const model = "provider/model";

  breaker.recordRetryableFailure(acquire(breaker, model));
  assert.equal(breaker.snapshot()[0]?.state, "OPEN");

  // cooldown=0 means retryAt === openedAt, so the very next acquire at the
  // same timestamp should transition straight to HALF_OPEN.
  const trial = acquire(breaker, model);
  assert.equal(trial.state, "HALF_OPEN");

  // The watchdog must NOT fire for cooldownMs=0: a second acquire while the
  // trial is unsettled must be rejected, preserving the single-trial gate.
  const second = breaker.acquireCandidate(model);
  assert.equal(second.allowed, false);
  assert.equal(second.state, "HALF_OPEN");

  breaker.recordSuccess(trial);
  assert.equal(breaker.snapshot()[0]?.state, "CLOSED");
});

test("a leaked half-open trial is reclaimed by the watchdog after cooldownMs", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
  const model = "provider/model";

  // Open the circuit, then let cooldown expire to enter HALF_OPEN.
  breaker.recordRetryableFailure(acquire(breaker, model));
  now = 10;
  const trial = acquire(breaker, model);
  assert.equal(trial.state, "HALF_OPEN");

  // Simulate a leaked trial: no recordSuccess / recordRetryableFailure /
  // releaseCandidate is ever called.  Before the watchdog deadline the
  // circuit stays HALF_OPEN and rejects others.
  now = 15;
  assert.deepEqual(breaker.acquireCandidate(model), {
    allowed: false,
    model,
    state: "HALF_OPEN",
  });

  // After cooldownMs elapses from halfOpenEnteredAt (10 + 10 = 20), the
  // watchdog re-opens the circuit so recovery can proceed.
  now = 20;
  const rejected = breaker.acquireCandidate(model);
  // The watchdog fires inside acquireCandidate: HALF_OPEN → open() → OPEN
  // branch.  Because now === openedAt (just set), retryAt = now + cooldownMs.
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.state, "OPEN");

  // After the fresh cooldown, a new trial is possible.
  now = 30;
  const retry = acquire(breaker, model);
  assert.equal(retry.state, "HALF_OPEN");
  breaker.recordSuccess(retry);
  assert.equal(breaker.snapshot()[0]?.state, "CLOSED");
});

test("concurrent acquisitions during half-open: only the first trial is allowed", () => {
  let now = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 5, now: () => now });
  const model = "provider/model";

  breaker.recordRetryableFailure(acquire(breaker, model));
  now = 5;

  // First caller gets the trial.
  const first = breaker.acquireCandidate(model);
  assert.equal(first.allowed, true);
  assert.equal(first.state, "HALF_OPEN");

  // Simulate N concurrent callers — all must be rejected.
  for (let i = 0; i < 5; i += 1) {
    const nth = breaker.acquireCandidate(model);
    assert.equal(nth.allowed, false);
    assert.equal(nth.state, "HALF_OPEN");
  }

  // Trial succeeds — circuit closes and the next acquire is allowed.
  if (first.allowed) breaker.recordSuccess(first);
  assert.equal(breaker.acquireCandidate(model).allowed, true);
});

test("onTransition fires on CLOSED→OPEN→HALF_OPEN→CLOSED transitions", () => {
  const transitions: Array<{ model: string; from: string; to: string }> = [];
  const breaker = new ModelCircuitBreaker({
    threshold: 1,
    cooldownMs: 0,
    onTransition: (transition) => transitions.push({ model: transition.model, from: transition.from, to: transition.to }),
  });
  const acquired = breaker.acquireCandidate("provider/model");
  assert.equal(acquired.allowed, true);
  if (acquired.allowed) breaker.recordRetryableFailure(acquired); // CLOSED → OPEN
  const trial = breaker.acquireCandidate("provider/model"); // OPEN → HALF_OPEN (cooldown 0)
  assert.equal(trial.allowed, true);
  if (trial.allowed) breaker.recordSuccess(trial); // HALF_OPEN → CLOSED
  assert.deepEqual(transitions.map((t) => `${t.from}->${t.to}`), ["CLOSED->OPEN", "OPEN->HALF_OPEN", "HALF_OPEN->CLOSED"]);
});

test("rankModelsByHealth orders healthy first, OPEN last, and stays stable for ties", () => {
  let now = 1_000;
  const breaker = new ModelCircuitBreaker({ now: () => now });
  const never = "never/tried";
  const closed1 = "provider/closed1";
  const closed2 = "provider/closed2";
  const halfOpen = "provider/half";
  const open = "provider/open";

  breaker.recordRetryableFailure(acquire(breaker, closed1)); // CLOSED, 1 failure
  breaker.recordRetryableFailure(acquire(breaker, closed2));
  breaker.recordRetryableFailure(acquire(breaker, closed2)); // CLOSED, 2 failures
  for (let failure = 0; failure < DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD; failure += 1) {
    breaker.recordRetryableFailure(acquire(breaker, halfOpen));
  }
  for (let failure = 0; failure < DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD; failure += 1) {
    breaker.recordRetryableFailure(acquire(breaker, open));
  }
  now += DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS;
  const trial = acquire(breaker, halfOpen); // OPEN → HALF_OPEN recovery trial in progress
  assert.equal(trial.state, "HALF_OPEN");

  const input = [open, halfOpen, closed2, never, closed1];
  assert.deepEqual(rankModelsByHealth(input, breaker), [never, closed1, closed2, halfOpen, open]);
  assert.deepEqual(input, [open, halfOpen, closed2, never, closed1], "input must not be mutated");

  // Ties keep the configured order (stable sort): two never-tried candidates.
  assert.deepEqual(rankModelsByHealth(["b/second", "a/first"], breaker), ["b/second", "a/first"]);
});
