import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDelegatedWorkerBootstrap,
  buildDelegationDelivery,
  buildDelegationPlannerPrompt,
  cancelDelegationDraft,
  createDelegationDraft,
  delegationDocumentPath,
  formatDelegationDocument,
  listDelegationRecords,
  loadDelegationRecord,
  MAX_DELEGATION_DOCUMENT_BYTES,
  parseDelegationCommand,
  parseDelegationTaskDraft,
  readDelegationDocument,
  updateDelegationRecord,
  type DelegationRecord,
  type DelegationSourceContext,
  type DelegationTaskDraft,
  type DelegationWorkerContext,
} from "../src/extension/task-delegation.ts";

function task(overrides: Partial<DelegationTaskDraft> = {}): DelegationTaskDraft {
  return {
    title: "Fix delegated cache invalidation",
    objective: "Correct the cache invalidation path without changing unrelated behavior.",
    context: "The current session traced stale reads to the package cache adapter.",
    deliverables: ["Implement the cache fix", "Add focused regression coverage"],
    acceptanceCriteria: ["Stale entries are not returned after invalidation"],
    constraints: ["Preserve unrelated worktree changes"],
    suggestedFiles: ["src/cache.ts", "test/cache.test.ts"],
    verification: ["Run the focused cache test file"],
    executionNotes: "Inspect the current implementation before editing.",
    ...overrides,
  };
}

function source(root: string): DelegationSourceContext {
  return {
    cwd: root,
    workspaceId: "a".repeat(64),
    sessionId: "source-session",
    sessionName: "source-window",
    sessionFile: join(root, "source.jsonl"),
  };
}

async function createDraft(
  root: string,
  now = 1_000,
  workerContext: DelegationWorkerContext = "fresh",
): Promise<DelegationRecord> {
  await writeFile(source(root).sessionFile, "{}\n", "utf8");
  return createDelegationDraft(root, {
    request: "Keep the current approach and also fix cache invalidation.",
    workerContext,
    source: source(root),
    task: task(),
    planner: {
      agent: "planner",
      correlationId: "planner-correlation",
      model: "provider/model",
      durationMs: 25,
    },
    now,
  });
}

async function markRecordSent(root: string, draft: DelegationRecord, startAt: number): Promise<DelegationRecord> {
  const sessionName = `mw-token-${draft.id}`;
  const confirmed = await updateDelegationRecord(root, draft.id, (record) => ({
    ...record,
    status: "confirmed",
    confirmedAt: startAt,
    updatedAt: startAt,
  }), { expectedRevision: draft.revision, expectedStatuses: ["draft"] });
  const spawning = await updateDelegationRecord(root, draft.id, (record) => ({
    ...record,
    status: "spawning",
    updatedAt: startAt + 1,
    launch: {
      name: draft.id,
      sessionName,
      presentation: "interactive",
      startedAt: startAt + 1,
    },
  }), { expectedRevision: confirmed.revision, expectedStatuses: ["confirmed"] });
  const dispatching = await updateDelegationRecord(root, draft.id, (record) => ({
    ...record,
    status: "dispatching",
    updatedAt: startAt + 2,
    dispatchMessageId: "f".repeat(32),
    window: {
      name: draft.id,
      sessionName,
      ownerId: "b".repeat(32),
      ownerNonce: "c".repeat(32),
      pid: 1234,
      presentation: "interactive",
      registeredAt: startAt + 2,
    },
  }), { expectedRevision: spawning.revision, expectedStatuses: ["spawning"] });
  return updateDelegationRecord(root, draft.id, (record) => ({
    ...record,
    status: "sent",
    updatedAt: startAt + 3,
    window: { ...record.window!, sentAt: startAt + 3 },
  }), { expectedRevision: dispatching.revision, expectedStatuses: ["dispatching"] });
}

