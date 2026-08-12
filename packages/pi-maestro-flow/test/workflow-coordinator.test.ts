import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Check } from "typebox/value";
import {
  defaultRunner,
  RunCliAdapter,
  type RunCliCapabilities,
  type RunCliResult,
  type RunDoneOptions,
  type RunEditOptions,
  type RunPlanPublishOptions,
} from "../src/session/cli-adapter.ts";
import { WorkflowBridge } from "../src/session/bridge.ts";
import {
  publicWorkflowErrorMessage,
  WorkflowCoordinator,
  WorkflowLeaseBusyError,
  WorkflowLeaseStore,
  type WorkflowRunAdapter,
  type WorkflowSnapshotProvider,
} from "../src/session/coordinator.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import {
  classifyRunControlArgv,
  executeRunControl,
  RunControlParams,
} from "../src/tools/run-control.ts";
import {
  assertPublishedPlanSnapshot,
  derivePlanPublishRequestId,
  parsePublishedPlanIdentity,
  requirePublishedExecutionRun,
} from "../src/tools/plan-workflow.ts";

test("run-control schema rejects unknown fields", () => {
  assert.equal(Check(RunControlParams, { argv: ["session", "status"] }), true);
  assert.equal(Check(RunControlParams, { argv: ["session", "status"], typo: true }), false);
  assert.equal(Check(RunControlParams, { argv: ["session", "status"], hostSessionId: "spoofed" }), false);
});

test("run-control classification covers reads, Session CAS, Execution acquisition, and lease writes", () => {
  const cases: Array<{
    argv: string[];
    expected: ReturnType<typeof classifyRunControlArgv>;
  }> = [
    { argv: ["capabilities", "--json"], expected: readClassification() },
    { argv: ["skills", "--steps"], expected: readClassification() },
    { argv: ["run", "status"], expected: readClassification() },
    { argv: ["run", "brief"], expected: readClassification() },
    { argv: ["run", "check"], expected: readClassification() },
    { argv: ["session", "status"], expected: readClassification() },
    { argv: ["session", "show"], expected: readClassification() },
    { argv: ["session", "list"], expected: readClassification() },
    { argv: ["execution", "status"], expected: readClassification() },
    { argv: ["execution", "show"], expected: readClassification() },
    { argv: ["execution", "list"], expected: readClassification() },
    { argv: ["execution", "lease", "status"], expected: readClassification() },
    { argv: ["session", "create"], expected: writeClassification("session", "none", true) },
    { argv: ["session", "archive"], expected: writeClassification("session", "none") },
    { argv: ["session", "unarchive"], expected: writeClassification("session", "none") },
    { argv: ["session", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["run", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["run", "create"], expected: writeClassification("execution", "required", true) },
    { argv: ["run", "next"], expected: writeClassification("execution", "required") },
    { argv: ["run", "complete"], expected: writeClassification("execution", "required") },
    { argv: ["run", "decide"], expected: writeClassification("execution", "required") },
    { argv: ["plan", "publish", "approved.md", "--handoff-key", "handoff-1"], expected: writeClassification("plan-publish", "required") },
    { argv: ["execution", "start"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "attach"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "pause"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "resolve"], expected: writeClassification("execution", "none") },
    { argv: ["execution", "resume"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "seal"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "handoff", "prepare"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "handoff", "accept"], expected: writeClassification("execution-acquire", "acquire") },
    { argv: ["execution", "handoff", "cancel"], expected: writeClassification("execution", "required") },
    { argv: ["execution", "lease", "heartbeat"], expected: writeClassification("execution-lease", "required") },
    { argv: ["execution", "lease", "release"], expected: writeClassification("execution-lease", "required") },
    { argv: ["execution", "lease", "recover"], expected: writeClassification("execution-lease", "acquire") },
    { argv: ["session", "next"], expected: writeClassification("execution", "required") },
    { argv: ["future", "command"], expected: writeClassification("execution", "required") },
  ];

  for (const fixture of cases) {
    assert.deepEqual(classifyRunControlArgv(fixture.argv), fixture.expected, fixture.argv.join(" "));
  }
});

test("public workflow errors redact lease-path fencing tokens", () => {
  const token = "123e4567-e89b-42d3-a456-426614174000";
  const message = publicWorkflowErrorMessage(new Error(
    `EPERM: D:/workspace/.workflow/tmp/hook/session-1.lease/3.${token}.state.json`,
  ));
  assert.doesNotMatch(message, new RegExp(token));
  assert.match(message, /<redacted>/);
  const coreMessage = publicWorkflowErrorMessage(new Error(
    'maestro execution pause --lease-id private-lease --handoff-token private-handoff '
    + 'failed: {"lease_id":"private-json-lease","token":"private-json-token"}',
  ));
  for (const secret of ["private-lease", "private-handoff", "private-json-lease", "private-json-token"]) {
    assert.equal(coreMessage.includes(secret), false, `public errors must redact ${secret}`);
  }
  assert.equal(publicWorkflowErrorMessage(new Error("ordinary workflow failure")), "ordinary workflow failure");
});

test("old CLI is read-only and fail-closed unless legacy compatibility is explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-old-cli-"));
  const snapshot = workflowSnapshot("running");
  const calls: string[][] = [];
  const store = new WorkflowLeaseStore(root);
  const defaultCoordinator = new WorkflowCoordinator(fakeBridge(snapshot), fakeAdapter(calls), store);
  try {
    assert.equal(await defaultCoordinator.selectMode(), "fail-closed");
    const read = await defaultCoordinator.exec(["session", "status"], readClassification());
    assert.equal(read.command.stdout, "exec session status");
    await assert.rejects(defaultCoordinator.attach("pi-old"), /authority mode is fail-closed/);
    assert.equal(store.current(), undefined);

    const compatible = WorkflowCoordinator.legacyCompatible(
      fakeBridge(snapshot),
      fakeAdapter([]),
      new WorkflowLeaseStore(root),
    );
    try {
      assert.equal(await compatible.selectMode(), "legacy-host");
      await compatible.attach("pi-old");
      assert.equal(compatible.mode(), "legacy-host");
    } finally {
      await compatible.release();
    }
  } finally {
    await defaultCoordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core-execution selection negotiates full support and never uses the legacy host lease store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-mode-"));
  const calls: string[][] = [];
  const store = new WorkflowLeaseStore(root);
  const snapshot = coreWorkflowSnapshot();
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot),
    store,
  );
  try {
    await coordinator.selectMode("core-execution");
    assert.equal(coordinator.mode(), "core-execution");
    const attached = await coordinator.attach("pi-core");
    assert.equal(store.current(), undefined, "core mode must not acquire the legacy host lease");
    assert.deepEqual(attached.lease, {
      sessionId: "session-1",
      executionId: "execution-1",
      generation: 1,
      ownerId: "pi-core",
      epoch: 4,
      executionRevision: 8,
    });
    assert.equal("lease_id" in attached.lease, false);

    const callsBeforeSpoof = calls.length;
    await assert.rejects(
      coordinator.exec(
        ["execution", "pause", "--execution", "execution-other", "--reason", "spoof"],
        classifyRunControlArgv(["execution", "pause"]),
        "pi-core",
      ),
      /--execution conflicts with coordinator authority/,
    );
    assert.equal(calls.length, callsBeforeSpoof, "conflicting locators must be rejected before raw CLI execution");

    const paused = await coordinator.exec(
      ["execution", "pause", "--reason", "checkpoint"],
      classifyRunControlArgv(["execution", "pause"]),
      "pi-core",
    );
    const internalPause = calls.find((call) => call[0] === "exec" && call[1] === "execution" && call[2] === "pause")!;
    assert.equal(flagValue(internalPause, "--session"), "session-1");
    assert.equal(flagValue(internalPause, "--execution"), "execution-1");
    assert.equal(flagValue(internalPause, "--expected-execution-revision"), "8");
    assert.equal(flagValue(internalPause, "--execution-owner"), "pi-core");
    assert.equal(flagValue(internalPause, "--owner-kind"), "pi");
    assert.equal(flagValue(internalPause, "--owner-epoch"), "4");
    assert.equal(flagValue(internalPause, "--actor"), "pi-core");
    assert.equal(flagValue(internalPause, "--evidence"), "pi-session:pi-core");
    assert.equal(flagValue(internalPause, "--lease-id"), "private-core-lease");
    assert.equal(JSON.stringify(paused).includes("private-core-lease"), false);
    assert.equal(JSON.stringify(paused).includes("lease_claim"), false);
    await assert.rejects(
      coordinator.done("run-1", {}, { hostSessionId: "pi-core" }),
      /no transient core lease claim is held/,
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core-execution start and resume use documented acquisition fences", async () => {
  const startRoot = await mkdtemp(join(tmpdir(), "pi-workflow-core-start-"));
  const startSnapshot = coreWorkflowSnapshot();
  const futureExecution = startSnapshot.execution!;
  startSnapshot.locator = { sessionId: "session-1" };
  startSnapshot.execution = undefined;
  startSnapshot.revision.executionRevision = undefined;
  startSnapshot.session!.activeRunId = null;
  const startCalls: string[][] = [];
  const startCoordinator = testCoordinator(
    fakeBridge(startSnapshot),
    coreAdapter(startCalls, startSnapshot, (argv) => {
      const response = coreRunResponse(operationForArgv(argv));
      if (argv[0] === "execution" && argv[1] === "start") {
        startSnapshot.locator = {
          sessionId: "session-1",
          executionId: "execution-1",
          generation: 1,
          runId: "run-1",
        };
        startSnapshot.execution = { ...futureExecution, revision: 8 };
        startSnapshot.revision.executionRevision = 8;
      }
      return response;
    }),
    new WorkflowLeaseStore(startRoot),
  );
  try {
    await startCoordinator.exec(
      ["execution", "start"],
      classifyRunControlArgv(["execution", "start"]),
      "pi-owner",
    );
    const start = startCalls.find((call) => call[1] === "execution" && call[2] === "start")!;
    assert.equal(flagValue(start, "--session"), "session-1");
    assert.equal(start.includes("--execution"), false);
    assert.equal(flagValue(start, "--expected-identity-revision"), "3");
    assert.equal(flagValue(start, "--expected-activity-revision"), "5");
    assert.equal(flagValue(start, "--expected-lease-epoch"), "0");
    assert.equal(flagValue(start, "--execution-owner"), "pi-owner");
    assert.equal(flagValue(start, "--owner-kind"), "pi");
  } finally {
    await startCoordinator.release();
    await rm(startRoot, { recursive: true, force: true });
  }

  const resumeRoot = await mkdtemp(join(tmpdir(), "pi-workflow-core-resume-"));
  const resumeCalls: string[][] = [];
  const resumeSnapshot = coreWorkflowSnapshot();
  const resumeCoordinator = testCoordinator(
    fakeBridge(resumeSnapshot),
    coreAdapter(resumeCalls, resumeSnapshot),
    new WorkflowLeaseStore(resumeRoot),
  );
  try {
    await resumeCoordinator.attach("pi-owner");
    await resumeCoordinator.exec(
      ["execution", "pause", "--reason", "checkpoint", "--evidence", "ART-1"],
      classifyRunControlArgv(["execution", "pause"]),
      "pi-owner",
    );
    await resumeCoordinator.exec(
      ["execution", "resume", "--reason", "continue", "--evidence", "ART-2"],
      classifyRunControlArgv(["execution", "resume"]),
      "pi-owner",
    );
    const resume = resumeCalls.find((call) => call[1] === "execution" && call[2] === "resume")!;
    assert.equal(flagValue(resume, "--session"), "session-1");
    assert.equal(flagValue(resume, "--execution"), "execution-1");
    assert.equal(flagValue(resume, "--expected-execution-revision"), "8");
    assert.equal(flagValue(resume, "--expected-activity-revision"), "5");
    assert.equal(flagValue(resume, "--expected-lease-epoch"), "4");
    assert.equal(flagValue(resume, "--execution-owner"), "pi-owner");
    assert.equal(flagValue(resume, "--owner-kind"), "pi");
    assert.equal(resume.includes("--lease-id"), false, "acquisition must not send an existing lease token");
  } finally {
    await resumeCoordinator.release();
    await rm(resumeRoot, { recursive: true, force: true });
  }
});

