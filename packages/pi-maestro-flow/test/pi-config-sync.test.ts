import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { link as fsLink, mkdir, mkdtemp, open as fsOpen, readFile, readdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ClientChannel } from "ssh2";
import { main } from "../src/gateway/cli.ts";
import { applyPiConfigPayload, serializePiConfigApplyError } from "../src/gateway/pi-config-apply.ts";
import { acquirePrivateStateLock } from "../src/gateway/private-state-transaction.ts";
import {
  PI_CONFIG_SYNC_COMMAND,
  PiConfigTransactionError,
  SshPiConfigSyncTransport,
  syncPiConfig,
  type PiConfigCategory,
  type PiConfigLocalSource,
} from "../src/ssh-manager/pi-config-sync.ts";
import type { SshExecutor } from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const SENTINEL = "FAKE_SECRET_SENTINEL_9d2e";
const routing = {
  version: 3,
  defaultProfile: "default",
  profiles: {
    default: {
      name: "Default",
      mappings: { development: "provider/model", verification: "provider/model" },
      fallbackMappings: { verification: ["provider/fallback"] },
      thinkingLevels: {},
      roleMappings: { verifier: { model: "provider/model", taskType: "verification", circuit: { threshold: 2, cooldownMs: 0 } } },
      typeMeta: { verification: { keywords: ["verify"] } },
    },
  },
};

