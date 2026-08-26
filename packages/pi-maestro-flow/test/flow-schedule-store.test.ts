import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWorkspaceCompletionHandle } from "pi-maestro-teammate/v1/workspace-completion";
import {
  FlowScheduleConflictError,
  FlowScheduleCorruptionError,
  FlowScheduleStore,
} from "../src/flow-schedule/store.ts";
import {
  FLOW_SCHEDULE_LIMITS,
  FLOW_SCHEDULE_RESULT_TYPE,
  FLOW_SCHEDULE_VERSION,
  type ExactWindowIdentity,
  type FlowScheduleCompletionRecord,
  type FlowScheduleRecord,
  type FlowScheduleTodoBinding,
} from "../src/flow-schedule/types.ts";

const DISPATCH_A = "123e4567-e89b-42d3-a456-426614174000";
const DISPATCH_B = "223e4567-e89b-42d3-a456-426614174000";
const OWNER_ID = "a".repeat(32);
const OWNER_SELECTOR = `owner:${OWNER_ID}`;
const COMPLETION_CORRELATION = bindWorkspaceCompletionHandle("9".repeat(32), {
  workspaceId: "f".repeat(64),
  ownerId: "1".repeat(32),
  ownerNonce: "2".repeat(32),
});
const identity: ExactWindowIdentity = {
  workspaceId: "workspace",
  endpointId: "endpoint",
  ownerId: OWNER_ID,
  ownerNonce: "b".repeat(32),
  sessionId: "session-a",
};

function attemptId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function temporaryStore(options: ConstructorParameters<typeof FlowScheduleStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-store-"));
  const projectRoot = join(root, "workspace");
  const store = new FlowScheduleStore(projectRoot, {
    getProcessIdentity: () => `test-process:${process.pid}`,
    ...options,
  });
  return { root, projectRoot, store };
}

async function createActiveSchedule(store: FlowScheduleStore, scheduleId: string, stepId = "verify") {
  await store.createSchedule({
    scheduleId,
    target: OWNER_SELECTOR,
    steps: [{ stepId, prompt: `Run ${stepId}` }],
  });
  return store.updateSchedule(scheduleId, (schedule) => ({ ...schedule, state: "active" }));
}

function completion(dispatchId = DISPATCH_A): FlowScheduleCompletionRecord {
  return {
    version: FLOW_SCHEDULE_VERSION,
    type: "flow-schedule-completion",
    dispatchId,
    scheduleId: "release",
    stepId: "verify",
    targetIdentity: identity,
    state: "completed",
    result: {
      version: FLOW_SCHEDULE_VERSION,
      type: FLOW_SCHEDULE_RESULT_TYPE,
      dispatchId,
      scheduleId: "release",
      stepId: "verify",
      outcome: "completed",
      summary: "Verification passed",
      resources: [],
    },
    completedAt: 200,
  };
}

