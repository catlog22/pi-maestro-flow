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
import type { WorkflowSession, WorkflowSnapshot } from "../src/session/types.ts";
import { deriveWorkflowViewModel, type WorkflowSnapshotLike } from "../src/session/view-model.ts";
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
    { argv: ["artifact", "inspect", "ART-1"], expected: readClassification() },
    { argv: ["artifact", "list"], expected: readClassification() },
    { argv: ["artifact", "show", "ART-1"], expected: readClassification() },
    { argv: ["artifact", "republish", "ART-1"], expected: writeClassification("artifact-republish", "none") },
    { argv: ["artifact", "future", "ART-1"], expected: writeClassification("artifact-republish", "none") },
    { argv: ["session", "create"], expected: writeClassification("session", "none", true) },
    { argv: ["session", "archive"], expected: writeClassification("session", "none") },
    { argv: ["session", "unarchive"], expected: writeClassification("session", "none") },
    { argv: ["session", "migrate"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "insert"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "replace"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "update"], expected: writeClassification("session", "none") },
    { argv: ["session", "chain", "skip"], expected: writeClassification("session", "none") },
    { argv: ["session", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["run", "start"], expected: writeClassification("compatibility-start", "command-aware", true) },
    { argv: ["run", "create"], expected: writeClassification("session", "none") },
    { argv: ["run", "next"], expected: writeClassification("session", "none") },
    { argv: ["run", "complete"], expected: writeClassification("run", "none") },
    { argv: ["run", "decide"], expected: writeClassification("session", "none") },
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

test("legacy-host mode restores lease fencing for shared commands reclassified for v3", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-legacy-classification-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    fakeAdapter(calls),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.selectMode("legacy-host");
    await coordinator.attach("pi-owner");
    for (const argv of [
      ["session", "migrate"],
      ["session", "chain", "update", "--step-id", "execute", "--stage", "review"],
      ["run", "next"],
      ["run", "complete", "run-1"],
      ["run", "decide", "decision-1"],
    ]) {
      await assert.rejects(
        coordinator.exec(argv, classifyRunControlArgv(argv), "pi-intruder"),
        /lease belongs to Pi session pi-owner/,
        argv.join(" "),
      );
    }
    assert.equal(
      calls.filter((call) => call[0] === "exec").length,
      0,
      "legacy shared writes remain fenced before CLI dispatch",
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
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
    assert.deepEqual(attached.lease!, {
      sessionId: "session-1",
      executionId: "execution-1",
      generation: 1,
      ownerId: "pi-core",
      epoch: 4,
      executionRevision: 8,
    });
    assert.equal("lease_id" in attached.lease!, false);

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
    assert.equal(flagValue(start, "--expected-identity-revision"), "1");
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

test("plan-B v3 cores select the session-v3 adapter and route mutations through it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-detected-"));
  try {
    const snapshot = v3SessionSnapshot("session-1");
    const calls: string[][] = [];
    const coordinator = testCoordinator(
      fakeBridge(snapshot),
      v3Adapter(calls, snapshot),
      new WorkflowLeaseStore(root),
    );
    assert.equal(await coordinator.selectMode(), "session-v3");
    assert.equal(coordinator.mode(), "session-v3");
    // Reads stay available through the v3 adapter.
    const read = await coordinator.exec(
      ["session", "status"],
      classifyRunControlArgv(["session", "status"]),
    );
    assert.equal(read.command.exitCode, 0);
    // Mutations route through the v3 CAS path with injected identity.
    const completed = await coordinator.exec(
      ["session", "complete"],
      classifyRunControlArgv(["session", "complete"]),
      "pi-core",
    );
    assert.equal(completed.command.exitCode, 0);
    const completeCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "complete")!;
    assert.equal(flagValue(completeCall, "--participant"), "pi-core");
    assert.equal(flagValue(completeCall, "--expected-orchestration-revision"), "4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact republish injects inspect-derived CAS and host identity for execution and v3 writers", async (t) => {
  for (const writer of ["session/2.0", "session/3.0"] as const) {
    await t.test(writer, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-workflow-artifact-republish-"));
      const calls: string[][] = [];
      const capabilities = writer === "session/3.0" ? v3CoreCapabilities() : fullCoreCapabilities();
      const snapshot = coreWorkflowSnapshot();
      const adapter: WorkflowRunAdapter = {
        ...fakeAdapter(calls),
        async capabilities() { return capabilities; },
        async exec(argv) {
          calls.push(["exec", ...argv]);
          if (argv[0] === "artifact" && argv[1] === "inspect") {
            return result(argv, JSON.stringify(artifactInspectResponse(writer)));
          }
          assert.equal(argv[0], "artifact");
          assert.equal(argv[1], "republish");
          assert.equal(flagValue(argv, "--session"), "session-1");
          assert.equal(flagValue(argv, "--participant"), "pi-artifact");
          assert.equal(flagValue(argv, "--actor"), "pi-artifact");
          assert.equal(flagValue(argv, "--assessment-hash"), `sha256:${"a".repeat(64)}`);
          assert.equal(flagValue(argv, "--expected-artifact-revision"), "7");
          assert.equal(flagValue(argv, "--expected-orchestration-revision"), "4");
          assert.equal(flagValue(argv, "--request-id")?.length! > 0, true);
          assert.equal(flagValue(argv, "--reason")?.length! > 0, true);
          assert.equal(flagValue(argv, "--evidence"), "pi-session:pi-artifact");
          return result(argv, JSON.stringify(artifactRepublishResponse(flagValue(argv, "--request-id")!)));
        },
      };
      const coordinator = testCoordinator(fakeBridge(snapshot), adapter, new WorkflowLeaseStore(root));
      try {
        const transition = await coordinator.exec(
          [
            "artifact", "republish", "ART-source",
            "--session", "session-1",
            "--consumer", "review",
            "--alias", "current-review",
          ],
          classifyRunControlArgv(["artifact", "republish", "ART-source"]),
          "pi-artifact",
        );
        assert.equal(transition.command.exitCode, 0);
        assert.equal(JSON.parse(transition.command.stdout).operation, "artifact-republish");
        assert.equal(calls.filter((call) => call[1] === "artifact" && call[2] === "inspect").length, 1);
        assert.equal(calls.filter((call) => call[1] === "artifact" && call[2] === "republish").length, 1);
        if (writer === "session/3.0") {
          assert.equal(coordinator.mode(), "session-v3", "full v3 lifecycle mutation adapter is active");
        } else {
          assert.equal(coordinator.mode(), "core-execution");
        }
      } finally {
        await coordinator.release();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("artifact republish fails closed for missing capability, spoofed identity, and unknown subcommands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-artifact-closed-"));
  try {
    const capabilities = fullCoreCapabilities();
    capabilities.support = { ...capabilities.support, artifact_compatibility_v1: false };
    const calls: string[][] = [];
    const coordinator = testCoordinator(
      fakeBridge(coreWorkflowSnapshot()),
      coreAdapter(calls, coreWorkflowSnapshot(), undefined, capabilities),
      new WorkflowLeaseStore(root),
    );
    await assert.rejects(
      coordinator.exec(
        ["artifact", "republish", "ART-source", "--session", "session-1", "--consumer", "review", "--alias", "slot"],
        classifyRunControlArgv(["artifact", "republish", "ART-source"]),
        "pi-artifact",
      ),
      /artifact_compatibility_v1.*run-response\/1\.2/,
    );
    assert.equal(calls.some((call) => call.includes("artifact")), false);

    const capableCalls: string[][] = [];
    const capable = testCoordinator(
      fakeBridge(coreWorkflowSnapshot()),
      {
        ...fakeAdapter(capableCalls),
        async capabilities() { return fullCoreCapabilities(); },
      },
      new WorkflowLeaseStore(root),
    );
    await assert.rejects(
      capable.exec(
        [
          "artifact", "republish", "ART-source", "--session", "session-1", "--consumer", "review",
          "--alias", "slot", "--participant", "spoofed",
        ],
        classifyRunControlArgv(["artifact", "republish", "ART-source"]),
        "pi-artifact",
      ),
      /--participant conflicts with coordinator authority/,
    );
    assert.equal(capableCalls.some((call) => call[0] === "exec"), false);
    await assert.rejects(
      capable.exec(
        ["artifact", "future", "ART-source"],
        classifyRunControlArgv(["artifact", "future", "ART-source"]),
        "pi-artifact",
      ),
      /Unknown Maestro artifact mutation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact republish preserves a projected run-response/1.2 conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-artifact-conflict-"));
  const adapter: WorkflowRunAdapter = {
    ...fakeAdapter([]),
    async capabilities() { return v3CoreCapabilities(); },
    async exec(argv) {
      if (argv[1] === "inspect") return result(argv, JSON.stringify(artifactInspectResponse("session/3.0")));
      const requestId = flagValue(argv, "--request-id")!;
      const envelope = {
        ...artifactRepublishResponse(requestId),
        ok: false,
        exit_code: 3,
        disposition: "control_flow",
        result: null,
        replay: null,
        error: {
          code: "ORCHESTRATION_REVISION_CONFLICT",
          message: "stale orchestration revision",
          retryable: true,
          details: { participant_token: "private-conflict-token", visible: true },
          target_type: "orchestration",
          target_id: "session-1",
          expected_revision: 4,
          current_revision: 5,
          changed_by: "participant-other",
          next_actions: ["inspect-artifact-compatibility", "resubmit-with-new-request-id"],
        },
      };
      return { argv: [...argv], stdout: JSON.stringify(envelope), stderr: "", exitCode: 3 };
    },
  };
  const coordinator = testCoordinator(fakeBridge(coreWorkflowSnapshot()), adapter, new WorkflowLeaseStore(root));
  try {
    const transition = await coordinator.exec(
      ["artifact", "republish", "ART-source", "--session", "session-1", "--consumer", "review", "--alias", "slot"],
      classifyRunControlArgv(["artifact", "republish", "ART-source"]),
      "pi-artifact",
    );
    const response = JSON.parse(transition.command.stdout);
    assert.equal(transition.command.exitCode, 3);
    assert.equal(response.error.code, "ORCHESTRATION_REVISION_CONFLICT");
    assert.deepEqual(response.error.details, { visible: true });
    assert.equal(JSON.stringify(transition.command).includes("private-conflict-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
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

// The distributed operation claim/drain experiment was removed; execution
// handoff prepare is always a plain prepare without drain argument injection.
test("core execution handoff prepare dispatches as a plain prepare without drain arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-plain-handoff-prepare-"));
  const snapshot = coreWorkflowSnapshot();
  const calls: string[][] = [];
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    coreAdapter(calls, snapshot),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("pi-owner");
    const prepared = await executeRunControl(
      { argv: ["execution", "handoff", "prepare", "--to-owner-id", "pi-next"] },
      coordinator,
      { hostSessionId: "pi-owner" },
    );
    assert.equal(prepared.ok, true, prepared.message);
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
    assert.equal("token" in attached.lease!, false, "attach results must not expose the fencing token");
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

    assert.ok(second.lease!.epoch > first.lease!.epoch);
    assert.equal(second.lease!.hostSessionId, "pi-after");
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
    await waitUntil(() => Date.parse(store.current()!.heartbeatAt) > Date.parse(first.lease!.heartbeatAt));
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

  await adapter.exec(["artifact", "inspect", "ART-1", "--json"]);
  assert.deepEqual(calls.at(-1), ["artifact", "inspect", "ART-1", "--json", "--workflow-root", "D:/workspace"]);
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
    assert.equal(flagValue(call, "--expected-identity-revision"), "1");
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

test("real Maestro v3 session open, chain insert, and run next start a fresh statusless flow with injected identity and birth packets", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-start-"));
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
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    // Project-local step definition so the Run completes without a blocking
    // required-output contract from the global prepare library.
    await mkdir(join(root, "prepare"), { recursive: true });
    await writeFile(join(root, "prepare", "execute.md"), `---
name: execute
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces: []
  gates:
    entry: []
    exit: []
---
# Execute
`, "utf8");
    assert.equal(await coordinator.selectMode(), "session-v3");
    assert.equal(coordinator.mode(), "session-v3");

    const host = "pi-real-start";
    const openArgv = ["session", "open", "fresh statusless flow", "--id", "real-v3-fresh"];
    const open = await coordinator.exec(openArgv, classifyRunControlArgv(openArgv), host);
    assert.equal(open.command.exitCode, 0);
    const openEnvelope = JSON.parse(open.command.stdout) as Record<string, any>;
    assert.equal(openEnvelope.schema_version, "run-response/1.2");
    assert.equal(openEnvelope.operation, "session-open");
    assert.equal(openEnvelope.ok, true);
    assert.equal(openEnvelope.result.session_id, "real-v3-fresh");
    const openCall = calls.find((call) => call[0] === "session" && call[1] === "open")!;
    assert.equal(flagValue(openCall, "--participant"), host);
    assert.equal(flagValue(openCall, "--actor"), host);
    assert.ok(flagValue(openCall, "--request-id"));
    assert.equal(flagValue(openCall, "--reason"), "Pi run-control v3 mutation");
    assert.equal(openCall.includes("--json"), true);
    // v3 workspaces carry no state.json; bind the canonical Session through
    // the bridge so subsequent CAS mutations can resolve the orchestration
    // revision from the projected session/3.0 record.
    await bridge.refreshSession("real-v3-fresh");
    assert.equal(
      openCall.some((argument) => argument.startsWith("--expected-")),
      false,
      "session open mints the Session without a CAS expected revision",
    );

    const insertArgv = ["session", "chain", "insert", "--step-id", "execute", "--command", "execute"];
    const insert = await coordinator.exec(insertArgv, classifyRunControlArgv(insertArgv), host);
    assert.equal(insert.command.exitCode, 0);
    const insertEnvelope = JSON.parse(insert.command.stdout) as Record<string, any>;
    assert.equal(insertEnvelope.operation, "session-chain-insert");
    const insertCall = calls.find((call) => call[0] === "session" && call[1] === "chain" && call[2] === "insert")!;
    assert.equal(flagValue(insertCall, "--participant"), host);
    assert.equal(flagValue(insertCall, "--actor"), host);
    assert.ok(flagValue(insertCall, "--request-id"));
    assert.equal(flagValue(insertCall, "--expected-orchestration-revision"), "1");

    const nextArgv = ["run", "next"];
    const next = await coordinator.exec(nextArgv, classifyRunControlArgv(nextArgv), host);
    assert.equal(next.command.exitCode, 0);
    const nextEnvelope = JSON.parse(next.command.stdout) as Record<string, any>;
    assert.equal(nextEnvelope.operation, "next");
    const nextCall = calls.find((call) => call[0] === "run" && call[1] === "next")!;
    assert.equal(flagValue(nextCall, "--participant"), host);
    assert.equal(flagValue(nextCall, "--actor"), host);
    assert.ok(flagValue(nextCall, "--request-id"));
    assert.equal(flagValue(nextCall, "--expected-orchestration-revision"), "2");

    // The v3 birth packet carries everything the executor needs without an
    // extra round trip: run identity, the run working directory, the chain
    // step, consumed upstream artifacts, guidance hashes, knowledge context,
    // the brief command, and the no-duplicate-run invariant.
    const birth = nextEnvelope.result as Record<string, any>;
    assert.equal(typeof birth.run_id, "string");
    assert.equal(typeof birth.run_dir, "string");
    assert.equal(birth.run_dir.endsWith(birth.run_id), true, "birth packet run_dir resolves to the Run directory");
    assert.equal(birth.step_id, "execute");
    assert.equal(birth.status, "running");
    assert.equal(birth.revision, 1);
    assert.equal(typeof birth.upstream, "object");
    assert.ok(birth.guidance && typeof birth.guidance.source_path === "string");
    assert.match(birth.guidance.source_path, /execute\.md$/);
    assert.ok(birth.knowledge_context && typeof birth.knowledge_context.path === "string");
    assert.equal(typeof birth.brief.command, "string");
    assert.match(birth.brief.command, new RegExp(`run brief ${birth.run_id}`));
    assert.equal(birth.run_already_created, true);
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro v3 sessions re-run run next against an existing Session shell and replay idempotently", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-shell-"));
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
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    await mkdir(join(root, "prepare"), { recursive: true });
    await writeFile(join(root, "prepare", "execute.md"), `---
name: execute
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces: []
  gates:
    entry: []
    exit: []
---
# Execute
`, "utf8");
    assert.equal(await coordinator.selectMode(), "session-v3");

    const host = "pi-real-shell";
    const openArgv = ["session", "open", "existing v3 session shell", "--id", "real-v3-shell"];
    const open = await coordinator.exec(openArgv, classifyRunControlArgv(openArgv), host);
    assert.equal(open.command.exitCode, 0);
    await bridge.refreshSession("real-v3-shell");
    const insertArgv = ["session", "chain", "insert", "--step-id", "execute", "--command", "execute"];
    const insert = await coordinator.exec(insertArgv, classifyRunControlArgv(insertArgv), host);
    assert.equal(insert.command.exitCode, 0);

    // Establish the run-next mutation through the raw shell so the
    // coordinator's cached orchestration revision stays at the pre-next value;
    // the replay retry through execV3 must rebuild the identical canonical
    // payload (same request-id, actor, reason, and expected revision).
    const replayRequestId = "req-real-v3-next-replay";
    const rawNext = await adapter.exec([
      "run", "next", "--session", "real-v3-shell",
      "--participant", host, "--actor", host,
      "--request-id", replayRequestId,
      "--reason", "Pi run-control v3 mutation",
      "--expected-orchestration-revision", "2", "--json",
    ]);
    assert.equal(rawNext.exitCode, 0);
    const rawNextEnvelope = JSON.parse(rawNext.stdout) as Record<string, any>;
    assert.equal(rawNextEnvelope.ok, true);
    const runId = rawNextEnvelope.result.run_id as string;
    const appliedTransitionId = rawNextEnvelope.replay.transition_id as string;
    assert.equal(rawNextEnvelope.replay.status, "applied");

    const replayArgv = ["run", "next", "--request-id", replayRequestId];
    const replay = await coordinator.exec(replayArgv, classifyRunControlArgv(replayArgv), host);
    assert.equal(replay.command.exitCode, 0);
    const replayEnvelope = JSON.parse(replay.command.stdout) as Record<string, any>;
    assert.equal(replayEnvelope.ok, true);
    assert.equal(replayEnvelope.replay.status, "replayed");
    assert.equal(replayEnvelope.replay.transition_id, appliedTransitionId);
    assert.equal(replayEnvelope.result.run_id, runId);
    const nextCalls = calls.filter((call) => call[0] === "run" && call[1] === "next");
    const replayCall = nextCalls[nextCalls.length - 1]!;
    assert.equal(flagValue(replayCall, "--request-id"), replayRequestId, "the coordinator preserves an explicit request-id for idempotent replay");
    assert.equal(flagValue(replayCall, "--expected-orchestration-revision"), "2", "replay keeps the original expected orchestration revision");

    // Idempotency: the replay must not allocate a second Run.
    const sessionDir = join(root, ".workflow", "sessions", "real-v3-shell");
    const runDirectories = (await readdir(join(sessionDir, "runs"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.deepEqual(runDirectories.map((entry) => entry.name), [runId]);
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro v3 coordinator drives the full open -> chain insert -> run next -> brief -> check -> complete -> decide -> session complete lifecycle", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-life-"));
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
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    await mkdir(join(root, "prepare"), { recursive: true });
    await writeFile(join(root, "prepare", "execute.md"), `---
name: execute
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces: []
  gates:
    entry: []
    exit: []
---
# Execute
`, "utf8");
    assert.equal(await coordinator.selectMode(), "session-v3");

    const host = "pi-real-life";
    const openArgv = ["session", "open", "full v3 lifecycle", "--id", "real-v3-life"];
    const open = await coordinator.exec(openArgv, classifyRunControlArgv(openArgv), host);
    assert.equal(open.command.exitCode, 0);
    const openEnvelope = JSON.parse(open.command.stdout) as Record<string, any>;
    assert.equal(openEnvelope.operation, "session-open");
    assert.equal(openEnvelope.revision.revision, 1);
    await bridge.refreshSession("real-v3-life");

    const insertArgv = ["session", "chain", "insert", "--step-id", "execute", "--command", "execute"];
    const insert = await coordinator.exec(insertArgv, classifyRunControlArgv(insertArgv), host);
    assert.equal(insert.command.exitCode, 0);
    const insertEnvelope = JSON.parse(insert.command.stdout) as Record<string, any>;
    assert.equal(insertEnvelope.operation, "session-chain-insert");
    assert.equal(insertEnvelope.revision.revision, 2);

    const updateArgv = [
      "session", "chain", "update", "--step-id", "execute",
      "--stage", "implementation", "--goal-ref", "goal-real-life",
    ];
    const update = await coordinator.exec(updateArgv, classifyRunControlArgv(updateArgv), host);
    assert.equal(update.command.exitCode, 0);
    const updateEnvelope = JSON.parse(update.command.stdout) as Record<string, any>;
    assert.equal(updateEnvelope.operation, "session-chain-update");
    assert.equal(updateEnvelope.revision.revision, 3);
    const updateCall = calls.find(
      (call) => call[0] === "session" && call[1] === "chain" && call[2] === "update",
    )!;
    assert.equal(flagValue(updateCall, "--session"), "real-v3-life");
    assert.equal(flagValue(updateCall, "--expected-orchestration-revision"), "2");

    const nextArgv = ["run", "next"];
    const next = await coordinator.exec(nextArgv, classifyRunControlArgv(nextArgv), host);
    assert.equal(next.command.exitCode, 0);
    const nextEnvelope = JSON.parse(next.command.stdout) as Record<string, any>;
    assert.equal(nextEnvelope.operation, "next");
    assert.equal(nextEnvelope.revision.revision, 4);
    const runId = nextEnvelope.result.run_id as string;

    const briefArgv = ["run", "brief", runId, "--json"];
    const brief = await coordinator.exec(briefArgv, classifyRunControlArgv(briefArgv), host);
    assert.equal(brief.command.exitCode, 0);
    const briefEnvelope = JSON.parse(brief.command.stdout) as Record<string, any>;
    assert.equal(briefEnvelope.operation, "brief");
    assert.equal(briefEnvelope.result.schema_version, "brief-result/3.0");
    assert.equal(briefEnvelope.result.session.orchestration_revision, 4);
    assert.equal(briefEnvelope.result.run.status, "running");
    assert.equal(briefEnvelope.result.run.run_id, runId);
    assert.equal(
      calls.some((call) => call[0] === "run" && call[1] === "brief" && call.includes("--participant")),
      false,
      "brief reads pass through without coordinator identity injection",
    );

    const checkArgv = ["run", "check", runId, "--json"];
    const check = await coordinator.exec(checkArgv, classifyRunControlArgv(checkArgv), host);
    assert.equal(check.command.exitCode, 0);
    const checkEnvelope = JSON.parse(check.command.stdout) as Record<string, any>;
    assert.equal(checkEnvelope.operation, "check");
    assert.equal(checkEnvelope.result.status, "running");
    assert.equal(checkEnvelope.result.revision, 1);

    const completeArgv = ["run", "complete", runId, "--advance", "--verdict", "done", "--summary", "done"];
    const complete = await coordinator.exec(completeArgv, classifyRunControlArgv(completeArgv), host);
    assert.equal(complete.command.exitCode, 0);
    const completeEnvelope = JSON.parse(complete.command.stdout) as Record<string, any>;
    assert.equal(completeEnvelope.operation, "complete");
    assert.equal(completeEnvelope.revision.revision, 5);
    assert.equal(completeEnvelope.result.run_revision, 2);
    assert.equal(completeEnvelope.result.status, "sealed");
    const completeCall = calls.find((call) => call[0] === "run" && call[1] === "complete")!;
    assert.equal(flagValue(completeCall, "--expected-run-revision"), "1");
    assert.equal(flagValue(completeCall, "--expected-orchestration-revision"), "4");

    const decideArgv = ["run", "decide", runId, "--verdict", "proceed"];
    const decide = await coordinator.exec(decideArgv, classifyRunControlArgv(decideArgv), host);
    assert.equal(decide.command.exitCode, 0);
    const decideEnvelope = JSON.parse(decide.command.stdout) as Record<string, any>;
    assert.equal(decideEnvelope.operation, "run-decide");
    assert.equal(decideEnvelope.revision.revision, 6);

    const completeSessionArgv = ["session", "complete"];
    const completeSession = await coordinator.exec(completeSessionArgv, classifyRunControlArgv(completeSessionArgv), host);
    assert.equal(completeSession.command.exitCode, 0);
    const completeSessionEnvelope = JSON.parse(completeSession.command.stdout) as Record<string, any>;
    assert.equal(completeSessionEnvelope.operation, "session-complete");
    assert.equal(completeSessionEnvelope.revision.revision, 7);
    assert.equal(completeSessionEnvelope.result.status, "completed");
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro v3 coordinator migrates one legacy Session with resolved revision fences", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-migrate-"));
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
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/1.3",
        features: { session_statusless: false },
      },
    }), "utf8");
    const created = await adapter.exec([
      "session", "create", "legacy migration fixture", "--id", "real-v3-migrate",
      "--intent", "Legacy migration fixture", "--json",
    ]);
    assert.equal(created.exitCode, 0, created.stderr || created.stdout);
    const createdEnvelope = JSON.parse(created.stdout) as { locator: { session_id: string } };
    const legacySessionId = createdEnvelope.locator.session_id;
    const legacySnapshot = await bridge.refreshSession(legacySessionId);
    assert.ok(legacySnapshot.session, "the CLI-created legacy Session is projected");
    assert.equal(legacySnapshot.session.identityRevision, 1);

    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    assert.equal(await coordinator.selectMode(), "session-v3");

    const argv = ["session", "migrate", "--session", legacySessionId, "--to-v3"];
    const migrated = await coordinator.exec(argv, classifyRunControlArgv(argv), "pi-real-migrate");
    assert.equal(migrated.command.exitCode, 0, migrated.command.stderr || migrated.command.stdout);
    const envelope = JSON.parse(migrated.command.stdout) as Record<string, any>;
    assert.equal(envelope.operation, "session-migrate");
    assert.equal(envelope.ok, true);
    const migrateCall = calls.find(
      (call) => call[0] === "session" && call[1] === "migrate" && call.includes("--to-v3"),
    )!;
    assert.equal(flagValue(migrateCall, "--session"), legacySessionId);
    assert.equal(flagValue(migrateCall, "--participant"), "pi-real-migrate");
    assert.equal(flagValue(migrateCall, "--actor"), "pi-real-migrate");
    assert.ok(flagValue(migrateCall, "--request-id"));
    assert.equal(flagValue(migrateCall, "--reason"), "Pi run-control v3 mutation");
    assert.equal(
      flagValue(migrateCall, "--expected-identity-revision"),
      String(legacySnapshot.session!.identityRevision ?? legacySnapshot.session!.revision),
    );
    assert.equal(
      flagValue(migrateCall, "--expected-activity-revision"),
      String(legacySnapshot.session!.activityRevision ?? legacySnapshot.session!.revision),
    );
    assert.equal(flagValue(migrateCall, "--expected-orchestration-revision"), undefined);
    const migratedRecord = JSON.parse(
      await readFile(join(root, ".workflow", "sessions", legacySessionId, "session.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(migratedRecord.schema_version, "session/3.0");
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
          session_identity_revision: snapshot.session?.revision ?? 1,
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

test("real Maestro v3 coordinator publishes and replays a Plan Session after response loss", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-plan-"));
  const maestroBin = "D:/maestro2/bin/maestro.js";
  const calls: string[][] = [];
  let discardFirstPublish = true;
  const runner = async (args: readonly string[], cwd: string): Promise<RunCliResult> => {
    calls.push([...args]);
    const completed = await defaultRunner([maestroBin, ...args], cwd, {
      executable: process.execPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    // Simulate response loss after the first `plan publish` commits: the core
    // sealed the producer Run and registered the plan/1.0 artifact, but the
    // CLI response never reached the coordinator. The retry must replay.
    if (discardFirstPublish
      && args[0] === "plan" && args[1] === "publish"
      && completed.exitCode === 0) {
      discardFirstPublish = false;
      throw new Error("injected response loss after the plan publish Run committed");
    }
    return completed;
  };
  const adapter = new RunCliAdapter(root, runner);
  const bridge = new WorkflowBridge(root);
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    const source = "# New statusless Plan\n\nExecute with canonical authority.\n";
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, source, "utf8");
    const options: RunPlanPublishOptions = {
      sourcePath,
      sourceRoot: root,
      intent: "Execute a new approved Plan",
      topic: "Execute a new approved Plan",
      handoffKey: "handoff-real-v3-statusless",
      sourcePiSession: "pi-real-v3-plan",
      planRevision: 1,
      approvedAt: "2026-08-12T02:00:00.000Z",
    };
    const expectedRequestId = `req_plan_publish_${createHash("sha256").update(options.handoffKey).digest("hex").slice(0, 32)}`;

    assert.equal(await coordinator.selectMode(), "session-v3");
    assert.equal(await coordinator.supportsNewPlanSession(), true);

    await assert.rejects(
      coordinator.publishPlan(options, { hostSessionId: "pi-real-v3-plan" }),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /injected response loss/);
        return true;
      },
    );

    const recovered = await coordinator.publishPlan(options, { hostSessionId: "pi-real-v3-plan" });
    const replay = await coordinator.publishPlan(options, { hostSessionId: "pi-real-v3-plan" });
    const recoveredEnvelope = JSON.parse(recovered.command.stdout) as Record<string, any>;
    const replayEnvelope = JSON.parse(replay.command.stdout) as Record<string, any>;
    assert.equal(recoveredEnvelope.schema_version, "run-response/1.2");
    assert.equal(recoveredEnvelope.operation, "plan-publish");
    assert.equal(recoveredEnvelope.ok, true);
    const sessionId = recoveredEnvelope.result.session_id as string;
    assert.equal(recoveredEnvelope.result.request_id, expectedRequestId);
    assert.equal(
      recoveredEnvelope.result.source_checksum,
      `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
    );
    // v3 core produces a real sealed artifact: run_id and artifact_id are
    // canonical identities, not synthetic plan:<session>:<rev> strings.
    assert.equal(typeof recoveredEnvelope.result.run_id, "string");
    assert.match(recoveredEnvelope.result.run_id, /^run-/);
    assert.equal(typeof recoveredEnvelope.result.artifact_id, "string");
    assert.notMatch(recoveredEnvelope.result.artifact_id, /^plan:/);
    assert.equal(replayEnvelope.ok, true);
    assert.equal(replayEnvelope.result.session_id, sessionId);
    assert.equal(replayEnvelope.result.run_id, recoveredEnvelope.result.run_id);
    assert.equal(replayEnvelope.result.artifact_id, recoveredEnvelope.result.artifact_id);

    const sessionsRoot = join(root, ".workflow", "sessions");
    const sessionDirectories = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== ".backups");
    assert.deepEqual(sessionDirectories.map((entry) => entry.name), [sessionId]);
    const sessionDir = join(sessionsRoot, sessionId);
    const recoveredIdentity = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(recoveredIdentity.schema_version, "session/3.0");
    assert.equal(recoveredIdentity.session_id, sessionId);
    const chainSteps = recoveredIdentity.chain as Array<{ command: string; status: string }>;
    assert.equal(chainSteps.some((step) => step.command === "plan-publish"), true, "the plan-publish chain step exists");
    assert.equal(chainSteps.every((step) => step.status === "completed"), true, "chain step is completed");

    // The sealed plan/1.0 artifact is in the Session Artifact Registry under
    // the current-plan alias (no .workflow/plans/ file is written by the v3 path).
    const artifacts = JSON.parse(
      await readFile(join(sessionDir, "artifacts.json"), "utf8"),
    ) as { artifacts: Record<string, { status: string; kind: string; schema_version?: string }>; aliases: Record<string, string> };
    assert.equal(artifacts.aliases["current-plan"], recoveredEnvelope.result.artifact_id);
    const artifact = artifacts.artifacts[recoveredEnvelope.result.artifact_id];
    assert.equal(artifact.status, "sealed");
    assert.equal(artifact.kind, "plan");
    assert.equal(artifact.schema_version, "plan/1.0");

    const replayIdentity = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(replayIdentity.session_id, sessionId, "replay does not recreate the Session");
    assert.equal(
      Number(replayIdentity.orchestration_revision) >= Number(recoveredIdentity.orchestration_revision),
      true,
      "replay does not reset the orchestration revision",
    );
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro v3 coordinator publishes into an existing Session and surfaces orchestration revision conflicts", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-real-v3-plan-current-"));
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
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/3.0",
        features: { session_statusless: false },
      },
    }), "utf8");
    assert.equal(await coordinator.selectMode(), "session-v3");

    const host = "pi-real-plan-current";
    const openArgv = ["session", "open", "current plan target", "--id", "real-plan-current"];
    const open = await coordinator.exec(openArgv, classifyRunControlArgv(openArgv), host);
    assert.equal(open.command.exitCode, 0);
    // v3 workspaces carry no state.json; bind the canonical Session through
    // the bridge so publishPlanV3 and later mutations can resolve revisions.
    await bridge.refreshSession("real-plan-current");

    const source = "# Statusless current Plan\n\nExecute through current authority.\n";
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, source, "utf8");
    const publishOptions: RunPlanPublishOptions = {
      sourcePath,
      sourceRoot: root,
      sessionId: "real-plan-current",
      handoffKey: "handoff-real-v3-current",
      sourcePiSession: host,
      planRevision: 1,
      approvedAt: "2026-08-11T21:00:00.000Z",
    };
    const first = await coordinator.publishPlan(publishOptions, { hostSessionId: host });
    const firstEnvelope = JSON.parse(first.command.stdout) as Record<string, any>;
    assert.equal(firstEnvelope.operation, "plan-publish");
    assert.equal(firstEnvelope.ok, true);
    assert.equal(firstEnvelope.result.session_id, "real-plan-current");
    // v3 core seals a real plan/1.0 artifact under the current-plan alias.
    assert.match(firstEnvelope.result.run_id, /^run-/);
    assert.notMatch(firstEnvelope.result.artifact_id, /^plan:/);
    const sessionDir = join(root, ".workflow", "sessions", "real-plan-current");
    const artifacts = JSON.parse(
      await readFile(join(sessionDir, "artifacts.json"), "utf8"),
    ) as { artifacts: Record<string, { status: string; kind: string }>; aliases: Record<string, string> };
    assert.equal(artifacts.aliases["current-plan"], firstEnvelope.result.artifact_id);
    assert.equal(artifacts.artifacts[firstEnvelope.result.artifact_id].status, "sealed");
    assert.equal(artifacts.artifacts[firstEnvelope.result.artifact_id].kind, "plan");

    // Replay into the same Session: no new Session directory is created, and
    // the same run_id / artifact_id are returned.
    const replay = await coordinator.publishPlan(publishOptions, { hostSessionId: host });
    const replayEnvelope = JSON.parse(replay.command.stdout) as Record<string, any>;
    assert.equal(replayEnvelope.ok, true);
    assert.equal(replayEnvelope.result.run_id, firstEnvelope.result.run_id);
    assert.equal(replayEnvelope.result.artifact_id, firstEnvelope.result.artifact_id);
    const sessionsRoot = join(root, ".workflow", "sessions");
    const sessionDirectories = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== ".backups");
    assert.deepEqual(sessionDirectories.map((entry) => entry.name), ["real-plan-current"]);

    // Mutate authority through the raw shell so the coordinator's cached
    // orchestration revision goes stale, then verify a coordinator chain
    // insert surfaces ORCHESTRATION_REVISION_CONFLICT with next_actions and a
    // re-read hint instead of replaying with a replaced revision.
    const status = await adapter.exec(["session", "status", "--session", "real-plan-current", "--json"]);
    const statusEnvelope = JSON.parse(status.stdout) as Record<string, any>;
    const currentRevision = statusEnvelope.result.orchestration_revision as number;
    const rawInsert = await adapter.exec([
      "session", "chain", "insert", "--session", "real-plan-current",
      "--step-id", "conflict-probe", "--command", "probe",
      "--participant", host, "--actor", host,
      "--request-id", "req-real-v3-conflict-raw",
      "--reason", "probe", "--expected-orchestration-revision", String(currentRevision), "--json",
    ]);
    assert.equal(rawInsert.exitCode, 0);

    const conflictArgv = ["session", "chain", "insert", "--step-id", "conflict-insert", "--command", "probe"];
    const conflict = await coordinator.exec(conflictArgv, classifyRunControlArgv(conflictArgv), host);
    assert.notEqual(conflict.command.exitCode, 0);
    const conflictEnvelope = JSON.parse(conflict.command.stdout) as Record<string, any>;
    assert.equal(conflictEnvelope.ok, false);
    assert.equal(conflictEnvelope.error.code, "ORCHESTRATION_REVISION_CONFLICT");
    assert.equal(Array.isArray(conflictEnvelope.error.next_actions), true);
    assert.equal(conflictEnvelope.error.next_actions.length > 0, true);
    assert.match(
      conflictEnvelope.error.message,
      /Re-read authority via 'maestro session status --json'/,
    );

    // The conflict is never replayed: the raw probe step survives exactly once
    // and the conflicted insert is not applied.
    const finalIdentity = JSON.parse(
      await readFile(join(sessionsRoot, "real-plan-current", "session.json"), "utf8"),
    ) as Record<string, any>;
    const finalSteps = finalIdentity.chain as Array<{ step_id: string }>;
    assert.equal(finalSteps.filter((step) => step.step_id === "conflict-probe").length, 1);
    assert.equal(finalSteps.filter((step) => step.step_id === "conflict-insert").length, 0);
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Maestro CLI preserves legacy Plan publication through the Pi adapter", { timeout: 120_000 }, async () => {
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
    // Legacy v2-era session/1.3 writer keeps the non-Execution-aware raw plan
    // publish path (run-response/1.0) that the Pi adapter preserves.
    await mkdir(join(root, ".workflow"), { recursive: true });
    await writeFile(join(root, ".workflow", "config.json"), JSON.stringify({
      session_schema: {
        schema_version: "session-schema-selection/1.0",
        writer: "session/1.3",
        features: { session_statusless: false },
      },
    }), "utf8");
    const sourcePath = join(root, "approved.md");
    await writeFile(sourcePath, "# Legacy Plan\n", "utf8");
    const created = await adapter.exec([
      "session", "create", "legacy plan", "--id", "legacy-plan", "--intent", "Legacy Plan", "--json",
    ]);
    assert.equal(created.exitCode, 0, created.stderr || created.stdout);
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

// ---------------------------------------------------------------------------
// session-v3 coordinator (Plan-B Session/Run minimal-state core)
// ---------------------------------------------------------------------------

test("session-v3 exec injects participant/actor/request-id/reason/json and expected revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-inject-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    v3Adapter(calls, snapshot, { applyMutations: false }),
    new WorkflowLeaseStore(root),
  );
  try {
    assert.equal(await coordinator.selectMode(), "session-v3");
    assert.equal(coordinator.mode(), "session-v3");

    const open = await coordinator.exec(
      ["session", "open", "Complete integration", "--id", "session-2"],
      classifyRunControlArgv(["session", "open"]),
      "pi-v3",
    );
    assert.equal(open.command.exitCode, 0);
    const openCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "open")!;
    assert.equal(flagValue(openCall, "--participant"), "pi-v3");
    assert.equal(flagValue(openCall, "--actor"), "pi-v3");
    assert.ok(flagValue(openCall, "--request-id"));
    assert.equal(flagValue(openCall, "--reason"), "Pi run-control v3 mutation");
    assert.ok(openCall.includes("--json"));
    assert.equal(openCall.some((argument) => argument.startsWith("--expected-")), false, "open has no CAS expected revision");

    const insert = await coordinator.exec(
      ["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"],
      classifyRunControlArgv(["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"]),
      "pi-v3",
    );
    assert.equal(insert.command.exitCode, 0);
    const insertCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "insert")!;
    assert.equal(flagValue(insertCall, "--session"), "session-1");
    assert.equal(flagValue(insertCall, "--expected-orchestration-revision"), "4");
    assert.equal(flagValue(insertCall, "--expected-run-revision"), undefined, "orchestration targets carry no run revision");

    const update = await coordinator.exec(
      ["session", "chain", "update", "--step-id", "execute", "--stage", "review"],
      classifyRunControlArgv(["session", "chain", "update"]),
      "pi-v3",
    );
    assert.equal(update.command.exitCode, 0);
    const updateCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "update")!;
    assert.equal(flagValue(updateCall, "--session"), "session-1");
    assert.equal(flagValue(updateCall, "--expected-orchestration-revision"), "4");

    const complete = await coordinator.exec(
      ["run", "complete", "run-1", "--advance", "--verdict", "done"],
      classifyRunControlArgv(["run", "complete", "run-1"]),
      "pi-v3",
    );
    assert.equal(complete.command.exitCode, 0);
    const completeCall = calls.find((call) => call[0] === "exec" && call[1] === "run" && call[2] === "complete")!;
    assert.equal(flagValue(completeCall, "--session"), "session-1");
    assert.equal(flagValue(completeCall, "--expected-run-revision"), "2");
    assert.equal(flagValue(completeCall, "--expected-orchestration-revision"), "4");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 CAS derives from the explicit --session target, not the stale state.json active Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-target-aware-"));
  const calls: string[][] = [];
  // state.json-derived active Session (stale, orchestration revision 2) vs the
  // explicit mutation target session-B (revision 4).
  const staleSession = { ...v3SessionSnapshot("session-A").session!, orchestrationRevision: 2, revision: 2 };
  const targetSession = { ...v3SessionSnapshot("session-B").session!, orchestrationRevision: 4, revision: 4 };
  const staleSnapshot = { ...v3SessionSnapshot("session-A"), session: staleSession };
  const targetSnapshot = { ...v3SessionSnapshot("session-B"), session: targetSession };
  const bridge: WorkflowSnapshotProvider = {
    async refresh() { return staleSnapshot; },
    getSnapshot() { return staleSnapshot; },
    async refreshSession(sessionId) {
      return sessionId === "session-B" ? targetSnapshot : staleSnapshot;
    },
  };
  const coordinator = new WorkflowCoordinator(bridge, v3Adapter(calls, targetSnapshot), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    await coordinator.exec(
      ["session", "chain", "insert", "--session", "session-B", "--step-id", "s1", "--command", "execute"],
      classifyRunControlArgv(["session", "chain", "insert", "--session", "session-B", "--step-id", "s1", "--command", "execute"]),
      "pi-target",
    );
    const insertCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "insert")!;
    assert.equal(flagValue(insertCall, "--session"), "session-B");
    // The CAS revision must come from the explicit target (4), not the stale
    // active Session (2) — a stale revision would be rejected by the core.
    assert.equal(flagValue(insertCall, "--expected-orchestration-revision"), "4");

    await assert.rejects(
      coordinator.exec(
        ["session", "chain", "insert", "--session", "session-C", "--step-id", "s2", "--command", "execute"],
        classifyRunControlArgv(["session", "chain", "insert"]),
        "pi-target",
      ),
      /targets Session session-C, but resolved authority is session-A/,
    );
    assert.equal(
      calls.filter((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain").length,
      1,
      "a mismatched explicit Session is rejected before CLI dispatch",
    );
  } finally {
    await coordinator.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 migration injects legacy fences and requires caller batch manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-migrate-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("legacy-1");
  snapshot.session = {
    ...snapshot.session!,
    schemaVersion: "session/1.3",
    revision: 3,
    orchestrationRevision: undefined,
    activityRevision: 2,
  };
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    applyMutations: false,
    responses: (argv) => argv[0] === "session" && argv[1] === "migrate"
      ? v3RunResponse("session-migrate", {
          request_id: null,
          locator: { session_id: flagValue(argv, "--session") ?? null, run_id: null },
          revision: null,
          result: { status: "applied" },
          replay: null,
        })
      : defaultV3Envelope(argv, snapshot),
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const migrated = await coordinator.exec(
      ["session", "migrate", "--session", "legacy-1", "--to-v3"],
      classifyRunControlArgv(["session", "migrate"]),
      "pi-migrate",
    );
    assert.equal(migrated.command.exitCode, 0);
    const migrateCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "migrate")!;
    assert.equal(flagValue(migrateCall, "--session"), "legacy-1");
    assert.equal(flagValue(migrateCall, "--participant"), "pi-migrate");
    assert.equal(flagValue(migrateCall, "--actor"), "pi-migrate");
    assert.ok(flagValue(migrateCall, "--request-id"));
    assert.equal(flagValue(migrateCall, "--reason"), "Pi run-control v3 mutation");
    assert.equal(flagValue(migrateCall, "--expected-identity-revision"), "3");
    assert.equal(flagValue(migrateCall, "--expected-activity-revision"), "2");
    assert.equal(flagValue(migrateCall, "--expected-orchestration-revision"), undefined);
    assert.equal(migrateCall.includes("--json"), true);

    await assert.rejects(
      coordinator.exec(
        ["session", "migrate", "--session", "legacy-1", "--to-v3", "--expected-identity-revision", "99"],
        classifyRunControlArgv(["session", "migrate"]),
        "pi-migrate",
      ),
      /--expected-identity-revision conflicts with coordinator authority/,
    );
    await assert.rejects(
      coordinator.exec(
        ["session", "migrate", "--all", "--to-v3"],
        classifyRunControlArgv(["session", "migrate"]),
        "pi-migrate",
      ),
      /requires exactly one non-empty --expected-revisions/,
    );

    const manifest = JSON.stringify({
      "legacy-1": { identity_revision: 3, activity_revision: 2 },
    });
    const batch = await coordinator.exec(
      ["session", "migrate", "--all", "--to-v3", "--expected-revisions", manifest],
      classifyRunControlArgv(["session", "migrate"]),
      "pi-migrate",
    );
    assert.equal(batch.command.exitCode, 0);
    const batchCall = calls.filter((call) => call[0] === "exec" && call[1] === "session" && call[2] === "migrate").at(-1)!;
    assert.equal(flagValue(batchCall, "--expected-revisions"), manifest);
    assert.equal(flagValue(batchCall, "--session"), undefined);
    assert.equal(flagValue(batchCall, "--expected-identity-revision"), undefined);
    assert.equal(flagValue(batchCall, "--expected-activity-revision"), undefined);
    assert.equal(flagValue(batchCall, "--expected-orchestration-revision"), undefined);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 full lifecycle open -> chain insert -> run next -> check -> complete -> decide -> session complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-chain-"));
  const calls: string[][] = [];
  const snapshot = v3EmptySnapshot();
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");

    const open = await coordinator.exec(
      ["session", "open", "Complete integration", "--id", "session-1"],
      classifyRunControlArgv(["session", "open"]),
      "pi-v3",
    );
    assert.equal(open.command.exitCode, 0);
    assert.equal(snapshot.session?.sessionId, "session-1");

    const insert = await coordinator.exec(
      ["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"],
      classifyRunControlArgv(["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"]),
      "pi-v3",
    );
    assert.equal(insert.command.exitCode, 0);
    const insertCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "insert")!;
    assert.equal(flagValue(insertCall, "--session"), "session-1");
    assert.equal(flagValue(insertCall, "--expected-orchestration-revision"), "0");

    const next = await coordinator.exec(
      ["run", "next", "--run", "run-1"],
      classifyRunControlArgv(["run", "next"]),
      "pi-v3",
    );
    assert.equal(next.command.exitCode, 0);
    const nextCall = calls.find((call) => call[0] === "exec" && call[1] === "run" && call[2] === "next")!;
    assert.equal(flagValue(nextCall, "--session"), "session-1");
    assert.equal(flagValue(nextCall, "--expected-orchestration-revision"), "1");

    const check = await coordinator.exec(
      ["run", "check", "run-1"],
      classifyRunControlArgv(["run", "check", "run-1"]),
      "pi-v3",
    );
    assert.equal(check.command.exitCode, 0);
    assert.deepEqual(
      calls.find((call) => call[0] === "exec" && call[1] === "run" && call[2] === "check"),
      ["exec", "run", "check", "run-1"],
      "reads pass through without coordinator injection",
    );

    const complete = await coordinator.exec(
      ["run", "complete", "run-1", "--advance", "--verdict", "done", "--summary", "done"],
      classifyRunControlArgv(["run", "complete", "run-1"]),
      "pi-v3",
    );
    assert.equal(complete.command.exitCode, 0);
    const completeCall = calls.find((call) => call[0] === "exec" && call[1] === "run" && call[2] === "complete")!;
    assert.equal(flagValue(completeCall, "--expected-run-revision"), "0");
    assert.equal(flagValue(completeCall, "--expected-orchestration-revision"), "2");

    const decide = await coordinator.exec(
      ["run", "decide", "decision-1", "--verdict", "proceed"],
      classifyRunControlArgv(["run", "decide", "decision-1"]),
      "pi-v3",
    );
    assert.equal(decide.command.exitCode, 0);

    const completeSession = await coordinator.exec(
      ["session", "complete"],
      classifyRunControlArgv(["session", "complete"]),
      "pi-v3",
    );
    assert.equal(completeSession.command.exitCode, 0);
    const completeSessionCall = calls.find((call) => call[0] === "exec" && call[1] === "session" && call[2] === "complete")!;
    assert.equal(flagValue(completeSessionCall, "--session"), "session-1");
    assert.equal(flagValue(completeSessionCall, "--expected-orchestration-revision"), "4");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 revision conflicts surface next_actions and a re-read hint without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-conflict-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    responses: (argv) => {
      if (argv[0] === "session" && argv[1] === "chain" && argv[2] === "insert") {
        return v3RunErrorResponse("session-chain-insert", "ORCHESTRATION_REVISION_CONFLICT", {
          target_type: "orchestration",
          target_id: "session-1",
          expected_revision: 4,
          current_revision: 5,
          changed_by: "participant-other",
          next_actions: ["read-session-status", "resubmit-with-current-revision"],
        });
      }
      if (argv[0] === "session" && argv[1] === "status") {
        return v3RunResponse("session-status", {
          request_id: null,
          locator: { session_id: "session-1", run_id: null },
          revision: null,
          result: {
            session_id: "session-1",
            schema_version: "session/3.0",
            status: "open",
            orchestration_revision: 5,
          },
          replay: null,
        });
      }
      return defaultV3Envelope(argv, snapshot);
    },
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const result = await coordinator.exec(
      ["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"],
      classifyRunControlArgv(["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"]),
      "pi-v3",
    );
    const envelope = JSON.parse(result.command.stdout) as {
      ok: boolean;
      error: { code: string; message: string; next_actions: string[] };
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "ORCHESTRATION_REVISION_CONFLICT");
    assert.match(envelope.error.message, /Re-read authority via 'maestro session status --json'/);
    assert.match(envelope.error.message, /current orchestration revision 5/);
    assert.deepEqual(envelope.error.next_actions, ["read-session-status", "resubmit-with-current-revision"]);
    assert.equal(
      calls.filter((call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "insert").length,
      1,
      "a revision conflict must never be replayed with a replaced revision",
    );
    const statusReRead = calls.find(
      (call) => call[0] === "exec" && call[1] === "session" && call[2] === "status",
    );
    assert.ok(statusReRead, "the coordinator re-reads session status after an orchestration conflict");
    assert.equal(flagValue(statusReRead, "--session"), "session-1");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 Run conflicts re-read the exact Session brief without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-run-conflict-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    responses: (argv) => {
      if (argv[0] === "run" && argv[1] === "complete") {
        return v3RunErrorResponse("complete", "RUN_REVISION_CONFLICT", {
          target_type: "run",
          target_id: "run-1",
          expected_revision: 2,
          current_revision: 3,
          changed_by: "participant-other",
          next_actions: ["read-run-brief", "resubmit-with-current-revision"],
        });
      }
      if (argv[0] === "run" && argv[1] === "brief") {
        return v3RunResponse("brief", {
          request_id: null,
          locator: { session_id: "session-1", run_id: "run-1" },
          revision: { target_type: "run", target_id: "run-1", revision: 3 },
          result: { run_id: "run-1", revision: 3 },
          replay: null,
        });
      }
      return defaultV3Envelope(argv, snapshot);
    },
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const result = await coordinator.exec(
      ["run", "complete", "run-1", "--advance", "--verdict", "done"],
      classifyRunControlArgv(["run", "complete", "run-1"]),
      "pi-v3",
    );
    const envelope = JSON.parse(result.command.stdout) as { error: { message: string } };
    assert.match(envelope.error.message, /current Run revision 3/);
    const briefReRead = calls.find(
      (call) => call[0] === "exec" && call[1] === "run" && call[2] === "brief",
    )!;
    assert.equal(flagValue(briefReRead, "--session"), "session-1");
    assert.equal(
      calls.filter((call) => call[0] === "exec" && call[1] === "run" && call[2] === "complete").length,
      1,
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 REQUEST_CONFLICT returns the error without swapping request-id or replaying", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-request-conflict-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    responses: (argv) => {
      if (argv[0] === "run" && argv[1] === "complete") {
        return v3RunErrorResponse("complete", "REQUEST_CONFLICT", {
          target_type: null,
          target_id: null,
          expected_revision: null,
          current_revision: null,
          changed_by: null,
          next_actions: ["resubmit-with-new-request-id"],
        });
      }
      return defaultV3Envelope(argv, snapshot);
    },
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const result = await coordinator.exec(
      ["run", "complete", "run-1", "--advance", "--request-id", "retry-request-1"],
      classifyRunControlArgv(["run", "complete", "run-1"]),
      "pi-v3",
    );
    const envelope = JSON.parse(result.command.stdout) as {
      ok: boolean;
      error: { code: string; message: string; next_actions: string[] };
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "REQUEST_CONFLICT");
    assert.doesNotMatch(envelope.error.message, /Re-read authority/, "REQUEST_CONFLICT is returned as-is (D2)");
    assert.deepEqual(envelope.error.next_actions, ["resubmit-with-new-request-id"]);
    const completeCalls = calls.filter((call) => call[0] === "exec" && call[1] === "run" && call[2] === "complete");
    assert.equal(completeCalls.length, 1, "REQUEST_CONFLICT must not auto-retry with a new request id (D2)");
    assert.equal(
      flagValue(completeCalls[0]!, "--request-id"),
      "retry-request-1",
      "the caller-provided request id is preserved for retry reuse",
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 mutations never emit participant register after the command family retired", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-register-retired-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(
    fakeBridge(snapshot),
    v3Adapter(calls, snapshot),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.selectMode("session-v3");
    await coordinator.exec(
      ["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"],
      classifyRunControlArgv(["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"]),
      "pi-v3",
    );
    await coordinator.exec(
      ["session", "chain", "skip", "--step-id", "execute"],
      classifyRunControlArgv(["session", "chain", "skip", "--step-id", "execute"]),
      "pi-v3",
    );
    const registerCalls = calls.filter(
      (call) => call[0] === "exec" && call[1] === "participant" && call[2] === "register",
    );
    assert.equal(registerCalls.length, 0, "the retired participant register command is never issued");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 attach returns no lease, ownership is unowned, and continuation is revision-based", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-attach-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const attached = await coordinator.attach("pi-v3");
    assert.equal(attached.snapshot.session?.sessionId, "session-1");
    assert.equal("lease" in attached, false, "session-v3 attach holds no lease");
    assert.equal(attached.brief?.stdout, "brief run-1");

    const ownership = await coordinator.ownership("pi-v3");
    assert.deepEqual(ownership, {
      sessionId: "session-1",
      currentHostSessionId: "pi-v3",
      state: "unowned",
      isOwner: false,
      isAttached: false,
    });

    await coordinator.fenceContinuation();
    await coordinator.release();
    const marker = coordinator.continuationMarker(1);
    const encoded = marker.split("maestro-workflow-continuation:")[1]!;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { epoch: number };
    assert.equal(parsed.epoch, 4, "v3 continuation epoch is the orchestration revision");
    assert.equal(coordinator.acceptsContinuation(marker), true);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 attach consumes the core resume-view ResumeMapV1 with fingerprint validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-resume-attach-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    responses: (argv) => {
      if (argv[0] === "session" && argv[1] === "resume-view") return v3ResumeMapResponse();
      return defaultV3Envelope(argv, snapshot);
    },
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const attached = await coordinator.attach("pi-v3");
    assert.equal(attached.snapshot.session?.sessionId, "session-1");
    assert.equal("lease" in attached, false, "session-v3 attach holds no lease");
    assert.ok(attached.resumeMap, "a validated ResumeMapV1 is returned on attach");
    assert.equal(attached.resumeMap?.sessionId, "session-1");
    assert.equal(attached.resumeMap?.orchestrationRevision, 7);
    assert.deepEqual(attached.resumeMap?.nextActions, [
      { action: "run-next", targetId: "run-1", expectedRevision: 2 },
    ]);
    assert.equal(attached.resumeMap?.openDecisions.includes("decision-1"), true);
    assert.match(attached.resumeMap?.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(coordinator.resumeMapDiagnostics().length, 0, "a valid resume map records no diagnostics");
    assert.ok(
      calls.some((call) => call[0] === "exec" && call[1] === "session" && call[2] === "resume-view"),
      "attach consumes session resume-view",
    );
    const resumeViewCall = calls.find(
      (call) => call[0] === "exec" && call[1] === "session" && call[2] === "resume-view",
    )!;
    assert.equal(flagValue(resumeViewCall, "--session"), "session-1");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 attach tolerates invalid resume maps (fingerprint, size, forbidden fields)", async () => {
  const cases: Array<{
    name: string;
    map: () => Record<string, unknown>;
    diagnostic: RegExp;
  }> = [
    {
      name: "fingerprint mismatch",
      map: () => v3ResumeMapResponse(
        { orchestrationRevision: 7 },
        v3ResumeMapFingerprint({ sessionId: "session-1", orchestrationRevision: 99 }),
      ),
      diagnostic: /fingerprint/,
    },
    {
      name: "over 2048 UTF-8 bytes",
      map: () => v3ResumeMapResponse({
        activeRuns: [{ runId: "x".repeat(2500), stepId: "execute", status: "running", revision: 2 }],
      }),
      diagnostic: /2048 UTF-8 bytes/,
    },
    {
      name: "forbidden execution field",
      map: () => v3ResumeMapResponse({ executionId: "execution-1" }),
      diagnostic: /forbidden execution\/lease\/operation field names/,
    },
  ];
  for (const fixture of cases) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-v3-resume-${fixture.name.replace(/\s+/g, "-")}-`));
    const snapshot = v3SessionSnapshot("session-1");
    const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter([], snapshot, {
      responses: (argv) => {
        if (argv[0] === "session" && argv[1] === "resume-view") return fixture.map();
        return defaultV3Envelope(argv, snapshot);
      },
    }), new WorkflowLeaseStore(root));
    try {
      await coordinator.selectMode("session-v3");
      const attached = await coordinator.attach("pi-v3");
      assert.equal(attached.snapshot.session?.sessionId, "session-1", `${fixture.name}: attach still succeeds`);
      assert.equal("resumeMap" in attached, false, `${fixture.name}: invalid resume map is dropped`);
      assert.equal("lease" in attached, false, `${fixture.name}: session-v3 attach holds no lease`);
      assert.match(
        coordinator.resumeMapDiagnostics().join(" "),
        fixture.diagnostic,
        `${fixture.name}: the rejection reason is recorded`,
      );
    } finally {
      await coordinator.release();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("session-v3 exec falls back to the attach resume-map revision when the bridge omits orchestrationRevision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-v3-resume-fallback-"));
  const calls: string[][] = [];
  const snapshot = v3SessionSnapshot("session-1");
  delete snapshot.session!.orchestrationRevision;
  const coordinator = testCoordinator(fakeBridge(snapshot), v3Adapter(calls, snapshot, {
    responses: (argv) => {
      if (argv[0] === "session" && argv[1] === "resume-view") return v3ResumeMapResponse();
      return defaultV3Envelope(argv, snapshot);
    },
  }), new WorkflowLeaseStore(root));
  try {
    await coordinator.selectMode("session-v3");
    const attached = await coordinator.attach("pi-v3");
    assert.equal(attached.resumeMap?.orchestrationRevision, 7, "attach caches the resume-map revision");
    const insert = await coordinator.exec(
      ["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"],
      classifyRunControlArgv(["session", "chain", "insert", "--step-id", "analyze", "--command", "analyze"]),
      "pi-v3",
    );
    assert.equal(insert.command.exitCode, 0);
    const insertCall = calls.find(
      (call) => call[0] === "exec" && call[1] === "session" && call[2] === "chain" && call[3] === "insert",
    )!;
    assert.equal(
      flagValue(insertCall, "--expected-orchestration-revision"),
      "7",
      "the attach resume-map revision backs the expected-orchestration-revision CAS flag",
    );
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session-v3 view-model projection exposes v3 authority without lease/execution fields", () => {
  const snapshot: WorkflowSnapshotLike = {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-08-12T00:00:00.000Z",
    revision: { sessionRevision: 4, fingerprint: "v3-view" },
    sessionGeneration: "canonical:valid:session-1:4",
    canonicalClaim: { activeSessionId: "session-1", status: "valid" },
    locator: { sessionId: "session-1", runId: "run-1" },
    decisionPoints: [{ status: "pending" }, { status: "passed" }],
    diagnostics: [],
    session: {
      schemaVersion: "session/3.0",
      sessionId: "session-1",
      intent: "Complete integration",
      status: "running",
      lifecycleAuthority: "legacy-session",
      revision: 4,
      orchestrationRevision: 7,
      activityRevision: 1,
      activeRunId: "run-1",
      definitionOfDone: "All gates pass",
      chain: [{ step: "execute", command: "execute", status: "running", runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status: "running",
        goal: "Execute",
        args: [],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        revision: 2,
        startedAt: "2026-08-12T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
  const view = deriveWorkflowViewModel(snapshot);
  assert.ok(view);
  assert.equal(view.orchestrationRevision, 7, "v3 orchestration revision is projected");
  assert.equal(view.activeRunId, "run-1", "v3 active Run identity is projected");
  assert.equal(view.activeRun?.id, "run-1");
  assert.equal(view.decisionPending, true, "v3 decision status is derived from host decision points");
  assert.equal(view.pendingDecisions, 1);
  // The v3 branch must never project Execution/lease authority.
  for (const key of ["executionId", "generation", "lease", "leaseEpoch", "leaseOwner"]) {
    assert.equal(key in view, false, `v3 view-model must not expose ${key}`);
  }
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
  mutation: "session" | "run" | "execution" | "execution-acquire" | "execution-lease"
    | "compatibility-start" | "plan-publish",
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
      "run-response/1.1": false,
      "run-response/1.2": false,
      artifact_compatibility_v1: false,
      atomic_run_complete_seal: false,
      generation_scoped_seal_receipts: false,
    },
    protocol: "fail-closed",
    diagnostic,
  };
}

function legacyCoreCapabilities(): RunCliCapabilities {
  return {
    ...failClosedCoreCapabilities("Installed Maestro CLI has no capabilities command"),
    mode: "legacy",
  };
}

/** Session/Run minimal-state (plan B v3) core: v2 lease/generation retired. */
function v3CoreCapabilities(): RunCliCapabilities {
  const capabilities = fullCoreCapabilities();
  return {
    ...capabilities,
    structured: {
      ...capabilities.structured!,
      session_schema_writes: ["session/3.0"],
      execution_schema_writes: [],
      features: {
        execution_generation: false,
        core_execution_lease: false,
        execution_handoff: false,
        session_statusless: true,
        legacy_session_aliases: false,
        session_run_minimal_v3: true,
        entity_revision_cas: true,
        participant_identity: true,
        request_receipts_v2: true,
        execution_lease: false,
        operation_registry: false,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    },
    support: {
      execution_generation: false,
      core_execution_lease: false,
      "run-response/1.1": true,
      "run-response/1.2": true,
      artifact_compatibility_v1: true,
      atomic_run_complete_seal: true,
      generation_scoped_seal_receipts: true,
    },
    v3: {
      session_run_minimal_v3: true,
      entity_revision_cas: true,
      participant_identity: true,
      request_receipts_v2: true,
      execution_lease_retired: true,
      operation_registry_retired: true,
    },
    protocol: "session-run-v3",
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
      run_response_writes: ["run-response/1.1", "run-response/1.2"],
      features: {
        execution_generation: true,
        core_execution_lease: true,
        execution_handoff: true,
        session_statusless: true,
        legacy_session_aliases: true,
        artifact_compatibility_v1: true,
        atomic_run_complete_seal: true,
        generation_scoped_seal_receipts: true,
      },
    },
    support: {
      execution_generation: true,
      core_execution_lease: true,
      "run-response/1.1": true,
      "run-response/1.2": true,
      artifact_compatibility_v1: true,
      atomic_run_complete_seal: true,
      generation_scoped_seal_receipts: true,
    },
    v3: {
      session_run_minimal_v3: false,
      entity_revision_cas: false,
      participant_identity: false,
      request_receipts_v2: false,
      execution_lease_retired: false,
      operation_registry_retired: false,
    },
    protocol: "execution-v2",
    diagnostic: null,
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
      if (!classification.write) return result(argv, `read ${argv.join(" ")}`);
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
  if (argv[0] === "execution" && argv[1] === "handoff") return `execution-handoff-${argv[2]}`;
  if (argv[0] === "execution" && argv[1] === "lease") return `execution-lease-${argv[2]}`;
  if (argv[0] === "execution") return `execution-${argv[1]}`;
  if (argv[0] === "session") return `session-${argv[1]}`;
  if (argv[0] === "run" && argv[1] === "complete") return "complete";
  return argv[1] ?? argv[0] ?? "check";
}

function artifactInspectResponse(sessionSchemaVersion: "session/2.0" | "session/3.0"): Record<string, unknown> {
  return {
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
        session_schema_version: sessionSchemaVersion,
        session_revision: 4,
        artifact_registry_revision: 7,
      },
    },
    replay: null,
    warnings: [],
    error: null,
  };
}

function artifactRepublishResponse(requestId: string): Record<string, unknown> {
  return {
    schema_version: "run-response/1.2",
    operation: "artifact-republish",
    ok: true,
    exit_code: 0,
    disposition: "success",
    request_id: requestId,
    locator: { session_id: "session-1", run_id: "run-compatibility" },
    revision: { target_type: "artifact", target_id: "ART-derived", revision: 8 },
    result: {
      source_artifact_id: "ART-source",
      artifact_id: "ART-derived",
      receipt: { schema_version: "artifact-republish/1.0" },
    },
    replay: { status: "applied", transition_id: "transition-artifact-republish" },
    warnings: [],
    error: null,
  };
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

// ---------------------------------------------------------------------------
// session-v3 coordinator test helpers
// ---------------------------------------------------------------------------

function v3SessionSnapshot(sessionId: string): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-08-12T00:00:00.000Z",
    revision: { sessionRevision: 4, fingerprint: "v3-session" },
    sessionGeneration: `canonical:valid:${sessionId}:4`,
    canonicalClaim: { activeSessionId: sessionId, status: "valid" },
    locator: { sessionId, runId: "run-1" },
    diagnostics: [],
    session: {
      schemaVersion: "session/3.0",
      sessionId,
      intent: "Complete integration",
      status: "running",
      lifecycleAuthority: "legacy-session",
      revision: 4,
      orchestrationRevision: 4,
      activityRevision: 1,
      activeRunId: "run-1",
      definitionOfDone: "All gates pass",
      chain: [{ step: "execute", command: "execute", status: "running", runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status: "running",
        goal: "Execute",
        args: [],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        revision: 2,
        startedAt: "2026-08-12T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function v3EmptySnapshot(): WorkflowSnapshot {
  return {
    source: "none",
    projectRoot: "D:/workspace",
    loadedAt: "2026-08-12T00:00:00.000Z",
    revision: { sessionRevision: 0, fingerprint: "v3-empty" },
    diagnostics: [],
  };
}

function v3Adapter(
  calls: string[][],
  snapshot: WorkflowSnapshot,
  options: {
    responses?: (argv: readonly string[]) => Record<string, unknown>;
    applyMutations?: boolean;
  } = {},
): WorkflowRunAdapter {
  const adapter = fakeAdapter(calls);
  return {
    ...adapter,
    async capabilities() { return v3CoreCapabilities(); },
    async exec(argv) {
      calls.push(["exec", ...argv]);
      const envelope = options.responses?.(argv) ?? defaultV3Envelope(argv, snapshot);
      if (options.applyMutations !== false && envelope.ok === true) {
        applyV3ResponseToSnapshot(snapshot, envelope, argv);
      }
      return {
        argv: [...argv],
        stdout: JSON.stringify(envelope),
        stderr: "",
        exitCode: envelope.ok === true ? 0 : Number(envelope.exit_code ?? 1),
      };
    },
  };
}

function defaultV3Envelope(argv: readonly string[], snapshot: WorkflowSnapshot): Record<string, unknown> {
  const operation = v3OperationForArgv(argv);
  const sessionId = flagValue(argv, "--id") ?? snapshot.session?.sessionId ?? "session-1";
  const runId = v3ResponseRunId(argv);
  if (operation === "session-status") {
    return v3RunResponse("session-status", {
      request_id: null,
      locator: { session_id: sessionId, run_id: null },
      revision: null,
      result: {
        session_id: sessionId,
        schema_version: "session/3.0",
        status: "open",
        orchestration_revision: snapshot.session?.orchestrationRevision ?? 0,
      },
      replay: null,
    });
  }
  if (operation === "brief") {
    const run = snapshot.session?.runs.find((candidate) => candidate.runId === runId);
    return v3RunResponse("brief", {
      request_id: null,
      locator: { session_id: sessionId, run_id: runId },
      revision: null,
      result: run ?? { run_id: runId, schema_version: "run/3.0", status: "running", revision: 0 },
      replay: null,
    });
  }
  if (operation === "check") {
    return v3RunResponse("check", {
      request_id: null,
      locator: { session_id: sessionId, run_id: runId },
      revision: null,
      result: {
        run_id: runId,
        status: "running",
        revision: snapshot.session?.runs.find((candidate) => candidate.runId === runId)?.revision ?? 0,
      },
      replay: null,
    });
  }
  if (operation === "participant-register") {
    return v3RunResponse("participant-register", {
      locator: { session_id: sessionId, run_id: null },
      result: { participant_id: flagValue(argv, "--participant"), session_id: sessionId, status: "registered" },
    });
  }
  return v3RunResponse(operation, {
    request_id: flagValue(argv, "--request-id") ?? "request-v3",
  });
}

function applyV3ResponseToSnapshot(
  snapshot: WorkflowSnapshot,
  envelope: Record<string, unknown>,
  argv: readonly string[],
): void {
  if (envelope.ok !== true) return;
  const operation = String(envelope.operation);
  if (operation === "session-open") {
    const sessionId = flagValue(argv, "--id") ?? "session-1";
    const session: WorkflowSession = {
      schemaVersion: "session/3.0",
      sessionId,
      intent: String(argv[2] ?? ""),
      status: "running",
      lifecycleAuthority: "legacy-session",
      revision: 1,
      orchestrationRevision: 0,
      activityRevision: 1,
      activeRunId: null,
      definitionOfDone: "",
      chain: [],
      runs: [],
      artifacts: [],
      aliases: {},
    };
    snapshot.source = "canonical";
    snapshot.canonicalClaim = { activeSessionId: sessionId, status: "valid" };
    snapshot.sessionGeneration = `canonical:valid:${sessionId}:1`;
    snapshot.locator = { sessionId };
    snapshot.session = session;
    snapshot.revision = { sessionRevision: 1, fingerprint: `v3-open-${sessionId}` };
    return;
  }
  const session = snapshot.session;
  if (!session) return;
  if (operation === "session-chain-insert") {
    session.chain.push({
      step: flagValue(argv, "--step-id") ?? `step-${session.chain.length + 1}`,
      command: flagValue(argv, "--command") ?? "execute",
      status: "pending",
      runId: null,
    });
    bumpV3Orchestration(session);
    return;
  }
  if (operation === "session-chain-skip") {
    const stepId = flagValue(argv, "--step-id");
    session.chain = session.chain.map((step) => step.step === stepId && step.status === "pending"
      ? { ...step, status: "completed" }
      : step);
    bumpV3Orchestration(session);
    return;
  }
  if (operation === "next") {
    const runId = flagValue(argv, "--run") ?? "run-1";
    const pending = session.chain.find((step) => step.status === "pending" && !step.runId);
    session.runs.push({
      runId,
      parentRunId: null,
      command: pending?.command ?? "execute",
      status: "running",
      goal: null,
      args: [],
      gates: [],
      primaryArtifactId: null,
      handoff: null,
      revision: 0,
      startedAt: "2026-08-12T00:00:00.000Z",
      endedAt: null,
    });
    session.activeRunId = runId;
    session.chain = session.chain.map((step) => step.step === pending?.step
      ? { ...step, status: "running", runId }
      : step);
    bumpV3Orchestration(session);
    return;
  }
  if (operation === "complete") {
    const runId = v3ResponseRunId(argv);
    const run = session.runs.find((candidate) => candidate.runId === runId);
    if (run) {
      run.status = "sealed";
      run.endedAt = "2026-08-12T00:10:00.000Z";
      run.revision = (run.revision ?? 0) + 1;
    }
    session.activeRunId = null;
    session.chain = session.chain.map((step) => step.runId === runId ? { ...step, status: "completed" } : step);
    bumpV3Orchestration(session);
    return;
  }
  if (operation === "run-decide") {
    bumpV3Orchestration(session);
    return;
  }
  if (operation === "session-complete") {
    session.status = "sealed";
    bumpV3Orchestration(session);
  }
}

function bumpV3Orchestration(session: WorkflowSession): void {
  session.orchestrationRevision = (session.orchestrationRevision ?? 0) + 1;
  session.revision = Math.max(
    session.orchestrationRevision,
    session.activityRevision ?? 0,
  );
}

function v3OperationForArgv(argv: readonly string[]): string {
  if (argv[0] === "session") {
    if (argv[1] === "chain") return `session-chain-${argv[2] ?? "unknown"}`;
    return `session-${argv[1] ?? "unknown"}`;
  }
  if (argv[0] === "run") {
    if (argv[1] === "complete") return "complete";
    if (argv[1] === "decide") return "run-decide";
    if (argv[1] === "transition") return "run-transition";
    if (argv[1] === "cancel") return "run-cancel";
    if (argv[1] === "seal") return "run-seal";
    return argv[1] ?? "unknown";
  }
  if (argv[0] === "participant") return `participant-${argv[1] ?? "unknown"}`;
  if (argv[0] === "artifact") return `artifact-${argv[1] ?? "unknown"}`;
  return argv[1] ?? argv[0] ?? "unknown";
}

function v3ResponseRunId(argv: readonly string[]): string {
  if (argv[0] !== "run") return "run-1";
  const flagged = flagValue(argv, "--run");
  if (flagged) return flagged;
  const positional = argv[2];
  return positional && !positional.startsWith("-") ? positional : "run-1";
}

function v3RunResponse(operation: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "run-response/1.2",
    operation,
    ok: true,
    exit_code: 0,
    disposition: "success",
    request_id: "request-v3",
    locator: { session_id: "session-1", run_id: "run-1" },
    revision: { target_type: "orchestration", target_id: "session-1", revision: 1 },
    result: { visible: true },
    replay: { status: "applied", transition_id: `transition-${operation}` },
    warnings: [],
    error: null,
    ...overrides,
  };
}

function v3RunErrorResponse(
  operation: string,
  code: string,
  errorOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "run-response/1.2",
    operation,
    ok: false,
    exit_code: 3,
    disposition: "control_flow",
    request_id: "request-v3",
    locator: { session_id: "session-1", run_id: "run-1" },
    revision: null,
    result: null,
    replay: null,
    warnings: [],
    error: {
      code,
      message: `${code} message`,
      retryable: true,
      details: {},
      target_type: "orchestration",
      target_id: "session-1",
      expected_revision: 0,
      current_revision: 1,
      changed_by: "participant-other",
      next_actions: ["read-session-status", "resubmit-with-current-revision"],
      ...errorOverrides,
    },
  };
}

/** Mirrors the coordinator/core stableJsonUtf8 for resume-map fingerprint fixtures. */
function v3StableJsonUtf8(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function v3ResumeMapFingerprint(body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(v3StableJsonUtf8(body), "utf8").digest("hex")}`;
}

/** A session-resume-view run-response/1.2 envelope whose result is a ResumeMapV1. */
function v3ResumeMapResponse(
  overrides: Record<string, unknown> = {},
  fingerprintOverride?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionId: "session-1",
    sessionStatus: "open",
    orchestrationRevision: 7,
    activityRevision: 1,
    activeRuns: [{ runId: "run-1", stepId: "execute", status: "running", revision: 2 }],
    blockingGates: [],
    openDecisions: ["decision-1"],
    pendingPublications: [],
    nextActions: [{ action: "run-next", targetId: "run-1", expectedRevision: 2 }],
    ...overrides,
  };
  const map = { ...body, fingerprint: fingerprintOverride ?? v3ResumeMapFingerprint(body) };
  return v3RunResponse("session-resume-view", {
    request_id: null,
    locator: { session_id: "session-1", run_id: null },
    revision: null,
    result: map,
    replay: null,
  });
}
