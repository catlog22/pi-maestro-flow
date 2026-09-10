import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { migrateLegacyGateway } from "../src/gateway/config-migration.ts";
import { GatewayLegacyMigrationError } from "../src/gateway/migration-contracts.ts";

const noPrivate = async () => undefined;
const noDurability = { syncFile: async () => undefined, syncDirectory: async () => undefined };
const dead = async () => false as const;
const identity = async () => "migration-test-process";
function options(home: string, extra: Record<string, unknown> = {}) {
  return { homeDirectory: home, enforcePrivate: noPrivate, durability: noDurability, processLiveness: dead, processIdentity: identity, residentProbe: async () => undefined, ...extra };
}
function sha(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
async function fixture(): Promise<{ home: string; legacy: string; native: string; workspace: string }> {
  const home = await mkdtemp(join(tmpdir(), "gateway-migration-"));
  const legacy = join(home, ".mcpx");
  const native = join(home, ".pi", "agent", "gateway");
  const workspace = join(home, "workspace");
  await mkdir(join(legacy, "gateway", "v1"), { recursive: true });
  await mkdir(join(legacy, "tasks", "delegated", "session-private"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(legacy, "config.yaml"), [
    "version: 1",
    "auth:",
    "  mode: bearer",
    "  token: migrate-secret-token",
    "  oauth:",
    "    password: migrate-secret-password",
    "    server_url: https://legacy-tunnel.invalid",
    "workspaces:",
    `  - path: ${workspace.replace(/\\/gu, "/")}`,
    "    mode: permanent",
    `  - path: ${join(home, "config-lease").replace(/\\/gu, "/")}`,
    "    ttl_seconds: 600",
    "state:",
    `  root_dir: ${join(legacy, "runtime").replace(/\\/gu, "/")}`,
    "legacy_tunnel_provider:",
    "  token: must-not-copy",
    "",
  ].join("\n"));
  await writeFile(join(legacy, "gateway", "v1", "workspaces.json"), JSON.stringify({ version: 1, workspaces: [
    { version: 1, path: workspace, mode: "permanent", generation: 4, registeredAt: 10, updatedAt: 11, ownerToken: "legacy-owner-token-secret" },
    { version: 1, path: join(home, "leased"), mode: "lease", generation: 2, registeredAt: 20, updatedAt: 21, expiresAt: 123456, ownerToken: "legacy-lease-owner" },
    { version: 1, path: join(home, "ttl-only"), mode: "lease", ttlMs: 999999 },
  ] }));
  await writeFile(join(legacy, "gateway", "v1", "pairings.json"), JSON.stringify({ version: 1, pairings: [
    { version: 1, id: "pair-legacy", tokenHash: "a".repeat(64), createdAt: 100, expiresAt: 200, label: "phone", audience: ["tunnel", "gateway"] },
  ] }));
  await writeFile(join(legacy, "tasks", "delegated", "session-private", "task-private.json"), '{"prompt":"do not disclose this task"}\n');
  await writeFile(join(legacy, "mcpx-server.pid"), "999999\n");
  return { home, legacy, native, workspace };
}

test("dry-run writes nothing; apply is idempotent, redacted, and preserves legacy checksums", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.home, { recursive: true, force: true }));
  const before = new Map<string, string>();
  for (const path of ["config.yaml", join("gateway", "v1", "workspaces.json"), join("gateway", "v1", "pairings.json"), join("tasks", "delegated", "session-private", "task-private.json")]) before.set(path, sha(await readFile(join(f.legacy, path))));

  const dry = await migrateLegacyGateway("dry-run", options(f.home));
  assert.equal(dry.status, "ready");
  await assert.rejects(() => lstat(f.native), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.doesNotMatch(JSON.stringify(dry), /migrate-secret|session-private|task-private|legacy-tunnel\.invalid/u);

  const applied = await migrateLegacyGateway("apply", options(f.home));
  assert.equal(applied.status, "applied");
  assert.ok(applied.artifacts.some((entry) => entry.kind === "tasks-snapshot" && entry.disposition === "published" && entry.records === 1));
  const configText = await readFile(join(f.native, "config.yaml"), "utf8");
  const config = parseYaml(configText) as Record<string, unknown>;
  assert.equal(config.version, 2);
  assert.deepEqual(config.state, {});
  assert.doesNotMatch(configText, /legacy-tunnel|serverUrl|server_url|must-not-copy/u);
  assert.match(configText, /migrate-secret-token/u, "necessary bearer configuration is retained in the private native config");

  const registry = JSON.parse(await readFile(join(f.native, "v1", "workspaces.json"), "utf8")) as { workspaces: Array<Record<string, unknown>> };
  assert.equal(registry.workspaces.length, 2, "TTL-only config/registry leases are not renewed");
  assert.equal(registry.workspaces.find((entry) => entry.mode === "lease")?.expiresAt, 123456);
  assert.equal(registry.workspaces.every((entry) => entry.ownerToken === undefined), true);
  assert.equal(registry.workspaces.find((entry) => entry.mode === "permanent")?.generation, 4);

  const pairingsText = await readFile(join(f.native, "v1", "pairings.json"), "utf8");
  const pairings = JSON.parse(pairingsText) as { pairings: Array<Record<string, unknown>> };
  assert.equal(pairings.pairings[0]?.tokenHash, "a".repeat(64));
  assert.equal(pairings.pairings[0]?.expiresAt, 200);
  assert.equal(pairings.pairings[0]?.audience, undefined);
  assert.doesNotMatch(pairingsText, /tunnel/u);

  const snapshotText = await readFile(join(f.native, "v1", "legacy-tasks-snapshot.json"), "utf8");
  assert.doesNotMatch(snapshotText, /session-private|task-private|do not disclose/u);
  assert.equal((JSON.parse(snapshotText) as { recordCount: number }).recordCount, 1);
  for (const [path, digest] of before) assert.equal(sha(await readFile(join(f.legacy, path))), digest);

  const second = await migrateLegacyGateway("apply", options(f.home));
  assert.equal(second.status, "already-applied");
  assert.equal(second.sourceDigest, applied.sourceDigest);
  assert.deepEqual((await readdir(f.native)).filter((name) => name.includes("staging") || name.includes("transaction")), []);
});