test("core-execution mutations fail closed for missing support, locator, claim, or response fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-fail-closed-"));
  try {
    const missingSupportCalls: string[][] = [];
    const missingSupportSnapshot = coreWorkflowSnapshot();
    const missingSupport = testCoordinator(
      fakeBridge(missingSupportSnapshot),
      coreAdapter(missingSupportCalls, missingSupportSnapshot, undefined, {
        ...fullCoreCapabilities(),
        support: {
          ...fullCoreCapabilities().support,
          core_execution_lease: false,
        },
      }),
      new WorkflowLeaseStore(root),
    );
    assert.equal(await missingSupport.selectMode(), "fail-closed");
    assert.equal(await missingSupport.supportsNewPlanSession(), false);
    assert.equal(missingSupport.mode(), "fail-closed");
    const read = await missingSupport.exec(
      ["execution", "status"],
      classifyRunControlArgv(["execution", "status"]),
    );
    assert.equal(read.command.stdout, "read execution status");
    await assert.rejects(
      missingSupport.exec(
        ["execution", "attach"],
        classifyRunControlArgv(["execution", "attach"]),
        "pi-core",
      ),
      /authority mode is fail-closed/,
    );

    const missingSessionWriterCapabilities = fullCoreCapabilities();
    missingSessionWriterCapabilities.structured!.session_schema_writes = ["session/1.3"];
    const missingSessionWriter = testCoordinator(
      fakeBridge(coreWorkflowSnapshot()),
      coreAdapter([], coreWorkflowSnapshot(), undefined, missingSessionWriterCapabilities),
      new WorkflowLeaseStore(root),
    );
    assert.equal(await missingSessionWriter.selectMode(), "fail-closed");
    assert.equal(await missingSessionWriter.supportsNewPlanSession(), false);

    const missingStatuslessCapabilities = fullCoreCapabilities();
    missingStatuslessCapabilities.structured!.features.session_statusless = false;
    const missingStatusless = testCoordinator(
      fakeBridge(coreWorkflowSnapshot()),
      coreAdapter([], coreWorkflowSnapshot(), undefined, missingStatuslessCapabilities),
      new WorkflowLeaseStore(root),
    );
    assert.equal(await missingStatusless.selectMode(), "fail-closed");
    await assert.rejects(
      missingStatusless.exec(
        ["execution", "attach"],
        classifyRunControlArgv(["execution", "attach"]),
        "pi-core",
      ),
      /authority mode is fail-closed/,
    );

    const legacySnapshot = workflowSnapshot("running");
    const legacyStore = new WorkflowLeaseStore(root);
    const legacy = new WorkflowCoordinator(
      fakeBridge(legacySnapshot),
      coreAdapter([], legacySnapshot, undefined, legacyCoreCapabilities()),
      legacyStore,
      10_000,
      { legacyCompatibility: true },
    );
    try {
      await legacy.attach("pi-legacy");
      assert.equal(legacy.mode(), "legacy-host");
      assert.equal(await legacy.supportsNewPlanSession(), true);
      assert.equal(legacyStore.current()?.hostSessionId, "pi-legacy");
    } finally {
      await legacy.release();
    }

    const malformedSnapshot = coreWorkflowSnapshot();
    const malformed = testCoordinator(
      fakeBridge(malformedSnapshot),
      coreAdapter([], malformedSnapshot, undefined, failClosedCoreCapabilities("malformed capabilities response")),
      new WorkflowLeaseStore(root),
    );
    assert.equal(await malformed.selectMode(), "fail-closed");
    assert.equal((await malformed.exec(
      ["execution", "status"],
      classifyRunControlArgv(["execution", "status"]),
    )).command.stdout, "read execution status");
    await assert.rejects(
      malformed.exec(
        ["execution", "attach"],
        classifyRunControlArgv(["execution", "attach"]),
        "pi-core",
      ),
      /malformed capabilities response/,
    );

    const missingLocatorSnapshot = workflowSnapshot("running");
    const missingLocator = testCoordinator(
      fakeBridge(missingLocatorSnapshot),
      coreAdapter([], missingLocatorSnapshot),
      new WorkflowLeaseStore(root),
    );
    await missingLocator.selectMode("core-execution");
    await assert.rejects(
      missingLocator.exec(
        ["execution", "attach"],
        classifyRunControlArgv(["execution", "attach"]),
        "pi-core",
      ),
      /non-legacy Session\/Execution\/generation locator is required/,
    );

    const missingClaimSnapshot = coreWorkflowSnapshot();
    const missingClaim = testCoordinator(
      fakeBridge(missingClaimSnapshot),
      coreAdapter([], missingClaimSnapshot),
      new WorkflowLeaseStore(root),
    );
    await missingClaim.selectMode("core-execution");
    await assert.rejects(
      missingClaim.exec(
        ["execution", "pause"],
        classifyRunControlArgv(["execution", "pause"]),
        "pi-core",
      ),
      /no transient core lease claim is held/,
    );

    const missingFenceSnapshot = coreWorkflowSnapshot();
    const missingFence = testCoordinator(
      fakeBridge(missingFenceSnapshot),
      coreAdapter([], missingFenceSnapshot, () => coreRunResponse("execution-attach", { fence: null })),
      new WorkflowLeaseStore(root),
    );
    await missingFence.selectMode("core-execution");
    await assert.rejects(
      missingFence.exec(
        ["execution", "attach"],
        classifyRunControlArgv(["execution", "attach"]),
        "pi-core",
      ),
      /current core fence is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy session/1.x compatibility projections select legacy-host with a structured core CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-legacy-projection-"));
  const snapshot = workflowSnapshot("running");
  snapshot.locator = {
    sessionId: "session-1",
    executionId: "legacy:session-1",
    generation: 1,
    runId: "run-1",
  };
  snapshot.execution = {
    executionId: "legacy:session-1",
    sessionId: "session-1",
    generation: 1,
    status: "active",
    revision: 1,
    activeRunId: "run-1",
    chain: snapshot.session!.chain,
    decisionPoints: [],
    gatesRef: "gates.json",
    artifactsRef: "artifacts.json",
    evidenceRef: "evidence.json",
    lease: null,
    startedAt: "",
    sealedAt: null,
    sealSummary: null,
    finalOutcome: null,
    legacyProjection: true,
  };
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter([], snapshot),
    new WorkflowLeaseStore(root),
  );
  try {
    assert.equal(await coordinator.selectMode(), "legacy-host");
    const attached = await coordinator.attach("pi-legacy-projection");
    assert.equal(attached.snapshot.execution?.legacyProjection, true);
    assert.equal(coordinator.mode(), "legacy-host");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core-execution mode is sticky and run-control public results redact acquisition claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-redaction-"));
  const snapshot = coreWorkflowSnapshot();
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter([], snapshot),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.selectMode("core-execution");
    await assert.rejects(coordinator.selectMode("legacy-host"), /cannot select legacy-host/);
    assert.equal(coordinator.mode(), "core-execution");

    const acquired = await executeRunControl(
      { argv: ["execution", "attach"] },
      coordinator,
      { hostSessionId: "pi-core" },
    );
    assert.equal(acquired.ok, true);
    const serialized = JSON.stringify(acquired);
    assert.equal(serialized.includes("private-core-lease"), false);
    assert.equal(serialized.includes("private-nested-token"), false);
    assert.equal(serialized.includes("lease_claim"), false);
    assert.equal(serialized.includes('"lease_id"'), false);
    assert.equal(serialized.includes('"token"'), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core host operations preserve claim hierarchy and handoff prepare drains from its current tool claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-operation-drain-"));
  const snapshot = coreWorkflowSnapshot();
  const calls: string[][] = [];
  let registryRevision = 0;
  const activeClaims = new Map<string, { kind: string; parent_operation_id: string | null }>();
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot, (argv) => {
      const operation = operationForArgv(argv);
      if (operation === "execution-attach") return coreRunResponse(operation);
      if (operation === "execution-operation-status") {
        return coreRunResponse(operation, {
          result: {
            operation_registry: {
              revision: registryRevision,
              admission: "open",
              active_claims: Object.fromEntries(activeClaims),
            },
          },
        });
      }
      if (operation === "execution-operation-claim") {
        const operationId = flagValue(argv, "--operation-id")!;
        registryRevision++;
        activeClaims.set(operationId, {
          kind: flagValue(argv, "--kind")!,
          parent_operation_id: flagValue(argv, "--parent-operation") ?? null,
        });
        return coreRunResponse(operation, {
          result: {
            operation_registry: {
              revision: registryRevision,
              admission: "open",
              active_claims: Object.fromEntries(activeClaims),
            },
            operation_claim: {
              operation_id: operationId,
              operation_token: `private-${operationId}`,
            },
          },
        });
      }
      if (operation === "execution-operation-heartbeat" || operation === "execution-operation-release") {
        const operationId = flagValue(argv, "--operation-id")!;
        registryRevision++;
        if (operation.endsWith("release")) activeClaims.delete(operationId);
        return coreRunResponse(operation, {
          result: {
            operation_registry: {
              revision: registryRevision,
              admission: "open",
              active_claims: Object.fromEntries(activeClaims),
            },
          },
        });
      }
      if (operation === "execution-handoff-prepare") {
        registryRevision++;
        return coreRunResponse(operation, {
          result: { operation_registry_revision: registryRevision, to_owner_id: "pi-next" },
        });
      }
      return coreRunResponse(operation);
    }),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("pi-owner");
    const turn = await coordinator.claimHostOperation("turn-1", "turn", "pi-owner");
    const childTool = await coordinator.claimHostOperation("tool-1", "tool", "pi-owner", turn.operationId);
    assert.equal(childTool.parentOperationId, "turn-1");
    const childClaimCall = calls.find((call) => flagValue(call, "--operation-id") === "tool-1")!;
    assert.equal(flagValue(childClaimCall, "--parent-operation-token"), "private-turn-1");
    await coordinator.heartbeatHostOperation("tool-1", "pi-owner");
    await coordinator.releaseHostOperation("tool-1", "pi-owner");

    const drainTool = await coordinator.claimHostOperation("tool-handoff", "tool", "pi-owner");
    const prepared = await executeRunControl(
      { argv: ["execution", "handoff", "prepare", "--to-owner-id", "pi-next"] },
      coordinator,
      { hostSessionId: "pi-owner", toolOperationId: drainTool.operationId },
    );
    assert.equal(prepared.ok, true);
    const prepareCall = calls.find((call) => call[2] === "handoff" && call[3] === "prepare")!;
    assert.equal(flagValue(prepareCall, "--drain-operation"), "tool-handoff");
    assert.equal(flagValue(prepareCall, "--drain-operation-token"), "private-tool-handoff");
    await coordinator.releaseHostOperation("tool-handoff", "pi-owner");
    const releaseCall = calls.findLast((call) => call[2] === "operation" && call[3] === "release")!;
    assert.equal(flagValue(releaseCall, "--expected-operation-registry-revision"), String(registryRevision - 1));
    assert.equal(JSON.stringify(await coordinator.operationStatus("pi-owner")).includes("private-"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

// execution_operation_drain is an optional capability of the deprecated
// operation drain experiment (superseded by
// docs/session-run-minimal-state-architecture-20260812.md). A core that does
// not advertise it must still negotiate the modern core-execution protocol,
// with every operation claim/heartbeat/release/drain feature gated off.
test("core coordinator keeps the modern protocol and gates drain features off without the optional capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-no-drain-"));
  const snapshot = coreWorkflowSnapshot();
  const calls: string[][] = [];
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot, undefined, noDrainCoreCapabilities()),
    new WorkflowLeaseStore(root),
  );
  try {
    assert.equal(await coordinator.selectMode(), "core-execution");
    assert.equal(coordinator.supportsOperationDrain(), false);
    await coordinator.attach("pi-owner");

    const callsBeforeOperations = calls.length;
    await assert.rejects(
      coordinator.claimHostOperation("turn-1", "turn", "pi-owner"),
      /execution_operation_drain/,
    );
    await assert.rejects(coordinator.operationStatus("pi-owner"), /execution_operation_drain/);
    await assert.rejects(
      coordinator.heartbeatHostOperation("turn-1", "pi-owner"),
      /execution_operation_drain/,
    );
    await assert.rejects(
      coordinator.releaseHostOperation("turn-1", "pi-owner"),
      /execution_operation_drain/,
    );
    assert.equal(calls.length, callsBeforeOperations, "gated operation mutations must not reach the CLI");

    const passthrough = await executeRunControl(
      { argv: ["execution", "operation", "claim", "--operation-id", "tool-1", "--kind", "tool"] },
      coordinator,
      { hostSessionId: "pi-owner" },
    );
    assert.equal(passthrough.ok, false);
    assert.match(passthrough.message, /execution_operation_drain/);
    assert.equal(calls.length, callsBeforeOperations, "gated passthrough must not reach the CLI");

    const prepared = await executeRunControl(
      { argv: ["execution", "handoff", "prepare", "--to-owner-id", "pi-next"] },
      coordinator,
      { hostSessionId: "pi-owner" },
    );
    assert.equal(prepared.ok, true);
    const prepareCall = calls.find((call) => call[2] === "handoff" && call[3] === "prepare")!;
    assert.equal(prepareCall.includes("--drain-operation"), false);
    assert.equal(prepareCall.includes("--drain-operation-token"), false);
    assert.equal(prepareCall.includes("--expected-operation-registry-revision"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core-execution rejects response locator drift before retaining a lease claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-locator-"));
  const snapshot = coreWorkflowSnapshot();
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter([], snapshot, (argv) => {
      const response = coreRunResponse(operationForArgv(argv));
      return {
        ...response,
        locator: {
          ...(response.locator as Record<string, unknown>),
          execution_id: "execution-other",
        },
      };
    }),
    new WorkflowLeaseStore(root),
  );
  try {
    await assert.rejects(
      coordinator.attach("pi-core"),
      /returned a different Execution locator/,
    );
    assert.equal(coordinator.mode(), "core-execution");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("core-execution heartbeats and releases the exact private lease tuple with public attribution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-heartbeat-"));
  const snapshot = coreWorkflowSnapshot();
  const calls: string[][] = [];
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot),
    new WorkflowLeaseStore(root),
    5,
  );
  try {
    await coordinator.attach("pi-owner");
    snapshot.execution!.lease = {
      sessionId: "session-1",
      executionId: "execution-1",
      ownerId: "pi-owner",
      ownerKind: "pi",
      epoch: 4,
      acquiredAt: "2026-07-15T00:00:00.000Z",
      heartbeatAt: "2026-07-15T00:00:01.000Z",
      handoffTo: null,
    };
    const owner = await coordinator.ownership("pi-owner");
    const reader = await coordinator.ownership("pi-reader");
    assert.equal(owner?.isOwner, true);
    assert.equal(owner?.isAttached, true);
    assert.equal(reader?.ownerHostSessionId, "pi-owner");
    assert.equal(reader?.isOwner, false);
    assert.equal(JSON.stringify({ owner, reader }).includes("lease_id"), false);

    await waitUntil(() => calls.some((call) => call[1] === "execution" && call[2] === "lease" && call[3] === "heartbeat"));
    const heartbeat = calls.find((call) => call[1] === "execution" && call[3] === "heartbeat")!;
    assertCoreLeaseTuple(heartbeat);

    await coordinator.release();
    const release = calls.find((call) => call[1] === "execution" && call[3] === "release")!;
    assertCoreLeaseTuple(release);
    const callCount = calls.length;
    await delay(20);
    assert.equal(calls.length, callCount, "release must stop core lease heartbeat scheduling");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator attaches brief-first and fences old continuation markers across done and next", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-coordinator-"));
  const snapshot = workflowSnapshot("running");
  const bridge = fakeBridge(snapshot);
  const calls: string[][] = [];
  const adapter = fakeAdapter(calls, {
    onDone(_runId, _sessionId, options) {
      snapshot.session!.runs[0]!.status = "sealed";
      snapshot.session!.activeRunId = null;
      snapshot.session!.chain[0]!.status = options.verdict === "needs-retry" ? "pending" : "sealed";
      snapshot.session!.chain[0]!.runId = null;
    },
    onNext() {
      snapshot.session!.runs.push({
        ...snapshot.session!.runs[0]!,
        runId: "run-2",
        status: "running",
        startedAt: "2026-07-15T00:01:00.000Z",
        endedAt: null,
      });
      snapshot.session!.activeRunId = "run-2";
      snapshot.session!.chain[0]!.status = "running";
      snapshot.session!.chain[0]!.runId = "run-2";
    },
  });
  const coordinator = testCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    const attached = await coordinator.attach("host-1");
    assert.equal(coordinator.mode(), "legacy-host");
    assert.equal("token" in attached.lease, false, "attach results must not expose the fencing token");
    assert.equal(attached.brief?.stdout, "brief run-1");
    assert.deepEqual(calls[0], ["brief", "run-1", "session-1"]);

    const marker = coordinator.continuationMarker(3);
    assert.equal(coordinator.acceptsContinuation(marker), true);
    assert.equal(coordinator.acceptsContinuation(marker), false, "continuation marker must be single-use");
    const fencedMarker = coordinator.continuationMarker(3);
    await coordinator.fenceContinuation();
    assert.equal(coordinator.acceptsContinuation(fencedMarker), false);
    const doneMarker = coordinator.continuationMarker(4);
    const completed = await coordinator.done("run-1", { verdict: "needs-retry" }, { hostSessionId: "host-1" });
    assert.equal(completed.command.stdout, "done run-1");
    assert.equal(coordinator.acceptsContinuation(doneMarker), false);
    assert.deepEqual(calls.at(-1), ["done", "run-1", "session-1", "needs-retry"]);

    const next = await coordinator.next(undefined, { hostSessionId: "host-1" });
    assert.equal(next.command.stdout, "next session-1");
    assert.deepEqual(calls.at(-1), ["next", "session-1", ""]);
    assert.equal(next.snapshot.session!.activeRunId, "run-2");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease is atomic under first-acquire concurrency and stale takeover raises epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  const clock = () => now;
  const first = new WorkflowLeaseStore(root, 1_000, clock);
  const second = new WorkflowLeaseStore(root, 1_000, clock);
  try {
    const contenders = await Promise.allSettled([
      first.acquire("session-1", "host-1"),
      second.acquire("session-1", "host-2"),
    ]);
    const fulfilled = contenders.filter((result) => result.status === "fulfilled");
    const rejected = contenders.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof WorkflowLeaseBusyError);
    assert.equal("token" in rejected[0]!.reason.owner, false, "busy errors must not expose the fencing token");
    const firstWon = contenders[0]!.status === "fulfilled";
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const original = fulfilled[0]!.value;
    now = new Date("2026-07-15T00:00:02.000Z");
    const replacement = await loser.acquire("session-1", firstWon ? "host-2" : "host-1");
    assert.ok(replacement.epoch > original.epoch);
    await winner.release();
    assert.equal((await loser.heartbeat()).token, replacement.token);
  } finally {
    await first.release();
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease ownership reports Pi session attribution without exposing the fencing token", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-owner-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  const owner = new WorkflowLeaseStore(root, 1_000, () => now);
  const observer = new WorkflowLeaseStore(root, 1_000, () => now);
  try {
    const lease = await owner.acquire("session-1", "pi-owner");
    const ownerView = await owner.ownership("session-1", "pi-owner");
    assert.deepEqual(ownerView, {
      sessionId: "session-1",
      currentHostSessionId: "pi-owner",
      state: "owned",
      ownerHostSessionId: "pi-owner",
      epoch: lease.epoch,
      heartbeatAt: lease.heartbeatAt,
      isOwner: true,
      isAttached: true,
    });
    assert.equal("token" in ownerView, false, "public ownership must not reveal the fencing token");

    const observerView = await observer.ownership("session-1", "pi-reader");
    assert.equal(observerView.ownerHostSessionId, "pi-owner");
    assert.equal(observerView.isOwner, false);
    assert.equal(observerView.isAttached, false);

    now = new Date("2026-07-15T00:00:02.000Z");
    assert.equal((await observer.ownership("session-1", "pi-reader")).state, "stale");
    await owner.release();
    assert.deepEqual(await observer.ownership("session-1", "pi-reader"), {
      sessionId: "session-1",
      currentHostSessionId: "pi-reader",
      state: "unowned",
      isOwner: false,
      isAttached: false,
    });
  } finally {
    await owner.release();
    await observer.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease storage is private and tightens existing POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-mode-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-private.lease");
  const owner = new WorkflowLeaseStore(root);
  const observer = new WorkflowLeaseStore(root);
  try {
    await owner.acquire("session-private", "host-owner");
    await owner.heartbeat();
    const entries = await readdir(directory);
    const claimPath = join(directory, entries.find((entry) => entry.endsWith(".claim.json"))!);
    const statePath = join(directory, entries.find((entry) => entry.endsWith(".state.json"))!);
    assert.equal((await lstat(claimPath)).isFile(), true);
    assert.equal((await lstat(statePath)).isFile(), true);

    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      await Promise.all([chmod(directory, 0o777), chmod(claimPath, 0o666), chmod(statePath, 0o666)]);
      await assert.rejects(observer.acquire("session-private", "host-observer"), WorkflowLeaseBusyError);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    }
  } finally {
    await owner.release();
    await observer.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease rejects a non-regular claim target", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-non-file-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-invalid.lease");
  try {
    await mkdir(join(directory, "1.claim.json"), { recursive: true });
    await assert.rejects(
      new WorkflowLeaseStore(root).acquire("session-invalid", "host-owner"),
      /Workflow lease path must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease rejects a symlink claim target on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-symlink-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-symlink.lease");
  try {
    await mkdir(directory, { recursive: true });
    const target = join(root, "outside.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, join(directory, "1.claim.json"));
    await assert.rejects(
      new WorkflowLeaseStore(root).acquire("session-symlink", "host-owner"),
      /Workflow lease path must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale takeover fences an already-validated old heartbeat and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-fence-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  let publishReached!: () => void;
  let resumePublish!: () => void;
  const reachedPublish = new Promise<void>((resolve) => { publishReached = resolve; });
  const publishResumed = new Promise<void>((resolve) => { resumePublish = resolve; });
  let pauseHeartbeat = true;
  const oldOwner = new WorkflowLeaseStore(root, 1_000, () => now, {
    async beforeHeartbeatPublish() {
      if (!pauseHeartbeat) return;
      pauseHeartbeat = false;
      publishReached();
      await publishResumed;
    },
  });
  const newOwner = new WorkflowLeaseStore(root, 1_000, () => now);
  try {
    await oldOwner.acquire("session-1", "host-old");
    const oldHeartbeat = oldOwner.heartbeat();
    await reachedPublish;

    now = new Date("2026-07-15T00:00:02.000Z");
    const replacement = await newOwner.acquire("session-1", "host-new");
    await oldOwner.release();
    resumePublish();

    await assert.rejects(oldHeartbeat, WorkflowLeaseBusyError);
    assert.equal(oldOwner.current(), undefined, "the fenced owner must not retain a held lease illusion");
    assert.equal((await newOwner.heartbeat()).token, replacement.token);
  } finally {
    resumePublish();
    await oldOwner.release();
    await newOwner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat publication failure clears ownership and blocks continuation and mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-heartbeat-failure-"));
  const snapshot = workflowSnapshot("running");
  const calls: string[][] = [];
  const store = new WorkflowLeaseStore(root, 1_000, () => new Date("2026-07-15T00:00:00.000Z"), {
    async beforeHeartbeatPublish() {
      throw new Error("injected heartbeat publication failure");
    },
  });
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter(calls),
    store,
  );
  try {
    await coordinator.attach("host-1");
    const marker = coordinator.continuationMarker(1);

    await assert.rejects(store.heartbeat(), /injected heartbeat publication failure/);
    assert.equal(store.current(), undefined);
    assert.equal(coordinator.acceptsContinuation(marker), false);
    assert.throws(() => coordinator.continuationMarker(2), /lease is not held/);
    await assert.rejects(
      coordinator.done("run-1", {}, { hostSessionId: "host-1" }),
      /lease is not held/,
    );
    assert.equal(calls.some(([operation]) => operation === "done"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("every run-control mutation rejects a different Pi session before fencing or CLI", async () => {
  const scenarios: Array<{
    name: string;
    mutate: (coordinator: WorkflowCoordinator) => Promise<unknown>;
  }> = [
    { name: "next", mutate: (coordinator) => coordinator.next(undefined, { hostSessionId: "pi-reader" }) },
    { name: "done", mutate: (coordinator) => coordinator.done("run-1", {}, { hostSessionId: "pi-reader" }) },
    { name: "done-invalid", mutate: (coordinator) => coordinator.done("run-missing", {}, { hostSessionId: "pi-reader" }) },
    { name: "edit", mutate: (coordinator) => coordinator.edit(["review"], {}, { hostSessionId: "pi-reader" }) },
  ];

  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-host-${scenario.name}-`));
    const calls: string[][] = [];
    const store = new WorkflowLeaseStore(root);
    const coordinator = testCoordinator(
      fakeBridge(workflowSnapshot("running")),
      fakeAdapter(calls),
      store,
    );
    try {
      await coordinator.attach("pi-owner");
      const callCountAfterAttach = calls.length;
      const leaseBefore = store.current();
      await assert.rejects(
        scenario.mutate(coordinator),
        /lease belongs to Pi session pi-owner, but this run-control call came from Pi session pi-reader/,
        scenario.name,
      );
      assert.equal(store.current()?.token, leaseBefore?.token, `${scenario.name} must not fence the owner lease`);
      assert.equal(store.current()?.epoch, leaseBefore?.epoch, `${scenario.name} must preserve the owner epoch`);
      assert.equal(calls.length, callCountAfterAttach, `${scenario.name} must not reach brief or a mutating CLI call`);
    } finally {
      await coordinator.release();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("every coordinator mutation rejects a canonical Session switch after attach before fencing or CLI", async () => {
  const scenarios: Array<{
    name: string;
    status: "running" | "failed" | "completed";
    mutate: (coordinator: WorkflowCoordinator) => Promise<unknown>;
  }> = [
    { name: "next", status: "completed", mutate: (coordinator) => coordinator.next(undefined, { hostSessionId: "host-1" }) },
    { name: "done", status: "running", mutate: (coordinator) => coordinator.done("run-1", {}, { hostSessionId: "host-1" }) },
    { name: "edit", status: "running", mutate: (coordinator) => coordinator.edit(["review"], {}, { hostSessionId: "host-1" }) },
    { name: "fenceContinuation", status: "running", mutate: (coordinator) => coordinator.fenceContinuation() },
  ];

  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-switch-${scenario.name}-`));
    const snapshot = workflowSnapshot(scenario.status);
    let refreshCount = 0;
    const bridge: WorkflowSnapshotProvider = {
      async refresh() {
        refreshCount++;
        if (refreshCount === 2) {
          snapshot.session!.sessionId = "session-2";
          snapshot.sessionGeneration = "canonical:valid:session-2:1";
          snapshot.canonicalClaim = { activeSessionId: "session-2", status: "valid" };
        }
        return snapshot;
      },
      getSnapshot() { return snapshot; },
    };
    const calls: string[][] = [];
    const store = new WorkflowLeaseStore(root);
    const coordinator = testCoordinator(
      bridge,
      fakeAdapter(calls),
      store,
    );
    try {
      await coordinator.attach("host-1");
      const leaseBefore = store.current();
      await assert.rejects(
        scenario.mutate(coordinator),
        /lease belongs to session-1, but the active canonical Session is session-2/,
        scenario.name,
      );
      assert.equal(store.current()?.token, leaseBefore?.token, `${scenario.name} must not fence the old lease`);
      assert.equal(
        calls.some(([operation]) => ["next", "done", "edit"].includes(operation ?? "")),
        false,
        `${scenario.name} must not reach a mutating CLI call`,
      );
    } finally {
      await coordinator.release();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("coordinator mutation fails closed when the canonical Session disappears after attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-missing-session-"));
  const attachedSnapshot = workflowSnapshot("running");
  const missingSnapshot: WorkflowSnapshot = {
    ...attachedSnapshot,
    sessionGeneration: "none",
    canonicalClaim: undefined,
    session: undefined,
  };
  let refreshCount = 0;
  const bridge: WorkflowSnapshotProvider = {
    async refresh() { return ++refreshCount === 1 ? attachedSnapshot : missingSnapshot; },
    getSnapshot() { return refreshCount <= 1 ? attachedSnapshot : missingSnapshot; },
  };
  const calls: string[][] = [];
  const coordinator = testCoordinator(
    bridge,
    fakeAdapter(calls),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("host-1");
    await assert.rejects(
      coordinator.done("run-1", {}, { hostSessionId: "host-1" }),
      /No active canonical Workflow Session/,
    );
    assert.equal(calls.some(([operation]) => operation === "done"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("reattaching the same Workflow Session under a new Pi session rotates ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-host-reattach-"));
  const snapshot = workflowSnapshot("running");
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    new WorkflowLeaseStore(root),
  );
  try {
    const first = await coordinator.attach("pi-before");
    const marker = coordinator.continuationMarker(1);
    const second = await coordinator.attach("pi-after");
    const ownership = await coordinator.ownership("pi-after");

    assert.ok(second.lease.epoch > first.lease.epoch);
    assert.equal(second.lease.hostSessionId, "pi-after");
    assert.equal(ownership?.isOwner, true);
    assert.equal(ownership?.isAttached, true);
    assert.equal(coordinator.acceptsContinuation(marker), false, "host identity rotation must invalidate continuation");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("attach heartbeats its token and safely stops on Session switch and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-heartbeat-"));
  const snapshot = workflowSnapshot("running");
  const store = new WorkflowLeaseStore(root, 1_000);
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    store,
    5,
  );
  const oldSessionObserver = new WorkflowLeaseStore(root, 1_000);
  try {
    const first = await coordinator.attach("host-1");
    await waitUntil(() => Date.parse(store.current()!.heartbeatAt) > Date.parse(first.lease.heartbeatAt));
    const oldMarker = coordinator.continuationMarker(1);

    snapshot.session!.sessionId = "session-2";
    snapshot.session!.activeRunId = "run-2";
    snapshot.session!.runs[0]!.runId = "run-2";
    snapshot.session!.chain[0]!.runId = "run-2";
    await coordinator.attach("host-2");
    assert.equal(coordinator.acceptsContinuation(oldMarker), false);
    const oldLease = await oldSessionObserver.acquire("session-1", "observer");
    assert.equal(oldLease.sessionId, "session-1", "switch must release the old Session lease");

    await coordinator.release();
    assert.equal(store.current(), undefined);
    await delay(20);
    assert.equal(store.current(), undefined, "released heartbeat must not reacquire or refresh a lease");
  } finally {
    await coordinator.release();
    await oldSessionObserver.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation rejects failed and blocked gates at issue and consume boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-gates-"));
  const snapshot = workflowSnapshot("running");
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("host-1");
    for (const status of ["failed", "blocked"] as const) {
      snapshot.session!.gates = [{ id: `session-${status}`, blocking: true, status }];
      assert.throws(() => coordinator.continuationMarker(1), /Blocking gate failure/);
      snapshot.session!.gates = [];
      snapshot.session!.runs[0]!.gates = [{ id: `run-${status}`, blocking: true, status }];
      assert.throws(() => coordinator.continuationMarker(1), /Blocking gate failure/);
      snapshot.session!.runs[0]!.gates = [];
    }
    const marker = coordinator.continuationMarker(2);
    snapshot.session!.runs[0]!.gates = [{ id: "late-block", blocking: true, status: "blocked" }];
    assert.equal(coordinator.acceptsContinuation(marker), false);
    snapshot.session!.runs[0]!.gates = [];
    const doneMarker = coordinator.continuationMarker(3);
    await coordinator.done("run-1", { verdict: "blocked" }, { hostSessionId: "host-1" });
    assert.equal(coordinator.acceptsContinuation(doneMarker), false, "done must fence pending continuation");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan publication response parsing rejects swapped request and handoff identities", () => {
  const resultValue = {
    session_id: "session-1",
    run_id: "run-plan-publish",
    artifact_id: "ART-PLAN",
    source_checksum: "sha256:source",
    handoff_key: "handoff-plan",
    request_id: "req-plan-publish",
  };
  assert.deepEqual(
    parsePublishedPlanIdentity({
      ok: true,
      request_id: "req-plan-publish",
      result: resultValue,
    }, "handoff-plan", "req-plan-publish"),
    resultValue,
  );
  assert.throws(
    () => parsePublishedPlanIdentity({
      ok: true,
      request_id: "req-plan-swapped",
      result: { ...resultValue, request_id: "req-plan-swapped" },
    }, "handoff-plan", "req-plan-publish"),
    /request identity/,
  );
  assert.throws(
    () => parsePublishedPlanIdentity({
      ok: true,
      request_id: "req-plan-publish",
      result: { ...resultValue, handoff_key: "handoff-other" },
    }, "handoff-plan", "req-plan-publish"),
    /handoff identity/,
  );
});

test("published Plan correlation rejects Session switches and unrelated active Runs", () => {
  const snapshot = workflowSnapshot("running");
  snapshot.canonicalClaim = { status: "valid", activeSessionId: "session-1" };
  snapshot.session!.aliases["current-plan"] = "ART-PLAN";
  snapshot.session!.artifacts.push({
    artifactId: "ART-PLAN",
    kind: "plan",
    role: "primary",
    runId: "run-plan-publish",
    path: "outputs/plan.json",
    hash: "sha256:plan",
    status: "sealed",
    replaces: null,
  });
  snapshot.session!.runs.unshift({
    runId: "run-plan-publish",
    parentRunId: null,
    command: "plan-publish",
    status: "sealed",
    goal: "publish",
    args: [],
    gates: [],
    primaryArtifactId: "ART-PLAN",
    handoff: {
      producer_run_id: "run-plan-publish",
      command: "plan-publish",
      verdict: "ready",
      artifact_refs: ["ART-PLAN"],
      next: [],
    },
    planPublication: {
      requestId: "req-plan-publish",
      handoffKeyHash: "sha256:ce12ef052d5c235d124f0448cef062aee208e1c3fa7a56042d5d739fe8e4a33c",
    },
    startedAt: "2026-07-14T23:58:00.000Z",
    endedAt: "2026-07-14T23:59:00.000Z",
  });
  const published = {
    session_id: "session-1",
    run_id: "run-plan-publish",
    artifact_id: "ART-PLAN",
    source_checksum: "sha256:source",
    handoff_key: "handoff-plan",
    request_id: "req-plan-publish",
  };
  assert.doesNotThrow(() => assertPublishedPlanSnapshot(snapshot, published, "session-1"));
  assert.equal(requirePublishedExecutionRun(snapshot, published).runId, "run-1");

  const switched = structuredClone(snapshot);
  switched.canonicalClaim!.activeSessionId = "session-2";
  assert.throws(() => assertPublishedPlanSnapshot(switched, published), /does not match/);

  const unrelated = structuredClone(snapshot);
  unrelated.session!.runs.find((run) => run.runId === "run-1")!.command = "review";
  assert.throws(() => requirePublishedExecutionRun(unrelated, published), /not correlated/);

  const statusless = structuredClone(snapshot);
  const currentRun = statusless.session!.runs.find((run) => run.runId === "run-1")!;
  const staleRun = structuredClone(currentRun);
  staleRun.runId = "run-stale";
  staleRun.startedAt = "2026-07-15T00:01:00.000Z";
  statusless.session!.schemaVersion = "session/2.0";
  statusless.session!.lifecycleAuthority = "execution-derived";
  statusless.session!.currentExecutionId = "execution-1";
  statusless.session!.latestExecutionId = "execution-1";
  statusless.session!.archivedAt = null;
  statusless.session!.activeRunId = "run-stale";
  statusless.session!.chain = [{ step: "stale-execute", command: "execute", status: "running", runId: "run-stale" }];
  statusless.session!.runs.push(staleRun);
  delete (statusless.session as { status?: string }).status;
  statusless.locator = { sessionId: "session-1", executionId: "execution-1", generation: 1, runId: "run-1" };
  statusless.execution = {
    schemaVersion: "execution/1.0",
    executionId: "execution-1",
    sessionId: "session-1",
    generation: 1,
    status: "active",
    revision: 1,
    activeRunId: "run-1",
    chain: [{ step: "execute", command: "execute", status: "running", runId: "run-1" }],
    decisionPoints: [],
    gatesRef: "gates.json",
    artifactsRef: "artifacts.json",
    evidenceRef: "evidence.json",
    lease: null,
    startedAt: "2026-07-15T00:00:00.000Z",
    sealedAt: null,
    sealSummary: null,
    finalOutcome: null,
  };
  assert.doesNotThrow(() => assertPublishedPlanSnapshot(statusless, published, "session-1"));
  assert.equal(requirePublishedExecutionRun(statusless, published).runId, "run-1");

  const staleFallback = structuredClone(statusless);
  staleFallback.execution!.activeRunId = null;
  assert.throws(() => requirePublishedExecutionRun(staleFallback, published), /no execution Run was allocated/);

  const mismatchedStep = structuredClone(statusless);
  mismatchedStep.execution!.chain[0]!.runId = "run-stale";
  assert.throws(() => requirePublishedExecutionRun(mismatchedStep, published), /not correlated/);

  const invalidHandoff = structuredClone(statusless);
  invalidHandoff.session!.runs.find((run) => run.runId === published.run_id)!.handoff = null;
  assert.throws(() => assertPublishedPlanSnapshot(invalidHandoff, published), /producer Run.*not canonical/);

  const sameContentDifferentHandoff = { ...published, handoff_key: "handoff-other" };
  assert.throws(
    () => assertPublishedPlanSnapshot(statusless, sameContentDifferentHandoff),
    /producer Run.*not canonical/,
  );

  const swappedRequest = { ...published, request_id: "req-plan-swapped" };
  assert.throws(
    () => assertPublishedPlanSnapshot(statusless, swappedRequest),
    /producer Run.*not canonical/,
  );
});

test("Workflow Plan publication is host-fenced for current Sessions and requires release for new Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-plan-publish-"));
  const calls: string[][] = [];
  const store = new WorkflowLeaseStore(root);
  const snapshot = workflowSnapshot("running");
  let currentPublish: RunPlanPublishOptions | undefined;
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter(calls, { onPublish: (options) => { currentPublish = options; } }),
    store,
  );
  const base = {
    sourcePath: "C:/plans/approved.md",
    sourceRoot: "C:/plans",
    handoffKey: "a".repeat(64),
    sourcePiSession: "pi-owner",
    planRevision: 1,
    approvedAt: "2026-08-02T12:00:00.000Z",
  };
  try {
    await coordinator.attach("pi-owner");
    const callsAfterAttach = calls.length;
    await assert.rejects(
      coordinator.publishPlan({ ...base, sessionId: "session-1" }, { hostSessionId: "pi-reader" }),
      /lease belongs to Pi session pi-owner/,
    );
    assert.equal(calls.length, callsAfterAttach);

    const before = store.current();
    await coordinator.publishPlan({ ...base, sessionId: "session-1" }, { hostSessionId: "pi-owner" });
    assert.equal(calls.at(-1)?.[0], "plan-publish");
    assert.equal(currentPublish?.expectedIdentityRevision, 1);
    assert.equal(currentPublish?.expectedActivityRevision, 1);
    assert.ok((store.current()?.epoch ?? 0) > (before?.epoch ?? 0));

    await assert.rejects(
      coordinator.publishPlan(base, { hostSessionId: "pi-owner" }),
      /Release the current Workflow Session/,
    );
    const contenderCalls: string[][] = [];
    const contenderSnapshot = workflowSnapshot("running");
    contenderSnapshot.session!.activeRunId = null;
    const contender = testCoordinator(
      fakeBridge(contenderSnapshot),
      fakeAdapter(contenderCalls),
      new WorkflowLeaseStore(root),
    );
    await assert.rejects(
      contender.publishPlan(base, { hostSessionId: "pi-reader" }),
      /owned by Pi session pi-owner/,
    );
    assert.equal(contenderCalls.length, 0);
    snapshot.session!.activeRunId = null;
    await coordinator.release();
    await coordinator.publishPlan(base, { hostSessionId: "pi-owner" });
    assert.deepEqual(calls.at(-1), ["plan-publish", "new", "a".repeat(64)]);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale foreign lease never blocks binding the current Session or creating a new one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-stale-publish-"));
  let now = new Date("2026-08-02T12:00:00.000Z");
  const staleStore = new WorkflowLeaseStore(root, 1_000, () => now);
  const freshStore = new WorkflowLeaseStore(root, 1_000, () => now);
  const calls: string[][] = [];
  const snapshot = workflowSnapshot("running");
  snapshot.session!.activeRunId = null;
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter(calls),
    freshStore,
  );
  const base = {
    sourcePath: "C:/plans/approved.md",
    sourceRoot: "C:/plans",
    handoffKey: "b".repeat(64),
    sourcePiSession: "pi-owner",
    planRevision: 1,
    approvedAt: "2026-08-02T12:00:00.000Z",
  };
  try {
    // A foreign Pi session acquires the lease, then its heartbeat goes stale.
    const oldOwner = new WorkflowLeaseStore(root, 1_000, () => now);
    const foreign = await oldOwner.acquire("session-1", "pi-foreign");
    assert.equal(foreign.hostSessionId, "pi-foreign");
    now = new Date("2026-08-02T12:00:05.000Z");
    const ownership = await freshStore.ownership("session-1", "pi-owner");
    assert.equal(ownership.state, "stale", "the foreign lease must be past its heartbeat window");
    // The confirmation equivalent (ownedHere) treats stale as reclaimable, and
    // the current-binding path attaches first (acquiring the stale lease)
    // before fencing and publishing — mirroring publishApprovedPlanToWorkflow.
    await coordinator.attach("pi-owner");
    await coordinator.publishPlan({ ...base, sessionId: "session-1" }, { hostSessionId: "pi-owner" });
    assert.equal(calls.at(-1)?.[0], "plan-publish");
    assert.equal(calls.at(-1)?.[1], "session-1");
    const takenOver = await freshStore.ownership("session-1", "pi-owner");
    assert.equal(takenOver.isOwner, true, "the stale foreign lease must be taken over");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI adapter capability-detects and publishes an approved Plan", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    const command = args.join(" ");
    if (command === "run --help") return result(args, "Commands:\n  brief\n  next\n  complete\n");
    if (command === "session --help") return result(args, "Commands:\n  next\n  done\n");
    if (command === "plan --help") return result(args, "Commands:\n  publish <path>\n");
    return result(args, '{"ok":true}');
  });

  assert.equal(await adapter.supportsPlanPublish(), true);
  await adapter.publishPlan({
    sourcePath: "C:/plans/approvals/plan.md",
    sourceRoot: "C:/plans",
    sessionId: "session-1",
    handoffKey: "a".repeat(64),
    sourcePiSession: "pi-session-1",
    planRevision: 3,
    approvedAt: "2026-08-02T12:00:00.000Z",
  });
  assert.deepEqual(calls.at(-1), [
    "plan", "publish", "C:/plans/approvals/plan.md",
    "--source-root", "C:/plans",
    "--session", "session-1",
    "--handoff-key", "a".repeat(64),
    "--source-pi-session", "pi-session-1",
    "--plan-revision", "3",
    "--approved-at", "2026-08-02T12:00:00.000Z",
    "--json", "--workflow-root", "D:/workspace",
  ]);
});

test("CLI adapter keeps top-level passthrough commands rooted by cwd", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    return result(args, "ok");
  });

  await adapter.exec(["skills", "--steps", "--json", "--platform", "pi"]);
  assert.deepEqual(calls.at(-1), ["skills", "--steps", "--json", "--platform", "pi"]);

  await adapter.exec(["run", "status"]);
  assert.deepEqual(calls.at(-1), ["run", "status", "--workflow-root", "D:/workspace"]);

  await adapter.exec(["session", "status", "--workflow-root", "D:/pinned"]);
  assert.deepEqual(calls.at(-1), ["session", "status", "--workflow-root", "D:/pinned"]);
});

