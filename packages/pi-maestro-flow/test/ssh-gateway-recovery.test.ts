import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedSshStore } from "../src/ssh-manager/encrypted-store.ts";
import { GatewaySessionLauncher, type GatewayLaunchBindingPersistence } from "../src/ssh-manager/gateway-session-launch.ts";
import { validateSshGatewayLaunchBinding, type SshGatewayLaunchBinding, type SshHost } from "../src/ssh-manager/model.ts";
import type { TodoTask } from "../src/tools/todo.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const DIGEST = "a".repeat(64);
const ENDPOINT = "b".repeat(64);
const PRINCIPAL = "stdio:local-owner";
const NOW = 1_700_000_000_000;

function host(): SshHost {
  return { id: "host-a", label: "A", host: "host.test", user: "runner", port: 22, shell: "bash", hostKey: PIN, auth: { kind: "agent" }, tags: [], jumpHostId: null, monitorEnabled: false };
}
function todo(): TodoTask {
  return { id: "14", subject: "recover", status: "in_progress", blockedBy: [], skills: [], resourceUris: [], createdBy: { kind: "root", id: "root", label: "root" }, assignee: { kind: "root", id: "root", label: "root" }, createdAt: 1, updatedAt: 1 };
}
function memoryPersistence(seed?: SshGatewayLaunchBinding): GatewayLaunchBindingPersistence & { values: Map<string, SshGatewayLaunchBinding> } {
  const values = new Map<string, SshGatewayLaunchBinding>();
  if (seed) values.set(seed.bindingId, structuredClone(seed));
  return {
    values,
    getGatewayLaunchBinding: (hostId, bindingId) => {
      const value = values.get(bindingId);
      return value?.hostId === hostId ? structuredClone(value) : undefined;
    },
    saveGatewayLaunchBinding: async (binding) => { values.set(binding.bindingId, structuredClone(binding)); },
    removeGatewayLaunchBinding: async (hostId, bindingId) => Boolean(values.get(bindingId)?.hostId === hostId && values.delete(bindingId)),
  };
}

interface RemoteState {
  principal: string;
  sessionId: string;
  sessionRevision: number;
  memberId: string;
  memberPrincipal: string;
  memberGeneration: number;
  leaseExpiresAt: number;
  handle: string;
  taskStatus: "running" | "lost";
}
function recoveryCaller(state: RemoteState, calls: Array<{ tool: string; action: unknown }> = []) {
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ tool, action: args.action });
    const meta = { principalId: state.principal };
    if (tool === "host" && args.action === "describe") return { ok: true, data: { cwd: "/remote" }, meta };
    if (tool === "session" && args.action === "get") return { ok: true, data: { session: { id: state.sessionId, revision: state.sessionRevision }, members: [{ id: state.memberId, principalId: state.memberPrincipal, status: "active", generation: state.memberGeneration, leaseExpiresAt: state.leaseExpiresAt }] }, meta };
    if (tool === "monitor" && args.action === "observe") return { ok: true, data: { handle: state.handle, nextCursor: args.cursor, task: { status: state.taskStatus } }, meta };
    throw new Error(`unexpected ${tool}.${String(args.action)}`);
  };
}

function storedBinding(overrides: Partial<SshGatewayLaunchBinding> = {}): SshGatewayLaunchBinding {
  return {
    version: 1,
    bindingId: "launch-binding-1",
    hostId: "host-a",
    effectiveHostDigest: DIGEST,
    endpointIdentity: ENDPOINT,
    gatewayPrincipalId: PRINCIPAL,
    gatewaySessionId: "gateway-session-1",
    gatewayMemberId: "gateway-member-1",
    sessionRevision: 3,
    memberGeneration: 2,
    leaseExpiresAt: NOW + 90_000,
    leaseTtlMs: 90_000,
    operationId: "ssh-start-operation-1",
    executionHandle: "execution-1",
    generation: 4,
    cursor: 7,
    ...overrides,
  };
}
function matchingRemote(binding: SshGatewayLaunchBinding): RemoteState {
  return { principal: binding.gatewayPrincipalId.slice(binding.gatewayPrincipalId.indexOf(":") + 1), sessionId: binding.gatewaySessionId, sessionRevision: binding.sessionRevision, memberId: binding.gatewayMemberId, memberPrincipal: binding.gatewayPrincipalId, memberGeneration: binding.memberGeneration, leaseExpiresAt: binding.leaseExpiresAt, handle: binding.executionHandle, taskStatus: "running" };
}

test("client restart restores only a validated observation binding and never relaunches", async () => {
  const binding = storedBinding();
  const persistence = memoryPersistence(binding);
  const calls: Array<{ tool: string; action: unknown }> = [];
  const launcher = new GatewaySessionLauncher(() => NOW, persistence);
  const args = { action: "observe", sessionId: binding.gatewaySessionId, memberId: binding.gatewayMemberId, handle: binding.executionHandle, cursor: binding.cursor, _sshLaunch: { bindingId: binding.bindingId, generation: binding.generation } };
  await launcher.restoreMonitorBinding(recoveryCaller(matchingRemote(binding), calls), binding.hostId, DIGEST, ENDPOINT, args, 30);
  const prepared = launcher.prepareMonitorCall(binding.hostId, DIGEST, args);
  assert.equal(prepared.args._sshLaunch, undefined);
  assert.equal(prepared.args.handle, binding.executionHandle);
  assert.deepEqual(calls.map((call) => `${call.tool}.${String(call.action)}`), ["host.describe", "session.get", "monitor.observe"]);
  assert.equal(calls.some((call) => call.action === "start-pi"), false, "restore does not reattach or relaunch a daemon child");
});

