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
  type SshHost,
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
  command: string | undefined;
  output: string | Buffer = "hello";
  errorOutput: string | Buffer = "warning";
  stayPending = false;

  connect(config: ConnectConfig): this {
    this.config = config;
    if (this.stayPending) return this;
    queueMicrotask(() => {
      const verified = config.hostVerifier?.(SERVER_KEY) ?? false;
      if (!verified) this.emit("error", new Error("host key rejected"));
      else this.emit("ready");
    });
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, channel: any) => void): this {
    this.command = command;
    const channel = new PassThrough() as PassThrough & { stderr: PassThrough };
    channel.stderr = new PassThrough();
    callback(undefined, channel);
    queueMicrotask(() => {
      channel.write(this.output);
      channel.stderr.write(this.errorOutput);
      channel.emit("exit", 7);
      channel.emit("close");
    });
    return this;
  }

  end(): this {
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

test("SHA256 fingerprints use the OpenSSH SHA256 base64 form", () => {
  const expected = `SHA256:${createHash("sha256").update(SERVER_KEY).digest("base64").replace(/=+$/u, "")}`;
  assert.equal(sha256HostKeyFingerprint(SERVER_KEY), expected);
});