test("CLI adapter maps canonical check, next, done, and edit commands", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "run --help") {
      return result(args, "Commands:\n  prepare <step>\n  brief <run-id>\n  check <run-id>\n  next\n  complete <run-id>\n  edit [commands...]\n");
    }
    return result(args, "ok");
  });

  const capabilities = await adapter.capabilities();
  assert.deepEqual([...capabilities.commands], ["prepare", "brief", "check", "next", "complete", "edit"]);
  await adapter.check("run-1", "session-1");
  assert.deepEqual(calls.at(-1), [
    "run", "check", "run-1", "--session", "session-1", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.next("session-1", "step-2");
  assert.deepEqual(calls.at(-1), [
    "run", "next", "--session", "session-1", "--pick", "step-2", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.done("run-1", "session-1", {
    verdict: "done-with-concerns",
    notes: ["note"],
    decisions: ["decision"],
  });
  assert.deepEqual(calls.at(-1), [
    "run", "complete", "run-1", "--session", "session-1", "--verdict", "done-with-concerns",
    "--note", "note", "--decision", "decision", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.edit(["review"], { sessionId: "session-1", after: "latest", args: "--scope core" });
  assert.deepEqual(calls.at(-1), [
    "run", "edit", "review", "--session", "session-1", "--after", "latest",
    "--args", "--scope core", "--workflow-root", "D:/workspace",
  ]);
});

test("CLI adapter uses session next/done when the session subcommand is detected", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "run --help") {
      return result(args, "Commands:\n  prepare <step>\n  brief <run-id>\n  check <run-id>\n  edit [commands...]\n");
    }
    if (args.join(" ") === "session --help") {
      return result(args, "Commands:\n  next\n  done <run-id>\n  decide\n  seal\n");
    }
    return result(args, "ok");
  });

  const capabilities = await adapter.capabilities();
  assert.deepEqual([...capabilities.sessionCommands], ["next", "done", "decide", "seal"]);
  await adapter.next("session-1", "step-2");
  assert.deepEqual(calls.at(-1), [
    "session", "next", "--session", "session-1", "--inline-brief", "--pick", "step-2", "--json", "--workflow-root", "D:/workspace",
  ]);
  assert.equal(calls.at(-1)!.includes("--inline-brief"), true, "session next must carry --inline-brief to inline the birth brief");
  await adapter.done("run-1", "session-1", { verdict: "done" });
  assert.deepEqual(calls.at(-1), [
    "session", "done", "run-1", "--session", "session-1", "--verdict", "done", "--json", "--workflow-root", "D:/workspace",
  ]);
});