test("restore revalidates every host, endpoint, principal, session, member, lease, and handle fence", async () => {
  const binding = storedBinding();
  const cases: Array<{ name: string; hostDigest?: string; endpoint?: string; stored?: SshGatewayLaunchBinding; remote?: Partial<RemoteState>; pattern: RegExp }> = [
    { name: "host", hostDigest: "c".repeat(64), pattern: /host fence/ },
    { name: "endpoint", endpoint: "d".repeat(64), pattern: /endpoint identity/ },
    { name: "principal", remote: { principal: "other" }, pattern: /principal/ },
    { name: "session", remote: { sessionRevision: binding.sessionRevision + 1 }, pattern: /session fence/ },
    { name: "member principal", remote: { memberPrincipal: "stdio:other" }, pattern: /member fence/ },
    { name: "member generation", remote: { memberGeneration: binding.memberGeneration + 1 }, pattern: /member fence/ },
    { name: "lease", stored: storedBinding({ leaseExpiresAt: NOW }), pattern: /lease expired/ },
    { name: "handle", remote: { handle: "execution-other" }, pattern: /execution handle/ },
  ];
  for (const item of cases) {
    const candidate = item.stored ?? binding;
    const persistence = memoryPersistence(candidate);
    const launcher = new GatewaySessionLauncher(() => NOW, persistence);
    const remote = { ...matchingRemote(candidate), ...item.remote };
    const args = { action: "observe", sessionId: candidate.gatewaySessionId, memberId: candidate.gatewayMemberId, handle: candidate.executionHandle, cursor: candidate.cursor, _sshLaunch: { bindingId: candidate.bindingId, generation: candidate.generation } };
    await assert.rejects(launcher.restoreMonitorBinding(recoveryCaller(remote), candidate.hostId, item.hostDigest ?? DIGEST, item.endpoint ?? ENDPOINT, args, 30), item.pattern, item.name);
    assert.equal(persistence.values.size, 0, `${item.name} mismatch quarantines the local receipt`);
  }
});

test("daemon restart exposes lost or outcome-unknown without child reattach or relaunch", async () => {
  const binding = storedBinding();
  const calls: Array<{ tool: string; action: unknown }> = [];
  const launcher = new GatewaySessionLauncher(() => NOW, memoryPersistence(binding));
  const remote = matchingRemote(binding); remote.taskStatus = "lost";
  const args = { action: "observe", sessionId: binding.gatewaySessionId, memberId: binding.gatewayMemberId, handle: binding.executionHandle, cursor: binding.cursor, _sshLaunch: { bindingId: binding.bindingId, generation: binding.generation } };
  await launcher.restoreMonitorBinding(recoveryCaller(remote, calls), binding.hostId, DIGEST, ENDPOINT, args, 30);
  assert.equal(calls.some((call) => call.action === "start-pi"), false);

  let starts = 0;
  const fresh = new GatewaySessionLauncher(() => NOW, memoryPersistence());
  await assert.rejects(fresh.start(async (tool, callArgs) => {
    const meta = { principalId: "local-owner" };
    if (tool === "host") return { ok: true, data: { cwd: "/remote" }, meta };
    if (callArgs.action === "create") return { ok: true, data: { session: { revision: 1 }, member: { id: callArgs.ownerId, principalId: PRINCIPAL, status: "active", generation: 1, leaseExpiresAt: NOW + 90_000, updatedAt: NOW } }, meta };
    if (callArgs.action === "start-pi") { starts += 1; return { ok: false, error: { code: "operation_outcome_unknown", message: "outcome unknown" }, meta }; }
    throw new Error("unexpected call");
  }, "host-a", DIGEST, "local-session", [todo()], { action: "start_pi", todoIds: ["14"], requestId: "restart-outcome" }, undefined, ENDPOINT), /outcome unknown/);
  assert.equal(starts, 1, "outcome-unknown is surfaced without an automatic second dispatch");
});

function writeV3Fixture(path: string, password: string): Promise<void> {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const header = { version: 1, kdf: { name: "scrypt", N: 32_768, r: 8, p: 1, keyLength: 32 }, cipher: { name: "aes-256-gcm" }, salt: salt.toString("base64"), iv: iv.toString("base64") };
  const plaintext = Buffer.from(JSON.stringify({ version: 3, revision: 9, keys: [], hosts: [host()], gatewayBindings: [] }));
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { ...header, tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  key.fill(0); salt.fill(0); iv.fill(0); plaintext.fill(0); ciphertext.fill(0);
  return writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

test("encrypted store migrates v3 at the read boundary and persists only allow-listed non-secret launch metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ssh-recovery-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "hosts.enc.json");
  await writeV3Fixture(path, "password");
  const original = await readFile(path);
  const store = new EncryptedSshStore({ path });
  await store.unlock("password");
  assert.equal(store.revision, 10);
  assert.deepEqual(await readFile(`${path}.v3.bak`), original);
  const digest = store.getEffectiveHostDigest("host-a");
  const binding = storedBinding({ effectiveHostDigest: digest });
  await store.saveGatewayLaunchBinding(binding);
  store.lock(); await store.unlock("password");
  assert.deepEqual(store.getGatewayLaunchBinding("host-a", binding.bindingId), binding);
  for (const secretField of ["token", "prompt", "message", "rawCommand"] as const) {
    assert.throws(() => validateSshGatewayLaunchBinding({ ...binding, [secretField]: "secret" }), /unsupported field/);
  }
  assert.doesNotMatch(await readFile(path, "utf8"), /execution-1|ssh-start-operation-1|secret/);
  store.lock();
});