test("delegate command accepts user instructions and reserves explicit lifecycle commands", () => {
  assert.deepEqual(parseDelegationCommand("add focused cache coverage"), {
    action: "create",
    request: "add focused cache coverage",
  });
  assert.deepEqual(parseDelegationCommand("create add focused cache coverage"), {
    action: "create",
    request: "add focused cache coverage",
  });
  assert.deepEqual(parseDelegationCommand("--new add focused cache coverage"), {
    action: "create",
    request: "add focused cache coverage",
    workerContext: "fresh",
  });
  assert.deepEqual(parseDelegationCommand("create --fork add focused cache coverage"), {
    action: "create",
    request: "add focused cache coverage",
    workerContext: "fork",
  });
  assert.deepEqual(parseDelegationCommand("list"), { action: "list" });
  assert.deepEqual(parseDelegationCommand("send dlg-task-deadbeef"), {
    action: "send",
    id: "dlg-task-deadbeef",
  });
  assert.equal(parseDelegationCommand("").action, "help");
  assert.deepEqual(parseDelegationCommand("help me repair the cache"), {
    action: "create",
    request: "help me repair the cache",
  });
  assert.deepEqual(parseDelegationCommand("list stale cache entries"), {
    action: "create",
    request: "list stale cache entries",
  });
  assert.deepEqual(parseDelegationCommand("stop leaking file handles"), {
    action: "create",
    request: "stop leaking file handles",
  });
  assert.deepEqual(parseDelegationCommand("send invalid"), {
    action: "create",
    request: "send invalid",
  });
  assert.equal(parseDelegationCommand("--fork --new conflicting").action, "invalid");
});

test("delegation task parser enforces required arrays, bounds, and additionalProperties=false", () => {
  assert.deepEqual(parseDelegationTaskDraft(task()), task());
  assert.throws(
    () => parseDelegationTaskDraft({ ...task(), unexpected: true }),
    /unexpected field/,
  );
  assert.throws(
    () => parseDelegationTaskDraft({ ...task(), verification: [] }),
    /requires at least 1/,
  );
  assert.throws(
    () => parseDelegationTaskDraft({ ...task(), title: "x".repeat(121) }),
    /exceeds 120/,
  );
});

test("planner, document, bootstrap, and delivery preserve additive user instruction semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-format-"));
  const record = await createDraft(root);
  const prompt = buildDelegationPlannerPrompt(record.request, record.source, record.workerContext);
  const document = formatDelegationDocument(record);
  const bootstrap = buildDelegatedWorkerBootstrap(record, "owner:source");
  const delivery = buildDelegationDelivery(record, document, "owner:source");
  const forkRecord: DelegationRecord = { ...record, workerContext: "fork" };
  const forkPrompt = buildDelegationPlannerPrompt(forkRecord.request, forkRecord.source, "fork");
  const forkBootstrap = buildDelegatedWorkerBootstrap(forkRecord, "owner:source");
  const forkDelivery = buildDelegationDelivery(forkRecord, formatDelegationDocument(forkRecord), "owner:source");

  assert.match(prompt, /forked conversation/);
  assert.match(prompt, /Target worker context: fresh/);
  assert.match(prompt, /The target starts fresh: make the task document self-contained/);
  assert.match(forkPrompt, /Target worker context: fork/);
  assert.match(prompt, /Preserve the user's delegation instruction/);
  assert.match(prompt, /Keep the current approach and also fix cache invalidation/);
  assert.match(document, /Worker context: `fresh`/);
  assert.match(document, /## Delegation Instruction/);
  assert.match(document, /Keep the current approach and also fix cache invalidation/);
  assert.match(bootstrap, /fresh worker session/);
  assert.match(bootstrap, /Do not continue any inherited task/);
  assert.match(forkBootstrap, /forked from the source session/);
  assert.match(delivery, /self-contained document in the fresh worker session/);
  assert.match(forkDelivery, /additive assignment on top of compatible inherited conversation/);
  assert.match(delivery, /Send progress blockers and the final result to owner:source/);
  assert.ok(delivery.endsWith(document));
});

test("worker context persists and legacy records default to fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-worker-context-"));
  const forkDraft = await createDraft(root, 1_000, "fork");
  assert.equal((await loadDelegationRecord(root, forkDraft.id)).workerContext, "fork");

  const recordPath = join(root, ".pi", "delegations", forkDraft.id, "record.json");
  const legacy = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  delete legacy.workerContext;
  await writeFile(recordPath, `${JSON.stringify(legacy)}\n`, "utf8");
  assert.equal((await loadDelegationRecord(root, forkDraft.id)).workerContext, "fresh");
});

