import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { FileService } from "../src/gateway/services/file-service.ts";
import { ExecService } from "../src/gateway/services/exec-service.ts";
import { HostService } from "../src/gateway/services/host-service.ts";
import { JobService } from "../src/gateway/services/job-service.ts";

const principal = (workspace: string) => createGatewayPrincipal("stdio", "gateway-test", {
  authenticated: true,
  workspacePath: workspace,
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for Gateway service state");
}

function nodeArgs(source: string): string[] {
  return ["-e", source];
}

test("host service describes and probes only the local Gateway host", () => {
  const service = new HostService();
  const described = service.describe();
  assert.equal(described.ok, true);
  assert.equal(described.data?.service, "gateway");
  assert.equal(typeof described.data?.platform, "string");
  assert.equal(service.status().ok, true);
  const probe = service.test();
  assert.equal(probe.ok, true);
  assert.equal(probe.data?.reachable, true);
});

test("exec service enforces argv policy, workspace bounds, output caps, and cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-exec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const testPrincipal = principal(root);
  const policy = new GatewayPolicy({ workspaceRoot: root, limits: { maxOutputBytes: 256, maxExecTimeoutMs: 10_000 } });
  const service = new ExecService({ policy, workspaceRoot: root, principal: testPrincipal });

  const success = await service.run({ command: process.execPath, args: nodeArgs("process.stdout.write('ok')"), cwd: root });
  assert.equal(success.ok, true);
  assert.equal(success.data?.stdout, "ok");
  assert.equal(success.data?.exitCode, 0);

  const denied = await new ExecService({ policy, workspaceRoot: root, principal: testPrincipal, commandPolicy: { default: "deny" } }).run({
    command: process.execPath,
    args: nodeArgs(""),
    cwd: root,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "command_denied");

  const limited = await service.run({ command: process.execPath, args: nodeArgs("process.stdout.write('x'.repeat(2_000))"), cwd: root, maxOutputBytes: 64 });
  assert.equal(limited.ok, false);
  assert.equal(limited.error?.code, "output_limit");
  assert.equal(limited.data?.outputTruncated, true);
  assert.ok((limited.data?.stdout.length ?? 0) <= 64);

  const escaped = await service.run({ command: process.execPath, args: nodeArgs(""), cwd: join(root, "..") });
  assert.equal(escaped.ok, false);
  assert.ok(["policy_denied", "not_found"].includes(escaped.error?.code ?? ""));

  const controller = new AbortController();
  const pending = service.run({ command: process.execPath, args: nodeArgs("setInterval(() => {}, 1000)"), cwd: root, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.status, "cancelled");
});

test("job service exposes terminal states, cursor logs, stdin, and idempotent cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const testPrincipal = principal(root);
  const policy = new GatewayPolicy({ workspaceRoot: root, limits: { maxOutputBytes: 256, maxExecTimeoutMs: 10_000, maxConcurrentJobs: 1 } });
  const service = new JobService({ policy, workspaceRoot: root, principal: testPrincipal });

  const started = await service.start({ command: process.execPath, args: nodeArgs("process.stdout.write('out'); process.stderr.write('err')"), cwd: root });
  assert.equal(started.ok, true);
  assert.equal(started.status, "accepted");
  const id = started.data!.job.id;
  await waitFor(async () => (await service.status({ id })).data?.job.status === "completed");
  const completed = await service.status({ id });
  assert.equal(completed.data?.job.status, "completed");
  const logs = await service.logs({ id, cursor: 0 });
  assert.equal(logs.ok, true);
  assert.deepEqual(logs.data?.entries.map((entry) => entry.data).join(""), "outerr");
  assert.ok((logs.data?.nextCursor ?? 0) > 0);
  const listed = await service.list();
  assert.equal(listed.data?.jobs.length, 1);
  const otherPrincipal = createGatewayPrincipal("stdio", "other-gateway-client", {
    authenticated: true,
    workspacePath: root,
  });
  assert.equal((await service.list({ principal: otherPrincipal })).data?.jobs.length, 0);
  assert.equal((await service.status({ id, principal: otherPrincipal })).error?.code, "not_found");

  const stdinJob = await service.start({ command: process.execPath, args: nodeArgs("process.stdin.once('data', d => { process.stdout.write(d); process.exit(0) })"), cwd: root });
  const stdinId = stdinJob.data!.job.id;
  await waitFor(async () => (await service.status({ id: stdinId })).data?.job.status === "running");
  assert.equal((await service.status({ id: stdinId })).status, "running", "status envelope must match the running resource");
  const sent = await service.stdin({ id: stdinId, data: "input" });
  assert.equal(sent.ok, true);
  await waitFor(async () => (await service.status({ id: stdinId })).data?.job.status === "completed");
  assert.equal((await service.status({ id: stdinId })).data?.job.stdout, "input");

  const cancellable = await service.start({ command: process.execPath, args: nodeArgs("setInterval(() => {}, 1000)"), cwd: root });
  const cancelId = cancellable.data!.job.id;
  await waitFor(async () => (await service.status({ id: cancelId })).data?.job.status === "running");
  const firstCancel = await service.cancel({ id: cancelId });
  assert.equal(firstCancel.ok, true);
  await waitFor(async () => (await service.status({ id: cancelId })).data?.job.status === "cancelled");
  const secondCancel = await service.cancel({ id: cancelId });
  assert.equal(secondCancel.ok, true);
  assert.equal(secondCancel.data?.cancelled, false);
  await service.shutdown();
});

test("job service restores terminal snapshots and fences interrupted snapshots as lost", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-job-restore-"));
  const jobsRoot = join(root, "jobs");
  t.after(() => rm(root, { recursive: true, force: true }));
  const testPrincipal = principal(root);
  const first = new JobService({ workspaceRoot: root, principal: testPrincipal, jobsRoot });
  const started = await first.start({ command: process.execPath, args: nodeArgs("process.stdout.write('saved')"), cwd: root });
  const completedId = started.data!.job.id;
  await waitFor(async () => (await first.status({ id: completedId })).data?.job.status === "completed");
  const restored = new JobService({ workspaceRoot: root, principal: testPrincipal, jobsRoot });
  assert.equal((await restored.status({ id: completedId })).data?.job.stdout, "saved");

  await writeFile(join(jobsRoot, "job-interrupted.json"), JSON.stringify({
    version: 1,
    id: "job-interrupted",
    status: "running",
    command: process.execPath,
    cwd: root,
    principalId: testPrincipal.id,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    stdout: "partial",
    stderr: "",
  }), "utf8");
  const restarted = new JobService({ workspaceRoot: root, principal: testPrincipal, jobsRoot });
  const lost = await restarted.status({ id: "job-interrupted" });
  assert.equal(lost.ok, false);
  assert.equal(lost.status, "lost");
  assert.equal(lost.data?.job.status, "lost");
});

