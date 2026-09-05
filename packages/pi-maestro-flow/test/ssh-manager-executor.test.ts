import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Client, ConnectConfig } from "ssh2";
import {
  buildRemoteCommand,
  matchesPinnedHostKey,
  sha256HostKeyFingerprint,
  SshExecutor,
  type SshConnectionSource,
  type SshHost,
  type SshKey,
} from "../src/ssh-manager/index.ts";

const SERVER_KEY = Buffer.from("server-public-key-blob");
const PIN = sha256HostKeyFingerprint(SERVER_KEY);

function host(auth: SshHost["auth"] = { kind: "password", password: "auth-secret" }): SshHost {
  return {
    id: "server-1",
    label: "Server one",
    host: "127.0.0.1",
    user: "tester",
    port: 2222,
    shell: "bash",
    hostKey: PIN,
    auth,
  };
}

class FakeClient extends EventEmitter {
  config: ConnectConfig | undefined;
  readonly forwarded: Array<{ host: string; port: number }> = [];
  serverKey = SERVER_KEY;
  lifecycle?: string[];
  name = "client";
  command: string | undefined;
  output: string | Buffer = "hello";
  errorOutput: string | Buffer = "warning";
  stayPending = false;
  keepChannelOpen = false;
  channel: (PassThrough & { stderr: PassThrough }) | undefined;
  connectionError: Error | undefined;
  lateErrorAfterEnd = false;
  forwardError = false;
  abortAfterReady: AbortController | undefined;

  connect(config: ConnectConfig): this {
    this.config = config;
    if (this.stayPending) return this;
    queueMicrotask(() => {
      if (this.connectionError) {
        this.emit("error", this.connectionError);
        return;
      }
      const verified = config.hostVerifier?.(this.serverKey) ?? false;
      if (!verified) this.emit("error", new Error("host key rejected"));
      else {
        this.emit("ready");
        this.abortAfterReady?.abort();
      }
    });
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, channel: any) => void): this {
    this.command = command;
    const channel = new PassThrough() as PassThrough & { stderr: PassThrough };
    channel.stderr = new PassThrough();
    this.channel = channel;
    callback(undefined, channel);
    if (!this.keepChannelOpen) queueMicrotask(() => {
      channel.write(this.output);
      channel.stderr.write(this.errorOutput);
      channel.emit("exit", 7);
      channel.emit("close");
    });
    return this;
  }

  forwardOut(_sourceHost: string, _sourcePort: number, host: string, port: number, callback: (error: Error | undefined, stream: PassThrough) => void): this {
    this.forwarded.push({ host, port });
    const stream = new PassThrough();
    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = ((error?: Error) => {
      this.lifecycle?.push(`destroy:${this.name}`);
      return originalDestroy(error);
    }) as typeof stream.destroy;
    queueMicrotask(() => this.forwardError ? callback(new Error("forward failed"), stream) : callback(undefined, stream));
    return this;
  }

  end(): this {
    this.lifecycle?.push(`end:${this.name}`);
    if (this.lateErrorAfterEnd) {
      queueMicrotask(() => {
        this.emit("error", new Error("read ECONNRESET"));
        this.emit("close");
      });
    }
    return this;
  }
}

test("SSH executor pins the host key, uses password auth, and returns bounded UTF-8 output", async () => {
  const client = new FakeClient();
  const executor = new SshExecutor(() => client as unknown as Client);
  const result = await executor.execute(host(), { command: "printf hello", cwd: "/tmp/a'b", timeout: 5 });
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.equal(result.exitCode, 7);
  assert.equal(client.config?.password, "auth-secret");
  assert.equal(client.config?.host, "127.0.0.1");
  assert.equal(client.command, "exec bash -lc 'cd -- '\\''/tmp/a'\\''\\'\\'''\\''b'\\'' && printf hello'");
  assert.equal(matchesPinnedHostKey(SERVER_KEY, PIN), true);
  assert.equal(matchesPinnedHostKey(Buffer.from("other"), PIN), false);
});

test("SSH executor opens a reusable pinned command channel without changing the requested command", async () => {
  const client = new FakeClient();
  client.keepChannelOpen = true;
  const executor = new SshExecutor(() => client as unknown as Client);
  const handle = await executor.openChannel(host(), { command: "pi-maestro-gateway connect --stdio", timeout: 5 });
  assert.equal(client.config?.password, "auth-secret");
  assert.equal(client.config?.hostVerifier?.(SERVER_KEY), true);
  assert.equal(client.command, "exec bash -lc 'pi-maestro-gateway connect --stdio'");
  assert.equal(handle.channel, client.channel);
  handle.close();
  assert.equal(client.channel?.destroyed, true);
});

