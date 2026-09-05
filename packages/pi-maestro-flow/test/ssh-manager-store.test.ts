import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedSshStore,
  effectiveSshHostDigest,
  pairSshGateway,
  replaceSshHost,
  reverseSshHostDependencyClosure,
  validateSshHost,
  validateSshHosts,
  unpairSshGateway,
  validateSshManagerData,
  type SshExecutor,
  type SshHost,
  type SshKey,
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
    tags: [],
    jumpHostId: null,
    monitorEnabled: false,
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

test("explicit lock wins over in-flight unlock without clearing a later successful unlock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-unlock-race-"));
  const path = join(root, "ssh.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("master-password", [passwordHost()]);
    store.lock();
    const stale = store.unlock("master-password");
    store.lock();
    await assert.rejects(stale, /Unable to unlock/);
    assert.equal(store.locked, true);

    const failing = store.unlock("wrong-password");
    const succeeding = store.unlock("master-password");
    await assert.rejects(failing, /Unable to unlock/);
    await succeeding;
    assert.equal(store.locked, false, "an older failed unlock must not clear the newer successful state");
  } finally {
    store.lock();
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
  const legacy = passwordHost();
  delete (legacy as Partial<SshHost>).tags;
  delete (legacy as Partial<SshHost>).jumpHostId;
  delete (legacy as Partial<SshHost>).monitorEnabled;
  assert.deepEqual(validateSshHost(legacy), passwordHost());
  assert.throws(() => validateSshHost({ ...passwordHost(), hostKey: "" }), /pinned SHA256/);
  assert.throws(() => validateSshHost({ ...passwordHost(), port: 0 }), /between 1 and 65535/);
  assert.throws(() => validateSshHost({ ...passwordHost(), shell: "cmd" }), /bash or powershell/);
  assert.throws(() => validateSshHost({ ...passwordHost(), auth: { kind: "password", password: "secret", extra: true } }), /unsupported field/);
  assert.throws(() => validateSshHosts([passwordHost(), passwordHost()]), /Duplicate SSH host id/);
  assert.throws(() => replaceSshHost([passwordHost()], "primary-1", passwordHost({ id: "changed" })), /cannot change/);
  assert.equal(replaceSshHost([passwordHost()], "primary-1", passwordHost({ label: "Edited" }))[0]!.id, "primary-1");
});