test("delegation records persist editable documents and valid state transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-state-"));
  const draft = await createDraft(root);
  assert.equal(draft.status, "draft");
  assert.equal(draft.revision, 0);
  assert.equal((await listDelegationRecords(root)).length, 1);
  assert.match(await readDelegationDocument(root, draft.id), /## Delegation Instruction/);

  await writeFile(delegationDocumentPath(root, draft.id), "# Reviewed task\n\nUser-approved edit.\n", "utf8");
  assert.match(await readDelegationDocument(root, draft.id), /User-approved edit/);

  const sent = await markRecordSent(root, draft, 2_000);
  assert.equal(sent.status, "sent");
  assert.equal(sent.revision, 4);
  assert.equal(sent.window?.pid, 1234);

  const closed = await updateDelegationRecord(root, draft.id, (record) => ({
    ...record,
    status: "closed",
    closedAt: 3_000,
    updatedAt: 3_000,
  }), { expectedRevision: sent.revision, expectedStatuses: ["sent"] });
  assert.equal(closed.status, "closed");
  assert.equal((await loadDelegationRecord(root, draft.id)).closedAt, 3_000);
});

test("cancelling preserves the task document and rejects sent records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-cancel-"));
  const draft = await createDraft(root);
  const cancelled = await cancelDelegationDraft(root, draft.id, 2_000);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledAt, 2_000);
  assert.match(await readDelegationDocument(root, draft.id), /Fix delegated cache invalidation/);

  const second = await createDraft(root, 3_000);
  await markRecordSent(root, second, 4_000);
  await assert.rejects(cancelDelegationDraft(root, second.id), /must be stopped/);
});

test("delegation storage rejects redirected roots, document symlinks, and oversized documents", async (t) => {
  const redirectedRoot = await mkdtemp(join(tmpdir(), "pi-delegation-root-link-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-delegation-outside-"));
  await mkdir(join(redirectedRoot, ".pi"), { recursive: true });
  let redirected = false;
  try {
    await symlink(outside, join(redirectedRoot, ".pi", "delegations"), "junction");
    redirected = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("directory symlink case skipped: platform denied symlink creation");
    } else {
      throw error;
    }
  }
  if (redirected) await assert.rejects(createDraft(redirectedRoot), /non-symlink directory/);

  const root = await mkdtemp(join(tmpdir(), "pi-delegation-document-link-"));
  const draft = await createDraft(root);
  const documentPath = delegationDocumentPath(root, draft.id);
  const outsideDocument = join(outside, "outside-task.md");
  await writeFile(outsideDocument, "# outside\n", "utf8");
  await rm(documentPath);
  try {
    await symlink(outsideDocument, documentPath, "file");
    await assert.rejects(readDelegationDocument(root, draft.id), /regular non-symlink file/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("file symlink case skipped: platform denied symlink creation");
    } else {
      throw error;
    }
  }

  await rm(documentPath, { force: true });
  await writeFile(documentPath, "x".repeat(MAX_DELEGATION_DOCUMENT_BYTES + 1), "utf8");
  await assert.rejects(readDelegationDocument(root, draft.id), /exceeds 49152 bytes/);
});

test("record revision and cross-process lock reject concurrent transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-concurrency-"));
  const draft = await createDraft(root);
  const confirmations = await Promise.allSettled([
    updateDelegationRecord(root, draft.id, (record) => ({
      ...record,
      status: "confirmed",
      confirmedAt: 2_000,
      updatedAt: 2_000,
    }), { expectedRevision: 0, expectedStatuses: ["draft"] }),
    updateDelegationRecord(root, draft.id, (record) => ({
      ...record,
      status: "confirmed",
      confirmedAt: 2_001,
      updatedAt: 2_001,
    }), { expectedRevision: 0, expectedStatuses: ["draft"] }),
  ]);
  assert.equal(confirmations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(confirmations.filter((result) => result.status === "rejected").length, 1);

  const confirmed = await loadDelegationRecord(root, draft.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.revision, 1);
  const competing = await Promise.allSettled([
    updateDelegationRecord(root, draft.id, (record) => ({
      ...record,
      status: "spawning",
      updatedAt: 3_000,
      launch: {
        name: draft.id,
        sessionName: `mw-token-${draft.id}`,
        presentation: "interactive",
        startedAt: 3_000,
      },
    }), { expectedRevision: confirmed.revision, expectedStatuses: ["confirmed"] }),
    cancelDelegationDraft(root, draft.id, 3_001),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
  const settled = await loadDelegationRecord(root, draft.id);
  assert.equal(settled.revision, 2);
  assert.ok(settled.status === "spawning" || settled.status === "cancelled");
});

test("loaded record id must match its delegation directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-id-mismatch-"));
  const first = await createDraft(root, 1_000);
  const second = await createDraft(root, 2_000);
  const firstRecord = join(root, ".pi", "delegations", first.id, "record.json");
  const secondRecord = join(root, ".pi", "delegations", second.id, "record.json");
  await writeFile(firstRecord, await readFile(secondRecord));
  await assert.rejects(loadDelegationRecord(root, first.id), /does not match directory/);
});