test("SSH executor absorbs a late connection reset after command completion", async () => {
  const client = new FakeClient();
  client.lateErrorAfterEnd = true;
  const result = await new SshExecutor(() => client as unknown as Client).execute(host(), { command: "id" });
  assert.equal(result.exitCode, 7);
  assert.equal(client.listenerCount("error"), 0);
});

test("SSH executor absorbs a late connection reset after reporting a connection failure", async () => {
  const client = new FakeClient();
  client.connectionError = new Error("connection failed");
  client.lateErrorAfterEnd = true;
  await assert.rejects(
    new SshExecutor(() => client as unknown as Client).execute(host(), { command: "id" }),
    /connection or authentication failed/,
  );
  assert.equal(client.listenerCount("error"), 0);
});

test("SSH executor resolves managed keys and a root-first jump chain with per-hop auth and pins", async () => {
  const rootHost: SshHost = { ...host({ kind: "password", password: "jump-password" }), id: "jump", host: "jump.example", hostKey: PIN, jumpHostId: null, tags: [], monitorEnabled: false };
  const targetKey: SshKey = { id: "managed", label: "Managed", privateKey: "MANAGED PRIVATE KEY", passphrase: "managed-pass", publicKeyFingerprint: PIN, createdAt: "2025-01-01T00:00:00.000Z" };
  const targetHost: SshHost = { ...host({ kind: "key", keyId: "managed" }), id: "target", host: "target.internal", hostKey: PIN, jumpHostId: "jump", tags: [], monitorEnabled: false };
  let checkedOut: SshKey | undefined;
  const source: SshConnectionSource = {
    getHosts: () => [targetHost, rootHost],
    checkoutKey: (id) => { assert.equal(id, "managed"); checkedOut = structuredClone(targetKey); return checkedOut; },
    getEffectiveHostDigest: (id) => { assert.equal(id, "target"); return "digest-1"; },
  };
  const root = new FakeClient();
  const target = new FakeClient();
  const clients = [root, target];
  const result = await new SshExecutor(() => clients.shift()! as unknown as Client, source).execute("target", { command: "id" });
  assert.equal(root.config?.host, "jump.example");
  assert.equal(root.config?.password, "jump-password");
  assert.deepEqual(root.forwarded, [{ host: "target.internal", port: 2222 }]);
  assert.equal(target.config?.host, "target.internal");
  assert.equal(target.config?.sock instanceof PassThrough, true);
  assert.equal(target.config?.passphrase, "managed-pass");
  assert.ok((target.config?.privateKey as Buffer).every((byte) => byte === 0), "managed key buffer is zeroized after connect submission");
  assert.equal(checkedOut?.privateKey, "", "checked-out managed key object is scrubbed");
  assert.equal(checkedOut?.passphrase, undefined);
  assert.equal(root.config?.hostVerifier?.(SERVER_KEY), true);
  assert.equal(target.config?.hostVerifier?.(SERVER_KEY), true);
  assert.equal(result.effectiveDigest, "digest-1");
});

test("SSH executor TOFU seam captures only the authenticated final target fingerprint", async () => {
  const jump = { ...host(), id: "jump", hostKey: PIN, jumpHostId: null, tags: [], monitorEnabled: false };
  const target = { ...host(), id: "target", hostKey: null, jumpHostId: "jump", tags: [], monitorEnabled: false };
  const source: SshConnectionSource = { getHosts: () => [target, jump], checkoutKey: () => { throw new Error("unused"); }, getEffectiveHostDigest: () => "tofu-digest" };
  const clients = [new FakeClient(), new FakeClient()];
  const executor = new SshExecutor(() => clients.shift()! as unknown as Client, source);
  await assert.rejects(executor.execute("target", { command: "id" }), /pinned SHA256/);
  assert.equal(clients.length, 2, "normal execution rejects an unpinned final target before connect");
  const tested = await executor.testConnection("target");
  assert.deepEqual(tested, { fingerprint: PIN, effectiveDigest: "tofu-digest" });

  const unpinnedJump = { ...jump, hostKey: null };
  const badSource: SshConnectionSource = { ...source, getHosts: () => [target, unpinnedJump] };
  let creates = 0;
  await assert.rejects(new SshExecutor(() => { creates++; return new FakeClient() as unknown as Client; }, badSource).testConnection("target"), /pinned SHA256/);
  assert.equal(creates, 0, "TOFU never applies to a jump host");
});

