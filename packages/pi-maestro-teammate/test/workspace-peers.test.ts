import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
  MAX_OWNER_AGENTS,
  MAX_OWNER_FILE_BYTES,
  WorkspaceTargetResolutionError,
  buildWorkspaceOwnerSnapshot,
  commandMailboxPath,
  consumeWorkspacePeerCommands,
  createWorkspacePeerCommandConsumer,
  createWorkspacePeerIdentity,
  createWorkspacePeerRuntime,
  defaultWorkspacePeerRoot,
  discoverWorkspacePeers,
  enqueueWorkspacePeerCommand,
  ensureWorkspacePeerDirectories,
  normalizeWorkspacePath,
  ownerSnapshotPath,
  publishWorkspaceOwner,
  requireRoutableWorkspaceTarget,
  resolveWorkspaceTarget,
  sendWorkspacePeerCommand,
  validateWorkspaceOwnerSnapshot,
  validateWorkspacePeerCommand,
  waitForWorkspacePeerCommandResponse,
  workspaceIdForCwd,
  writePrivateJsonAtomic,
  type WorkspaceAgentSnapshot,
  type WorkspaceOwnerSnapshot,
  type WorkspaceOwnerState,
  type WorkspaceResolvedTarget,
} from "../src/extension/workspace-peers.ts";

const OWNER_A = "a".repeat(32);
const NONCE_A = "1".repeat(32);
const OWNER_B = "b".repeat(32);
const NONCE_B = "2".repeat(32);
const OWNER_C = "c".repeat(32);
const NONCE_C = "3".repeat(32);
const COMMAND_ID = "d".repeat(32);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryWorkspace(): Promise<{ cwd: string; rootDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "workspace-peers-"));
  temporaryDirectories.push(base);
  const cwd = join(base, "project");
  const rootDir = join(base, "runtime");
  await mkdir(cwd, { recursive: true });
  return { cwd, rootDir };
}

function agent(correlationId: string, name?: string, summary?: string): WorkspaceAgentSnapshot {
  return {
    correlationId,
    ...(name ? { name } : {}),
    agent: "general",
    status: "running",
    startedAt: 100,
    lastActivityAt: 200,
    ...(summary ? { summary } : {}),
    wakeable: true,
  };
}

function state(...agents: WorkspaceAgentSnapshot[]): WorkspaceOwnerState {
  return { agents, settled: [] };
}

function remoteSnapshot(
  identity: ReturnType<typeof createWorkspacePeerIdentity>,
  agents: WorkspaceAgentSnapshot[],
): WorkspaceOwnerSnapshot {
  return buildWorkspaceOwnerSnapshot(identity, { agents, settled: [] }, Date.now());
}

function remoteTarget(
  owner: ReturnType<typeof createWorkspacePeerIdentity>,
  targetAgent = agent("remote-cid-0001", "remote"),
): WorkspaceResolvedTarget {
  return {
    scope: "remote",
    ownerId: owner.ownerId,
    ownerNonce: owner.ownerNonce,
    state: "active",
    agent: targetAgent,
  };
}

test("workspace identity is normalized, hashed, and isolated by cwd", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const equivalent = join(cwd, "nested", "..");
  assert.equal(normalizeWorkspacePath(equivalent), normalizeWorkspacePath(cwd));
  assert.equal(workspaceIdForCwd(equivalent), workspaceIdForCwd(cwd));
  assert.match(workspaceIdForCwd(cwd), /^[a-f0-9]{64}$/);
  assert.ok(defaultWorkspacePeerRoot(cwd).endsWith(join(workspaceIdForCwd(cwd), "runtime")));

  const first = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const otherCwd = join(cwd, "other");
  await mkdir(otherCwd);
  const second = createWorkspacePeerIdentity(otherCwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  await publishWorkspaceOwner(first, state(agent("cid-first", "first")), 1_000);

  const discovery = await discoverWorkspacePeers(second, { now: 1_000, includeSelf: true });
  assert.deepEqual(discovery.peers, [], "a file from another workspace identity is never trusted");
  assert.deepEqual(discovery.corruptFiles, [`${OWNER_A}.json`]);
});

