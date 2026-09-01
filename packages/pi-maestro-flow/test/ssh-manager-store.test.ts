import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedSshStore,
  replaceSshHost,
  validateSshHost,
  validateSshHosts,
  type SshHost,
} from "../src/ssh-manager/index.ts";

const PIN = `SHA256:${"A".repeat(43)}`;

function passwordHost(overrides: Partial<SshHost> = {}): SshHost {
  return {
    id: "primary-1",
    label: "Production box",
    host: "ssh.example.test",
    user: "deploy",
    port: 22,
    shell: "bash",
    hostKey: PIN,
    auth: { kind: "password", password: "remote-password-secret" },
    ...overrides,
  };
}

test("encrypted SSH store encrypts the entire payload, writes mode 0600, and supports save/reload/lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-store-"));
  const path = join(root, "nested", "ssh-manager.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("master-password-secret", [passwordHost()]);
    assert.equal(store.locked, false);
    assert.equal(store.revision, 0);
    const disk = await readFile(path, "utf8");
    assert.doesNotMatch(disk, /Production box|ssh\.example\.test|deploy|remote-password-secret|master-password-secret/);
    assert.match(disk, /"name":"scrypt"/);
    assert.match(disk, /"name":"aes-256-gcm"/);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

    const hosts = store.getHosts();
    hosts[0]!.label = "Renamed server";
    await store.save(hosts);
    assert.equal(store.revision, 1);
    await store.reload();
    assert.equal(store.getHosts()[0]!.label, "Renamed server");

    store.lock();
    assert.equal(store.locked, true);
    assert.throws(() => store.getHosts(), /locked/);
    await store.unlock("master-password-secret");
    assert.equal(store.getHosts()[0]!.auth.kind, "password");
    assert.equal((store.getHosts()[0]!.auth as { password: string }).password, "remote-password-secret");
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted SSH store fails closed on wrong password, tamper, and envelope drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-tamper-"));
  const path = join(root, "ssh.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("correct horse battery staple", [passwordHost()]);
    store.lock();
    await assert.rejects(store.unlock("wrong password"), /^Error: Unable to unlock SSH manager store$/);
    assert.equal(store.locked, true);

    const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const tampered = structuredClone(original) as { ciphertext: string };
    tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
    await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(store.unlock("correct horse battery staple"), /Unable to unlock/);
    assert.equal(store.locked, true);

    const drifted = structuredClone(original) as { kdf: { N: number } };
    drifted.kdf.N = 16_384;
    await writeFile(path, JSON.stringify(drifted), { mode: 0o600 });
    await assert.rejects(store.unlock("correct horse battery staple"), /Unable to unlock/);
    assert.equal(store.locked, true);

    await writeFile(path, JSON.stringify(original), { mode: 0o600 });
    await store.unlock("correct horse battery staple");
    await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(store.reload());
    assert.equal(store.locked, true, "reload tamper locks and clears the in-memory store");
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted SSH store rejects stale writers instead of losing another Pi process update", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-concurrent-"));
  const path = join(root, "ssh.enc.json");
  const first = new EncryptedSshStore({ path });
  const stale = new EncryptedSshStore({ path });
  try {
    await first.create("shared-master-password", [passwordHost()]);
    await stale.unlock("shared-master-password");
    await first.save([passwordHost({ label: "First writer" })]);
    await assert.rejects(
      stale.save([passwordHost({ label: "Stale writer" })]),
      /revision conflict: expected 0, found 1/,
    );
    const check = new EncryptedSshStore({ path });
    await check.unlock("shared-master-password");
    assert.equal(check.getHosts()[0]!.label, "First writer");
    check.lock();
  } finally {
    first.lock();
    stale.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted SSH store creation publishes exactly one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-create-race-"));
  const path = join(root, "ssh.enc.json");
  const first = new EncryptedSshStore({ path });
  const second = new EncryptedSshStore({ path });
  try {
    const results = await Promise.allSettled([
      first.create("first-master-password", [passwordHost({ label: "First" })]),
      second.create("second-master-password", [passwordHost({ label: "Second" })]),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winner = results[0]!.status === "fulfilled"
      ? { password: "first-master-password", label: "First" }
      : { password: "second-master-password", label: "Second" };
    const check = new EncryptedSshStore({ path });
    await check.unlock(winner.password);
    assert.equal(check.getHosts()[0]!.label, winner.label);
    check.lock();
  } finally {
    first.lock();
    second.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted SSH store replaces pre-existing Windows ACL grants with the current user only", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows DACL boundary");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-acl-"));
  const directory = join(root, "private");
  const path = join(directory, "hosts.enc.json");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const store = new EncryptedSshStore({ path });
  try {
    await mkdir(directory);
    execFileSync(icacls, [directory, "/grant", "*S-1-5-11:(RX)"], { windowsHide: true });
    await store.create("master-password", [passwordHost()]);
    const sid = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true })
      .match(/S-\d-(?:\d+-)+\d+/u)?.[0];
    assert.ok(sid);
    const aclPath = join(root, "acl.txt");
    execFileSync(icacls, [directory, "/save", aclPath], { windowsHide: true });
    const acl = await readFile(aclPath, "utf16le");
    assert.match(acl, new RegExp(`;;;${sid.replaceAll("-", "\\-")}\\)`));
    assert.doesNotMatch(acl, /;;;(?:AU|SY|BA|BU|WD)\)/u);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted SSH store rejects oversized files before allocating their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-oversized-"));
  const path = join(root, "ssh.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(store.unlock("master-password"), /Unable to unlock/);
    assert.equal(store.locked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH host model validates pins/auth, uniqueness, and stable ids on edit", () => {
  assert.deepEqual(validateSshHost(passwordHost()), passwordHost());
  assert.throws(() => validateSshHost({ ...passwordHost(), hostKey: "" }), /pinned SHA256/);
  assert.throws(() => validateSshHost({ ...passwordHost(), port: 0 }), /between 1 and 65535/);
  assert.throws(() => validateSshHost({ ...passwordHost(), shell: "cmd" }), /bash or powershell/);
  assert.throws(() => validateSshHost({ ...passwordHost(), auth: { kind: "password", password: "secret", extra: true } }), /unsupported field/);
  assert.throws(() => validateSshHosts([passwordHost(), passwordHost()]), /Duplicate SSH host id/);
  assert.throws(() => replaceSshHost([passwordHost()], "primary-1", passwordHost({ id: "changed" })), /cannot change/);
  assert.equal(replaceSshHost([passwordHost()], "primary-1", passwordHost({ label: "Edited" }))[0]!.id, "primary-1");
});