test("apply fails closed on collision, unknown versions, live/unknown process evidence, and symlink escape", async (t) => {
  const collision = await fixture();
  t.after(() => rm(collision.home, { recursive: true, force: true }));
  await mkdir(collision.native, { recursive: true });
  await writeFile(join(collision.native, "config.yaml"), "foreign: true\n");
  await assert.rejects(() => migrateLegacyGateway("apply", options(collision.home)), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_COLLISION");
  assert.equal(await readFile(join(collision.native, "config.yaml"), "utf8"), "foreign: true\n");

  const versioned = await fixture();
  t.after(() => rm(versioned.home, { recursive: true, force: true }));
  await writeFile(join(versioned.legacy, "config.yaml"), "version: 99\n");
  await assert.rejects(() => migrateLegacyGateway("dry-run", options(versioned.home)), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_UNKNOWN_VERSION");

  const live = await fixture();
  t.after(() => rm(live.home, { recursive: true, force: true }));
  await assert.rejects(() => migrateLegacyGateway("dry-run", options(live.home, { processLiveness: async (pid: number) => pid === 999999 ? true : false })), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_LIVE_PROCESS");
  await assert.rejects(() => migrateLegacyGateway("dry-run", options(live.home, { processLiveness: async () => null })), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_LIVE_PROCESS");

  const escaped = await fixture();
  t.after(() => rm(escaped.home, { recursive: true, force: true }));
  await rm(join(escaped.legacy, "gateway"), { recursive: true });
  const outside = join(escaped.home, "outside");
  await mkdir(join(outside, "v1"), { recursive: true });
  try {
    await symlink(outside, join(escaped.legacy, "gateway"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => migrateLegacyGateway("dry-run", options(escaped.home)), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_UNSAFE_SOURCE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});

test("source drift publishes nothing and an interrupted transaction resumes exactly", async (t) => {
  const drift = await fixture();
  t.after(() => rm(drift.home, { recursive: true, force: true }));
  await assert.rejects(() => migrateLegacyGateway("apply", options(drift.home, { fault: async (point: string) => {
    if (point === "after-marker") await writeFile(join(drift.legacy, "config.yaml"), `${await readFile(join(drift.legacy, "config.yaml"), "utf8")}# drift\n`);
  } })), (error: unknown) => error instanceof GatewayLegacyMigrationError && error.code === "LEGACY_MIGRATION_SOURCE_DRIFT");
  await assert.rejects(() => lstat(join(drift.native, "config.yaml")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  const interrupted = await fixture();
  t.after(() => rm(interrupted.home, { recursive: true, force: true }));
  let crashed = false;
  await assert.rejects(() => migrateLegacyGateway("apply", options(interrupted.home, { fault: async (point: string) => {
    if (!crashed && point === "after-publish:config") { crashed = true; throw new Error("simulated interruption"); }
  } })), /simulated interruption/u);
  assert.equal((await lstat(join(interrupted.native, ".legacy-migration-transaction.json"))).isFile(), true);
  const recovered = await migrateLegacyGateway("apply", options(interrupted.home));
  assert.equal(recovered.status, "recovered");
  assert.equal((JSON.parse(await readFile(join(interrupted.native, "legacy-migration.json"), "utf8")) as { status: string }).status, "applied");
  await assert.rejects(() => lstat(join(interrupted.native, ".legacy-migration-transaction.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});