test("owner files are private where mode bits are supported", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows ACLs are not represented by POSIX mode bits");
    return;
  }
  const { cwd, rootDir } = await temporaryWorkspace();
  const identity = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  await publishWorkspaceOwner(identity, state(agent("cid-private")));
  assert.equal((await stat(rootDir)).mode & 0o777, 0o700);
  assert.equal((await stat(ownerSnapshotPath(identity))).mode & 0o777, 0o600);
});

test("corrupt, oversized, symlink, and invalid snapshots are ignored", async (t) => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const identity = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  await ensureWorkspacePeerDirectories(identity);
  await writeFile(join(identity.paths.ownersDir, `${OWNER_B}.json`), "{broken", "utf8");
  await writeFile(join(identity.paths.ownersDir, `${OWNER_C}.json`), Buffer.alloc(MAX_OWNER_FILE_BYTES + 1));
  await writeFile(join(identity.paths.ownersDir, "../../escape.json"), "{}", "utf8").catch(() => undefined);

  const discovery = await discoverWorkspacePeers(identity, { includeSelf: true });
  assert.deepEqual(discovery.peers, []);
  assert.deepEqual(discovery.corruptFiles.sort(), [`${OWNER_B}.json`, `${OWNER_C}.json`]);

  const tooMany = Array.from({ length: MAX_OWNER_AGENTS + 1 }, (_, index) => agent(`cid-${index}`));
  assert.throws(() => buildWorkspaceOwnerSnapshot(identity, { agents: tooMany }), /invalid|bounds/);
  const raw = buildWorkspaceOwnerSnapshot(identity, state(agent("cid-valid")));
  assert.equal(validateWorkspaceOwnerSnapshot({ ...raw, normalizedCwd: `${raw.normalizedCwd}-forged` }), undefined);
  assert.equal(validateWorkspaceOwnerSnapshot({ ...raw, ownerNonce: "../outside" }), undefined);
  assert.equal(validateWorkspaceOwnerSnapshot({ ...raw, agents: [{ ...raw.agents[0], summary: "bad\u0000text" }] }), undefined);

  if (process.platform !== "win32") {
    const { symlink } = await import("node:fs/promises");
    const target = join(rootDir, "target.json");
    await writeFile(target, JSON.stringify(raw));
    const link = join(identity.paths.ownersDir, `${"e".repeat(32)}.json`);
    await symlink(target, link);
    const linked = await discoverWorkspacePeers(identity, { includeSelf: true });
    assert.equal(linked.peers.length, 0);
  } else {
    t.diagnostic("symlink case skipped on Windows");
  }
});

test("concurrent publishers retain separate per-owner files", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const first = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const second = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  await Promise.all([
    publishWorkspaceOwner(first, state(agent("cid-a", "alpha")), 5_000),
    publishWorkspaceOwner(second, state(agent("cid-b", "beta")), 5_000),
  ]);

  const discovery = await discoverWorkspacePeers(first, { now: 5_000, includeSelf: true });
  assert.deepEqual(discovery.peers.map((peer) => peer.ownerId).sort(), [OWNER_A, OWNER_B]);
  assert.equal(JSON.parse(await readFile(ownerSnapshotPath(first), "utf8")).agents[0].name, "alpha");
  assert.equal(JSON.parse(await readFile(ownerSnapshotPath(second), "utf8")).agents[0].name, "beta");
});

test("stale and implausibly future owners are filtered and stale files can be cleaned", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const local = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const stale = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const future = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_C, ownerNonce: NONCE_C });
  await publishWorkspaceOwner(stale, state(agent("cid-stale")), 1_000);
  await publishWorkspaceOwner(future, state(agent("cid-future")), 100_000);

  const discovery = await discoverWorkspacePeers(local, { now: 10_000, staleAfterMs: 2_000, cleanupStale: true });
  assert.deepEqual(discovery.peers, []);
  assert.deepEqual(discovery.staleOwnerIds.sort(), [OWNER_B, OWNER_C]);
  await assert.rejects(readFile(ownerSnapshotPath(stale)), { code: "ENOENT" });
  await assert.rejects(readFile(ownerSnapshotPath(future)), { code: "ENOENT" });
});

