import assert from "node:assert/strict";
import test from "node:test";
import {
  RunResponseParseError,
  UnsupportedRunResponseVersionError,
  extractRunResponseLeaseClaim,
  parseRunResponse,
  projectPublicRunResponse,
} from "../src/session/run-response.ts";

const responseV10 = {
  schema_version: "run-response/1.0",
  operation: "check",
  ok: true,
  exit_code: 0,
  request_id: "request-v10",
  locator: { session_id: "session-1", run_id: "run-1" },
  result: { state: "running" },
  next: null,
  continuation: null,
  replay: { status: "applied", transition_id: "transition-v10" },
  error: null,
};

const responseV11 = {
  schema_version: "run-response/1.1",
  operation: "execution-attach",
  ok: true,
  exit_code: 0,
  disposition: "success",
  request_id: "request-v11",
  locator: {
    session_id: "session-1",
    execution_id: "execution-2",
    generation: 2,
    run_id: "run-9",
  },
  fence: {
    session_identity_revision: 4,
    session_activity_revision: 12,
    execution_revision: 7,
    lease_epoch: 3,
  },
  result: {
    owner: "pi-session",
    lease_claim: {
      schema_version: "execution-lease-claim/1.0",
      lease_id: "private-top-level",
      nested: { lease_id: "private-nested" },
    },
    diagnostic: {
      lease_id: "private-diagnostic",
      handoff_token: "private-handoff-token",
      safe: "kept",
      message: "lease_claim={lease_id=private-text-claim} --handoff-token private-text-token",
      values: [{ lease_id: "private-array" }, { visible: true }],
    },
  },
  next: null,
  continuation: null,
  replay: { status: "replayed", transition_id: "transition-v11" },
  warnings: [{
    code: "LEGACY_ALIAS",
    message: "Use execution status",
    replacement_command: "maestro execution status",
  }],
  error: null,
};

test("run-response parser strictly accepts and types the 1.0 compatibility envelope", () => {
  const parsed = parseRunResponse(JSON.stringify(responseV10));
  assert.equal(parsed.schema_version, "run-response/1.0");
  assert.equal(parsed.locator?.session_id, "session-1");
  assert.equal(parsed.locator?.run_id, "run-1");
  assert.deepEqual(parsed.replay, { status: "applied", transition_id: "transition-v10" });
  assert.deepEqual(parsed.result, { state: "running" });
});

test("run-response parser extracts 1.1 execution locators, fences, warnings, replay, and private result", () => {
  const parsed = parseRunResponse(responseV11);
  assert.equal(parsed.schema_version, "run-response/1.1");
  assert.equal(parsed.locator?.execution_id, "execution-2");
  assert.equal(parsed.locator?.generation, 2);
  assert.equal(parsed.fence?.execution_revision, 7);
  assert.equal(parsed.fence?.lease_epoch, 3);
  assert.equal(parsed.warnings[0]?.code, "LEGACY_ALIAS");
  assert.equal(parsed.replay?.status, "replayed");
  assert.equal(extractRunResponseLeaseClaim(parsed)?.lease_id, "private-top-level");
});

test("public run-response projection removes the lease claim and every raw lease_id recursively", () => {
  const parsed = parseRunResponse(responseV11);
  const projected = projectPublicRunResponse(parsed);
  const projectedResult = projected.result as Record<string, unknown>;

  assert.equal("lease_claim" in projectedResult, false);
  assert.deepEqual(projectedResult, {
    owner: "pi-session",
    diagnostic: {
      safe: "kept",
      message: "lease_claim=<redacted> --handoff-token <redacted>",
      values: [{}, { visible: true }],
    },
  });
  assert.equal(extractRunResponseLeaseClaim(parsed)?.lease_id, "private-top-level");
  assert.equal(JSON.stringify(projected).includes("private-"), false);
});

test("run-response parser permits private claims only for authorized successful 1.1 acquisitions", async (t) => {
  const authorizedOperations = [
    "execution-start",
    "execution-attach",
    "execution-resume",
    "execution-handoff-accept",
    "execution-lease-recover",
  ];
  for (const operation of authorizedOperations) {
    await t.test(operation, () => {
      const parsed = parseRunResponse({ ...responseV11, operation });
      assert.equal(extractRunResponseLeaseClaim(parsed)?.lease_id, "private-top-level");
    });
  }
});

test("run-response parser rejects private claims from status, non-acquisition, failure, and 1.0 envelopes", () => {
  for (const operation of ["execution-status", "execution-lease-status", "execution-lease-heartbeat"]) {
    assert.throws(
      () => parseRunResponse({ ...responseV11, operation }),
      /lease_claim is not permitted/,
    );
  }
  assert.throws(
    () => parseRunResponse({ ...responseV11, operation: "show" }),
    RunResponseParseError,
  );
  assert.throws(
    () => parseRunResponse({ ...responseV10, result: { lease_claim: { lease_id: "private-v10" } } }),
    /lease_claim is not permitted/,
  );
  assert.throws(
    () => parseRunResponse({
      ...responseV11,
      ok: false,
      exit_code: 3,
      disposition: "control_flow",
      result: { lease_claim: { lease_id: "private-error" } },
      error: {
        code: "LEASE_BUSY",
        message: "busy",
        retryable: true,
        details: {},
        recovery_command: null,
      },
    }),
    RunResponseParseError,
  );
});

test("run-response parser rejects unsupported, malformed, and non-strict envelopes", () => {
  assert.throws(
    () => parseRunResponse({ ...responseV11, schema_version: "run-response/2.0" }),
    UnsupportedRunResponseVersionError,
  );
  assert.throws(
    () => parseRunResponse({ ...responseV11, locator: { ...responseV11.locator, generation: -1 } }),
    RunResponseParseError,
  );
  assert.throws(
    () => parseRunResponse({ ...responseV10, unexpected: true }),
    RunResponseParseError,
  );
  const { continuation: _continuation, ...missingContinuation } = responseV10;
  assert.throws(
    () => parseRunResponse(missingContinuation),
    /missing continuation/,
  );
  assert.throws(
    () => parseRunResponse({ ...responseV11, result: { lease_claim: { lease_id: "" } } }),
    /lease_claim must contain a non-empty lease_id/,
  );
});