test("tampered delegation records fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-tamper-"));
  const draft = await createDraft(root);
  const recordPath = join(root, ".pi", "delegations", draft.id, "record.json");
  const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  parsed.status = "sent";
  await writeFile(recordPath, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(loadDelegationRecord(root, draft.id), /requires confirmedAt|requires a window receipt/);
});

test("delegate command wiring keeps fork, confirmation, additive injection, and rollback boundaries", async () => {
  const sourceText = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const delegationText = await readFile(new URL("../src/extension/task-delegation.ts", import.meta.url), "utf8");
  const gitignore = await readFile(new URL("../../../.gitignore", import.meta.url), "utf8");

  assert.equal(sourceText.match(/pi\.registerCommand\("delegate"/g)?.length, 1);
  assert.match(sourceText, /agent: "planner",[\s\S]*?context: "fork"[\s\S]*?outputSchema: DELEGATION_TASK_SCHEMA/);
  assert.match(sourceText, /parentSessionFile: forkSessionFile/);
  assert.match(sourceText, /spawning\.workerContext === "fork"/);
  assert.match(sourceText, /workerForkSessionFile = canonicalDelegationForkSource/);
  assert.match(sourceText, /sessionName,[\s\S]*?workerForkSessionFile,[\s\S]*?"delegation"/);
  assert.match(sourceText, /ctx\.ui\.select\([\s\S]*?Delegation worker context/);
  assert.match(sourceText, /command\.workerContext \?\? await selectDelegationWorkerContext\(ctx\)/);
  assert.match(sourceText, /Delegation cancelled before drafting/);
  assert.match(sourceText, /onProgress\(progress\)/);
  assert.match(sourceText, /delegationPlannerProgressText\(progress, workerContext\)/);
  assert.match(sourceText, /ctx\.ui\.setStatus\(progressKey, undefined\)/);
  assert.match(sourceText, /ctx\.ui\.confirm\(/);
  assert.match(sourceText, /return confirmed \? document : undefined/);
  assert.match(sourceText, /if \(confirmedDocument === undefined\)[\s\S]*?dispatchDelegation\(record, confirmedDocument, ctx\)/);
  assert.match(sourceText, /forkArgs = forkSessionFile \? \["--fork", forkSessionFile\] : \[\]/);
  assert.match(sourceText, /buildDelegationDelivery\(dispatching, confirmedDocument, replyTo\)/);
  assert.match(sourceText, /messageId: dispatchMessageId/);
  assert.match(sourceText, /commandId: request\.messageId/);
  assert.match(sourceText, /publicationStage === "accepted"/);
  assert.match(sourceText, /status: "dispatching"[\s\S]*?dispatchMessageId/);
  assert.match(sourceText, /status: "delivery_unknown"/);
  assert.match(sourceText, /rollbackDelegationWindow\(dispatching, root, failure\)/);
  assert.match(sourceText, /owner\.ownerNonce === record\.window!\.ownerNonce[\s\S]*?owner\.pid === record\.window!\.pid/);
  assert.match(delegationText, /acquireDelegationLock/);
  assert.match(delegationText, /expectedRevision/);
  assert.match(delegationText, /Buffer\.alloc\(maxBytes \+ 1\)/);
  assert.match(delegationText, /record\.id !== id/);
  assert.match(delegationText, /before\.dev !== after\.dev/);
  assert.match(delegationText, /workerContext: input\.workerContext \?\? "fresh"/);
  assert.match(delegationText, /Target worker context:/);
  assert.match(delegationText, /## Delegation Instruction/);
  assert.match(delegationText, /additive assignment on top of compatible inherited/);
  assert.match(gitignore, /^\.pi\/delegations\/$/m);
});
