import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyModelHealthFailure,
  ModelCircuitBreaker,
  ModelHealthAttemptState,
  ModelHealthCoordinator,
  type AcquiredModelCandidate,
  type AcquiredModelHealthCandidate,
  type ModelHealthProjection,
  type ModelHealthTarget,
} from "../src/public/v1/retry.ts";

function projection(
  hash: string,
  routes: Record<string, string>,
  aliases: Record<string, string> = {},
): ModelHealthProjection {
  const targets = Object.entries(routes).map(([modelRegistrationId, deploymentId]) => [
    modelRegistrationId,
    { modelRegistrationId, deploymentId },
  ] as const);
  return {
    hash,
    routesByRegistrationId: new Map(targets),
    deploymentsById: new Map([...new Set(Object.values(routes))].map((id) => [id, {}])),
    modelAliases: new Map(Object.entries(aliases)),
  };
}

function acquire(health: ModelHealthCoordinator, model: string): AcquiredModelHealthCandidate {
  const result = health.acquireCandidate(model);
  assert.equal(result.allowed, true);
  return result;
}

function acquireCircuit(breaker: ModelCircuitBreaker, key: string): AcquiredModelCandidate {
  const result = breaker.acquireCandidate(key);
  assert.equal(result.allowed, true);
  return result;
}

test("route failures stay isolated while composite ranking sinks only the failed route", () => {
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });
  health.reconcileProjection(projection("routes-v1", {
    "provider/alpha": "shared",
    "provider/beta": "shared",
    "other/gamma": "other",
  }));

  health.recordFailure(acquire(health, "provider/alpha"), "route");

  const alpha = health.acquireCandidate("provider/alpha");
  assert.equal(alpha.allowed, false);
  assert.equal(alpha.blockedScope, "route");
  assert.equal(health.isHealthy("provider/alpha"), false);
  assert.equal(health.isHealthy("provider/beta"), true);
  assert.equal(health.isHealthy("other/gamma"), true);
  assert.equal(health.snapshot().deployments.find((entry) => entry.model === "shared")?.state, "CLOSED");
  assert.deepEqual(
    health.rankCandidates(["provider/alpha", "provider/beta", "other/gamma"]),
    ["provider/beta", "other/gamma", "provider/alpha"],
  );

  health.recordSuccess(acquire(health, "provider/beta"));
  health.recordSuccess(acquire(health, "other/gamma"));
});

test("deployment failure suppresses every route on that deployment but not another deployment", () => {
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });
  health.reconcileProjection(projection("deployments-v1", {
    "provider/alpha": "shared",
    "provider/beta": "shared",
    "other/gamma": "other",
  }));

  health.recordFailure(acquire(health, "provider/alpha"), "deployment");

  for (const model of ["provider/alpha", "provider/beta"]) {
    const rejected = health.acquireCandidate(model);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.blockedScope, "deployment");
  }
  assert.equal(health.isHealthy("provider/beta"), false);
  assert.equal(health.isHealthy("other/gamma"), true);
  health.recordSuccess(acquire(health, "other/gamma"));
});

test("model aliases share the canonical route circuit", () => {
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });
  health.reconcileProjection(projection(
    "aliases-v1",
    { "provider/canonical": "deployment" },
    { "provider/old-name": "provider/canonical" },
  ));

  const aliasAttempt = acquire(health, "provider/old-name");
  assert.deepEqual(aliasAttempt.target, {
    deploymentId: "deployment",
    modelRegistrationId: "provider/canonical",
  });
  health.recordFailure(aliasAttempt, "route");

  const canonical = health.acquireCandidate("provider/canonical");
  assert.equal(canonical.allowed, false);
  assert.equal(canonical.blockedScope, "route");
  assert.deepEqual(health.snapshot().routes.map((entry) => entry.model), ["provider/canonical"]);
  assert.equal(health.isHealthy("provider/old-name"), false);
});

test("health coordinator rejects sharing one breaker across both scopes", () => {
  const breaker = new ModelCircuitBreaker();
  assert.throws(
    () => new ModelHealthCoordinator({ deploymentBreaker: breaker, routeBreaker: breaker }),
    /separate breaker instances/,
  );
});

test("atomic paired acquisition rolls back an unspent deployment half-open permit", () => {
  let now = 0;
  const deploymentBreaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
  const routeBreaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
  const health = new ModelHealthCoordinator({ deploymentBreaker, routeBreaker });
  health.reconcileProjection(projection("permits-v1", { "provider/model": "deployment" }));

  deploymentBreaker.recordRetryableFailure(acquireCircuit(deploymentBreaker, "deployment"));
  routeBreaker.recordRetryableFailure(acquireCircuit(routeBreaker, "provider/model"));
  now = 10;
  const heldRouteTrial = acquireCircuit(routeBreaker, "provider/model");
  assert.equal(heldRouteTrial.state, "HALF_OPEN");

  const rejected = health.acquireCandidate("provider/model");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.blockedScope, "route");
  assert.deepEqual(deploymentBreaker.snapshot(), [{
    model: "deployment",
    state: "OPEN",
    consecutiveFailures: 1,
    openedAt: 0,
    retryAt: 10,
    halfOpenTrialInProgress: false,
  }]);

  routeBreaker.cancelCandidate(heldRouteTrial);
  const retry = acquire(health, "provider/model");
  assert.equal(retry.deployment.state, "HALF_OPEN");
  assert.equal(retry.route.state, "HALF_OPEN");
  health.recordSuccess(retry);
});