test("SSH executor rejects invalid jump graphs and key references before creating clients", async () => {
  const base = { ...host(), tags: [], monitorEnabled: false };
  const cases: Array<{ hosts: SshHost[]; target: string; message: RegExp }> = [
    { hosts: [{ ...base, id: "a", jumpHostId: "missing" }], target: "a", message: /missing jump host/ },
    { hosts: [{ ...base, id: "a", jumpHostId: "b" }, { ...base, id: "b", jumpHostId: "a" }], target: "a", message: /cycle/ },
    { hosts: Array.from({ length: 7 }, (_, index) => ({ ...base, id: `h${index}`, jumpHostId: index === 6 ? null : `h${index + 1}` })), target: "h0", message: /depth exceeds 5/ },
  ];
  for (const item of cases) {
    let creates = 0;
    const source: SshConnectionSource = { getHosts: () => item.hosts, checkoutKey: () => { throw new Error("unused"); }, getEffectiveHostDigest: () => "digest" };
    await assert.rejects(new SshExecutor(() => { creates++; return new FakeClient() as unknown as Client; }, source).execute(item.target, { command: "id" }), item.message);
    assert.equal(creates, 0);
  }
  let creates = 0;
  const keyed = { ...base, id: "keyed", jumpHostId: null, auth: { kind: "key", keyId: "missing" } as const };
  const missingKey: SshConnectionSource = { getHosts: () => [keyed], checkoutKey: () => { throw new Error("SSH key was not found"); }, getEffectiveHostDigest: () => "digest" };
  await assert.rejects(new SshExecutor(() => { creates++; return new FakeClient() as unknown as Client; }, missingKey).execute("keyed", { command: "id" }), /key was not found/);
  assert.equal(creates, 0);
});

test("SSH executor cleanup is reverse-order and idempotent for reusable channels", async () => {
  const jump = { ...host(), id: "jump", jumpHostId: null, tags: [], monitorEnabled: false };
  const target = { ...host(), id: "target", jumpHostId: "jump", tags: [], monitorEnabled: false };
  const source: SshConnectionSource = { getHosts: () => [target, jump], checkoutKey: () => { throw new Error("unused"); }, getEffectiveHostDigest: () => "digest" };
  const lifecycle: string[] = [];
  const root = new FakeClient(); root.name = "root"; root.lifecycle = lifecycle;
  const leaf = new FakeClient(); leaf.name = "leaf"; leaf.lifecycle = lifecycle; leaf.keepChannelOpen = true;
  const clients = [root, leaf];
  const handle = await new SshExecutor(() => clients.shift()! as unknown as Client, source).openChannel("target", { command: "gateway" });
  handle.close(); handle.close();
  assert.deepEqual(lifecycle, ["end:leaf", "destroy:root", "end:root"]);
});

test("SSH executor cleans partial chains and active channels on forwarding or transport failure", async () => {
  const jump = { ...host(), id: "jump", jumpHostId: null, tags: [], monitorEnabled: false };
  const target = { ...host(), id: "target", jumpHostId: "jump", tags: [], monitorEnabled: false };
  const source: SshConnectionSource = { getHosts: () => [target, jump], checkoutKey: () => { throw new Error("unused"); }, getEffectiveHostDigest: () => "digest" };

  const failedLifecycle: string[] = [];
  const failedRoot = new FakeClient(); failedRoot.name = "root"; failedRoot.lifecycle = failedLifecycle; failedRoot.forwardError = true;
  await assert.rejects(new SshExecutor(() => failedRoot as unknown as Client, source).execute("target", { command: "id" }), /forwarding failed/);
  assert.deepEqual(failedLifecycle, ["destroy:root", "end:root"]);

  const runtimeLifecycle: string[] = [];
  const root = new FakeClient(); root.name = "root"; root.lifecycle = runtimeLifecycle;
  const leaf = new FakeClient(); leaf.name = "leaf"; leaf.lifecycle = runtimeLifecycle; leaf.keepChannelOpen = true;
  const clients = [root, leaf];
  const handle = await new SshExecutor(() => clients.shift()! as unknown as Client, source).openChannel("target", { command: "gateway" });
  root.emit("error", new Error("jump transport failed"));
  assert.equal(handle.channel.destroyed, true);
  assert.deepEqual(runtimeLifecycle, ["end:leaf", "destroy:root", "end:root"]);
});