test("job logs cap tiny output events independently from terminal output evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-job-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const testPrincipal = principal(root);
  const service = new JobService({ workspaceRoot: root, principal: testPrincipal, maxOutputBytes: 1024, maxLogEvents: 3 });
  const script = "let i=0; const t=setInterval(() => { process.stdout.write(String(i++)); if(i===10){clearInterval(t);}}, 10)";
  const started = await service.start({ command: process.execPath, args: nodeArgs(script), cwd: root });
  const id = started.data!.job.id;
  await waitFor(async () => (await service.status({ id })).data?.job.status === "completed");
  const logs = await service.logs({ id, cursor: 0 });
  assert.ok((logs.data?.entries.length ?? 0) <= 3);
  assert.equal(logs.data?.truncated, true, "an evicted cursor range must be reported as truncated");
  assert.equal((await service.status({ id })).data?.job.stdout, "0123456789", "terminal output survives log event eviction");
});

test("job retention prunes expired terminal jobs without deleting active work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-job-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100;
  const testPrincipal = principal(root);
  const service = new JobService({ workspaceRoot: root, principal: testPrincipal, retentionMs: 10, now: () => now });
  const completed = await service.start({ command: process.execPath, args: nodeArgs(""), cwd: root });
  const completedId = completed.data!.job.id;
  await waitFor(async () => (await service.status({ id: completedId })).data?.job.status === "completed");
  const active = await service.start({ command: process.execPath, args: nodeArgs("setInterval(() => {}, 1000)"), cwd: root });
  const activeId = active.data!.job.id;
  await waitFor(async () => (await service.status({ id: activeId })).data?.job.status === "running");
  now = 111;
  assert.equal((await service.status({ id: completedId })).error?.code, "not_found");
  assert.equal((await service.status({ id: activeId })).data?.job.status, "running");
  await service.cancel({ id: activeId });
});

test("file service keeps operations canonical, bounded, atomic, and hash-fenced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-file-"));
  const outside = await mkdtemp(join(tmpdir(), "gateway-file-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "a.txt"), "alpha\nbeta\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  const testPrincipal = principal(root);
  const policy = new GatewayPolicy({ workspaceRoot: root, limits: { maxFileReadBytes: 128, maxFileWriteBytes: 128, maxPatchFiles: 4 } });
  const service = new FileService({ policy, workspaceRoot: root, principal: testPrincipal });

  const read = await service.read({ workspace: root, path: "nested/a.txt" });
  assert.equal(read.ok, true);
  assert.equal(read.data?.content, "alpha\nbeta\n");
  assert.equal(read.data?.bytes, 11);
  const listed = await service.list({ workspace: root, path: "nested" });
  assert.equal(listed.data?.entries[0]?.name, "a.txt");
  const found = await service.find({ workspace: root, pattern: "*.txt" });
  assert.equal(found.ok, true);
  assert.equal(found.data?.matches.length, 1);
  const grepped = await service.grep({ workspace: root, query: "beta" });
  assert.equal(grepped.data?.matches[0]?.line, 2);

  const write = await service.write({ workspace: root, path: "new.txt", content: "before" });
  assert.equal(write.ok, true);
  const edited = await service.edit({ workspace: root, path: "new.txt", expectedSha256: write.data!.sha256, oldText: "before", newText: "after" });
  assert.equal(edited.ok, true);
  const conflict = await service.edit({ workspace: root, path: "new.txt", expectedSha256: write.data!.sha256, content: "stale" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, "hash_conflict");
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "after");

  const copied = await service.transfer({ workspace: root, source: "new.txt", destination: "copy.txt" });
  assert.equal(copied.ok, true);
  assert.equal(await readFile(join(root, "copy.txt"), "utf8"), "after");
  const traversal = await service.read({ workspace: root, path: "../gateway-file-outside/secret.txt" });
  assert.equal(traversal.ok, false);
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  const symlinkEscape = await service.read({ workspace: root, path: "escape.txt" });
  assert.equal(symlinkEscape.ok, false);
});
