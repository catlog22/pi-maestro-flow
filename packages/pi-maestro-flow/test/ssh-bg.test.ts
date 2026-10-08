import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Value } from "typebox/value";
import {
  SshBgManager,
  SshBgParams,
  type SshBgCompletion,
  type SshBgResolvedTarget,
  type SshBgSnapshotPayload,
} from "../src/ssh-manager/ssh-bg.ts";
import type { SshCommandChannel, SshCommandSession, SshExecuteRequest, SshExecutor } from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const host: SshHost = {
  id: "host-1",
  label: "Test host",
  host: "host.example.test",
  user: "runner",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "agent" },
};

class FakeChannel extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly output = new PassThrough();
  signalName: string | undefined;
  destroyed = false;

  write(chunk: unknown): boolean {
    this.output.write(chunk as string | Buffer);
    return true;
  }

  end(): this {
    this.destroy();
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  signal(name: string): void {
    this.signalName = name;
    this.emit("exit", null, name);
    this.destroy();
  }

  complete(stdout = "", stderr = "", exitCode: number | null = 0, signal?: string): void {
    if (stdout) this.emit("data", Buffer.from(stdout));
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.emit("exit", exitCode, signal);
    this.destroy();
  }
}

class FakeSession implements SshCommandSession {
  readonly requests: SshExecuteRequest[] = [];
  readonly channels: FakeChannel[] = [];
  closed = false;

  async openChannel(request: SshExecuteRequest): Promise<SshCommandChannel> {
    if (this.closed) throw new Error("session closed");
    this.requests.push(structuredClone(request));
    const channel = new FakeChannel();
    this.channels.push(channel);
    return {
      channel: channel as never,
      close: () => channel.destroy(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels) channel.destroy();
  }
}

class FakeExecutor {
  readonly sessions: FakeSession[] = [];