test("attempt-local quarantine and auth suppression respect health scopes", () => {
  const sharedA: ModelHealthTarget = { deploymentId: "shared", modelRegistrationId: "provider/alpha" };
  const sharedB: ModelHealthTarget = { deploymentId: "shared", modelRegistrationId: "provider/beta" };
  const other: ModelHealthTarget = { deploymentId: "other", modelRegistrationId: "other/gamma" };

  const deploymentAttempt = new ModelHealthAttemptState("projection-v1");
  deploymentAttempt.noteFailure(sharedA, classifyModelHealthFailure({ message: "connection refused" }));
  assert.equal(deploymentAttempt.shouldSkip(sharedA), true);
  assert.equal(deploymentAttempt.shouldSkip(sharedB), true);
  assert.equal(deploymentAttempt.shouldSkip(other), false);

  const routeAttempt = new ModelHealthAttemptState("projection-v1");
  const routeAuth = classifyModelHealthFailure({ message: "401 unauthorized", scope: "route" });
  routeAttempt.noteFailure(sharedA, routeAuth);
  assert.equal(routeAttempt.isAuthSuppressed(sharedA), true);
  assert.equal(routeAttempt.shouldSkip(sharedB), false);
  assert.equal(routeAttempt.isDeploymentQuarantined("shared"), false);

  assert.equal(routeAttempt.reconcileProjectionFingerprint("projection-v1"), false);
  assert.equal(routeAttempt.reconcileProjectionFingerprint("projection-v2"), true);
  assert.equal(routeAttempt.shouldSkip(sharedA), false);
});

test("failure classification defaults can be overridden by structured backend scope hooks", () => {
  assert.deepEqual(classifyModelHealthFailure({ message: "connection reset" }), {
    retryKind: "network",
    scope: "deployment",
    affectsCircuit: true,
    suppressAuth: false,
  });
  assert.deepEqual(classifyModelHealthFailure({ message: "503 provider overloaded" }), {
    retryKind: "provider",
    scope: "route",
    affectsCircuit: true,
    suppressAuth: false,
  });
  assert.deepEqual(classifyModelHealthFailure({ status: 401 }), {
    retryKind: "auth",
    scope: "deployment",
    affectsCircuit: true,
    suppressAuth: true,
  });
  assert.deepEqual(
    classifyModelHealthFailure(
      { message: "connection reset" },
      (facts) => facts.retryKind === "network" ? "route" : undefined,
    ),
    {
      retryKind: "network",
      scope: "route",
      affectsCircuit: true,
      suppressAuth: false,
    },
  );
});

test("projection views pin target maps while sharing process-wide breaker stores", () => {
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });
  const first = projection("projection-v1", {
    "provider/model": "deployment-old",
  }, {
    "provider/alias": "provider/model",
  });
  health.reconcileProjection(first);
  const dispatchView = health.createProjectionView(first);

  health.reconcileProjection(projection("projection-v2", {
    "provider/model": "deployment-new",
    "provider/new": "deployment-new",
  }));

  assert.equal(health.resolveTarget("provider/model")?.deploymentId, "deployment-new");
  assert.equal(dispatchView.resolveTarget("provider/alias")?.deploymentId, "deployment-old");
  dispatchView.recordFailure(acquire(dispatchView, "provider/alias"), "deployment");
  assert.equal(
    health.snapshot().deployments.find((entry) => entry.model === "deployment-old")?.state,
    "OPEN",
  );
  assert.equal(
    health.snapshot().deployments.some((entry) => entry.model === "deployment-new"),
    false,
  );
});

test("projection reconciliation preserves live keys and forgets removed route state", () => {
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });
  const first = projection("projection-v1", {
    "provider/removed": "deployment",
    "provider/retained": "deployment",
  });
  assert.equal(health.reconcileProjection(first), true);
  health.recordFailure(acquire(health, "provider/removed"), "route");
  assert.equal(health.reconcileProjection(first), false);

  assert.equal(health.reconcileProjection(projection("projection-v2", {
    "provider/retained": "deployment",
    "provider/new": "deployment",
  })), true);
  assert.deepEqual(health.snapshot().routes.map((entry) => entry.model), []);
  assert.equal(health.isHealthy("provider/removed"), true);
  health.recordSuccess(acquire(health, "provider/new"));
});