test("run-control read results expose owner and non-owner Pi session attribution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-run-control-ownership-"));
  const snapshot = workflowSnapshot("running");
  const owner = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    new WorkflowLeaseStore(root),
  );
  const reader = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    new WorkflowLeaseStore(root),
  );
  try {
    await owner.attach("pi-owner");
    const ownerStatus = await executeRunControl(
      { argv: ["run", "status"] },
      owner,
      { hostSessionId: "pi-owner" },
    );
    assert.equal(ownerStatus.ok, true);
    assert.match(ownerStatus.message, /this Pi session owns the active mutation lease/);
    const ownerDetails = ownerStatus.details as { ownership: Record<string, unknown> };
    assert.equal(ownerDetails.ownership.isOwner, true);
    assert.equal(ownerDetails.ownership.isAttached, true);
    assert.equal("token" in ownerDetails.ownership, false);

    const readerStatus = await executeRunControl(
      { argv: ["run", "status"] },
      reader,
      { hostSessionId: "pi-reader" },
    );
    assert.equal(readerStatus.ok, true);
    assert.match(readerStatus.message, /Pi session pi-owner owns the active mutation lease/);
    const readerDetails = readerStatus.details as { ownership: Record<string, unknown> };
    assert.equal(readerDetails.ownership.currentHostSessionId, "pi-reader");
    assert.equal(readerDetails.ownership.ownerHostSessionId, "pi-owner");
    assert.equal(readerDetails.ownership.isOwner, false);
    assert.equal(readerDetails.ownership.isAttached, false);

    const brief = await executeRunControl(
      { argv: ["run", "brief"] },
      reader,
      { hostSessionId: "pi-reader" },
    );
    assert.equal(brief.ok, true);
    assert.match(brief.message, /^Read-only view: Workflow Session session-1 has an active mutation lease owned by Pi session pi-owner\./);
  } finally {
    await owner.release();
    await reader.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("run-control forwards arbitrary Maestro argv through the shell", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const command = result([], "ok");
  const transition = { command, snapshot: workflowSnapshot("running") };
  const coordinator = {
    async exec(argv: readonly string[], classification: unknown, hostSessionId?: string) {
      calls.push(["exec", argv, classification, hostSessionId]);
      return argv[0] === "skills"
        ? { ...transition, command: { ...command, stderr: "WARNING PI_SKILL_DIR_MISSING" } }
        : transition;
    },
    async ownership() { return undefined; },
  } as unknown as WorkflowCoordinator;
  const context = { hostSessionId: "pi-session-1" };

  assert.equal((await executeRunControl({ argv: ["run", "check", "run-1"] }, coordinator, context)).ok, true);
  const skillsResult = await executeRunControl({
    argv: ["skills", "--steps", "--json", "--platform", "pi"],
  }, coordinator);
  assert.equal(skillsResult.ok, true);
  assert.match(skillsResult.message, /WARNING PI_SKILL_DIR_MISSING/);
  assert.equal((await executeRunControl({ argv: ["session", "next", "--pick", "step-2"] }, coordinator, context)).ok, true);
  assert.equal((await executeRunControl({
    argv: ["session", "done", "run-1", "--verdict", "done-with-concerns"],
  }, coordinator, context)).ok, true);
  assert.equal((await executeRunControl({
    argv: ["run", "edit", "review", "--after", "latest"],
  }, coordinator, context)).ok, true);

  assert.deepEqual(calls, [
    ["exec", ["run", "check", "run-1"], readClassification(), "pi-session-1"],
    ["exec", ["skills", "--steps", "--json", "--platform", "pi"], readClassification(), undefined],
    ["exec", ["session", "next", "--pick", "step-2"], writeClassification("execution", "required"), "pi-session-1"],
    ["exec", ["session", "done", "run-1", "--verdict", "done-with-concerns"], writeClassification("execution", "required"), "pi-session-1"],
    ["exec", ["run", "edit", "review", "--after", "latest"], writeClassification("execution", "required"), "pi-session-1"],
  ]);
});

test("run-control reads pass through but mutations fail closed without host identity", async () => {
  const snapshot = workflowSnapshot("running");
  let execCalls = 0;
  const coordinator = {
    async exec() {
      execCalls++;
      return { command: result([], "ok"), snapshot };
    },
  } as unknown as WorkflowCoordinator;

  const status = await executeRunControl({ argv: ["run", "status"] }, coordinator);
  assert.equal(status.ok, true);

  const next = await executeRunControl({ argv: ["session", "next"] }, coordinator);
  assert.equal(next.ok, false);
  assert.match(next.message, /hostSessionId is required/);
  assert.equal(execCalls, 1);
});

