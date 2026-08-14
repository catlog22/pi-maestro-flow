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

const responseV12 = {
  schema_version: "run-response/1.2",
  operation: "artifact-inspect",
  ok: true,
  exit_code: 0,
  disposition: "success",
  request_id: null,
  locator: { session_id: "session-1", run_id: "run-source" },
  revision: { target_type: "artifact", target_id: "ART-source", revision: 7 },
  result: {
    schema_version: "artifact-compatibility/1.0",
    assessment_hash: `sha256:${"a".repeat(64)}`,
    source: {
      session_schema_version: "session/3.0",
      session_revision: 4,
      artifact_registry_revision: 7,
    },
    diagnostics: {
      lease_id: "private-v12-lease",
      participant_token: "private-v12-token",
      visible: true,
    },
  },
  replay: null,
  warnings: [],
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

test("run-response parser accepts and publicly projects artifact inspect run-response/1.2", () => {
  const parsed = parseRunResponse(responseV12);
  assert.equal(parsed.schema_version, "run-response/1.2");
  assert.equal(parsed.operation, "artifact-inspect");
  assert.equal(parsed.locator?.session_id, "session-1");
  assert.deepEqual(parsed.revision, { target_type: "artifact", target_id: "ART-source", revision: 7 });

  const projected = projectPublicRunResponse(parsed);
  assert.deepEqual((projected.result as Record<string, unknown>).diagnostics, { visible: true });
  assert.equal(JSON.stringify(projected).includes("private-v12"), false);
  assert.equal(extractRunResponseLeaseClaim(parsed), null);
});

test("run-response parser accepts artifact republish success, domain error, and revision conflict", async (t) => {
  await t.test("success", () => {
    const parsed = parseRunResponse({
      ...responseV12,
      operation: "artifact-republish",
      request_id: "request-republish",
      revision: { target_type: "artifact", target_id: "ART-derived", revision: 8 },
      replay: { status: "applied", transition_id: "transition-republish" },
      result: {
        source_artifact_id: "ART-source",
        artifact_id: "ART-derived",
        receipt: { schema_version: "artifact-republish/1.0" },
      },
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.replay?.status, "applied");
  });

  await t.test("domain error", () => {
    const parsed = parseRunResponse({
      ...responseV12,
      operation: "artifact-republish",
      ok: false,
      exit_code: 1,
      disposition: "domain_error",
      result: null,
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "assessment changed",
        retryable: false,
        details: { visible: true },
        target_type: null,
        target_id: null,
        expected_revision: null,
        current_revision: null,
        changed_by: null,
        next_actions: ["inspect-artifact-compatibility"],
      },
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.code, "INVALID_STATE_TRANSITION");
  });

  await t.test("revision conflict", () => {
    const parsed = parseRunResponse({
      ...responseV12,
      operation: "artifact-republish",
      ok: false,
      exit_code: 3,
      disposition: "control_flow",
      result: null,
      error: {
        code: "ORCHESTRATION_REVISION_CONFLICT",
        message: "stale orchestration revision",
        retryable: true,
        details: {},
        target_type: "orchestration",
        target_id: "session-1",
        expected_revision: 4,
        current_revision: 5,
        changed_by: "participant-other",
        next_actions: ["inspect-artifact-compatibility", "resubmit-with-new-request-id"],
      },
    });
    assert.equal(parsed.error?.current_revision, 5);
    assert.deepEqual(parsed.error?.next_actions, [
      "inspect-artifact-compatibility",
      "resubmit-with-new-request-id",
    ]);
  });
});

test("run-response/1.2 enforces strict conflict and public credential boundaries", () => {
  assert.throws(
    () => parseRunResponse({ ...responseV12, extra: true }),
    RunResponseParseError,
  );
  assert.throws(
    () => parseRunResponse({ ...responseV12, result: { lease_claim: { lease_id: "private-v12" } } }),
    /lease_claim is not permitted/,
  );
  assert.throws(
    () => parseRunResponse({
      ...responseV12,
      operation: "artifact-republish",
      ok: false,
      exit_code: 3,
      disposition: "control_flow",
      result: null,
      error: {
        code: "RUN_REVISION_CONFLICT",
        message: "conflict",
        retryable: true,
        details: {},
        target_type: "run",
        target_id: "run-1",
        expected_revision: 1,
        current_revision: 2,
        changed_by: null,
        next_actions: [],
      },
    }),
    RunResponseParseError,
  );
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

// The distributed operation claim/drain credential experiment was removed.
// V1.1 operation enums remain fail-closed for its retired operation kinds.
test("run-response parser rejects removed operation claim credentials and operation kinds fail-closed", () => {
  assert.throws(
    () => parseRunResponse({
      ...responseV11,
      result: {
        operation_claim: {
          operation_id: "turn-1",
          kind: "turn",
          operation_token: "private-operation-token",
        },
      },
    }),
    /operation_claim is not permitted/,
  );
  for (const operation of [
    "execution-operation-claim",
    "execution-operation-heartbeat",
    "execution-operation-release",
    "execution-operation-status",
  ]) {
    assert.throws(
      () => parseRunResponse({ ...responseV11, operation, result: {} }),
      RunResponseParseError,
    );
  }
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
