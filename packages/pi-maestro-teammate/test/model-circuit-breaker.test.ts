import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD,
  ModelCircuitBreaker,
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