test("SSH executor supports agent and identity authentication without returning secrets", async () => {
  const agentClient = new FakeClient();
  const agentResult = await new SshExecutor(() => agentClient as unknown as Client).execute(
    host({ kind: "agent" }),
    { command: "id" },
    { agentPath: "/agent/socket" },
  );
  assert.equal(agentClient.config?.agent, "/agent/socket");
  assert.doesNotMatch(JSON.stringify(agentResult), /agent\/socket|auth-secret/);

  const root = await mkdtemp(join(tmpdir(), "ssh-identity-"));
  const identityPath = join(root, "id_test");
  await writeFile(identityPath, "PRIVATE KEY MATERIAL");
  try {
    const identityClient = new FakeClient();
    const identityResult = await new SshExecutor(() => identityClient as unknown as Client).execute(
      host({ kind: "identity", path: identityPath, passphrase: "key-passphrase" }),
      { command: "whoami" },
    );
    assert.equal(identityClient.config?.passphrase, "key-passphrase");
    assert.ok(Buffer.isBuffer(identityClient.config?.privateKey));
    assert.ok((identityClient.config!.privateKey as Buffer).every((byte) => byte === 0), "identity buffer is zeroized after execution");
    assert.doesNotMatch(JSON.stringify(identityResult), /PRIVATE KEY|key-passphrase|id_test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH executor rejects symlinked identity files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ssh-identity-link-"));
  const identityPath = join(root, "id_test");
  const linkPath = join(root, "id_link");
  await writeFile(identityPath, "PRIVATE KEY MATERIAL");
  try {
    try {
      await symlink(identityPath, linkPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("creating symlinks is not permitted in this Windows environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      new SshExecutor(() => new FakeClient() as unknown as Client).execute(
        host({ kind: "identity", path: linkPath }),
        { command: "id" },
      ),
      /symlinked/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH executor uses PowerShell EncodedCommand and makes cwd failure terminating", () => {
  const remote = buildRemoteCommand("powershell", "Get-ChildItem", "C:\\A'B");
  assert.match(remote, /^powershell\.exe .* -EncodedCommand /);
  const encoded = remote.split(" ").at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.match(script, /Set-Location -LiteralPath 'C:\\A''B' -ErrorAction Stop/);
  assert.ok(script.indexOf("Set-Location") < script.indexOf("Get-ChildItem"));
});

test("SSH executor fails closed on missing pin, bounds, overflow, and abort", async () => {
  const executor = new SshExecutor(() => new FakeClient() as unknown as Client);
  await assert.rejects(executor.execute({ ...host(), hostKey: "" }, { command: "id" }), /pinned SHA256/);
  await assert.rejects(executor.execute(host(), { command: "x".repeat(65_537) }), /1-65536 UTF-8 bytes/);
  assert.throws(() => buildRemoteCommand("powershell", "x".repeat(5_000)), /too large for bounded Windows EncodedCommand/);
  await assert.rejects(executor.execute(host(), { command: "id", timeout: 301 }), /between 1 and 300/);

  const overflow = new FakeClient();
  overflow.output = "12345";
  await assert.rejects(
    new SshExecutor(() => overflow as unknown as Client).execute(host(), { command: "id" }, { outputLimitBytes: 4 }),
    /output exceeded/,
  );

  const invalidUtf8 = new FakeClient();
  invalidUtf8.output = Buffer.from([0xff]);
  await assert.rejects(
    new SshExecutor(() => invalidUtf8 as unknown as Client).execute(host(), { command: "id" }),
    /not valid UTF-8/,
  );

  const pending = new FakeClient();
  pending.stayPending = true;
  const controller = new AbortController();
  const promise = new SshExecutor(() => pending as unknown as Client).execute(host(), { command: "id" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("SSH executor closes the abort handoff after the final connection becomes ready", async () => {
  for (const action of ["execute", "openChannel"] as const) {
    const controller = new AbortController();
    const client = new FakeClient();
    client.abortAfterReady = controller;
    client.keepChannelOpen = true;
    const executor = new SshExecutor(() => client as unknown as Client);
    const pending = action === "execute"
      ? executor.execute(host(), { command: "id" }, { signal: controller.signal })
      : executor.openChannel(host(), { command: "gateway" }, { signal: controller.signal });
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(client.command, undefined, `${action} does not start after an abort in the ready-listener handoff`);
  }
});

test("SHA256 fingerprints use the OpenSSH SHA256 base64 form", () => {
  const expected = `SHA256:${createHash("sha256").update(SERVER_KEY).digest("base64").replace(/=+$/u, "")}`;
  assert.equal(sha256HostKeyFingerprint(SERVER_KEY), expected);
});