test("global target resolution supports exact ids, names, name#prefix, and unique prefixes", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const local = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const remote = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const localState = state(agent("cid-local-1111", "builder"));
  const peers = [remoteSnapshot(remote, [agent("cid-remote-2222", "reviewer")])];

  assert.equal(resolveWorkspaceTarget("cid-local-1111", local, localState, peers).scope, "local");
  assert.equal(resolveWorkspaceTarget("@reviewer", local, localState, peers).agent.correlationId, "cid-remote-2222");
  assert.equal(resolveWorkspaceTarget("reviewer#cid-rem", local, localState, peers).scope, "remote");
  assert.equal(resolveWorkspaceTarget("cid-loc", local, localState, peers).agent.name, "builder");
  assert.throws(
    () => resolveWorkspaceTarget("missing", local, localState, peers),
    (error) => error instanceof WorkspaceTargetResolutionError && error.code === "not_found",
  );
});

test("global resolution reports duplicate names and prefixes as ambiguous", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const local = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const remote = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const localState = state(agent("shared-prefix-a", "same"));
  const peers = [remoteSnapshot(remote, [agent("shared-prefix-b", "same")])];

  for (const target of ["same", "shared-prefix-"]) {
    assert.throws(
      () => resolveWorkspaceTarget(target, local, localState, peers),
      (error) => error instanceof WorkspaceTargetResolutionError
        && error.code === "ambiguous"
        && error.candidates.length === 2,
    );
  }
  assert.equal(resolveWorkspaceTarget("same#shared-prefix-b", local, localState, peers).scope, "remote");
});

test("settled tombstones remain discoverable but are not command-routable", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const local = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const target = resolveWorkspaceTarget("done", local, {
    agents: [],
    settled: [{ correlationId: "cid-done", name: "done", agent: "general", status: "completed", settledAt: 500 }],
  }, []);
  assert.equal(target.state, "settled");
  assert.throws(
    () => requireRoutableWorkspaceTarget(target),
    (error) => error instanceof WorkspaceTargetResolutionError && error.code === "not_routable",
  );
});

test("publisher coalesces dirty writes, heartbeats, and removes its owner file on stop", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  let current = state(agent("cid-runtime", "runtime", "first"));
  const runtime = createWorkspacePeerRuntime({
    cwd,
    rootDir,
    ownerId: OWNER_A,
    ownerNonce: NONCE_A,
    heartbeatMs: 30,
    publishThrottleMs: 15,
    getState: () => current,
  });
  await runtime.start();
  current = state(agent("cid-runtime", "runtime", "second"));
  runtime.markDirty();
  runtime.markDirty();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 45));
  const snapshot = JSON.parse(await readFile(ownerSnapshotPath(runtime.identity), "utf8"));
  assert.equal(snapshot.agents[0].summary, "second");
  await runtime.stop();
  await assert.rejects(readFile(ownerSnapshotPath(runtime.identity)), { code: "ENOENT" });
});

test("remote commands receive an acknowledgement and expose only the action whitelist", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const receiver = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const received: string[] = [];
  const consumer = createWorkspacePeerCommandConsumer(receiver, (command) => {
    received.push(`${command.action}:${command.message}`);
    return { status: "accepted", message: "queued" };
  }, { pollMs: 5 });
  consumer.start();
  try {
    const result = await sendWorkspacePeerCommand(sender, remoteTarget(receiver), "steer", "change direction", {
      timeoutMs: 1_000,
      pollMs: 5,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.response?.status, "accepted");
    assert.equal(result.response?.message, "queued");
    assert.deepEqual(received, ["steer:change direction"]);
  } finally {
    await consumer.stop();
  }

  assert.equal(validateWorkspacePeerCommand({
    version: 1,
    kind: "command",
    workspaceId: sender.workspaceId,
    commandId: COMMAND_ID,
    fromOwnerId: OWNER_A,
    fromOwnerNonce: NONCE_A,
    toOwnerId: OWNER_B,
    toOwnerNonce: NONCE_B,
    targetCorrelationId: "remote-cid-0001",
    action: "abort",
    message: "not allowed",
    createdAt: 1,
    expiresAt: 2,
  }), undefined);
});