function managedKey(overrides: Partial<SshKey> = {}): SshKey {
  return {
    id: "managed-key-1",
    label: "Deployment key",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material-secret\n-----END OPENSSH PRIVATE KEY-----\n",
    passphrase: "key-passphrase-secret",
    publicKeyFingerprint: PIN,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeV1Fixture(path: string, password: string, revision = 4): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const header = {
    version: 1,
    kdf: { name: "scrypt", N: 32_768, r: 8, p: 1, keyLength: 32 },
    cipher: { name: "aes-256-gcm" },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
  };
  const host = passwordHost();
  const plaintext = Buffer.from(JSON.stringify({
    version: 1,
    revision,
    hosts: [{ id: host.id, label: host.label, host: host.host, user: host.user, port: host.port, shell: host.shell, hostKey: host.hostKey, auth: host.auth }],
  }));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { ...header, tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  key.fill(0); salt.fill(0); iv.fill(0); plaintext.fill(0); ciphertext.fill(0);
  return writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

function writeV2Fixture(path: string, password: string, revision = 6): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const header = { version: 1, kdf: { name: "scrypt", N: 32_768, r: 8, p: 1, keyLength: 32 }, cipher: { name: "aes-256-gcm" }, salt: salt.toString("base64"), iv: iv.toString("base64") };
  const plaintext = Buffer.from(JSON.stringify({ version: 2, revision, keys: [], hosts: [passwordHost()] }));
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { ...header, tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  key.fill(0); salt.fill(0); iv.fill(0); plaintext.fill(0); ciphertext.fill(0);
  return writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

test("SSH v3 data validates managed keys, references, jump depth, cycles, bindings, and secret-free effective digests", () => {
  const key = managedKey();
  const jump = passwordHost({ id: "jump", auth: { kind: "agent" } });
  const leaf = passwordHost({ id: "leaf", auth: { kind: "key", keyId: key.id }, jumpHostId: jump.id, hostKey: null, tags: ["prod"] });
  const data = validateSshManagerData({ version: 3, revision: 0, keys: [key], hosts: [jump, leaf], gatewayBindings: [] });
  assert.deepEqual(reverseSshHostDependencyClosure(data.hosts, "jump"), ["jump", "leaf"]);
  const digest = effectiveSshHostDigest(data, "leaf");
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(digest, /secret|private-material/);
  assert.throws(() => validateSshManagerData({ ...data, hosts: [{ ...leaf, auth: { kind: "key", keyId: "missing" } }] }), /missing key/);
  assert.throws(() => validateSshManagerData({ ...data, hosts: [{ ...jump, jumpHostId: "leaf" }, leaf] }), /cycle/);
  assert.throws(() => validateSshManagerData({ ...data, keys: [{ ...key, extra: true }] }), /unsupported field/);
  assert.throws(() => validateSshManagerData({ ...data, hosts: [{ ...jump, tags: Array.from({ length: 17 }, (_, index) => `t${index}`) }] }), /at most 16/);
  const chain = Array.from({ length: 7 }, (_, index) => passwordHost({ id: `h${index}`, jumpHostId: index === 6 ? null : `h${index + 1}` }));
  assert.throws(() => validateSshManagerData({ version: 3, revision: 0, keys: [], hosts: chain, gatewayBindings: [] }), /depth exceeds 5/);
});

test("encrypted SSH store provides fenced host/key CRUD and blocks referenced deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v2-crud-"));
  const path = join(root, "ssh.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("master-password", []);
    await store.addKey(managedKey());
    await store.addHost(passwordHost({ auth: { kind: "key", keyId: "managed-key-1" } }));
    assert.equal(store.checkoutKey("managed-key-1").privateKey, managedKey().privateKey);
    await assert.rejects(store.deleteKey("managed-key-1"), /referenced/);
    await store.addHost(passwordHost({ id: "leaf", jumpHostId: "primary-1" }));
    await assert.rejects(store.deleteHost("primary-1"), /jump host/);
    const disk = await readFile(path, "utf8");
    assert.doesNotMatch(disk, /private-material-secret|key-passphrase-secret|remote-password-secret/);
    await store.deleteHost("leaf");
    await store.deleteHost("primary-1");
    await store.deleteKey("managed-key-1");
    assert.deepEqual(store.getKeys(), []);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("saveConfiguration publishes keys and referring hosts in one revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-configuration-save-"));
  const path = join(root, "ssh.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("master-password", []);
    const key = managedKey();
    const host = passwordHost({ auth: { kind: "key", keyId: key.id } });
    await store.saveConfiguration([host], [key]);
    assert.equal(store.revision, 1);
    assert.equal(store.getHosts()[0]?.auth.kind, "key");
    assert.equal(store.getKeys()[0]?.id, key.id);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 unlock migrates once with revision bump and exclusive private backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v1-migrate-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await writeV1Fixture(path, "migration-password");
    const original = await readFile(path);
    await store.unlock("migration-password");
    assert.equal(store.revision, 5);
    assert.deepEqual(store.getKeys(), []);
    assert.deepEqual(store.getHosts()[0]!.tags, []);
    assert.equal(store.getHosts()[0]!.jumpHostId, null);
    assert.equal(store.getHosts()[0]!.monitorEnabled, false);
    assert.deepEqual(await readFile(`${path}.v1.bak`), original);
    if (process.platform !== "win32") assert.equal((await stat(`${path}.v1.bak`)).mode & 0o777, 0o600);
    store.lock();
    await store.unlock("migration-password");
    assert.equal(store.revision, 5, "v3 unlock must not migrate again");
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 migration resumes when an interrupted publication left the matching backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v1-resume-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await writeV1Fixture(path, "migration-password", 8);
    const original = await readFile(path);
    await writeFile(`${path}.v1.bak`, original, { mode: 0o600 });
    await store.unlock("migration-password");
    assert.equal(store.revision, 9);
    assert.deepEqual(await readFile(`${path}.v1.bak`), original);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 unlock migrates atomically to v3 with an empty independent binding store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v2-migrate-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await writeV2Fixture(path, "migration-password");
    const original = await readFile(path);
    await store.unlock("migration-password");
    assert.equal(store.revision, 7);
    assert.equal(store.getGatewayBinding("primary-1"), undefined);
    assert.deepEqual(await readFile(`${path}.v2.bak`), original);
  } finally { store.lock(); await rm(root, { recursive: true, force: true }); }
});

test("fixed SSH bootstrap persists only an encrypted binding and returns a sanitized receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-bootstrap-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  const token = "s".repeat(43);
  const commands: string[] = [];
  const executor = { async execute(_host: SshHost, request: { command: string }) {
    commands.push(request.command);
    return request.command.includes("bootstrap")
      ? { stdout: JSON.stringify({ id: "pair-bootstrap", token, endpoint: "https://gateway.example.test/mcp", expiresAt: Date.now() + 60_000, serverName: "pi-maestro-gateway", protocolVersion: 1 }), stderr: "", exitCode: 0, signal: null, durationMs: 1 }
      : { stdout: JSON.stringify({ revoked: true }), stderr: "", exitCode: 0, signal: null, durationMs: 1 };
  } } as unknown as SshExecutor;
  try {
    await store.create("master-password", [passwordHost()]);
    const receipt = await pairSshGateway(store, executor, "primary-1");
    assert.deepEqual(Object.keys(receipt).sort(), ["expiresAt", "hostId", "paired"]);
    assert.doesNotMatch(JSON.stringify(receipt), /gateway\.example|s{20}|pair-bootstrap/u);
    assert.equal(store.getGatewayBinding("primary-1")?.token, token);
    assert.doesNotMatch(await readFile(path, "utf8"), /gateway\.example|s{20}|pair-bootstrap/u);
    assert.equal(await unpairSshGateway(store, executor, "primary-1"), true);
    assert.equal(store.getGatewayBinding("primary-1"), undefined);
    assert.match(commands[0]!, /^pi-maestro-gateway pair bootstrap/u);
    assert.equal(commands[1], "pi-maestro-gateway pair revoke pair-bootstrap");
  } finally { store.lock(); await rm(root, { recursive: true, force: true }); }
});