function source(values: Partial<Record<PiConfigCategory, unknown>>): PiConfigLocalSource {
  return { async read(category) { const value = values[category]; return value === undefined ? undefined : Buffer.from(JSON.stringify(value)); } };
}
function payload(values: Partial<Record<PiConfigCategory, unknown>>): Buffer {
  const entries = Object.entries(values).map(([category, value]) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { category: category as PiConfigCategory, bytes, digest };
  });
  const header = Buffer.from(`${JSON.stringify({ version: 1, entries: entries.map((entry) => ({ category: entry.category, bytes: entry.bytes.length, digest: entry.digest })) })}\n`);
  return Buffer.concat([header, ...entries.map((entry) => entry.bytes)]);
}
function parseHeader(bytes: Buffer): { entries: Array<{ category: PiConfigCategory; bytes: number; digest: string }> } {
  return JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8")) as { entries: Array<{ category: PiConfigCategory; bytes: number; digest: string }> };
}
async function fixture(): Promise<{ root: string; agent: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-config-sync-"));
  const agent = join(root, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  return { root, agent };
}
const linux = { platform: "linux" as const, enforcePrivate: async () => undefined };
async function names(agent: string): Promise<string[]> { return (await readdir(agent)).filter((name) => name.startsWith(".pi-config-sync")); }

test("collect-validate-commit merges all categories and clean success leaves no transaction artifacts", async () => {
  const { root, agent } = await fixture();
  const audit: unknown[] = [];
  await writeFile(join(agent, "models.json"), JSON.stringify({ remoteRoot: true, providers: { remote: { models: [{ id: "keep" }] }, same: { old: true } } }));
  await writeFile(join(agent, "auth.json"), JSON.stringify({ remoteCredential: "keep", same: "old" }));
  await writeFile(join(agent, "teammate-models.json"), JSON.stringify({ ...routing, profiles: { ...routing.profiles, remote: { name: "Remote", mappings: {}, thinkingLevels: {} } } }));
  const result = await syncPiConfig({
    categories: ["models", "auth", "teammate"],
    source: source({
      models: { localRoot: true, providers: { same: { apiKey: SENTINEL, models: [{ id: "new" }] } } },
      auth: { same: SENTINEL, localCredential: "new" },
      teammate: routing,
    }),
    transport: { async apply(bytes) { return applyPiConfigPayload(Buffer.from(bytes), { homeDirectory: root, ...linux }); } },
    audit: { record(event) { audit.push(event); } },
  });
  assert.equal(result.receipts.length, 3);
  assert.doesNotMatch(JSON.stringify({ result, audit }), new RegExp(SENTINEL));
  const models = JSON.parse(await readFile(join(agent, "models.json"), "utf8")) as { remoteRoot: boolean; localRoot: boolean; providers: Record<string, unknown> };
  assert.equal(models.remoteRoot, true); assert.equal(models.localRoot, true); assert.ok(models.providers.remote);
  assert.deepEqual(models.providers.same, { apiKey: SENTINEL, models: [{ id: "new" }] });
  assert.equal((JSON.parse(await readFile(join(agent, "auth.json"), "utf8")) as Record<string, unknown>).same, SENTINEL);
  assert.ok((JSON.parse(await readFile(join(agent, "teammate-models.json"), "utf8")) as { profiles: Record<string, unknown> }).profiles.remote);
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("canonical routing grammar accepts digit-leading IDs and rejects circuit/profile/merged collisions before artifacts", async () => {
  const { root, agent } = await fixture();
  const digit = { ...routing, defaultProfile: "1default", profiles: { "1default": { ...routing.profiles.default } } };
  await applyPiConfigPayload(payload({ teammate: digit }), { homeDirectory: root, ...linux });
  for (const invalid of [
    { ...routing, profiles: { default: { ...routing.profiles.default, unknown: true } } },
    { ...routing, profiles: { default: { ...routing.profiles.default, roleMappings: { verifier: { circuit: { unknown: 1 } } } } } },
    { ...routing, profiles: { default: { ...routing.profiles.default, roleMappings: { verifier: { circuit: { threshold: 0 } } } } } },
    { ...routing, profiles: { default: { ...routing.profiles.default, roleMappings: { verifier: { circuit: { cooldownMs: -1 } } } } } },
  ]) await assert.rejects(applyPiConfigPayload(payload({ teammate: invalid }), { homeDirectory: root, ...linux }));
  await writeFile(join(agent, "teammate-models.json"), JSON.stringify({ ...routing, retiredProfileIds: ["new"] }));
  const collision = { ...routing, profiles: { ...routing.profiles, new: { name: "New", mappings: {}, thinkingLevels: {} } } };
  await assert.rejects(applyPiConfigPayload(payload({ teammate: collision }), { homeDirectory: root, ...linux }));
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("cooperating cross-process applies serialize recovery/read/merge/publish without lost updates", async () => {
  const { root, agent } = await fixture();
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: {} }));
  const worker = fileURLToPath(new URL("./fixtures/pi-config-sync-worker.ts", import.meta.url));
  const first = spawn(process.execPath, ["--experimental-transform-types", worker, root, "first", "250"], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker lock timeout")), 10_000);
    first.stdout.on("data", (chunk) => { if (String(chunk).includes("locked")) { clearTimeout(timer); resolve(); } });
    first.once("error", reject);
  });
  const second = spawn(process.execPath, ["--experimental-transform-types", worker, root, "second", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const wait = (child: typeof first) => new Promise<void>((resolve, reject) => {
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker failed ${code}: ${stderr}`)));
    child.once("error", reject);
  });
  await Promise.all([wait(first), wait(second)]);
  const value = JSON.parse(await readFile(join(agent, "models.json"), "utf8")) as { providers: Record<string, unknown> };
  assert.deepEqual(Object.keys(value.providers).sort(), ["first", "second"]);
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("crash after a durable target publish is recovered under the reclaimed lock before the next merge", async () => {
  const { root, agent } = await fixture();
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { old: { models: [] } } }));
  const worker = fileURLToPath(new URL("./fixtures/pi-config-sync-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-transform-types", worker, root, "crashed", "0", "crash"], { stdio: ["ignore", "pipe", "pipe"] });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(code, 79);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await applyPiConfigPayload(payload({ models: { providers: { recovered: { models: [] } } } }), { homeDirectory: root, ...linux, lockStaleMs: 1 });
  const value = JSON.parse(await readFile(join(agent, "models.json"), "utf8")) as { providers: Record<string, unknown> };
  assert.deepEqual(Object.keys(value.providers).sort(), ["old", "recovered"]);
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("stale cooperating lock owner is quarantined only after two death proofs", async () => {
  const { root, agent } = await fixture();
  const lock = join(agent, ".pi-config-sync.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ version: 1, instance: randomUUID(), token: randomUUID(), pid: 424242, processIdentity: "dead:1", createdAt: 1 }));
  await writeFile(join(lock, "heartbeat"), "0000000000000001\n");
  let probes = 0;
  const result = await applyPiConfigPayload(payload({ auth: { reclaimed: true } }), {
    homeDirectory: root, ...linux, lockStaleMs: 5,
    processLiveness: async (pid) => { if (pid === 424242) probes++; return false; },
  });
  assert.equal(result.ok, true); assert.ok(probes >= 2); assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("immutable owner lock treats age as a trigger and distinguishes live, PID reuse, and inconclusive", async () => {
  const makeStale = async (agent: string, pid: number, identity: string): Promise<void> => {
    const lock = join(agent, ".probe.lock"); await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ version: 1, instance: randomUUID(), token: randomUUID(), pid, processIdentity: identity, createdAt: 1 }));
    await writeFile(join(lock, "heartbeat"), "0000000000000001\n");
  };
  const durability = { async syncFile() {}, async syncDirectory() {} };
  for (const scenario of ["live", "inconclusive", "reuse"] as const) {
    const { root, agent } = await fixture(); await makeStale(agent, 9191, "birth:old");
    let clock = 100;
    const attempt = acquirePrivateStateLock({
      directory: agent, name: ".probe.lock", timeoutMs: 2, staleMs: 5, heartbeatMs: 1000,
      now: () => clock, delay: async () => { clock += 3; }, pid: 8181,
      processIdentity: async (pid) => pid === 8181 ? "birth:self" : scenario === "reuse" ? "birth:new" : scenario === "live" ? "birth:old" : null,
      processLiveness: async () => scenario === "inconclusive" ? null : true,
      enforcePrivate: async () => undefined, durability,
    });
    if (scenario === "reuse") { const acquired = await attempt; assert.equal(await acquired.release(), true); }
    else await assert.rejects(attempt, /lock timeout/u);
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat reuses the originally retained FileHandle", async () => {
  const { root, agent } = await fixture(); let heartbeatOpens = 0; let heartbeatWrites = 0;
  const openSeam = (async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args);
    if (!String(args[0]).endsWith("heartbeat")) return handle;
    heartbeatOpens++;
    return new Proxy(handle, { get(target, property) {
      if (property === "write") return async (...writeArgs: Parameters<typeof target.write>) => { heartbeatWrites++; return target.write(...writeArgs); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof fsOpen;
  const owned = await acquirePrivateStateLock({
    directory: agent, name: ".probe.lock", heartbeatMs: 5,
    processIdentity: async () => "birth:self", processLiveness: async () => true,
    enforcePrivate: async () => undefined, durability: { async syncFile() {}, async syncDirectory() {} },
    fs: { open: openSeam },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeatOpens, 1); assert.ok(heartbeatWrites > 1);
  assert.equal(await owned.release(), true);
  await rm(root, { recursive: true, force: true });
});

test("release refuses a successor identity and leaves its canonical directory untouched", async () => {
  const { root, agent } = await fixture();
  const owned = await acquirePrivateStateLock({
    directory: agent, name: ".probe.lock", heartbeatMs: 1000,
    processIdentity: async () => "birth:self", processLiveness: async () => true,
    enforcePrivate: async () => undefined, durability: { async syncFile() {}, async syncDirectory() {} },
  });
  const successor = JSON.stringify({ version: 1, instance: randomUUID(), token: randomUUID(), pid: 777, processIdentity: "birth:successor", createdAt: 100 });
  await writeFile(join(agent, ".probe.lock", "owner.json"), successor);
  assert.equal(await owned.release(), false);
  assert.equal(await readFile(join(agent, ".probe.lock", "owner.json"), "utf8"), successor);
  await rm(root, { recursive: true, force: true });
});

test("no-replace publication preserves EEXIST racers for absent and displaced targets", async () => {
  for (const existing of [false, true]) {
    const { root, agent } = await fixture();
    if (existing) await writeFile(join(agent, "auth.json"), JSON.stringify({ old: true }));
    const foreign = JSON.stringify({ foreign: SENTINEL }); let injected = false;
    let caught!: PiConfigTransactionError;
    try {
      await applyPiConfigPayload(payload({ auth: { next: true } }), {
        homeDirectory: root, ...linux,
        link: async (sourcePath, targetPath) => {
          if (!injected && targetPath === join(agent, "auth.json")) { injected = true; await writeFile(targetPath, foreign); }
          return fsLink(sourcePath, targetPath);
        },
      });
    } catch (error) { caught = error as PiConfigTransactionError; }
    assert.equal(caught.disposition, "recovery-required");
    assert.equal(await readFile(join(agent, "auth.json"), "utf8"), foreign);
    await rm(root, { recursive: true, force: true });
  }
});

test("precommit fault rolls back durably and exposes typed sanitized disposition", async () => {
  const { root, agent } = await fixture();
  const oldModels = JSON.stringify({ providers: { old: { models: [] } } });
  const oldAuth = JSON.stringify({ old: "credential" });
  await writeFile(join(agent, "models.json"), oldModels); await writeFile(join(agent, "auth.json"), oldAuth);
  let caught!: PiConfigTransactionError;
  try {
    await applyPiConfigPayload(payload({ models: { providers: { next: { apiKey: SENTINEL, models: [] } } }, auth: { next: SENTINEL } }), {
      homeDirectory: root, ...linux, beforePublish: async (category) => { if (category === "auth") throw new Error(SENTINEL); },
    });
  } catch (error) { caught = error as PiConfigTransactionError; }
  assert.equal(caught.disposition, "rolled-back"); assert.equal(caught.cleanup, "complete");
  assert.doesNotMatch(`${caught.message}${serializePiConfigApplyError(caught)}`, new RegExp(`${SENTINEL}|${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  assert.equal((await readFile(join(agent, "models.json"), "utf8")).trim(), oldModels);
  assert.equal((await readFile(join(agent, "auth.json"), "utf8")).trim(), oldAuth);
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("foreign target at final digest check is never overwritten and leaves recovery-required journal", async () => {
  const { root, agent } = await fixture();
  const foreign = JSON.stringify({ foreign: SENTINEL });
  let journalText = "";
  let caught!: PiConfigTransactionError;
  try {
    await applyPiConfigPayload(payload({ auth: { next: "secret" } }), {
      homeDirectory: root, ...linux,
      beforePublish: async () => {
        journalText = await readFile(join(agent, ".pi-config-sync-journal.json"), "utf8");
        await writeFile(join(agent, "auth.json"), foreign);
      },
    });
  } catch (error) { caught = error as PiConfigTransactionError; }
  assert.equal(caught.disposition, "recovery-required"); assert.equal(await readFile(join(agent, "auth.json"), "utf8"), foreign);
  assert.doesNotMatch(journalText, new RegExp(`${SENTINEL}|${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  assert.ok((await names(agent)).includes(".pi-config-sync-journal.json"));
  await rm(root, { recursive: true, force: true });
});

test("displace and post-link crashes restore the exact prior file with no overwrite", async () => {
  for (const point of ["publish:displaced", "publish:durable"] as const) {
    const { root, agent } = await fixture(); const old = JSON.stringify({ old: true });
    await writeFile(join(agent, "auth.json"), old);
    let caught!: PiConfigTransactionError;
    try {
      await applyPiConfigPayload(payload({ auth: { next: true } }), {
        homeDirectory: root, ...linux, fault: async (seen) => { if (seen === point) throw new Error("crash seam"); },
      });
    } catch (error) { caught = error as PiConfigTransactionError; }
    assert.equal(caught.disposition, "rolled-back");
    assert.equal((await readFile(join(agent, "auth.json"), "utf8")).trim(), old);
    assert.deepEqual(await names(agent), []);
    await rm(root, { recursive: true, force: true });
  }
});

test("a visible committed marker remains a truthful success when its first parent flush fails", async () => {
  const { root, agent } = await fixture(); let sawCommittedFile = false; let failed = false;
  const result = await applyPiConfigPayload(payload({ auth: { committed: true } }), {
    homeDirectory: root, platform: "win32", windowsAclRunner: async () => undefined,
    windowsDurabilityRunner: async (request) => {
      if (request.env.PI_MAESTRO_SYNC_KIND === "directory") {
        sawCommittedFile ||= (await names(agent)).some((name) => name.endsWith(".committed"));
        if (sawCommittedFile && !failed) { failed = true; throw new Error("flush failed"); }
      }
    },
  });
  assert.equal(result.ok, true); assert.equal(sawCommittedFile, true); assert.equal(failed, true);
  assert.deepEqual(await names(agent), []);
  await rm(root, { recursive: true, force: true });
});

test("legacy applying journal rolls back and legacy committed journal is never reported rolled-back", async () => {
  for (const phase of ["applying", "committed"] as const) {
    const { root, agent } = await fixture(); const id = randomUUID();
    const before = Buffer.from(`${JSON.stringify({ old: true })}\n`); const after = Buffer.from(`${JSON.stringify({ committedOld: true })}\n`);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const target = { category: "auth", target: "auth.json", next: `.pi-config-sync-${id}-auth.next`, before: `.pi-config-sync-${id}-auth.before`, beforeDigest: digest(before), afterDigest: digest(after), bytes: 2, sourceDigest: "0".repeat(64) };
    await writeFile(join(agent, "auth.json"), after); await writeFile(join(agent, target.next), after); await writeFile(join(agent, target.before), before);
    await writeFile(join(agent, ".pi-config-sync-journal.json"), `${JSON.stringify({ version: 1, transactionId: id, phase, targets: [target] })}\n`);
    const result = await applyPiConfigPayload(payload({ auth: { new: true } }), { homeDirectory: root, ...linux });
    assert.equal(result.ok, true);
    const value = JSON.parse(await readFile(join(agent, "auth.json"), "utf8") as unknown as string) as Record<string, unknown>;
    assert.equal(value.new, true);
    assert.equal(value[phase === "committed" ? "committedOld" : "old"], true);
    assert.deepEqual(await names(agent), []);
    before.fill(0); after.fill(0); await rm(root, { recursive: true, force: true });
  }
});

test("capture substitution is preserved and produces cleanup-pending rather than deletion", async () => {
  const { root, agent } = await fixture(); const foreign = Buffer.from(`foreign-${SENTINEL}`); let substituted = false;
  const result = await applyPiConfigPayload(payload({ auth: { safe: true } }), {
    homeDirectory: root, ...linux,
    rename: async (sourcePath, targetPath) => {
      await fsRename(sourcePath, targetPath);
      if (!substituted && sourcePath.endsWith(".next") && targetPath.includes("capture-")) { substituted = true; await rm(targetPath); await writeFile(targetPath, foreign); }
    },
  });
  assert.equal(result.status, "committed-cleanup-pending"); assert.equal(substituted, true);
  assert.ok((await names(agent)).some((name) => name.includes("capture-")));
  assert.equal((JSON.parse(await readFile(join(agent, "auth.json"), "utf8")) as Record<string, unknown>).safe, true);
  foreign.fill(0); await rm(root, { recursive: true, force: true });
});

test("durable committed cleanup failure is additive success and the next locked operation resumes cleanup", async () => {
  const { root, agent } = await fixture();
  const first = await applyPiConfigPayload(payload({ auth: { token: SENTINEL } }), {
    homeDirectory: root, ...linux, fault: async (point) => { if (point === "cleanup:journal") throw new Error("injected"); },
  });
  assert.equal(first.status, "committed-cleanup-pending");
  assert.ok((await names(agent)).includes(".pi-config-sync-journal.json"));
  const second = await applyPiConfigPayload(payload({ auth: { second: true } }), { homeDirectory: root, ...linux });
  assert.equal(second.status, undefined); assert.deepEqual(await names(agent), []);
  const auth = JSON.parse(await readFile(join(agent, "auth.json"), "utf8")) as Record<string, unknown>;
  assert.equal(auth.token, SENTINEL); assert.equal(auth.second, true);
  await rm(root, { recursive: true, force: true });
});

test("Windows uses fixed ACL and non-noop FlushFileBuffers adapters without argv secret/path leakage", async () => {
  const { root } = await fixture();
  const acl: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const sync: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const result = await applyPiConfigPayload(payload({ auth: { token: SENTINEL } }), {
    homeDirectory: root, platform: "win32",
    windowsAclRunner: async (request) => { acl.push(request); },
    windowsDurabilityRunner: async (request) => { sync.push(request); },
  });
  assert.equal(result.ok, true); assert.ok(acl.length >= 4); assert.ok(sync.length >= 8);
  for (const request of [...acl, ...sync]) {
    assert.deepEqual(request.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    assert.doesNotMatch(request.args.join(" "), new RegExp(`${SENTINEL}|${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  }
  assert.ok(sync.some((request) => request.env.PI_MAESTRO_SYNC_KIND === "directory"));
  await rm(root, { recursive: true, force: true });
});

test("CLI config-sync failures use only the fixed versioned sanitized envelope", async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let out = "", err = ""; stdout.on("data", (chunk) => { out += chunk; }); stderr.on("data", (chunk) => { err += chunk; });
  stdin.end(Buffer.from(`not-json-${SENTINEL}`));
  assert.equal(await main(["config-sync", "apply"], { stdin, stdout, stderr }), 1);
  assert.equal(out, "");
  assert.deepEqual(JSON.parse(err), { version: 1, ok: false, error: { code: "PI_CONFIG_APPLY_FAILED", disposition: "rejected", cleanup: "complete" } });
  assert.doesNotMatch(err, new RegExp(SENTINEL));
});

type FakeChannelAction = (channel: FakeChannel) => void;
class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  written: Buffer | undefined;
  endCalls = 0;
  destroyCalls = 0;
  constructor(private readonly action: FakeChannelAction, private readonly throwOnEnd = false) { super(); }
  end(chunk?: string | Uint8Array): void {
    this.endCalls++;
    if (chunk !== undefined) this.written = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.throwOnEnd) throw new Error(SENTINEL);
    this.action(this);
  }
  destroy(): this {
    this.destroyCalls++;
    this.emit("error", new Error(SENTINEL));
    this.emit("close");
    return this;
  }
  success(status?: "committed-cleanup-pending"): void {
    const header = parseHeader(this.written!);
    this.emit("data", JSON.stringify({ ok: true, receipts: header.entries.map((entry) => ({ ...entry, backup: false })), ...(status ? { status } : {}) }));
    this.emit("close");
  }
}
function transportFor(channel: ClientChannel, timeoutMs = 60_000, closed?: () => void): SshPiConfigSyncTransport {
  const executor = { async openChannel(_host: unknown, request: { command: string }) {
    assert.equal(request.command, PI_CONFIG_SYNC_COMMAND);
    return { channel, close() { closed?.(); } };
  } } as unknown as SshExecutor;
  return new SshPiConfigSyncTransport(executor, { id: "server-1", hostKey: "pinned" } as unknown as SshHost, timeoutMs);
}

interface ExchangeMatrixRow {
  name: string;
  action: FakeChannelAction;
  throwOnEnd?: boolean;
  controller?: AbortController;
  expected: { kind: "success"; status?: "committed-cleanup-pending" } | { kind: "error"; name: string; message: string; disposition?: string; cleanup?: string; destroys?: boolean };
}

const genericRemoteFailure = { kind: "error", name: "Error", message: "Pi configuration synchronization failed" } as const;
const exchangeMatrix: ExchangeMatrixRow[] = [
  { name: "success", action: (channel) => queueMicrotask(() => channel.success()), expected: { kind: "success" } },
  { name: "timeout", action: () => undefined, expected: { kind: "error", name: "TimeoutError", message: "Pi configuration synchronization timed out" } },
  ...((): ExchangeMatrixRow[] => {
    const controller = new AbortController();
    return [{ name: "post-open abort", controller, action: () => queueMicrotask(() => controller.abort()), expected: { kind: "error", name: "AbortError", message: "Pi configuration synchronization aborted" } }];
  })(),
  { name: "channel error", action: (channel) => queueMicrotask(() => channel.emit("error", new Error(SENTINEL))), expected: genericRemoteFailure },
  { name: "joint stdout/stderr overflow", action: (channel) => queueMicrotask(() => { channel.emit("data", Buffer.alloc(40 * 1024, 0x61)); channel.stderr.emit("data", Buffer.alloc(25 * 1024, 0x62)); }), expected: genericRemoteFailure },
  { name: "malformed UTF-8 stderr", action: (channel) => queueMicrotask(() => { channel.stderr.emit("data", Buffer.from([0xc3, 0x28])); channel.emit("close"); }), expected: genericRemoteFailure },
  { name: "malformed remote envelope", action: (channel) => queueMicrotask(() => { channel.stderr.emit("data", `{\"secret\":\"${SENTINEL}\"}`); channel.emit("close"); }), expected: genericRemoteFailure },
  { name: "malformed receipt", action: (channel) => queueMicrotask(() => { channel.emit("data", JSON.stringify({ ok: true, receipts: [] })); channel.emit("close"); }), expected: { ...genericRemoteFailure, destroys: false } },
  { name: "synchronous end throw", throwOnEnd: true, action: () => undefined, expected: genericRemoteFailure },
  { name: "legacy receipt without status", action: (channel) => queueMicrotask(() => channel.success()), expected: { kind: "success" } },
  { name: "committed cleanup pending", action: (channel) => queueMicrotask(() => channel.success("committed-cleanup-pending")), expected: { kind: "success", status: "committed-cleanup-pending" } },
  { name: "validated transaction envelope", action: (channel) => queueMicrotask(() => { channel.stderr.emit("data", serializePiConfigApplyError(new PiConfigTransactionError("rolled-back", "pending"))); channel.emit("close"); }), expected: { kind: "error", name: "PiConfigTransactionError", message: "Pi configuration synchronization rolled back", disposition: "rolled-back", cleanup: "pending" } },
  { name: "competing close error abort", ...(() => { const controller = new AbortController(); return { controller, action: (channel: FakeChannel) => queueMicrotask(() => { channel.success(); channel.emit("error", new Error(SENTINEL)); controller.abort(); channel.emit("close"); }) }; })(), expected: { kind: "success" } },
];

test("SSH exchange table covers every post-open terminal interleaving and zeroes mutable buffers", async (t) => {
  for (const row of exchangeMatrix) await t.test(row.name, async () => {
    const channel = new FakeChannel(row.action, row.throwOnEnd);
    const noop = (): void => undefined;
    channel.on("data", noop); channel.on("error", noop); channel.on("close", noop); channel.stderr.on("data", noop);
    const baseline = { data: channel.listenerCount("data"), error: channel.listenerCount("error"), close: channel.listenerCount("close"), stderr: channel.stderr.listenerCount("data") };
    const timeoutMs = 8;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ handle: ReturnType<typeof setTimeout>; cleared: boolean }> = [];
    const combined: Buffer[] = [];
    const captured: Buffer[] = [];
    const realConcat = Buffer.concat;
    const realFrom = Buffer.from;
    let handleCloses = 0;
    let auditCalls = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(callback, delay, ...args);
      if (delay === timeoutMs) timers.push({ handle, cleared: false });
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer) timer.cleared = true;
      return realClearTimeout(handle);
    }) as typeof clearTimeout;
    Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
      const bytes = realConcat(list, totalLength);
      if (new Error().stack?.includes("src\\ssh-manager\\pi-config-sync.ts")) combined.push(bytes);
      return bytes;
    }) as typeof Buffer.concat;
    Buffer.from = ((...args: unknown[]) => {
      const bytes = Reflect.apply(realFrom, Buffer, args) as Buffer;
      if (new Error().stack?.includes("copyCaptureChunk")) captured.push(bytes);
      return bytes;
    }) as typeof Buffer.from;
    try {
      const attempt = syncPiConfig({
        categories: ["auth"], source: source({ auth: { token: SENTINEL } }),
        transport: transportFor(channel as unknown as ClientChannel, timeoutMs, () => { handleCloses++; }), signal: row.controller?.signal,
        audit: { record() { auditCalls++; } },
      });
      if (row.expected.kind === "success") {
        const result = await attempt;
        assert.equal(result.ok, true); assert.equal(result.status, row.expected.status);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL));
      } else {
        await assert.rejects(attempt, (error: unknown) => error instanceof Error
          && error.name === row.expected.name && error.message === row.expected.message
          && (row.expected.disposition === undefined || error instanceof PiConfigTransactionError && error.disposition === row.expected.disposition && error.cleanup === row.expected.cleanup)
          && !error.message.includes(SENTINEL));
      }
      await new Promise((resolve) => realSetTimeout(resolve, timeoutMs * 2));
      assert.equal(channel.endCalls, 1, "channel opened and payload ended once");
      assert.equal(handleCloses, 1, "transport handle closed once");
      assert.equal(auditCalls, 1, "sync settled and audited once");
      assert.equal(timers.length, 1, "one post-open exchange timer created");
      assert.equal(timers[0]!.cleared, true, "exchange timer cancelled at settlement");
      assert.deepEqual({ data: channel.listenerCount("data"), error: channel.listenerCount("error"), close: channel.listenerCount("close"), stderr: channel.stderr.listenerCount("data") }, baseline);
      assert.ok(combined.length >= 1);
      for (const bytes of combined) assert.ok(bytes.every((byte) => byte === 0), "combined buffer zeroed");
      for (const bytes of captured) assert.ok(bytes.every((byte) => byte === 0), "capture chunk zeroed");
      assert.ok(channel.written?.every((byte) => byte === 0), "payload buffer zeroed");
      const expectedDestroys = row.expected.kind === "error" && row.expected.destroys !== false ? 1 : 0;
      assert.equal(channel.destroyCalls, expectedDestroys, "exchange failure destroys exactly once after settlement");
    } finally {
      Buffer.concat = realConcat;
      Buffer.from = realFrom;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

test("full sync preserves a pre-open AbortError identity", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(syncPiConfig({ categories: ["auth"], source: source({ auth: { token: SENTINEL } }), transport: { async apply() { throw new Error("must not run"); } }, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError" && error.message === "Pi configuration synchronization aborted");
});