test("owner nonce changes return an explicit rejection instead of timing out", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const oldReceiver = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const restartedReceiver = createWorkspacePeerIdentity(cwd, {
    rootDir,
    ownerId: OWNER_B,
    ownerNonce: NONCE_C,
  });
  const command = await enqueueWorkspacePeerCommand(
    sender,
    remoteTarget(oldReceiver),
    "steer",
    "stale destination",
    { commandId: COMMAND_ID, now: 1_000, ttlMs: 5_000 },
  );

  await consumeWorkspacePeerCommands(restartedReceiver, () => {
    assert.fail("a command for the previous owner nonce must not execute");
  }, { now: 2_000 });

  const response = await waitForWorkspacePeerCommandResponse(sender, command, { timeoutMs: 100, pollMs: 5 });
  assert.equal(response?.status, "rejected");
  assert.equal(response?.fromOwnerNonce, NONCE_C);
  assert.match(response?.message ?? "", /owner instance has changed/);
});

test("command waits time out without hiding the queued command", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const receiver = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const result = await sendWorkspacePeerCommand(sender, remoteTarget(receiver), "follow_up", "later", {
    timeoutMs: 25,
    pollMs: 5,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.response, undefined);
  assert.equal((await stat(join(commandMailboxPath(sender, OWNER_B), `${result.command.commandId}.json`))).isFile(), true);
});

test("persistent response acknowledgements make replayed command consumption idempotent", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  const receiver = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B });
  const command = await enqueueWorkspacePeerCommand(
    sender,
    remoteTarget(receiver),
    "follow_up",
    "run once",
    { commandId: COMMAND_ID, now: 1_000, ttlMs: 5_000 },
  );
  let handled = 0;
  const first = await consumeWorkspacePeerCommands(receiver, () => {
    handled += 1;
  }, { now: 2_000 });
  assert.equal(first[0]?.replayed, false);
  assert.equal(first[0]?.response.status, "accepted");

  await writePrivateJsonAtomic(
    join(commandMailboxPath(sender, OWNER_B), `${COMMAND_ID}.json`),
    command,
    96 * 1024,
  );
  const replay = await consumeWorkspacePeerCommands(receiver, () => {
    handled += 1;
  }, { now: 2_100 });
  assert.equal(replay[0]?.replayed, true);
  assert.equal(handled, 1, "the handler is not invoked for a command with a durable acknowledgement");
});

test("protocol ids and generated mailbox paths reject traversal", async () => {
  const { cwd, rootDir } = await temporaryWorkspace();
  assert.throws(
    () => createWorkspacePeerIdentity(cwd, { rootDir, ownerId: "../outside", ownerNonce: NONCE_A }),
    /ownerId/,
  );
  const sender = createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_A, ownerNonce: NONCE_A });
  assert.throws(() => ownerSnapshotPath(sender, "../outside"), /ownerId/);
  assert.throws(() => commandMailboxPath(sender, "f".repeat(31) + "/"), /ownerId/);

  const unsafeTarget = {
    ...remoteTarget(createWorkspacePeerIdentity(cwd, { rootDir, ownerId: OWNER_B, ownerNonce: NONCE_B })),
    ownerId: "../outside",
  };
  await assert.rejects(
    enqueueWorkspacePeerCommand(sender, unsafeTarget, "steer", "safe payload"),
    /toOwnerId|ownerId|validation/,
  );

  if (process.platform !== "win32") {
    const { symlink } = await import("node:fs/promises");
    await ensureWorkspacePeerDirectories(sender);
    const receiverMailbox = commandMailboxPath(sender, OWNER_B);
    const outside = join(rootDir, "outside-mailbox");
    await mkdir(outside);
    await symlink(outside, receiverMailbox, "dir");
    await assert.rejects(
      enqueueWorkspacePeerCommand(sender, remoteTarget(createWorkspacePeerIdentity(cwd, {
        rootDir,
        ownerId: OWNER_B,
        ownerNonce: NONCE_B,
      })), "steer", "must not follow the link"),
      /not a private real directory/,
    );
  }
});