test("FlowScheduleStore creates the owned v1 layout and preserves stable schedule data across restart", async () => {
  const { root, projectRoot, store } = await temporaryStore({ now: () => 100 });
  try {
    const created = await store.createSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [
        { stepId: "build", prompt: "Build" },
        { stepId: "verify", prompt: "Verify" },
      ],
    });
    assert.equal(created.state, "draft");
    assert.deepEqual(created.stepIds, ["build", "verify"]);

    const owner = JSON.parse(await readFile(store.ownerPath, "utf8"));
    assert.equal(owner.version, 1);
    assert.equal(owner.type, "flow-schedule-store");
    assert.equal(owner.projectRoot.replaceAll("\\", "/"), projectRoot.replaceAll("\\", "/").toLowerCase());
    assert.equal((await lstat(store.schedulesDir)).isDirectory(), true);
    assert.equal((await lstat(store.dispatchesDir)).isDirectory(), true);
    assert.equal((await lstat(store.locksDir)).isDirectory(), true);

    const restarted = new FlowScheduleStore(projectRoot, {
      now: () => 999,
      getProcessIdentity: () => `test-process:${process.pid}`,
    });
    assert.deepEqual(await restarted.readSchedule("release"), created);
    assert.deepEqual((await restarted.listSchedules()).map((entry) => entry.scheduleId), ["release"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore normalizes the complete schedule before any persistence", async () => {
  const { root, store } = await temporaryStore();
  try {
    await assert.rejects(
      store.createSchedule({
        scheduleId: "duplicate",
        target: OWNER_SELECTOR,
        steps: [
          { stepId: "same", prompt: "First" },
          { stepId: "same", prompt: "Second" },
        ],
      }),
      /duplicate stepId/,
    );
    await assert.rejects(
      store.createSchedule({
        scheduleId: "too-many",
        target: OWNER_SELECTOR,
        steps: Array.from({ length: FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule + 1 }, (_, index) => ({
          stepId: `step-${index}`,
          prompt: "Work",
        })),
      }),
    );
    await assert.rejects(readFile(join(store.schedulesDir, "duplicate.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(store.schedulesDir, "too-many.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V2 pre-persist callbacks fence admission, acceptance, and completion compatibility writes", async () => {
  const { root, store } = await temporaryStore({ now: (() => { let now = 100; return () => now++; })() });
  const injected = new Error("journal committed, compatibility write interrupted");
  try {
    await createActiveSchedule(store, "release");

    await assert.rejects(
      store.createDispatchIntent({
        dispatchId: DISPATCH_A,
        scheduleId: "release",
        stepId: "verify",
        targetIdentity: identity,
      }, undefined, (projection) => {
        assert.equal(projection.activeStepId, "verify");
        throw injected;
      }),
      injected,
    );
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);
    assert.equal((await store.readSchedule("release"))?.activeStepId, undefined);

    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    await store.recordPublished({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-published",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      traceId: DISPATCH_A,
      publishedAt: 150,
    });
    const accepted = {
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-accepted" as const,
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      acceptedAt: 160,
      deliveryState: "injected" as const,
    };
    await assert.rejects(
      store.recordAccepted(accepted, (projection) => {
        assert.equal(projection.steps.verify.state, "awaiting-result");
        throw injected;
      }),
      injected,
    );
    assert.equal((await store.readDispatch(DISPATCH_A))?.accepted, undefined);
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "dispatching");

    await store.recordAccepted(accepted);
    await assert.rejects(
      store.recordCompletion(completion(), (projection) => {
        assert.equal(projection.state, "completed");
        throw injected;
      }),
      injected,
    );
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined);
    assert.equal((await store.readSchedule("release"))?.state, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore enforces the nonterminal schedule limit", async () => {
  const { root, store } = await temporaryStore();
  try {
    await store.createSchedule({
      scheduleId: "schedule-0",
      target: OWNER_SELECTOR,
      steps: [{ stepId: "step", prompt: "Work" }],
    });
    const seed = JSON.parse(
      await readFile(join(store.schedulesDir, "schedule-0.json"), "utf8"),
    ) as FlowScheduleRecord;
    await Promise.all(
      Array.from(
        { length: FLOW_SCHEDULE_LIMITS.maxNonterminalSchedules - 1 },
        async (_, offset) => {
          const scheduleId = `schedule-${offset + 1}`;
          const record = { ...seed, scheduleId };
          await writeFile(
            join(store.schedulesDir, `${scheduleId}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
            "utf8",
          );
        },
      ),
    );
    await assert.rejects(
      store.createSchedule({
        scheduleId: "schedule-over-limit",
        target: OWNER_SELECTOR,
        steps: [{ stepId: "step", prompt: "Work" }],
      }),
      /32 nonterminal schedules/,
    );
    assert.equal((await store.listSchedules()).length, FLOW_SCHEDULE_LIMITS.maxNonterminalSchedules);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore serializes concurrent snapshot mutations without losing appended steps", async () => {
  const { root, store } = await temporaryStore();
  try {
    await store.createSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [{ stepId: "base", prompt: "Base" }],
    });
    await Promise.all([
      store.appendSteps("release", "base", [{ stepId: "fix-a", prompt: "Fix A" }]),
      store.appendSteps("release", "base", [{ stepId: "fix-b", prompt: "Fix B" }]),
    ]);
    const stored = await store.readSchedule("release");
    assert.equal(stored?.stepIds.length, 3);
    assert.deepEqual(new Set(stored?.stepIds), new Set(["base", "fix-a", "fix-b"]));
    const entries = await readdir(store.schedulesDir);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore preserves sequential order and rejects insertion before an attempted step", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await store.createSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [
        { stepId: "build", prompt: "Build" },
        { stepId: "verify", prompt: "Verify" },
      ],
    });
    await store.updateSchedule("release", (schedule) => ({ ...schedule, state: "active" }));
    await assert.rejects(
      store.createDispatchIntent({
        dispatchId: DISPATCH_B,
        scheduleId: "release",
        stepId: "verify",
        targetIdentity: identity,
      }),
      /next sequential step.*build/,
    );

    await assert.rejects(
      store.createDispatchIntent({
        dispatchId: DISPATCH_A,
        scheduleId: "release",
        stepId: "build",
        targetIdentity: identity,
      }, () => false),
      /authority fence is stale/,
    );
    assert.equal(await store.readDispatch(DISPATCH_A), undefined);

    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "build",
      targetIdentity: identity,
    });
    await store.recordCompletion({
      version: 1,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "build",
      targetIdentity: identity,
      state: "completed",
      result: {
        version: 1,
        type: FLOW_SCHEDULE_RESULT_TYPE,
        dispatchId: DISPATCH_A,
        scheduleId: "release",
        stepId: "build",
        outcome: "completed",
        summary: "Build passed",
        resources: [],
      },
      completedAt: 110,
    });
    await store.createDispatchIntent({
      dispatchId: DISPATCH_B,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    await assert.rejects(
      store.appendSteps("release", "build", [{ stepId: "fix", prompt: "Fix" }]),
      /Cannot insert before attempted Flow schedule step: verify/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive intent admission permits one active dispatch per schedule and exact target", async () => {
  let now = 100;
  const { root, store } = await temporaryStore({ now: () => now++ });
  try {
    await createActiveSchedule(store, "release-a");
    await createActiveSchedule(store, "release-b");

    const outcomes = await Promise.allSettled([
      store.createDispatchIntent({
        dispatchId: DISPATCH_A,
        scheduleId: "release-a",
        stepId: "verify",
        targetIdentity: identity,
      }),
      store.createDispatchIntent({
        dispatchId: DISPATCH_B,
        scheduleId: "release-b",
        stepId: "verify",
        targetIdentity: identity,
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.ok(outcomes.some((outcome) => outcome.status === "rejected" && outcome.reason instanceof FlowScheduleConflictError));

    const dispatchEntries = await readdir(store.dispatchesDir);
    assert.equal(dispatchEntries.length, 1);
    const winningId = dispatchEntries[0];
    const winningSchedule = winningId === DISPATCH_A ? "release-a" : "release-b";
    const schedule = await store.readSchedule(winningSchedule);
    assert.equal(schedule?.activeStepId, "verify");
    assert.equal(schedule?.steps.verify.currentDispatchId, winningId);
    assert.deepEqual(schedule?.steps.verify.attempts, [winningId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function claimInChild(
  projectRoot: string,
  scheduleId: string,
  dispatchId: string,
  deadline: number,
): Promise<string> {
  const moduleUrl = new URL("../src/flow-schedule/store.ts", import.meta.url).href;
  const script = [
    "const [moduleUrl, projectRoot, scheduleId, dispatchId, deadline] = process.argv.slice(1);",
    "const { FlowScheduleStore, FlowScheduleConflictError } = await import(moduleUrl);",
    "while (Date.now() < Number(deadline)) {}",
    "const store = new FlowScheduleStore(projectRoot, { lockRetryMs: 1, lockTimeoutMs: 5000, getProcessIdentity: () => `child:${process.pid}` });",
    `const targetIdentity = ${JSON.stringify(identity)};`,
    "try { await store.createDispatchIntent({ dispatchId, scheduleId, stepId: 'verify', targetIdentity }); process.stdout.write('created'); }",
    "catch (error) { if (error instanceof FlowScheduleConflictError) process.stdout.write('conflict'); else throw error; }",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    script,
    moduleUrl,
    projectRoot,
    scheduleId,
    dispatchId,
    String(deadline),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`Flow schedule claim child exited ${String(code)}: ${stderr}`));
    });
  });
}

test("cross-process mutation locking admits one schedule for an exact target", async () => {
  const { root, projectRoot, store } = await temporaryStore();
  try {
    await createActiveSchedule(store, "release-a");
    await createActiveSchedule(store, "release-b");
    const deadline = Date.now() + 1_000;
    const outcomes = await Promise.all([
      claimInChild(projectRoot, "release-a", DISPATCH_A, deadline),
      claimInChild(projectRoot, "release-b", DISPATCH_B, deadline),
    ]);
    assert.deepEqual(outcomes.sort(), ["conflict", "created"]);
    assert.equal((await readdir(store.dispatchesDir)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("intent replay and completion projection are idempotent and exclusive", async () => {
  let now = 100;
  const { root, store } = await temporaryStore({ now: () => now++ });
  try {
    await createActiveSchedule(store, "release");
    const first = await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    const replay = await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.dispatch.createdAt, first.dispatch.createdAt);
    assert.deepEqual(replay.schedule.steps.verify.attempts, [DISPATCH_A]);

    await store.recordPublished({
      version: 1,
      type: "flow-schedule-published",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      traceId: DISPATCH_A,
      publishedAt: 150,
    });
    await store.recordAccepted({
      version: 1,
      type: "flow-schedule-accepted",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      acceptedAt: 160,
      deliveryState: "accepted",
    });
    assert.equal((await store.readSchedule("release"))?.steps.verify.state, "awaiting-result");

    const record = completion();
    assert.deepEqual(await store.recordCompletion(record), record);
    assert.deepEqual(await store.recordCompletion(record), record);
    const completed = await store.readSchedule("release");
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.steps.verify.state, "completed");
    assert.deepEqual(completed?.steps.verify.attempts, [DISPATCH_A]);

    await assert.rejects(
      store.recordCompletion({
        ...record,
        result: { ...record.result!, summary: "Conflicting result" },
      }),
      FlowScheduleConflictError,
    );
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.result?.summary, "Verification passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted projection replay repairs a dispatching step without changing the v1 durable layout", async () => {
  let now = 100;
  const { root, store } = await temporaryStore({ now: () => now++ });
  try {
    await createActiveSchedule(store, "release");
    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    await store.recordPublished({
      version: 1,
      type: "flow-schedule-published",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      traceId: DISPATCH_A,
      publishedAt: 150,
    });
    const accepted = {
      version: 1 as const,
      type: "flow-schedule-accepted" as const,
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      messageId: DISPATCH_A,
      acceptedAt: 160,
      deliveryState: "accepted" as const,
    };
    await store.recordAccepted(accepted);

    const schedulePath = join(store.schedulesDir, "release.json");
    const interrupted = JSON.parse(await readFile(schedulePath, "utf8")) as FlowScheduleRecord;
    interrupted.steps.verify.state = "dispatching";
    await writeFile(schedulePath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    await store.recordAccepted(accepted);
    const repaired = await store.readSchedule("release");
    assert.equal(repaired?.steps.verify.state, "awaiting-result");
    const repairedAt = repaired?.updatedAt;
    await store.recordAccepted(accepted);
    assert.equal((await store.readSchedule("release"))?.updatedAt, repairedAt, "an already-projected replay does not rewrite the schedule");
    await store.recordCompletion(completion());
    assert.deepEqual(await store.recordAccepted(accepted), accepted, "a late accepted receipt remains idempotent after completion");
    assert.equal((await store.readSchedule("release"))?.state, "completed");
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(store.dispatchesDir, DISPATCH_A, "accepted.json"), "utf8"))).sort(), [
      "acceptedAt", "deliveryState", "dispatchId", "messageId", "scheduleId", "stepId", "type", "version",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion correlation is optional only when both legacy intent and result omit it", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createActiveSchedule(store, "release");
    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
      completionCorrelation: COMPLETION_CORRELATION,
    });
    await assert.rejects(store.recordCompletion(completion()), /correlation does not match/);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed attempts can be explicitly retried without mutating their completion audit", async () => {
  let now = 100;
  const { root, store } = await temporaryStore({ now: () => now++ });
  try {
    await createActiveSchedule(store, "release");
    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    await store.recordCompletion({
      version: 1,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
      state: "failed",
      result: {
        version: 1,
        type: FLOW_SCHEDULE_RESULT_TYPE,
        dispatchId: DISPATCH_A,
        scheduleId: "release",
        stepId: "verify",
        outcome: "failed",
        summary: "Verification failed",
        resources: [],
      },
      completedAt: now++,
    });

    const retried = await store.prepareRetry("release", "verify", "Retry after fixing inputs");
    assert.equal(retried.steps.verify.state, "pending");
    assert.equal(retried.steps.verify.result, undefined);
    assert.deepEqual(retried.steps.verify.attempts, [DISPATCH_A]);

    await store.createDispatchIntent({
      dispatchId: DISPATCH_B,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    await store.recordCompletion(completion(DISPATCH_B));

    const completed = await store.readSchedule("release");
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.steps.verify.result?.dispatchId, DISPATCH_B);
    assert.equal((await store.readDispatch(DISPATCH_A))?.completion?.result?.outcome, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch admission enforces the per-step attempt limit", async () => {
  const { root, store } = await temporaryStore();
  try {
    await createActiveSchedule(store, "release");
    const schedulePath = join(store.schedulesDir, "release.json");
    const seeded = JSON.parse(await readFile(schedulePath, "utf8")) as FlowScheduleRecord;
    seeded.steps.verify.attempts = Array.from(
      { length: FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep },
      (_, index) => attemptId(index),
    );
    await writeFile(schedulePath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

    assert.equal((await store.readSchedule("release"))?.steps.verify.attempts.length, FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep);
    await assert.rejects(
      store.createDispatchIntent({
        dispatchId: attemptId(FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep),
        scheduleId: "release",
        stepId: "verify",
        targetIdentity: identity,
      }),
      /10 attempt limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt schedule and dispatch records fail closed without being rewritten", async () => {
  const { root, store } = await temporaryStore();
  try {
    await createActiveSchedule(store, "release");
    await store.createDispatchIntent({
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "verify",
      targetIdentity: identity,
    });
    const schedulePath = join(store.schedulesDir, "release.json");
    const original = JSON.parse(await readFile(schedulePath, "utf8"));
    const corrupt = `${JSON.stringify({ ...original, unexpected: true }, null, 2)}\n`;
    await writeFile(schedulePath, corrupt, "utf8");

    await assert.rejects(store.readSchedule("release"), FlowScheduleCorruptionError);
    await assert.rejects(store.listSchedules(), FlowScheduleCorruptionError);
    assert.equal(await readFile(schedulePath, "utf8"), corrupt);

    const intentPath = join(store.dispatchesDir, DISPATCH_A, "intent.json");
    const intent = JSON.parse(await readFile(intentPath, "utf8"));
    const corruptIntent = `${JSON.stringify({ ...intent, unexpected: true }, null, 2)}\n`;
    await writeFile(intentPath, corruptIntent, "utf8");
    await assert.rejects(store.readDispatch(DISPATCH_A), FlowScheduleCorruptionError);
    assert.equal(await readFile(intentPath, "utf8"), corruptIntent);

    await writeFile(schedulePath, "{broken", "utf8");
    await assert.rejects(store.readSchedule("release"), FlowScheduleCorruptionError);
    assert.equal(await readFile(schedulePath, "utf8"), "{broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store identity guards reject paths outside the owned root", async () => {
  const { root, store } = await temporaryStore();
  try {
    await store.createSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    });
    await assert.rejects(store.readSchedule("../escape"), /Invalid Flow schedule ID/);
    await assert.rejects(store.readDispatch("../escape"), /Invalid Flow schedule dispatch ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects symbolic record targets", { skip: process.platform === "win32" }, async () => {
  const { root, store } = await temporaryStore();
  try {
    await store.createSchedule({
      scheduleId: "release",
      target: OWNER_SELECTOR,
      steps: [{ stepId: "verify", prompt: "Verify" }],
    });
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside", "utf8");
    const schedulePath = join(store.schedulesDir, "release.json");
    await rm(schedulePath);
    await symlink(outside, schedulePath);
    await assert.rejects(store.readSchedule("release"), FlowScheduleCorruptionError);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store revalidates lock ownership immediately before creating a schedule record", async () => {
  const { root, store } = await temporaryStore();
  const acquire = store.acquireStoreLock.bind(store);
  try {
    await store.initialize();
    let ownershipChecks = 0;
    store.acquireStoreLock = async () => ({
      token: DISPATCH_A,
      async assertOwned() {
        ownershipChecks += 1;
        if (ownershipChecks > 1) throw new Error("injected lock loss");
      },
      async release() {},
    });
    await assert.rejects(
      store.createSchedule({
        scheduleId: "release",
        target: OWNER_SELECTOR,
        steps: [{ stepId: "verify", prompt: "Verify" }],
      }),
      /injected lock loss/,
    );
    await assert.rejects(lstat(join(store.schedulesDir, "release.json")), /ENOENT/);
  } finally {
    store.acquireStoreLock = acquire;
    await rm(root, { recursive: true, force: true });
  }
});

test("lock release is owner-checked and cannot remove a replacement owner", async () => {
  const { root, store } = await temporaryStore({ lockHeartbeatMs: 60_000 });
  try {
    const lock = await store.acquireStoreLock();
    const oldPath = `${store.lockPath}.old`;
    await rename(store.lockPath, oldPath);
    await mkdir(store.lockPath, { recursive: true });
    const replacementToken = randomUUID();
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      version: 1,
      type: "flow-schedule-lock",
      token: replacementToken,
      pid: process.pid,
      processIdentity: `test-process:${process.pid}`,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
    })}\n`, "utf8");

    await lock.release();
    assert.equal(JSON.parse(await readFile(store.lockOwnerPath, "utf8")).token, replacementToken);
    await rm(store.lockPath, { recursive: true, force: true });
    await rm(oldPath, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale lock recovery reclaims dead owners but preserves a matching live process identity", async () => {
  const dead = await temporaryStore({
    now: () => 1_000,
    lockStaleMs: 10,
    lockRetryMs: 1,
    lockTimeoutMs: 100,
    isProcessAlive: () => false,
    getProcessIdentity: () => "test-process:contender",
  });
  try {
    await dead.store.initialize();
    await mkdir(dead.store.lockPath, { recursive: true });
    await writeFile(dead.store.lockOwnerPath, `${JSON.stringify({
      version: 1,
      type: "flow-schedule-lock",
      token: DISPATCH_A,
      pid: 42424,
      processIdentity: "test-process:dead",
      createdAt: 0,
      heartbeatAt: 0,
    })}\n`, "utf8");
    const acquired = await dead.store.acquireStoreLock();
    assert.notEqual(acquired.token, DISPATCH_A);
    await acquired.release();
  } finally {
    await rm(dead.root, { recursive: true, force: true });
  }

  const live = await temporaryStore({
    now: () => 1_000,
    lockStaleMs: 10,
    lockRetryMs: 1,
    lockTimeoutMs: 1,
    isProcessAlive: () => true,
    getProcessIdentity: (pid) => pid === 42424 ? "test-process:birth-a" : "test-process:contender",
  });
  try {
    await live.store.initialize();
    await mkdir(live.store.lockPath, { recursive: true });
    await writeFile(live.store.lockOwnerPath, `${JSON.stringify({
      version: 1,
      type: "flow-schedule-lock",
      token: DISPATCH_A,
      pid: 42424,
      processIdentity: "test-process:birth-a",
      createdAt: 0,
      heartbeatAt: 0,
    })}\n`, "utf8");
    await assert.rejects(live.store.acquireStoreLock(), /Timed out waiting/);
    assert.equal(JSON.parse(await readFile(live.store.lockOwnerPath, "utf8")).token, DISPATCH_A);
  } finally {
    await rm(live.root, { recursive: true, force: true });
  }
});

test("terminal GC is owner-gated, bounded, contained, and preserves legacy data", async () => {
  let now = 1;
  const { root, projectRoot, store } = await temporaryStore({ now: () => now });
  try {
    const legacyDir = join(projectRoot, ".pi", "flow-track");
    const legacyFile = join(legacyDir, "record.json");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyFile, "legacy bytes", "utf8");

    for (const scheduleId of ["old-a", "old-b", "old-c"]) {
      await store.createSchedule({
        scheduleId,
        target: OWNER_SELECTOR,
        steps: [{ stepId: "done", prompt: "Done" }],
      });
      await store.updateSchedule(scheduleId, (schedule) => ({
        ...schedule,
        state: "cancelled",
        reason: "GC fixture",
        steps: { ...schedule.steps, done: { ...schedule.steps.done, state: "cancelled" } },
      }));
    }
    now = FLOW_SCHEDULE_LIMITS.terminalRetentionMs + 100;
    const first = await store.collectGarbage({ maxSchedules: 2 });
    assert.equal(first.deletedScheduleIds.length, 2);
    assert.equal((await store.listSchedules()).length, 1);
    assert.equal(await readFile(legacyFile, "utf8"), "legacy bytes");
    assert.deepEqual(await store.detectLegacyFlowTrack(), {
      present: true,
      path: store.legacyPath,
      kind: "directory",
    });
    assert.equal((await lstat(store.ownerPath)).isFile(), true);

    await assert.rejects(
      store.collectGarbage({ maxSchedules: FLOW_SCHEDULE_LIMITS.maxGcSchedulesPerRun + 1 }),
      /cannot exceed/,
    );

    const marker = JSON.parse(await readFile(store.ownerPath, "utf8"));
    await writeFile(store.ownerPath, `${JSON.stringify({ ...marker, storageRoot: join(root, "outside") })}\n`, "utf8");
    await assert.rejects(store.collectGarbage({ retentionMs: 0 }), FlowScheduleCorruptionError);
    assert.equal((await readdir(store.schedulesDir)).length, 1);
    assert.equal(await readFile(legacyFile, "utf8"), "legacy bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createDispatchForBinding(store: FlowScheduleStore, dispatchId: string, scheduleId = "release", stepId = "build"): Promise<void> {
  await store.createSchedule({
    scheduleId,
    target: OWNER_SELECTOR,
    steps: [{ stepId, prompt: `Run ${stepId}` }],
  });
  await store.updateSchedule(scheduleId, (schedule) => ({ ...schedule, state: "active" }));
  await store.createDispatchIntent({
    dispatchId,
    scheduleId,
    stepId,
    targetIdentity: identity,
  });
}

function bindingRecord(dispatchId: string, overrides: Partial<FlowScheduleTodoBinding> = {}): FlowScheduleTodoBinding {
  return {
    version: FLOW_SCHEDULE_VERSION,
    type: "flow-schedule-binding",
    dispatchId,
    scheduleId: "release",
    stepId: "build",
    state: "pending",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  } satisfies FlowScheduleTodoBinding as FlowScheduleTodoBinding;
}

test("FlowScheduleStore records and reads an optional todo binding keyed by dispatchId", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    assert.equal(await store.readBinding(DISPATCH_A), undefined);
    const pending = await store.recordBinding(bindingRecord(DISPATCH_A));
    assert.equal(pending.state, "pending");
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore lists durable bindings in stable creation order", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await store.recordBinding(bindingRecord(DISPATCH_A, { createdAt: 100, updatedAt: 100 }));
    await store.recordCompletion({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "build",
      targetIdentity: identity,
      state: "completed",
      result: {
        version: FLOW_SCHEDULE_VERSION,
        type: FLOW_SCHEDULE_RESULT_TYPE,
        dispatchId: DISPATCH_A,
        scheduleId: "release",
        stepId: "build",
        outcome: "completed",
        summary: "Build passed",
        resources: [],
      },
      completedAt: 150,
    });
    await createDispatchForBinding(store, DISPATCH_B, "release-2", "verify");
    await store.recordBinding(bindingRecord(DISPATCH_B, {
      scheduleId: "release-2",
      stepId: "verify",
      createdAt: 200,
      updatedAt: 200,
    }));

    const bindings = await store.listBindings();
    assert.deepEqual(bindings.map((item) => item.dispatchId), [DISPATCH_A, DISPATCH_B]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion terminalizes binding only after exclusive completion validation", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await store.recordBinding(bindingRecord(DISPATCH_A));
    await store.recordCompletion({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "build",
      targetIdentity: identity,
      state: "retired",
      reason: "Schedule cancelled: operator",
      completedAt: 200,
    });
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "ambiguous");
    assert.equal((await store.readBinding(DISPATCH_A))?.reason, "Schedule cancelled: operator");

    await assert.rejects(store.recordCompletion({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: DISPATCH_A,
      scheduleId: "release",
      stepId: "build",
      targetIdentity: identity,
      state: "ambiguous",
      reason: "Conflicting completion",
      completedAt: 201,
    }), /already exists with different content/);
    assert.equal((await store.readBinding(DISPATCH_A))?.reason, "Schedule cancelled: operator");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore binding upsert is idempotent on identical content replay", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    const first = await store.recordBinding(bindingRecord(DISPATCH_A));
    const second = await store.recordBinding(bindingRecord(DISPATCH_A));
    assert.deepEqual(first, second);
    assert.deepEqual(await store.readBinding(DISPATCH_A), second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore binding progresses pending -> bound -> completed", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await store.recordBinding(bindingRecord(DISPATCH_A, { state: "pending" }));
    const bound = await store.recordBinding(bindingRecord(DISPATCH_A, { state: "bound", todoId: "todo-1", updatedAt: 200 }));
    assert.equal(bound.state, "bound");
    assert.equal(bound.todoId, "todo-1");
    const completed = await store.recordBinding(bindingRecord(DISPATCH_A, { state: "completed", todoId: "todo-1", todoStatus: "completed", updatedAt: 300 }));
    assert.equal(completed.state, "completed");
    assert.equal(completed.todoStatus, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore binding rejects divergent content at the same non-terminal state", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await store.recordBinding(bindingRecord(DISPATCH_A, { state: "pending" }));
    await assert.rejects(
      store.recordBinding(bindingRecord(DISPATCH_A, { state: "pending", updatedAt: 150 })),
      (error: unknown) => error instanceof FlowScheduleConflictError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore terminal binding state is immutable", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await store.recordBinding(bindingRecord(DISPATCH_A, { state: "completed", todoId: "todo-1", todoStatus: "completed", updatedAt: 200 }));
    await assert.rejects(
      store.recordBinding(bindingRecord(DISPATCH_A, { state: "failed", todoId: "todo-1", todoStatus: "failed", updatedAt: 300 })),
      (error: unknown) => error instanceof FlowScheduleConflictError,
    );
    assert.equal((await store.readBinding(DISPATCH_A))?.state, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore binding requires an existing dispatch intent", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await assert.rejects(store.recordBinding(bindingRecord(DISPATCH_A)), /Unknown Flow schedule dispatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FlowScheduleStore binding allows unbound ambiguity but requires a reason", async () => {
  const { root, store } = await temporaryStore({ now: () => 100 });
  try {
    await createDispatchForBinding(store, DISPATCH_A);
    await assert.rejects(
      store.recordBinding(bindingRecord(DISPATCH_A, { state: "ambiguous", todoId: "todo-1" })),
      /reason.*ambiguous/i,
    );
    const ambiguous = await store.recordBinding(bindingRecord(DISPATCH_A, { state: "ambiguous", reason: "Todo evidence timed out", updatedAt: 200 }));
    assert.equal(ambiguous.state, "ambiguous");
    assert.equal(ambiguous.todoId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