test("v3 Gateway bindings are encrypted, separately fenced, rotated, and invalidated by host changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v3-binding-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await store.create("master-password", [passwordHost()]);
    const digest = store.getEffectiveHostDigest("primary-1");
    const first = { hostId: "primary-1", endpoint: "https://gateway.example.test/mcp", token: "a".repeat(43), pairingId: "pair-first", expiresAt: Date.now() + 60_000, effectiveHostDigest: digest };
    await store.saveGatewayBinding("primary-1", first, 0, digest);
    const firstFence = store.getGatewayBindingFence("primary-1");
    assert.deepEqual(store.getGatewayBinding("primary-1"), first);
    assert.doesNotMatch(await readFile(path, "utf8"), /gateway\.example|pair-first|a{20}/u);
    const second = { ...first, token: "b".repeat(43), pairingId: "pair-second" };
    await store.saveGatewayBinding("primary-1", second, 1, digest);
    assert.notEqual(store.getGatewayBindingFence("primary-1"), firstFence, "credential rotation changes only the private cache fence");
    assert.equal(store.getEffectiveHostDigest("primary-1"), digest, "binding secrets never affect the effective host digest");
    await store.updateHost("primary-1", passwordHost({ host: "changed.example.test" }));
    assert.equal(store.getGatewayBinding("primary-1"), undefined, "host changes invalidate the binding in the same revision write");
  } finally { store.lock(); await rm(root, { recursive: true, force: true }); }
});

test("v1 migration backup collision fails closed and leaves the old store usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-manager-v1-collision-"));
  const path = join(root, "hosts.enc.json");
  const store = new EncryptedSshStore({ path });
  try {
    await writeV1Fixture(path, "migration-password", 8);
    const original = await readFile(path);
    await writeFile(`${path}.v1.bak`, "collision", { mode: 0o600 });
    await assert.rejects(store.unlock("migration-password"), /Unable to unlock/);
    assert.equal(store.locked, true);
    assert.deepEqual(await readFile(path), original);
    await rm(`${path}.v1.bak`);
    await store.unlock("migration-password");
    assert.equal(store.revision, 9);
  } finally {
    store.lock();
    await rm(root, { recursive: true, force: true });
  }
});
