import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  _resetGatewayWorkspaceClientState,
  ensureGatewayWorkspace,
  isGatewayConfigured,
  listGatewayWorkspaces,
  readGatewayConfigView,
  readGatewayTasks,
  registerGatewayWorkspacePermanent,
  removeGatewayWorkspaceByPath,
  setGatewayControlClientForTest,
  startWorkspaceLease,
  stopGateway,
  stopWorkspaceLease,
  writeGatewayConfigChanges,
} from "../src/gateway/workspace-client.ts";
import { gatewayConfigPath } from "../src/gateway/state-paths.ts";

async function withIsolatedGateway(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  _resetGatewayWorkspaceClientState();
  try {
    await run(root);
  } finally {
    stopWorkspaceLease();
    await stopGateway(root).catch(() => undefined);
    _resetGatewayWorkspaceClientState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

const CONFIG = [
  "version: 2",
  "server:",
  "  host: 127.0.0.1",
  "  port: 9090",
  "  disable_localhost_protection: false",
  "  trust_proxy_headers: false",
  "auth:",
  "  mode: oauth",
  "  oauth:",
  "    password: keep-secret",
  "    server_url: https://gateway.example.test",
  "security:",
  "  commands:",
  "    default: allow",
  "    allow:",
  "      - ^ls\\b",
  "    confirm: []",
  "    deny:",
  "      - ^rm",
  "    auto_allow_readonly: true",
  "  files:",
  "    max_read_bytes: 1048576",
  "    max_patch_files: 20",
  "    allow: []",
  "    confirm: []",
  "    deny:",
  "      - ^/etc",
  "custom_section:",
  "  preserved: true",
  "",
].join("\n");

test("workspace lease registration is deduplicated and permanent registration replaces the lease", async () => {
  await withIsolatedGateway(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let generation = 0;
    let registered: Record<string, unknown> | undefined;
    const fakeControl = {
      cwd: root,
      registerWorkspace: async (path: string, ttlSeconds: number) => {
        generation++;
        registered = {
          version: 1, id: "a".repeat(64), path, canonicalPath: path,
          mode: ttlSeconds === 0 ? "permanent" : "lease", generation,
          registeredAt: Date.now(), updatedAt: Date.now(),
          ...(ttlSeconds === 0 ? {} : { expiresAt: Date.now() + ttlSeconds * 1000, ownerToken: "owner-token-1234567890" }),
        };
        return registered;
      },
      unregisterWorkspace: async () => { const existed = registered !== undefined; registered = undefined; return existed; },
      listWorkspaces: async () => registered ? [registered] : [],
      listTasks: async () => [],
      stop: async () => false,
    };
    setGatewayControlClientForTest(fakeControl as never);
    assert.deepEqual(await Promise.all([
      ensureGatewayWorkspace(workspace),
      ensureGatewayWorkspace(workspace),
    ]), [true, true]);
    let entries = await listGatewayWorkspaces();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.mode, "lease");
    assert.equal(entries[0]!.generation, 1);

    stopWorkspaceLease();
    assert.equal(await startWorkspaceLease(workspace), true);
    stopWorkspaceLease();
    assert.equal(await registerGatewayWorkspacePermanent(workspace), true);
    entries = await listGatewayWorkspaces();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.mode, "permanent");
    assert.equal(entries[0]!.expiresAt, undefined);
    assert.equal((await removeGatewayWorkspaceByPath(workspace)).ok, true);
    assert.deepEqual(await listGatewayWorkspaces(), []);
  });
});

test("Gateway configuration reads and writes only the native config path", async () => {
  await withIsolatedGateway(async () => {
    const path = gatewayConfigPath();
    assert.match(path.replace(/\\/g, "/"), /\/agent\/gateway\/config\.yaml$/);
    assert.equal(path.includes(".mcpx"), false);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, CONFIG, "utf8");
    assert.equal(isGatewayConfigured(), true);
    const view = readGatewayConfigView();
    assert.equal(view?.auth.oauthPassword, "keep-secret");
    assert.deepEqual(view?.commands.deny, ["^rm"]);
  });
});

test("config editor preserves omitted data, replaces lists, and clears lists/nullables", async () => {
  await withIsolatedGateway(async () => {
    const path = gatewayConfigPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, CONFIG, "utf8");

    await writeGatewayConfigChanges({
      port: 9191,
      commandsDeny: ["^mkfs"],
      filesDeny: [],
      commandsAutoReadonly: null,
    });
    const after = await readFile(path, "utf8");
    assert.match(after, /^version: 2$/m);
    assert.match(after, /port: 9191/);
    assert.match(after, /password: keep-secret/);
    assert.match(after, /custom_section:\n  preserved: true/);
    assert.match(after, /deny:\n\s+- \^mkfs/);
    assert.doesNotMatch(after, /\^rm(?:\s|$)/);
    assert.doesNotMatch(after, /auto_allow_readonly: true/);
    assert.match(after, /files:\n[\s\S]*?deny: \[\]/);

    const view = readGatewayConfigView();
    assert.equal(view?.server.port, 9191);
    assert.deepEqual(view?.commands.deny, ["^mkfs"]);
    assert.deepEqual(view?.files.deny, []);
    assert.equal(view?.commands.autoAllowReadonly, null);
  });
});

test("Gateway journal reader returns canonical metadata only and ignores legacy delegated files", async () => {
  await withIsolatedGateway(async (root) => {
    const stateRoot = join(root, "state");
    const path = gatewayConfigPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `version: 2\nstate:\n  root_dir: "${stateRoot.replace(/\\/g, "/")}"\n`, "utf8");
    await mkdir(join(stateRoot, "tasks"), { recursive: true });
    await writeFile(join(stateRoot, "tasks", "journal.json"), JSON.stringify({
      version: 1,
      tasks: [{
        version: 1,
        id: "gateway-task",
        status: "completed",
        cwd: root,
        workspaceId: "a".repeat(64),
        principalId: "principal",
        createdAt: 10,
        updatedAt: 20,
        finishedAt: 20,
        publicationId: "publication-1",
      }],
    }), "utf8");
    const legacy = join(root, ".mcpx", "tasks", "delegated", "session");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "legacy.json"), JSON.stringify({ task_id: "legacy-task" }), "utf8");

    const tasks = await readGatewayTasks(root);
    assert.deepEqual(tasks?.map((task) => task.id), ["gateway-task"]);
    assert.equal(tasks?.[0]?.publicationId, "publication-1");
    assert.equal("message" in (tasks?.[0] ?? {}), false);
  });
});