test("compatibility starts require the exact response operation derived from their arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-compat-operation-"));
  const snapshot = coreWorkflowSnapshot();
  const calls: string[][] = [];
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot, (argv) => {
      if (argv[0] === "execution") return coreRunResponse(operationForArgv(argv));
      return coreRunResponse(argv.includes("--cmd") || argv.includes("--chain") ? "create" : "next");
    }),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("pi-owner");
    const commandless = ["run", "start", "continue"];
    assert.equal(
      JSON.parse((await coordinator.exec(
        commandless,
        classifyRunControlArgv(commandless),
        "pi-owner",
      )).command.stdout).operation,
      "next",
    );

    const wrong = ["session", "start", "continue"];
    const wrongCoordinator = testCoordinator(
      fakeBridge(snapshot),
      coreAdapter([], snapshot, (argv) => argv[0] === "execution"
        ? coreRunResponse(operationForArgv(argv))
        : coreRunResponse("create")),
      new WorkflowLeaseStore(root),
    );
    await wrongCoordinator.attach("pi-owner");
    await assert.rejects(
      wrongCoordinator.exec(wrong, classifyRunControlArgv(wrong), "pi-owner"),
      /returned operation create, expected next/,
    );
    await wrongCoordinator.release();
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh compatibility start replays the same request immediately after response loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-compat-response-loss-"));
  const snapshot = coreWorkflowSnapshot();
  snapshot.session!.currentExecutionId = null;
  snapshot.session!.latestExecutionId = null;
  snapshot.session!.activityRevision = 0;
  snapshot.locator = { sessionId: "session-1" };
  snapshot.execution = undefined;
  snapshot.revision.executionRevision = undefined;
  const calls: string[][] = [];
  let attempts = 0;
  const adapter = coreAdapter(calls, snapshot, (argv) => {
    if (argv[0] !== "session" || argv[1] !== "start") {
      return coreRunResponse(operationForArgv(argv));
    }
    attempts++;
    const requestId = flagValue(argv, "--request-id")!;
    const envelope = coreRunResponse("execution-start", {
      request_id: requestId,
      locator: { session_id: "session-1", execution_id: "execution-1", generation: 1, run_id: null },
      fence: {
        session_identity_revision: 3,
        session_activity_revision: 1,
        execution_revision: 1,
        lease_epoch: 1,
      },
      replay: { status: attempts === 1 ? "applied" : "replayed", transition_id: "transition-start-loss" },
    });
    snapshot.session!.activityRevision = 1;
    snapshot.session!.currentExecutionId = "execution-1";
    snapshot.session!.latestExecutionId = "execution-1";
    snapshot.locator = { sessionId: "session-1", executionId: "execution-1", generation: 1 };
    snapshot.revision.executionRevision = 1;
    snapshot.execution = {
      executionId: "execution-1", sessionId: "session-1", generation: 1, status: "active", revision: 1,
      activeRunId: null, chain: [], decisionPoints: [], gatesRef: "gates.json", artifactsRef: "artifacts.json",
      evidenceRef: "evidence.json", lease: {
        sessionId: "session-1", executionId: "execution-1", ownerId: "pi-loss", ownerKind: "pi", epoch: 1,
        acquiredAt: "2026-08-12T00:00:00.000Z", heartbeatAt: "2026-08-12T00:00:00.000Z", handoffTo: null,
      }, startedAt: "2026-08-12T00:00:00.000Z", sealedAt: null, sealSummary: null, finalOutcome: null,
    };
    if (attempts === 1) throw new Error("injected response loss lease_id=private-core-lease");
    return envelope;
  });
  const coordinator = testCoordinator(fakeBridge(snapshot), adapter, new WorkflowLeaseStore(root));
  try {
    const argv = ["session", "start", "fresh", "--no-dispatch"];
    const started = await coordinator.exec(argv, classifyRunControlArgv(argv), "pi-loss");
    const starts = calls.filter((call) => call[1] === "session" && call[2] === "start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[0], starts[1]);
    assert.equal(JSON.parse(started.command.stdout).replay.status, "replayed");
    assert.equal(JSON.stringify(started).includes("private-core-lease"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-host raw plan publish pins the current Session and validates canonical publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-legacy-raw-plan-"));
  const snapshot = workflowSnapshot("running");
  snapshot.session!.activeRunId = null;
  const calls: string[][] = [];
  const handoffKey = "legacy-raw-plan";
  const requestId = derivePlanPublishRequestId(handoffKey);
  const adapter: WorkflowRunAdapter = {
    ...fakeAdapter(calls),
    async exec(argv) {
      calls.push(["exec", ...argv]);
      const producer = {
        runId: "run-plan-publish", parentRunId: null, command: "plan-publish", args: [], platform: "pi",
        status: "sealed", gates: [], primaryArtifactId: "ART-PLAN", startedAt: "2026-08-12T00:00:00.000Z",
        endedAt: "2026-08-12T00:00:01.000Z", handoff: {
          producer_run_id: "run-plan-publish", command: "plan-publish", verdict: "ready",
          artifact_refs: ["ART-PLAN"], next: [],
        },
        planPublication: {
          requestId,
          handoffKeyHash: `sha256:${createHash("sha256").update(handoffKey).digest("hex")}`,
        },
      } satisfies NonNullable<WorkflowSnapshot["session"]>["runs"][number];
      snapshot.session!.runs.push(producer);
      snapshot.session!.artifacts.push({
        artifactId: "ART-PLAN", kind: "plan", role: "primary", runId: producer.runId,
        path: "plans/approved.md", hash: "sha256:source", status: "sealed", createdAt: producer.endedAt!,
      });
      snapshot.session!.aliases["current-plan"] = "ART-PLAN";
      return result(argv, JSON.stringify({
        schema_version: "run-response/1.0", operation: "plan-publish", ok: true, exit_code: 0,
        request_id: requestId, locator: { session_id: "session-1", run_id: producer.runId },
        result: {
          session_id: "session-1", run_id: producer.runId, artifact_id: "ART-PLAN",
          source_checksum: "sha256:source", handoff_key: handoffKey, request_id: requestId,
        },
        next: null, continuation: null,
        replay: { status: "applied", transition_id: "transition-legacy-plan" }, error: null,
      }));
    },
  };
  const coordinator = testCoordinator(fakeBridge(snapshot), adapter, new WorkflowLeaseStore(root));
  try {
    await coordinator.attach("pi-legacy-plan");
    const argv = ["plan", "publish", "approved.md", "--handoff-key", handoffKey];
    const published = await coordinator.exec(argv, classifyRunControlArgv(argv), "pi-legacy-plan");
    const call = calls.find((candidate) => candidate[0] === "exec" && candidate[1] === "plan")!;
    assert.equal(flagValue(call, "--session"), "session-1");
    assert.equal(flagValue(call, "--expected-identity-revision"), "1");
    assert.equal(flagValue(call, "--expected-activity-revision"), "1");
    assert.equal(flagValue(call, "--request-id"), requestId);
    assert.equal(JSON.stringify(published).includes(handoffKey), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy-host raw plan publish fails closed when publication is unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-legacy-raw-plan-unsupported-"));
  const calls: string[][] = [];
  const adapter = fakeAdapter(calls);
  adapter.supportsPlanPublish = async () => false;
  const coordinator = testCoordinator(fakeBridge(workflowSnapshot("running")), adapter, new WorkflowLeaseStore(root));
  try {
    await assert.rejects(
      coordinator.exec(
        ["plan", "publish", "approved.md", "--handoff-key", "unsupported"],
        classifyRunControlArgv(["plan", "publish"]),
        "pi-owner",
      ),
      /does not support plan publish/,
    );
    assert.equal(calls.some((call) => call[0] === "exec"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("raw plan publish is fenced as a core Execution mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-raw-plan-publish-"));
  const snapshot = coreWorkflowSnapshot();
  snapshot.execution!.activeRunId = null;
  snapshot.locator!.runId = undefined;
  const calls: string[][] = [];
  const requestId = "req_plan_publish_90539656b7b168f130ae6b307d7d4ba4";
  const handoffKey = "raw-plan-handoff";
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot, (argv) => {
      if (argv[0] !== "plan" || argv[1] !== "publish") {
        return coreRunResponse(operationForArgv(argv));
      }
      const response = coreRunResponse("plan-publish", {
        request_id: flagValue(argv, "--request-id"),
        locator: {
          session_id: "session-1",
          execution_id: "execution-1",
          generation: 1,
          run_id: "run-plan-publish",
        },
        result: {
          session_id: "session-1",
          run_id: "run-plan-publish",
          artifact_id: "ART-PLAN",
          source_checksum: "sha256:source",
          handoff_key: handoffKey,
          request_id: flagValue(argv, "--request-id"),
        },
      });
      snapshot.execution!.revision = 8;
      snapshot.revision.executionRevision = 8;
      return response;
    }),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("pi-plan-owner");
    const argv = [
      "plan", "publish", "approved.md",
      "--source-root", "D:/plans",
      "--handoff-key", handoffKey,
      "--request-id", requestId,
      "--source-pi-session", "pi-plan-owner",
      "--plan-revision", "1",
      "--approved-at", "2026-08-12T03:00:00.000Z",
    ];
    const published = await coordinator.exec(argv, classifyRunControlArgv(argv), "pi-plan-owner");
    const call = calls.find((candidate) => candidate[1] === "plan" && candidate[2] === "publish")!;
    assert.equal(flagValue(call, "--session"), "session-1");
    assert.equal(flagValue(call, "--execution"), "execution-1");
    assert.equal(flagValue(call, "--generation"), "1");
    assert.equal(flagValue(call, "--request-id"), requestId);
    assert.equal(flagValue(call, "--expected-identity-revision"), "3");
    assert.equal(flagValue(call, "--expected-activity-revision"), "5");
    assert.equal(flagValue(call, "--expected-execution-revision"), "8");
    assert.equal(flagValue(call, "--execution-owner"), "pi-plan-owner");
    assert.equal(flagValue(call, "--owner-epoch"), "4");
    assert.equal(flagValue(call, "--actor"), "pi-plan-owner");
    assert.equal(flagValue(call, "--evidence"), "pi-session:pi-plan-owner");
    assert.equal(typeof flagValue(call, "--lease-id"), "string");
    assert.equal(JSON.stringify(published).includes(flagValue(call, "--lease-id")!), false);
    assert.equal(JSON.stringify(published).includes(handoffKey), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("run-control preserves success semantics and returns failure for a sanitized nonzero response", async () => {
  const transition = { command: result([], "ok"), snapshot: workflowSnapshot("running") };
  let ownershipCalls = 0;
  const coordinator = {
    async exec() { return transition; },
    async ownership() {
      ownershipCalls++;
      throw new Error("ownership unavailable");
    },
  } as unknown as WorkflowCoordinator;

  const resultValue = await executeRunControl(
    { argv: ["session", "next"] },
    coordinator,
    { hostSessionId: "pi-session-1" },
  );
  assert.equal(resultValue.ok, true);
  assert.equal(ownershipCalls, 0);

  const envelope = {
    schema_version: "run-response/1.1",
    operation: "execution-pause",
    ok: false,
    exit_code: 3,
    disposition: "control_flow",
    request_id: "request-nonzero",
    locator: { session_id: "session-1", execution_id: "execution-1", generation: 1, run_id: "run-1" },
    fence: {
      session_identity_revision: 3,
      session_activity_revision: 5,
      execution_revision: 8,
      lease_epoch: 4,
    },
    result: null,
    next: null,
    continuation: null,
    replay: null,
    warnings: [],
    error: {
      code: "LEASE_BUSY",
      message: "lease_id=private-message",
      retryable: true,
      details: { visible: true, lease_id: "private-detail" },
      recovery_command: null,
    },
  };
  const command = {
    argv: ["execution", "pause", "--lease-id", "private-argv", "--json"],
    stdout: JSON.stringify(envelope),
    stderr: "",
    exitCode: 3,
  };
  const failureCoordinator = {
    async exec() { return { command, snapshot: workflowSnapshot("running") }; },
  } as unknown as WorkflowCoordinator;

  const failureValue = await executeRunControl(
    { argv: ["execution", "pause", "--json"] },
    failureCoordinator,
    { hostSessionId: "pi-session-1" },
  );
  assert.equal(failureValue.ok, false);
  const details = failureValue.details as { command: RunCliResult };
  const projected = JSON.parse(details.command.stdout) as typeof envelope;
  assert.equal(details.command.exitCode, 3);
  assert.equal(projected.ok, false);
  assert.equal(projected.exit_code, 3);
  assert.equal(projected.disposition, "control_flow");
  assert.equal(projected.error.code, "LEASE_BUSY");
  assert.equal(projected.error.details.visible, true);
  assert.equal(JSON.stringify(failureValue).includes("private-"), false);
});

test("real Maestro compatibility starts use alias flags for fresh and current-Execution statusless flows", async () => {
  const maestroBin = "D:/maestro2/bin/maestro.js";
  for (const family of ["session", "run"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-real-${family}-start-`));
    const calls: string[][] = [];
    const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
      calls.push([...args]);
      return defaultRunner([maestroBin, ...args], cwd, {
        executable: process.execPath,
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
    };
    const adapter = new RunCliAdapter(root, runner);
    const bridge = new WorkflowBridge(root);
    const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
    try {
      await mkdir(join(root, ".workflow"), { recursive: true });
      await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
        session_schema: {
          schema_version: "session-schema-selection/1.0",
          writer: "session/2.0",
          features: { session_statusless: true },
        },
      }), "utf8");
      await writeFile(join(root, ".workflow", "state.json"), JSON.stringify({
        version: "2.0",
        active_session_id: null,
        sessions: [],
      }), "utf8");
      await bridge.refresh();
      assert.equal(await coordinator.selectMode(), "core-execution");

      const intent = `${family} fresh compatibility start`;
      const freshArgv = [family, "start", intent, "--no-dispatch"];
      const fresh = await coordinator.exec(
        freshArgv,
        classifyRunControlArgv(freshArgv),
        `pi-${family}`,
      );
      const freshEnvelope = JSON.parse(fresh.command.stdout) as Record<string, any>;
      assert.equal(freshEnvelope.operation, "execution-start");
      assert.equal(freshEnvelope.locator.generation, 1);
      const freshCall = calls.find((call) => call[0] === family && call[1] === "start")!;
      assert.equal(flagValue(freshCall, "--owner-id"), `pi-${family}`);
      assert.equal(freshCall.includes("--execution-owner"), false);
      assert.equal(flagValue(freshCall, "--expected-identity-revision"), "1");
      assert.equal(flagValue(freshCall, "--expected-activity-revision"), "0");
      assert.equal(flagValue(freshCall, "--expected-lease-epoch"), "0");
      assert.equal(flagValue(freshCall, "--actor"), `pi-${family}`);
      assert.equal(typeof flagValue(freshCall, "--reason"), "string");
      assert.equal(flagValue(freshCall, "--evidence"), `pi-session:pi-${family}`);
      assert.equal(JSON.stringify(fresh).includes("lease_id"), false);

      const existingArgv = family === "run"
        ? [family, "start", "--session", freshEnvelope.locator.session_id, "--cmd", "execute"]
        : [family, "start", "--session", freshEnvelope.locator.session_id, "--chain", "execute"];
      const existing = await coordinator.exec(
        existingArgv,
        classifyRunControlArgv(existingArgv),
        `pi-${family}`,
      );
      const existingEnvelope = JSON.parse(existing.command.stdout) as Record<string, any>;
      assert.equal(existingEnvelope.operation, "create");
      const aliasCalls = calls.filter((call) => call[0] === family && call[1] === "start");
      const existingCall = aliasCalls[1]!;
      assert.equal(flagValue(existingCall, "--owner-id"), `pi-${family}`);
      assert.equal(flagValue(existingCall, "--lease-epoch"), "1");
      assert.equal(typeof flagValue(existingCall, "--lease-id"), "string");
      assert.equal(flagValue(existingCall, "--execution"), freshEnvelope.locator.execution_id);
      assert.equal(flagValue(existingCall, "--generation"), "1");
      assert.equal(existingCall.includes("--expected-lease-epoch"), false);
      assert.equal(existingCall.includes("--execution-owner"), false);
      assert.equal(JSON.stringify(existing).includes(flagValue(existingCall, "--lease-id")!), false);
    } finally {
      await coordinator.release().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("real Maestro compatibility starts acquire existing statusless Session identity shells", async () => {
  const maestroBin = "D:/maestro2/bin/maestro.js";
  for (const family of ["session", "run"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-real-${family}-existing-shell-`));
    const calls: string[][] = [];
    const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
      calls.push([...args]);
      return defaultRunner([maestroBin, ...args], cwd, {
        executable: process.execPath,
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
    };
    const adapter = new RunCliAdapter(root, runner);
    const bridge = new WorkflowBridge(root);
    const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
    try {
      await mkdir(join(root, ".workflow"), { recursive: true });
      await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
        session_schema: {
          schema_version: "session-schema-selection/1.0",
          writer: "session/2.0",
          features: { session_statusless: true },
        },
      }), "utf8");
      const created = await adapter.exec([
        "session", "create", `${family} existing identity shell`,
        "--id", `${family}-existing-shell`,
        "--intent", `${family} existing identity shell`,
        "--json",
      ]);
      const createdEnvelope = JSON.parse(created.stdout) as Record<string, any>;
      const sessionId = createdEnvelope.locator.session_id as string;
      await writeFile(join(root, ".workflow", "state.json"), JSON.stringify({
        version: "2.0",
        active_session_id: sessionId,
        sessions: [],
      }), "utf8");
      const shell = await bridge.refresh();
      assert.equal(shell.session?.currentExecutionId, null);
      assert.equal(shell.execution, undefined);
      assert.equal(await coordinator.selectMode(), "core-execution");

      const argv = [family, "start", `${family} existing identity shell`, "--session", sessionId, "--no-dispatch"];
      const started = await coordinator.exec(argv, classifyRunControlArgv(argv), `pi-${family}-shell`);
      const envelope = JSON.parse(started.command.stdout) as Record<string, any>;
      assert.equal(envelope.operation, "execution-start");
      assert.equal(envelope.locator.session_id, sessionId);
      assert.equal(envelope.locator.generation, 1);
      const call = calls.find((candidate) => candidate[0] === family && candidate[1] === "start")!;
      assert.equal(flagValue(call, "--session"), sessionId);
      assert.equal(flagValue(call, "--owner-id"), `pi-${family}-shell`);
      assert.equal(call.includes("--execution-owner"), false);
      assert.equal(flagValue(call, "--expected-identity-revision"), "1");
      assert.equal(flagValue(call, "--expected-activity-revision"), "0");
      assert.equal(flagValue(call, "--expected-lease-epoch"), "0");
      assert.equal(flagValue(call, "--actor"), `pi-${family}-shell`);
      assert.equal(flagValue(call, "--evidence"), `pi-session:pi-${family}-shell`);
      assert.equal(JSON.stringify(started).includes("lease_id"), false);
    } finally {
      await coordinator.release().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("real Maestro CLI accepts coordinator-generated structured start and attach arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-maestro-"));
  const maestroBin = "D:/maestro2/bin/maestro.js";
  const calls: string[][] = [];
  const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
    calls.push([...args]);
    return defaultRunner([maestroBin, ...args], cwd, {
      executable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
  };
  const adapter = new RunCliAdapter(root, runner);
  const bridge = new WorkflowBridge(root);
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    assert.equal((await lstat(maestroBin)).isFile(), true);
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/2.0",
        features: { session_statusless: true },
      },
    }), "utf8");
    const created = await adapter.exec([
      "session", "create", "real coordinator integration",
      "--id", "real-coordinator", "--intent", "real coordinator integration", "--json",
    ]);
    assert.equal(created.exitCode, 0, created.stderr || created.stdout);
    const createdEnvelope = JSON.parse(created.stdout) as { locator?: { session_id?: string | null } };
    const sessionId = createdEnvelope.locator?.session_id;
    assert.equal(typeof sessionId, "string");
    await writeFile(join(root, ".workflow", "state.json"), JSON.stringify({
      active_session_id: sessionId,
    }), "utf8");
    await bridge.refresh();
    assert.equal(await coordinator.selectMode(), "core-execution");

    const started = await coordinator.exec(
      ["execution", "start"],
      classifyRunControlArgv(["execution", "start"]),
      "pi-real",
    );
    const startEnvelope = JSON.parse(started.command.stdout) as {
      schema_version: string; operation: string; ok: boolean;
    };
    assert.equal(startEnvelope.schema_version, "run-response/1.1");
    assert.equal(startEnvelope.operation, "execution-start");
    assert.equal(startEnvelope.ok, true);
    const startCall = calls.find((call) => call[0] === "execution" && call[1] === "start")!;
    assert.equal(startCall.includes("--chain"), false);
    assert.equal(flagValue(startCall, "--execution-owner"), "pi-real");
    assert.equal(flagValue(startCall, "--expected-lease-epoch"), "0");
    assert.equal(flagValue(startCall, "--expected-identity-revision"), "1");
    assert.equal(flagValue(startCall, "--expected-activity-revision"), "0");

    await coordinator.exec(
      ["execution", "lease", "release"],
      classifyRunControlArgv(["execution", "lease", "release"]),
      "pi-real",
    );
    const attached = await coordinator.attach("pi-real");
    assert.equal(attached.lease.ownerId, "pi-real");
    const attachCall = calls.find((call) => call[0] === "execution" && call[1] === "attach")!;
    assert.equal(flagValue(attachCall, "--execution-owner"), "pi-real");
    assert.equal(flagValue(attachCall, "--owner-kind"), "pi");
    assert.equal(flagValue(attachCall, "--expected-lease-epoch"), "1");
    assert.equal(flagValue(attachCall, "--expected-execution-revision"), "2");

    const turn = await coordinator.claimHostOperation("turn-real", "turn", "pi-real");
    const tool = await coordinator.claimHostOperation("tool-real", "tool", "pi-real", turn.operationId);
    const prepared = await executeRunControl(
      { argv: ["execution", "handoff", "prepare", "--to-owner-id", "pi-next"] },
      coordinator,
      { hostSessionId: "pi-real", toolOperationId: tool.operationId },
    );
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal(JSON.stringify(prepared).includes(tool.operationToken), false);
    await coordinator.releaseHostOperation(tool.operationId, "pi-real");
    let status = await coordinator.operationStatus("pi-real");
    assert.equal(status.admission, "draining");
    assert.deepEqual(status.activeOperationIds, [turn.operationId]);
    await coordinator.releaseHostOperation(turn.operationId, "pi-real");
    status = await coordinator.operationStatus("pi-real");
    assert.equal(status.admission, "draining");
    assert.deepEqual(status.activeOperationIds, []);
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("core new-Session Plan publication creates and replays one deterministic authority chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-core-new-plan-"));
  const snapshot: WorkflowSnapshot = {
    source: "none",
    projectRoot: root,
    loadedAt: "2026-08-12T00:00:00.000Z",
    revision: { fingerprint: "none" },
    diagnostics: [],
  };
  const calls: string[][] = [];
  let publishAttempts = 0;
  let failFirstPublish = true;
  const applyPublishedSnapshot = (): void => {
    snapshot.execution!.revision = 4;
    snapshot.execution!.chain = [
      { step: "step-000-execute", command: "execute", status: "pending", runId: null },
      { step: "step-001-verify", command: "verify", status: "pending", runId: null },
    ];
    snapshot.revision.executionRevision = 4;
    snapshot.session!.activityRevision = 4;
    snapshot.session!.chain = structuredClone(snapshot.execution!.chain);
  };
  const adapter: WorkflowRunAdapter = {
    ...coreAdapter(calls, snapshot, (argv) => {
      if (argv[0] === "session" && argv[1] === "create") {
        const sessionId = flagValue(argv, "--id")!;
        setCorePlanIdentitySnapshot(snapshot, sessionId, flagValue(argv, "--intent")!);
        return corePlanSessionCreateResponse(sessionId);
      }
      if (argv[0] === "execution" && argv[1] === "start") {
        const sessionId = flagValue(argv, "--session")!;
        setCorePlanExecutionSnapshot(snapshot, sessionId, flagValue(argv, "--execution-owner")!);
        return corePlanExecutionStartResponse(sessionId, flagValue(argv, "--request-id")!);
      }
      const operation = operationForArgv(argv);
      const executionId = snapshot.execution?.executionId ?? "execution-001";
      return coreRunResponse(operation, {
        locator: {
          session_id: snapshot.session?.sessionId ?? flagValue(argv, "--session"),
          execution_id: executionId,
          generation: snapshot.execution?.generation ?? 1,
          run_id: snapshot.execution?.activeRunId ?? null,
        },
        fence: {
          session_identity_revision: snapshot.session?.identityRevision ?? 1,
          session_activity_revision: snapshot.session?.activityRevision ?? 1,
          execution_revision: snapshot.execution?.revision ?? 1,
          lease_epoch: snapshot.execution?.lease?.epoch ?? 1,
        },
      });
    }),
    async publishPlan(options) {
      calls.push(["plan-publish", options.sessionId ?? "new", options.requestId ?? ""]);
      publishAttempts++;
      applyPublishedSnapshot();
      if (publishAttempts > 1) {
        assert.equal(options.expectedExecutionRevision, 4);
        assert.equal(options.expectedActivityRevision, 4);
      }
      if (failFirstPublish) {
        failFirstPublish = false;
        throw new Error("injected publish transport failure lease_id=publish-private");
      }
      return result([], JSON.stringify(coreRunResponse("plan-publish", {
        request_id: options.requestId,
        locator: {
          session_id: options.sessionId,
          execution_id: options.executionId,
          generation: options.generation,
          run_id: "run-plan-publish",
        },
        fence: {
          session_identity_revision: 1,
          session_activity_revision: 4,
          execution_revision: 4,
          lease_epoch: 1,
        },
        result: {
          session_id: options.sessionId,
          run_id: "run-plan-publish",
          artifact_id: "ART-PLAN",
          source_checksum: "sha256:source",
          handoff_key: options.handoffKey,
          request_id: options.requestId,
          visible: true,
          lease_id: "publish-private",
        },
        replay: {
          status: publishAttempts > 1 ? "replayed" : "applied",
          transition_id: "transition-plan-publish",
        },
      })));
    },
  };
  const coordinator = new WorkflowCoordinator(
    fakeBridge(snapshot),
    adapter,
    new WorkflowLeaseStore(root),
  );
  const options: RunPlanPublishOptions = {
    sourcePath: "D:/plans/approved.md",
    sourceRoot: "D:/plans",
    intent: "Execute deterministic approved Plan",
    topic: "Execute deterministic approved Plan",
    handoffKey: "handoff-core-new-session",
    sourcePiSession: "pi-new-plan",
    planRevision: 1,
    approvedAt: "2026-08-12T00:00:00.000Z",
  };
  try {
    assert.equal(await coordinator.supportsNewPlanSession(), true);
    await assert.rejects(
      coordinator.publishPlan(options, { hostSessionId: "pi-new-plan" }),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /can be retried with the same approved Plan/);
        assert.equal(message.includes("publish-private"), false);
        return true;
      },
    );

    const recovered = await coordinator.publishPlan(options, { hostSessionId: "pi-new-plan" });
    const replay = await coordinator.publishPlan(options, { hostSessionId: "pi-new-plan" });
    const createCalls = calls.filter((call) => call[1] === "session" && call[2] === "create");
    const startCalls = calls.filter((call) => call[1] === "execution" && call[2] === "start");
    assert.equal(createCalls.length, 1, "identity recovery must not allocate another Session");
    assert.equal(startCalls.length, 1, "recovery must retain the canonically revalidated in-memory claim");
    assert.equal(flagValue(createCalls[0]!, "--request-id"), undefined);
    assert.equal(flagValue(createCalls[0]!, "--actor"), undefined);
    const deterministicSessionId = flagValue(createCalls[0]!, "--id")!;
    assert.match(deterministicSessionId, /^pi-plan-[a-f0-9]{24}-00000000-000000$/);
    assert.equal(flagValue(startCalls[0]!, "--session"), deterministicSessionId);
    assert.equal(flagValue(startCalls[0]!, "--expected-identity-revision"), "1");
    assert.equal(flagValue(startCalls[0]!, "--expected-activity-revision"), "0");
    assert.equal(flagValue(startCalls[0]!, "--expected-lease-epoch"), "0");
    assert.equal(JSON.parse(recovered.command.stdout).replay.status, "replayed");
    assert.equal(JSON.parse(replay.command.stdout).replay.status, "replayed");
    assert.equal(JSON.stringify({ recovered, replay }).includes("private"), false);
    assert.equal(calls.filter((call) => call[0] === "plan-publish").length, 3);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro CLI publishes and replays a new statusless Plan Session after response loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-new-plan-"));
  const maestroBin = "D:/maestro2/bin/maestro.js";
  const calls: string[][] = [];
  let discardFirstPlanResponse = true;
  let privateLeaseId = "";
  let firstFailureMessage = "";
  const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
    calls.push([...args]);
    const completed = await defaultRunner([maestroBin, ...args], cwd, {
      executable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (discardFirstPlanResponse
      && args[0] === "plan"
      && args[1] === "publish"
      && completed.exitCode === 0) {
      discardFirstPlanResponse = false;
      privateLeaseId = flagValue(args, "--lease-id") ?? "";
      throw new Error(`injected response loss lease_id=${privateLeaseId}`);
    }
    return completed;
  };
  const adapter = new RunCliAdapter(root, runner);
  const bridge = new WorkflowBridge(root);
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    await mkdir(join(root, "prepare"), { recursive: true });
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, "prepare", "plan-publish.md"), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---
`, "utf8");
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/2.0",
        features: { session_statusless: true },
      },
    }), "utf8");
    await writeFile(join(root, ".workflow", "state.json"), JSON.stringify({
      version: "2.0",
      active_session_id: null,
      sessions: [],
    }), "utf8");
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, "# New statusless Plan\n\nExecute with canonical authority.\n", "utf8");
    const options: RunPlanPublishOptions = {
      sourcePath,
      sourceRoot: root,
      intent: "Execute a new approved Plan",
      topic: "Execute a new approved Plan",
      handoffKey: "handoff-real-new-statusless",
      sourcePiSession: "pi-real-new-plan",
      planRevision: 1,
      approvedAt: "2026-08-12T02:00:00.000Z",
    };

    assert.equal(await coordinator.supportsNewPlanSession(), true);
    await assert.rejects(
      coordinator.publishPlan(options, { hostSessionId: "pi-real-new-plan" }),
      (error: unknown) => {
        const message = String((error as Error).message);
        firstFailureMessage = message;
        assert.match(message, /can be retried with the same approved Plan/);
        assert.equal(privateLeaseId.length > 0 && message.includes(privateLeaseId), false);
        return true;
      },
    );
    assert.notEqual(privateLeaseId, "", firstFailureMessage);

    const recovered = await coordinator.publishPlan(options, { hostSessionId: "pi-real-new-plan" });
    const replay = await coordinator.publishPlan(options, { hostSessionId: "pi-real-new-plan" });
    const recoveredEnvelope = JSON.parse(recovered.command.stdout) as Record<string, any>;
    const replayEnvelope = JSON.parse(replay.command.stdout) as Record<string, any>;
    assert.equal(recoveredEnvelope.schema_version, "run-response/1.1");
    assert.equal(recoveredEnvelope.operation, "plan-publish");
    assert.equal(recoveredEnvelope.replay.status, "replayed");
    assert.equal(replayEnvelope.replay.status, "replayed");
    assert.equal(replayEnvelope.replay.transition_id, recoveredEnvelope.replay.transition_id);
    assert.equal(recoveredEnvelope.fence.execution_revision, 4);
    assert.equal(recoveredEnvelope.fence.session_activity_revision, 4);
    assert.equal(JSON.stringify({ recovered, replay }).includes(privateLeaseId), false);
    const serializedPublication = JSON.stringify({ recovered, replay });
    const handoffLeakAt = serializedPublication.indexOf(options.handoffKey);
    assert.equal(
      handoffLeakAt,
      -1,
      handoffLeakAt < 0 ? "" : serializedPublication.slice(Math.max(0, handoffLeakAt - 120), handoffLeakAt + options.handoffKey.length + 120),
    );

    const createCalls = calls.filter((call) => call[0] === "session" && call[1] === "create");
    const startCalls = calls.filter((call) => call[0] === "execution" && call[1] === "start");
    const publishCalls = calls.filter((call) => call[0] === "plan" && call[1] === "publish");
    assert.equal(createCalls.length, 1);
    assert.equal(startCalls.length, 1);
    assert.equal(publishCalls.length, 3);
    const sessionId = flagValue(createCalls[0]!, "--id")!;
    assert.match(sessionId, /^pi-plan-[a-f0-9]{24}-00000000-000000$/);
    assert.equal(flagValue(startCalls[0]!, "--session"), sessionId);
    assert.equal(flagValue(publishCalls[0]!, "--expected-execution-revision"), "1");
    assert.equal(flagValue(publishCalls[1]!, "--expected-execution-revision"), "4");
    assert.equal(flagValue(publishCalls[1]!, "--expected-activity-revision"), "4");

    const sessionsRoot = join(root, ".workflow", "sessions");
    const sessionDirectories = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== ".backups");
    assert.deepEqual(sessionDirectories.map((entry) => entry.name), [sessionId]);
    const sessionDir = join(sessionsRoot, sessionId);
    const identity = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as Record<string, any>;
    assert.equal(identity.schema_version, "session/2.0");
    assert.equal(identity.activity_revision, 4);

    const executionDirectories = (await readdir(join(sessionDir, "executions"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.equal(executionDirectories.length, 1);
    const executionId = executionDirectories[0]!.name;
    assert.equal(identity.current_execution_id, executionId);
    assert.equal(identity.latest_execution_id, executionId);
    const executionDir = join(sessionDir, "executions", executionId);
    const execution = JSON.parse(await readFile(join(executionDir, "execution.json"), "utf8")) as Record<string, any>;
    assert.equal(execution.schema_version, "execution/1.0");
    assert.equal(execution.generation, 1);
    assert.equal(execution.revision, 4);
    assert.equal(execution.active_run_id, null);
    assert.deepEqual(
      execution.chain.map((step: Record<string, unknown>) => ({
        command: step.command, status: step.status, run_id: step.run_id,
      })),
      [
        { command: "execute", status: "pending", run_id: null },
        { command: "verify", status: "pending", run_id: null },
      ],
    );
    const compatibility = JSON.parse(
      await readFile(join(sessionDir, ".compat", "session-1.3.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(compatibility.orchestration.engine, "manual");
    assert.deepEqual(compatibility.orchestration.chain, execution.chain);

    const runDirectories = (await readdir(join(sessionDir, "runs"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.equal(runDirectories.length, 1);
    const runId = runDirectories[0]!.name;
    const run = JSON.parse(await readFile(join(sessionDir, "runs", runId, "run.json"), "utf8")) as Record<string, any>;
    assert.equal(run.schema_version, "command-run/1.4");
    assert.equal(run.status, "sealed");
    assert.equal(run.command.name, "plan-publish");
    assert.equal(run.execution_id, executionId);
    assert.equal(run.generation, 1);
    assert.equal(run.handoff.producer_run_id, runId);
    assert.equal(run.handoff.command, "plan-publish");
    assert.equal(recoveredEnvelope.locator.session_id, sessionId);
    assert.equal(recoveredEnvelope.locator.execution_id, executionId);
    assert.equal(recoveredEnvelope.locator.generation, 1);
    assert.equal(recoveredEnvelope.locator.run_id, runId);

    const artifacts = JSON.parse(await readFile(join(sessionDir, "artifacts.json"), "utf8")) as Record<string, any>;
    const artifactId = artifacts.aliases["current-plan"] as string;
    assert.equal(Object.keys(artifacts.artifacts).length, 1);
    assert.equal(artifacts.artifacts[artifactId].producer_run_id, runId);
    const published = {
      ...(recoveredEnvelope.result as {
        session_id: string;
        run_id: string;
        artifact_id: string;
        source_checksum: string;
        request_id: string;
      }),
      handoff_key: options.handoffKey,
    };
    assert.equal(published.session_id, sessionId);
    assert.equal(published.run_id, runId);
    assert.equal(published.artifact_id, artifactId);
    assert.doesNotThrow(() => assertPublishedPlanSnapshot(recovered.snapshot, published, sessionId));

    const bootstrapRequestId = `${recoveredEnvelope.request_id}__bootstrap`;
    const bootstrapBytes = await readFile(join(executionDir, "transitions", `${bootstrapRequestId}.json`), "utf8");
    const bootstrapReceipt = JSON.parse(bootstrapBytes) as Record<string, any>;
    assert.equal(bootstrapReceipt.payload.operation, "execution-chain-bootstrap");
    assert.equal(bootstrapReceipt.payload.preconditions.execution_revision, 1);
    assert.equal(bootstrapReceipt.outcome.postconditions.execution_revision, 2);
    assert.equal(bootstrapBytes.includes(privateLeaseId), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro CLI publishes a statusless current Plan with Execution fences and replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-plan-publish-"));
  const maestroBin = "D:/maestro2/bin/maestro.js";
  const calls: string[][] = [];
  const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
    calls.push([...args]);
    return defaultRunner([maestroBin, ...args], cwd, {
      executable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
  };
  const adapter = new RunCliAdapter(root, runner);
  const bridge = new WorkflowBridge(root);
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    await mkdir(join(root, "prepare"), { recursive: true });
    await writeFile(join(root, "prepare", "plan-publish.md"), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---
`, "utf8");
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, "# Statusless current Plan\n\nExecute through current authority.\n", "utf8");

    const created = await adapter.exec([
      "session", "create", "statusless current plan", "--id", "statusless-plan",
      "--intent", "Execute approved Plan", "--chain", "execute", "verify", "--engine", "manual", "--json",
    ]);
    const createdEnvelope = JSON.parse(created.stdout) as { locator?: { session_id?: string | null } };
    const sessionId = createdEnvelope.locator?.session_id;
    assert.equal(typeof sessionId, "string");
    await writeFile(join(root, ".workflow", "state.json"), JSON.stringify({
      active_session_id: sessionId,
    }), "utf8");
    await bridge.refresh();

    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/2.0",
        features: { session_statusless: true },
      },
    }), "utf8");
    await adapter.exec(["session", "migrate", "--session", sessionId!, "--to", "session/2.0"]);
    await bridge.refresh();
    assert.equal(await coordinator.selectMode(), "core-execution");
    await coordinator.attach("pi-plan-real");

    const publishOptions: RunPlanPublishOptions = {
      sourcePath,
      sourceRoot: root,
      sessionId,
      handoffKey: "handoff-real-statusless",
      sourcePiSession: "pi-plan-real",
      planRevision: 1,
      approvedAt: "2026-08-11T21:00:00.000Z",
    };
    const first = await coordinator.publishPlan(publishOptions, { hostSessionId: "pi-plan-real" });
    const replay = await coordinator.publishPlan(publishOptions, { hostSessionId: "pi-plan-real" });
    const firstEnvelope = JSON.parse(first.command.stdout) as Record<string, any>;
    const replayEnvelope = JSON.parse(replay.command.stdout) as Record<string, any>;
    assert.equal(firstEnvelope.schema_version, "run-response/1.1");
    assert.equal(firstEnvelope.operation, "plan-publish");
    assert.equal(firstEnvelope.ok, true);
    assert.equal(firstEnvelope.locator.session_id, sessionId);
    assert.equal(firstEnvelope.locator.execution_id, replayEnvelope.locator.execution_id);
    assert.equal(firstEnvelope.locator.generation, 1);
    assert.equal(typeof firstEnvelope.locator.run_id, "string");
    assert.equal(firstEnvelope.replay.status, "applied");
    assert.equal(replayEnvelope.replay.status, "replayed");
    assert.equal(replayEnvelope.replay.transition_id, firstEnvelope.replay.transition_id);
    assert.equal(firstEnvelope.fence.execution_revision, replayEnvelope.fence.execution_revision);

    const planCall = calls.find((call) => call[0] === "plan" && call[1] === "publish")!;
    const privateLeaseId = flagValue(planCall, "--lease-id")!;
    assert.equal(JSON.stringify(first).includes('"lease_id":'), false);
    assert.equal(JSON.stringify(first).includes(privateLeaseId), false);
    assert.equal(JSON.stringify(first).includes("private-core"), false);
    const serializedPublication = JSON.stringify(first);
    const handoffLeakAt = serializedPublication.indexOf(publishOptions.handoffKey);
    assert.equal(
      handoffLeakAt,
      -1,
      handoffLeakAt < 0 ? "" : serializedPublication.slice(Math.max(0, handoffLeakAt - 120), handoffLeakAt + publishOptions.handoffKey.length + 120),
    );
    assert.equal(flagValue(planCall, "--session"), sessionId);
    assert.equal(flagValue(planCall, "--execution"), firstEnvelope.locator.execution_id);
    assert.equal(flagValue(planCall, "--generation"), "1");
    assert.equal(flagValue(planCall, "--request-id"), firstEnvelope.request_id);
    assert.equal(flagValue(planCall, "--execution-owner"), "pi-plan-real");
    assert.equal(flagValue(planCall, "--owner-kind"), "pi");
    assert.equal(flagValue(planCall, "--actor"), "pi-plan-real");
    assert.equal(flagValue(planCall, "--reason"), "Publish approved Pi Plan into current Execution");
    assert.equal(flagValue(planCall, "--evidence"), "pi-session:pi-plan-real");
    assert.equal(typeof flagValue(planCall, "--lease-id"), "string");

    const currentFence = replayEnvelope.fence as Record<string, number>;
    const directAuthority = {
      sourcePath,
      sourceRoot: root,
      sessionId,
      sourcePiSession: "pi-plan-real",
      planRevision: 1,
      approvedAt: "2026-08-11T21:01:00.000Z",
      expectedIdentityRevision: currentFence.session_identity_revision,
      expectedActivityRevision: currentFence.session_activity_revision,
      executionId: replayEnvelope.locator.execution_id as string,
      generation: replayEnvelope.locator.generation as number,
      expectedExecutionRevision: currentFence.execution_revision,
      executionOwner: "pi-plan-real",
      ownerKind: "pi" as const,
      ownerEpoch: currentFence.lease_epoch,
      leaseId: privateLeaseId,
      actor: "pi-plan-real",
      reason: "Exercise Plan publication fences",
      evidence: ["TEST:real-plan-fences"],
    };
    await assert.rejects(
      adapter.publishPlan({
        ...directAuthority,
        handoffKey: "handoff-real-stale-revision",
        requestId: "req-real-stale-revision",
        expectedExecutionRevision: currentFence.execution_revision - 1,
      }),
      /execution revision conflict/,
    );
    await assert.rejects(
      adapter.publishPlan({
        ...directAuthority,
        handoffKey: "handoff-real-stale-lease",
        requestId: "req-real-stale-lease",
        leaseId: `${privateLeaseId}-stale`,
      }),
      /lease fence conflict/,
    );

    await writeFile(sourcePath, "# Changed after approval\n", "utf8");
    await assert.rejects(
      coordinator.publishPlan(publishOptions, { hostSessionId: "pi-plan-real" }),
      /source bytes changed/,
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro CLI preserves legacy Plan publication through the Pi adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-plan-legacy-"));
  const maestroBin = "D:/maestro2/bin/maestro.js";
  const calls: string[][] = [];
  const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
    calls.push([...args]);
    return defaultRunner([maestroBin, ...args], cwd, {
      executable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
  };
  const adapter = new RunCliAdapter(root, runner);
  try {
    await mkdir(join(root, "prepare"), { recursive: true });
    await writeFile(join(root, "prepare", "plan-publish.md"), `---
name: plan-publish
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---
`, "utf8");
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, "# Legacy Plan\n", "utf8");
    const created = await adapter.exec([
      "session", "create", "legacy plan", "--id", "legacy-plan", "--intent", "Legacy Plan", "--json",
    ]);
    const createdEnvelope = JSON.parse(created.stdout) as { locator?: { session_id?: string | null } };
    const options: RunPlanPublishOptions = {
      sourcePath,
      sourceRoot: root,
      sessionId: createdEnvelope.locator?.session_id ?? undefined,
      handoffKey: "handoff-real-legacy",
      sourcePiSession: "pi-legacy",
      planRevision: 1,
      approvedAt: "2026-08-11T21:10:00.000Z",
    };
    const first = JSON.parse((await adapter.publishPlan(options)).stdout) as Record<string, any>;
    const replay = JSON.parse((await adapter.publishPlan(options)).stdout) as Record<string, any>;
    assert.equal(first.schema_version, "run-response/1.0");
    assert.equal(first.operation, "plan-publish");
    assert.equal(first.locator.session_id, options.sessionId);
    assert.equal(first.locator.execution_id, undefined);
    assert.equal(first.replay.status, "applied");
    assert.equal(replay.replay.status, "replayed");
    const planCall = calls.find((call) => call[0] === "plan" && call[1] === "publish")!;
    assert.equal(planCall.includes("--execution"), false);
    assert.equal(planCall.includes("--expected-execution-revision"), false);
    assert.equal(planCall.includes("--lease-id"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner advertises the Pi package root to the Maestro process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-package-root-"));
  try {
    const execution = await defaultRunner(
      ["-e", "process.stdout.write(process.env.MAESTRO_PI_PACKAGE_ROOT ?? '')"],
      root,
      { executable: process.execPath },
    );
    assert.equal(execution.exitCode, 0);
    assert.match(execution.stdout.replaceAll("\\", "/"), /\/pi-maestro-flow(?:\/packages\/pi-maestro-flow)?$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner times out and terminates a hung process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-timeout-"));
  try {
    const execution = await defaultRunner(
      ["-e", "setInterval(() => undefined, 1000)"],
      root,
      { executable: process.execPath, timeoutMs: 50, maxOutputBytes: 1024 },
    );
    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /timed out after 50ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner bounds UTF-8 output by bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-output-"));
  try {
    const execution = await defaultRunner(
      ["-e", "process.stdout.write('界'.repeat(4096)); setInterval(() => undefined, 1000)"],
      root,
      { executable: process.execPath, timeoutMs: 5_000, maxOutputBytes: 128 },
    );
    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /output exceeded 128 bytes/);
    assert.ok(Buffer.byteLength(execution.stdout, "utf8") <= 128);
    assert.ok(Buffer.byteLength(execution.stderr, "utf8") <= 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner settles once and removes listeners when error races close", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.emit("error", new Error("spawn failed"));
      child.emit("close", 1);
    });
    return child;
  };
  let settlements = 0;
  const execution = await defaultRunner([], process.cwd(), { spawnProcess: spawnProcess as never }).then((result) => {
    settlements++;
    return result;
  });
  await delay(10);

  assert.equal(execution.exitCode, 1);
  assert.match(execution.stderr, /spawn failed/);
  assert.equal(settlements, 1);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

function testCoordinator(
  bridge: WorkflowSnapshotProvider,
  adapter: WorkflowRunAdapter,
  leases: WorkflowLeaseStore,
  heartbeatEveryMs = 10_000,
): WorkflowCoordinator {
  return new WorkflowCoordinator(
    bridge,
    adapter,
    leases,
    heartbeatEveryMs,
    { legacyCompatibility: !adapter.capabilities },
  );
}

function readClassification(): ReturnType<typeof classifyRunControlArgv> {
  return { write: false, sessionless: false, mutation: "read", lease: "none" };
}

function writeClassification(
  mutation: "session" | "execution" | "execution-acquire" | "execution-lease"
    | "execution-operation" | "compatibility-start" | "plan-publish",
  lease: "none" | "required" | "acquire" | "command-aware",
  sessionless = false,
): ReturnType<typeof classifyRunControlArgv> {
  return { write: true, sessionless, mutation, lease };
}

function failClosedCoreCapabilities(diagnostic: string): RunCliCapabilities {
  return {
    ...fullCoreCapabilities(),
    mode: "fail-closed",
    structured: null,
    support: {
      execution_generation: false,
      core_execution_lease: false,
      execution_operation_drain: false,
      "run-response/1.1": false,
    },
    diagnostic,
  };
}

function legacyCoreCapabilities(): RunCliCapabilities {
  return {
    ...failClosedCoreCapabilities("Installed Maestro CLI has no capabilities command"),
    mode: "legacy",
  };
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function assertCoreLeaseTuple(argv: readonly string[]): void {
  assert.equal(flagValue(argv, "--session"), "session-1");
  assert.equal(flagValue(argv, "--execution"), "execution-1");
  assert.equal(flagValue(argv, "--expected-execution-revision"), "8");
  assert.equal(flagValue(argv, "--execution-owner"), "pi-owner");
  assert.equal(flagValue(argv, "--owner-kind"), "pi");
  assert.equal(flagValue(argv, "--owner-epoch"), "4");
  assert.equal(flagValue(argv, "--lease-id"), "private-core-lease");
}

function fullCoreCapabilities(): RunCliCapabilities {
  return {
    commands: new Set(["brief", "check", "next", "complete", "edit"]),
    sessionCommands: new Set(),
    planCommands: new Set(["publish"]),
    mode: "structured",
    structured: {
      schema_version: "maestro-capabilities/1.0",
      cli_version: "2.0.0",
      session_schema_writes: ["session/2.0"],
      execution_schema_writes: ["execution/1.0"],
      run_response_writes: ["run-response/1.1"],
      features: {
        execution_generation: true,
        core_execution_lease: true,
        execution_handoff: true,
        execution_operation_drain: true,
        session_statusless: true,
        legacy_session_aliases: true,
      },
    },
    support: {
      execution_generation: true,
      core_execution_lease: true,
      execution_operation_drain: true,
      "run-response/1.1": true,
    },
    diagnostic: null,
  };
}

// Plan-B style core: modern protocol without the optional (deprecated)
// execution_operation_drain capability, which it does not broadcast at all.
function noDrainCoreCapabilities(): RunCliCapabilities {
  const full = fullCoreCapabilities();
  const structured = full.structured!;
  const { execution_operation_drain: _omitted, ...features } = structured.features;
  return {
    ...full,
    structured: { ...structured, features },
    support: { ...full.support, execution_operation_drain: false },
  };
}

function corePlanSessionCreateResponse(sessionId: string): Record<string, unknown> {
  return {
    schema_version: "run-response/1.1",
    operation: "session-create",
    ok: true,
    exit_code: 0,
    disposition: "success",
    request_id: null,
    locator: { session_id: sessionId, execution_id: null, generation: null, run_id: null },
    fence: {
      session_identity_revision: 1,
      session_activity_revision: 0,
      execution_revision: null,
      lease_epoch: null,
    },
    result: {
      session_id: sessionId,
      schema_version: "session/2.0",
      current_execution_id: null,
      latest_execution_id: null,
    },
    next: null,
    continuation: null,
    replay: null,
    warnings: [],
    error: null,
  };
}

function corePlanExecutionStartResponse(sessionId: string, requestId: string): Record<string, unknown> {
  return coreRunResponse("execution-start", {
    request_id: requestId,
    locator: {
      session_id: sessionId,
      execution_id: "execution-001",
      generation: 1,
      run_id: null,
    },
    fence: {
      session_identity_revision: 1,
      session_activity_revision: 1,
      execution_revision: 1,
      lease_epoch: 1,
    },
    result: {
      lease_claim: {
        owner_id: "pi-new-plan",
        owner_kind: "pi",
        epoch: 1,
        lease_id: "private-new-plan-lease",
      },
    },
    replay: { status: "applied", transition_id: "transition-plan-execution-start" },
  });
}

function setCorePlanIdentitySnapshot(snapshot: WorkflowSnapshot, sessionId: string, intent: string): void {
  const identity = coreWorkflowSnapshot();
  snapshot.source = "canonical";
  snapshot.canonicalClaim = { activeSessionId: sessionId, status: "valid" };
  snapshot.sessionGeneration = `canonical:valid:${sessionId}:1`;
  snapshot.session = {
    ...identity.session!,
    sessionId,
    intent,
    identityRevision: 1,
    activityRevision: 0,
    currentExecutionId: null,
    latestExecutionId: null,
    activeRunId: null,
    chain: [],
    runs: [],
  };
  snapshot.locator = { sessionId };
  snapshot.execution = undefined;
  snapshot.revision = { sessionRevision: 1, fingerprint: `identity:${sessionId}` };
}

function setCorePlanExecutionSnapshot(snapshot: WorkflowSnapshot, sessionId: string, ownerId: string): void {
  snapshot.session!.activityRevision = 1;
  snapshot.session!.currentExecutionId = "execution-001";
  snapshot.session!.latestExecutionId = "execution-001";
  snapshot.locator = { sessionId, executionId: "execution-001", generation: 1 };
  snapshot.revision.executionRevision = 1;
  snapshot.execution = {
    schemaVersion: "execution/1.0",
    executionId: "execution-001",
    sessionId,
    generation: 1,
    status: "active",
    revision: 1,
    activeRunId: null,
    chain: [],
    decisionPoints: [],
    gatesRef: "gates.json",
    artifactsRef: "artifacts.json",
    evidenceRef: "evidence.json",
    lease: {
      sessionId,
      executionId: "execution-001",
      ownerId,
      ownerKind: "pi",
      epoch: 1,
      acquiredAt: "2026-08-12T00:00:00.000Z",
      heartbeatAt: "2026-08-12T00:00:00.000Z",
      handoffTo: null,
    },
    startedAt: "2026-08-12T00:00:00.000Z",
    sealedAt: null,
    sealSummary: null,
    finalOutcome: null,
  };
}

function coreAdapter(
  calls: string[][],
  snapshot: WorkflowSnapshot,
  response?: (argv: readonly string[]) => Record<string, unknown>,
  capabilities: RunCliCapabilities = fullCoreCapabilities(),
): WorkflowRunAdapter {
  const adapter = fakeAdapter(calls);
  return {
    ...adapter,
    async capabilities() { return capabilities; },
    async exec(argv) {
      calls.push(["exec", ...argv]);
      const classification = classifyRunControlArgv(argv);
      const executionOperation = argv[0] === "execution" && argv[1] === "operation";
      if (!classification.write && !executionOperation) return result(argv, `read ${argv.join(" ")}`);
      const envelope = response?.(argv) ?? coreRunResponse(operationForArgv(argv));
      applyCoreResponseToSnapshot(snapshot, envelope, argv);
      return result(argv, JSON.stringify(envelope));
    },
  };
}

function applyCoreResponseToSnapshot(
  snapshot: WorkflowSnapshot,
  envelope: Record<string, unknown>,
  argv: readonly string[],
): void {
  if (envelope.ok !== true) return;
  if (typeof flagValue(argv, "--request-id") === "string") {
    envelope.request_id = flagValue(argv, "--request-id");
  }
  const result = envelope.result as Record<string, unknown> | null;
  const leaseClaim = result?.lease_claim as Record<string, unknown> | undefined;
  if (leaseClaim) {
    leaseClaim.owner_id = flagValue(argv, "--execution-owner") ?? flagValue(argv, "--owner-id") ?? "pi-owner";
    leaseClaim.owner_kind = flagValue(argv, "--owner-kind") ?? "pi";
    leaseClaim.epoch = (envelope.fence as Record<string, unknown> | null)?.lease_epoch;
  }
  const locator = envelope.locator as Record<string, unknown> | null;
  const fence = envelope.fence as Record<string, unknown> | null;
  if (!locator || !fence || typeof locator.execution_id !== "string") return;
  const revision = fence.execution_revision;
  const generation = locator.generation;
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) return;
  const operation = String(envelope.operation);
  if (operation === "execution-seal") {
    snapshot.locator = { sessionId: String(locator.session_id) };
    snapshot.execution = undefined;
    snapshot.revision.executionRevision = undefined;
    return;
  }
  if (!snapshot.execution) return;
  snapshot.execution.revision = revision as number;
  snapshot.revision.executionRevision = revision as number;
  if (["execution-start", "execution-attach", "execution-resume", "execution-lease-recover"].includes(operation)) {
    snapshot.execution.status = "active";
    snapshot.execution.lease = {
      sessionId: String(locator.session_id),
      executionId: locator.execution_id,
      ownerId: flagValue(argv, "--execution-owner") ?? flagValue(argv, "--owner-id") ?? "pi-owner",
      ownerKind: "pi",
      epoch: fence.lease_epoch as number,
      acquiredAt: "2026-07-15T00:00:00.000Z",
      heartbeatAt: "2026-07-15T00:00:01.000Z",
      handoffTo: null,
    };
  } else if (operation === "execution-pause") {
    snapshot.execution.status = "paused";
    snapshot.execution.lease = null;
  } else if (operation === "execution-lease-release") {
    snapshot.execution.lease = null;
  }
}

function operationForArgv(argv: readonly string[]): string {
  if (argv[0] === "execution" && argv[1] === "operation") return `execution-operation-${argv[2]}`;
  if (argv[0] === "execution" && argv[1] === "handoff") return `execution-handoff-${argv[2]}`;
  if (argv[0] === "execution" && argv[1] === "lease") return `execution-lease-${argv[2]}`;
  if (argv[0] === "execution") return `execution-${argv[1]}`;
  if (argv[0] === "session") return `session-${argv[1]}`;
  if (argv[0] === "run" && argv[1] === "complete") return "complete";
  return argv[1] ?? argv[0] ?? "check";
}

function coreRunResponse(
  operation: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const acquisition = [
    "execution-start",
    "execution-attach",
    "execution-resume",
    "execution-handoff-accept",
    "execution-lease-recover",
  ].includes(operation);
  return {
    schema_version: "run-response/1.1",
    operation,
    ok: true,
    exit_code: 0,
    disposition: "success",
    request_id: "request-core",
    locator: {
      session_id: "session-1",
      execution_id: "execution-1",
      generation: 1,
      run_id: "run-1",
    },
    fence: {
      session_identity_revision: 3,
      session_activity_revision: 5,
      execution_revision: 8,
      lease_epoch: 4,
    },
    result: acquisition
      ? {
          lease_claim: {
            owner_id: "pi-owner",
            owner_kind: "pi",
            epoch: 4,
            lease_id: "private-core-lease",
          },
          nested: { token: "private-nested-token", visible: true },
          visible: true,
        }
      : { visible: true },
    next: null,
    continuation: null,
    replay: { status: "applied", transition_id: `transition-${operation}` },
    warnings: [],
    error: null,
    ...overrides,
  };
}

function coreWorkflowSnapshot(): WorkflowSnapshot {
  const snapshot = workflowSnapshot("running");
  const executionChain = snapshot.session!.chain;
  snapshot.session!.schemaVersion = "session/2.0";
  snapshot.session!.lifecycleAuthority = "execution-derived";
  delete (snapshot.session as { status?: string }).status;
  snapshot.session!.identityRevision = 3;
  snapshot.session!.activityRevision = 5;
  snapshot.session!.currentExecutionId = "execution-1";
  snapshot.session!.latestExecutionId = "execution-1";
  snapshot.session!.latestCompletedRunId = null;
  snapshot.session!.archivedAt = null;
  snapshot.session!.archivedBy = null;
  snapshot.session!.activeRunId = null;
  snapshot.session!.chain = [];
  snapshot.locator = {
    sessionId: "session-1",
    executionId: "execution-1",
    generation: 1,
    runId: "run-1",
  };
  snapshot.revision.executionRevision = 7;
  snapshot.execution = {
    executionId: "execution-1",
    sessionId: "session-1",
    generation: 1,
    status: "active",
    revision: 7,
    activeRunId: "run-1",
    chain: executionChain,
    decisionPoints: [],
    gatesRef: "gates.json",
    artifactsRef: "artifacts.json",
    evidenceRef: "evidence.json",
    lease: null,
    startedAt: "2026-07-15T00:00:00.000Z",
    sealedAt: null,
    sealSummary: null,
    finalOutcome: null,
  };
  return snapshot;
}

function fakeBridge(snapshot: WorkflowSnapshot): WorkflowSnapshotProvider {
  return {
    async refresh() { return snapshot; },
    getSnapshot() { return snapshot; },
  };
}

function fakeAdapter(
  calls: string[][],
  hooks: {
    onNext?: (sessionId: string, pick?: string) => void;
    onDone?: (runId: string, sessionId: string, options: RunDoneOptions) => void;
    onEdit?: (commands: readonly string[], options: RunEditOptions) => void;
    onPublish?: (options: RunPlanPublishOptions) => void;
  } = {},
): WorkflowRunAdapter {
  return {
    async prepare(step) { calls.push(["prepare", step]); return result([], `prepare ${step}`); },
    async brief(runId, sessionId) { calls.push(["brief", runId, sessionId ?? ""]); return result([], `brief ${runId}`); },
    async check(runId, sessionId) { calls.push(["check", runId, sessionId ?? ""]); return result([], `check ${runId}`); },
    async next(sessionId, pick) {
      calls.push(["next", sessionId, pick ?? ""]);
      hooks.onNext?.(sessionId, pick);
      return result([], `next ${sessionId}`);
    },
    async done(runId, sessionId, options = {}) {
      calls.push(["done", runId, sessionId, options.verdict ?? "done"]);
      hooks.onDone?.(runId, sessionId, options);
      return result([], `done ${runId}`);
    },
    async edit(commands, options) {
      calls.push(["edit", ...commands, options.sessionId]);
      hooks.onEdit?.(commands, options);
      return result([], `edit ${commands.join(" ")}`);
    },
    async exec(argv) {
      calls.push(["exec", ...argv]);
      return result([], `exec ${argv.join(" ")}`);
    },
    async supportsPlanPublish() { return true; },
    async publishPlan(options) {
      calls.push(["plan-publish", options.sessionId ?? "new", options.handoffKey]);
      hooks.onPublish?.(options);
      const requestId = options.requestId ?? `req_plan_publish_${"0".repeat(32)}`;
      return result([], JSON.stringify({
        schema_version: "run-response/1.0",
        operation: "plan-publish",
        ok: true,
        exit_code: 0,
        request_id: requestId,
        locator: { session_id: options.sessionId ?? "new-session", run_id: "run-plan-publish" },
        result: {
          session_id: options.sessionId ?? "new-session",
          run_id: "run-plan-publish",
          artifact_id: "ART-PLAN",
          source_checksum: "sha256:source",
          handoff_key: options.handoffKey,
          request_id: requestId,
        },
        next: null,
        continuation: null,
        replay: { status: "applied", transition_id: "transition-plan-publish" },
        error: null,
      }));
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await delay(5);
  }
}

function workflowSnapshot(status: "running" | "failed" | "completed"): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "fingerprint" },
    diagnostics: [],
    session: {
      sessionId: "session-1",
      intent: "Complete integration",
      status: "running",
      revision: 1,
      activeRunId: "run-1",
      definitionOfDone: "done",
      gates: [],
      chain: [{ step: "execute", command: "execute", status, runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status,
        goal: "execute",
        args: ["--scope", "core"],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function result(args: readonly string[], stdout: string): RunCliResult {
  return { argv: [...args], stdout, stderr: "", exitCode: 0 };
}
