import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { GatewayOwnerStore, GatewayOwnerStoreError } from "../src/gateway/owner-store.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const identity = "pi-maestro-gateway test";

test("owner store writes durable record v1 and rejects unknown record versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-owner-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerPath = join(root, "owner.json");
  const store = new GatewayOwnerStore({
    ownerPath,
    pid: 42,
    commandIdentity: identity,
    isProcessAlive: (pid) => pid === 42,
    getProcessIdentity: () => identity,
    now: () => 1_700_000_000_000,
  });

  const owner = await store.claim({ socket: join(root, "gateway.sock") });
  assert.equal(owner.version, 1);
  assert.equal((JSON.parse(await readFile(ownerPath, "utf8")) as { version: number }).version, 1);
  assert.equal(await store.release(owner.ownerToken), true);

  await writeFile(ownerPath, JSON.stringify({ ...owner, version: 2 }), "utf8");
  await assert.rejects(() => store.read(), GatewayOwnerStoreError);
});

test("daemon ignores legacy PID evidence and leaves legacy files untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-owner-no-fallback-"));
  const legacyDirectory = join(root, ".mcpx");
  const legacyPidPath = join(legacyDirectory, "mcpx-server.pid");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(legacyPidPath, "42\n", "utf8");
  const config = createTestGatewayConfig(root);
  const daemon = new GatewayDaemon({ config, cwd: root, http: false, commandIdentity: identity });
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  await daemon.start();
  assert.equal(daemon.owner?.pid, process.pid);
  assert.equal(await readFile(legacyPidPath, "utf8"), "42\n");
});