  async openSession(): Promise<SshCommandSession> {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

function target(): SshBgResolvedTarget {
  return { host, fence: "fence-1" };
}

function manager(executor = new FakeExecutor(), completions: unknown[] = [], snapshots: SshBgSnapshotPayload[] = []) {
  const instance = new SshBgManager({
    executor: executor as unknown as SshExecutor,
    resolveTarget: async () => target(),
    onCompletion: (completion) => completions.push(completion),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return { instance, executor };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("ssh_bg schema distinguishes session commands from job controls", () => {
  assert.equal(Value.Check(SshBgParams, { action: "job_start", targetId: "host-1", command: "sleep 10" }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_exec", sessionId: "ssh-session-1", command: "echo next" }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_status", jobId: "ssh-bg-1", tail: 20 }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_exec", targetId: "host-1", sessionId: "ssh-session-1", command: "echo next" }), false);
  assert.equal(Value.Check(SshBgParams, { action: "job_start", command: "" }), false);
});

test("ssh_bg reuses one SSH session for appended commands and notifies background completion", async () => {
  const completions: unknown[] = [];
  const fixture = manager(new FakeExecutor(), completions);
  const started = await fixture.instance.execute({ action: "job_start", targetId: "host-1", command: "long-running" });
  const sessionId = started.details?.sessionId;
  assert.ok(sessionId);
  assert.equal(fixture.executor.sessions.length, 1);
  const session = fixture.executor.sessions[0]!;
  assert.deepEqual(session.requests, [{ command: "long-running" }]);

  const appended = await fixture.instance.execute({ action: "job_exec", sessionId, command: "echo appended", tail: 20 });
  await tick();
  assert.equal(fixture.executor.sessions.length, 1);
  assert.deepEqual(session.requests, [{ command: "long-running" }, { command: "echo appended" }]);
  assert.equal(appended.details?.background, true);
  assert.equal(appended.details?.status, "running");
  session.channels[1]!.complete("appended output\n");
  await tick();
  const appendedStatus = await fixture.instance.execute({ action: "job_status", jobId: appended.details!.jobId!, tail: 20 });
  assert.match(appendedStatus.content[0]!.type === "text" ? appendedStatus.content[0]!.text : "", /appended output/);

  session.channels[0]!.complete("done\n");
  await tick();
  assert.equal(completions.length, 2);
  assert.equal((completions[0] as { status: string }).status, "completed");
  assert.equal((completions[0] as { sessionId: string }).sessionId, sessionId);
});

test("ssh_bg kill stops a remote channel and close reclaims the shared session", async () => {
  const completions: unknown[] = [];
  const fixture = manager(new FakeExecutor(), completions);
  const started = await fixture.instance.execute({ action: "job_start", targetId: "host-1", command: "watch" });
  const jobId = started.details?.jobId;
  const sessionId = started.details?.sessionId;
  assert.ok(jobId);
  assert.ok(sessionId);
  const session = fixture.executor.sessions[0]!;

  const killed = await fixture.instance.execute({ action: "job_kill", jobId });
  assert.equal(killed.details?.status, "killed");
  assert.equal(session.channels[0]!.signalName, "SIGTERM");
  assert.equal(completions.length, 1);
  assert.equal((completions[0] as { status: string }).status, "killed");

  const closed = await fixture.instance.execute({ action: "job_close", sessionId });
  assert.match(closed.content[0]!.type === "text" ? closed.content[0]!.text : "", /Closed SSH session/);
  assert.equal(session.closed, true);
  const listed = await fixture.instance.execute({ action: "job_list" });
  assert.match(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /No SSH background sessions/);
});

test("ssh_bg run returns completed output inline and preserves the session for later commands", async () => {
  const fixture = manager();
  const runPromise = fixture.instance.execute({ action: "job_run", targetId: "host-1", command: "printf ok", timeout: 1, tail: 10 });
  await tick();
  fixture.executor.sessions[0]!.channels[0]!.complete("ok\n");
  const result = await runPromise;
  assert.equal(result.details?.status, "completed");
  assert.equal(result.details?.background, false);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /ok/);
  assert.equal((await fixture.instance.execute({ action: "job_list" })).content[0]!.type, "text");
});

test("ssh_bg decodes Chinese and emoji across every chunk boundary and counts raw bytes", async () => {
  const text = "中文🙂🚀输出";
  const bytes = Buffer.from(text);
  for (let split = 1; split < bytes.length; split++) {
    const snapshots: SshBgSnapshotPayload[] = [];
    const completions: SshBgCompletion[] = [];
    const fixture = manager(new FakeExecutor(), completions, snapshots);
    const started = await fixture.instance.execute({ action: "job_start", command: "unicode" });
    const channel = fixture.executor.sessions[0]!.channels[0]!;
    channel.emit("data", bytes.subarray(0, split));
    assert.equal(snapshots.at(-1)!.sessions[0]!.jobs[0]!.outputBytes, split);
    channel.emit("data", bytes.subarray(split));
    channel.complete();
    const status = await fixture.instance.execute({ action: "job_status", jobId: started.details!.jobId! });
    assert.equal(status.details!.outputTail, text, `split ${split}`);
    assert.equal(completions[0]!.outputTail, text);
    assert.equal(snapshots.at(-1)!.sessions[0]!.jobs[0]!.outputBytes, bytes.length);
    await fixture.instance.close();
  }
});

test("ssh_bg keeps interleaved stdout and stderr decoder state independent", async () => {
  const snapshots: SshBgSnapshotPayload[] = [];
  const completions: SshBgCompletion[] = [];
  const fixture = manager(new FakeExecutor(), completions, snapshots);
  const started = await fixture.instance.execute({ action: "job_start", command: "interleaved" });
  const channel = fixture.executor.sessions[0]!.channels[0]!;
  const stdout = Buffer.from("中🙂");
  const stderr = Buffer.from("错🚀");
  channel.emit("data", stdout.subarray(0, 1));
  channel.stderr.emit("data", stderr.subarray(0, 2));
  channel.emit("data", stdout.subarray(1, 4));
  channel.stderr.emit("data", stderr.subarray(2, 4));
  channel.stderr.emit("data", stderr.subarray(4));
  channel.emit("data", stdout.subarray(4));
  channel.emit("data", "字符串");
  channel.complete();
  const status = await fixture.instance.execute({ action: "job_status", jobId: started.details!.jobId! });
  assert.equal(status.details!.outputTail, "中错🚀🙂字符串");
  assert.equal(completions[0]!.outputTail, status.details!.outputTail);
  assert.equal(snapshots.at(-1)!.sessions[0]!.jobs[0]!.outputBytes, stdout.length + stderr.length + Buffer.byteLength("字符串"));
  await fixture.instance.close();
});

test("ssh_bg keeps the 64KiB tail on UTF8 character boundaries", async () => {
  const maximum = 64 * 1024;
  for (const character of ["中", "🙂", "\uFFFD"]) {
    const characterBytes = Buffer.byteLength(character);
    for (let retained = 1; retained <= characterBytes; retained++) {
      const snapshots: SshBgSnapshotPayload[] = [];
      const completions: SshBgCompletion[] = [];
      const fixture = manager(new FakeExecutor(), completions, snapshots);
      const started = await fixture.instance.execute({ action: "job_start", command: "large output" });
      const channel = fixture.executor.sessions[0]!.channels[0]!;
      const suffix = "x".repeat(maximum - retained);
      const text = `prefix${character}${suffix}`;
      channel.emit("data", Buffer.from(`prefix${character}`));
      channel.emit("data", Buffer.from(suffix));
      const expected = retained === characterBytes ? character + suffix : suffix;
      const running = snapshots.at(-1)!.sessions[0]!.jobs[0]!;
      assert.equal(running.outputTail, expected, `${character}: retain ${retained} bytes`);
      assert.ok(Buffer.byteLength(running.outputTail) <= maximum);
      assert.equal(running.outputBytes, Buffer.byteLength(text));
      assert.equal(running.tailTruncated, true);
      channel.complete();
      const status = await fixture.instance.execute({ action: "job_status", jobId: started.details!.jobId! });
      assert.equal(status.details!.outputTail, expected);
      assert.equal(completions[0]!.outputTail, expected);
      await fixture.instance.close();
    }
  }
});

test("ssh_bg replaces invalid UTF8 and flushes pending bytes exactly once at finish", async () => {
  const snapshots: SshBgSnapshotPayload[] = [];
  const completions: SshBgCompletion[] = [];
  const fixture = manager(new FakeExecutor(), completions, snapshots);
  const started = await fixture.instance.execute({ action: "job_start", command: "invalid bytes" });
  const channel = fixture.executor.sessions[0]!.channels[0]!;
  channel.emit("data", Buffer.from([0xff, 0xe4, 0xb8]));
  channel.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
  const running = snapshots.at(-1)!.sessions[0]!.jobs[0]!;
  assert.equal(running.outputTail, "\uFFFD");
  assert.equal(running.outputBytes, 5);
  channel.complete("", "", 1);
  const finished = snapshots.at(-1)!.sessions[0]!.jobs[0]!;
  assert.equal(finished.status, "failed");
  assert.equal(finished.outputTail, "\uFFFD\uFFFD\uFFFD");
  assert.equal(finished.outputBytes, 5);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.outputTail, finished.outputTail);
  channel.emit("close");
  channel.emit("data", Buffer.from("late stdout"));
  channel.stderr.emit("data", Buffer.from("late stderr"));
  const status = await fixture.instance.execute({ action: "job_status", jobId: started.details!.jobId! });
  assert.equal(status.details!.outputTail, finished.outputTail);
  assert.equal(completions.length, 1);
  assert.equal(snapshots.at(-1)!.sessions[0]!.jobs[0]!.outputBytes, 5);
  await fixture.instance.close();
});

test("ssh_bg flushes pending UTF8 on kill and session close without duplicate completion", async () => {
  for (const action of ["job_kill", "job_close"] as const) {
    const snapshots: SshBgSnapshotPayload[] = [];
    const completions: SshBgCompletion[] = [];
    const fixture = manager(new FakeExecutor(), completions, snapshots);
    const started = await fixture.instance.execute({ action: "job_start", command: "pending bytes" });
    const channel = fixture.executor.sessions[0]!.channels[0]!;
    channel.emit("data", Buffer.from([0xe4, 0xb8]));
    channel.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
    if (action === "job_kill") {
      await fixture.instance.execute({ action, jobId: started.details!.jobId! });
    } else {
      await fixture.instance.execute({ action, sessionId: started.details!.sessionId! });
    }
    const finished = snapshots.flatMap((snapshot) => snapshot.sessions.flatMap((session) => session.jobs)).findLast((job) => job.status === "killed")!;
    assert.equal(finished.outputTail, "\uFFFD\uFFFD");
    assert.equal(finished.outputBytes, 4);
    assert.equal(completions.length, action === "job_kill" ? 1 : 0);
    channel.emit("close");
    assert.equal(completions.length, action === "job_kill" ? 1 : 0);
    await fixture.instance.close();
  }
});

test("ssh_bg can be initialized again after session shutdown", async () => {
  const fixture = manager();
  await fixture.instance.close();
  await assert.rejects(fixture.instance.execute({ action: "job_list" }), /outside an active session runtime/);
  fixture.instance.initialize();
  const listed = await fixture.instance.execute({ action: "job_list" });
  assert.match(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /No SSH background sessions/);
});
