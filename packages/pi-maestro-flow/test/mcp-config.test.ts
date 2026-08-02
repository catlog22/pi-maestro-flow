import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mcpAdapter from "../src/mcp/index.ts";
import {
  normalizeHttpUrl,
  parseMcpJsonServers,
  parseStringArray,
  parseStringRecord,
  serializeMcpServerJson,
} from "../src/mcp/mcp-manager-flow.ts";
import { McpManagerStore, validateServerName } from "../src/mcp/mcp-manager-store.ts";
import { loadMcpConfig, loadMcpManagementConfig } from "../src/mcp/config.ts";

test("MCP manager store preserves unknown config while renaming and deleting servers", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-manager-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const userPath = join(tempDir, "agent", "mcp.json");
  const projectPath = join(tempDir, ".mcp.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(tempDir, "agent"), { recursive: true }));
  writeFileSync(userPath, JSON.stringify({
    customRoot: { preserved: true },
    settings: { toolPrefix: "short" },
    mcpServers: {
      alpha: { command: "old-command", args: ["--old"], customServerField: "keep-me" },
    },
  }, null, 2));

  const store = new McpManagerStore(tempDir, userPath);
  let snapshot = await store.load();
  const alpha = snapshot.servers.find((server) => server.name === "alpha");
  assert.ok(alpha);
  assert.equal(alpha.scope, "user");

  snapshot = await store.save({
    previousName: "alpha",
    name: "beta",
    scope: "user",
    entry: { ...alpha.entry, command: "new-command" },
  });
  assert.equal(snapshot.servers.some((server) => server.name === "alpha"), false);
  assert.equal(snapshot.servers.some((server) => server.name === "beta"), true);
  const savedUser = JSON.parse(readFileSync(userPath, "utf8"));
  assert.deepEqual(savedUser.customRoot, { preserved: true });
  assert.equal(savedUser.mcpServers.beta.customServerField, "keep-me");
  assert.equal(savedUser.mcpServers.beta.command, "new-command");

  snapshot = await store.save({
    name: "project-http",
    scope: "project",
    entry: { url: "https://mcp.example.com", auth: "oauth", lifecycle: "lazy" },
  });
  assert.equal(snapshot.servers.find((server) => server.name === "project-http")?.scope, "project");
  const savedProject = JSON.parse(readFileSync(projectPath, "utf8"));
  assert.equal(savedProject.mcpServers["project-http"].url, "https://mcp.example.com");
  await assert.rejects(() => store.save({
    name: "project-http",
    scope: "user",
    entry: { command: "duplicate" },
  }), /already exists/);

  const beta = snapshot.servers.find((server) => server.name === "beta");
  assert.ok(beta);
  await store.delete(beta);
  const afterDelete = JSON.parse(readFileSync(userPath, "utf8"));
  assert.equal("beta" in afterDelete.mcpServers, false);
  assert.deepEqual(afterDelete.customRoot, { preserved: true });
});

test("MCP manager validates names, URLs, args, and string maps", () => {
  assert.equal(validateServerName("github-mcp.v2"), "github-mcp.v2");
  assert.throws(() => validateServerName("bad name"), /letters, numbers/);
  assert.equal(normalizeHttpUrl("https://mcp.example.com///"), "https://mcp.example.com");
  assert.throws(() => normalizeHttpUrl("file:///tmp/mcp"), /http or https/);
  assert.deepEqual(parseStringArray('["-y","server"]', "Arguments"), ["-y", "server"]);
  assert.throws(() => parseStringArray('["ok",1]', "Arguments"), /only strings/);
  assert.deepEqual(parseStringRecord('{"TOKEN":"value"}', "Environment"), { TOKEN: "value" });
  assert.throws(() => parseStringRecord('{"PORT":3000}', "Environment"), /values must all be strings/);
});

test("MCP manager recognizes portable MCP JSON and preserves raw server fields", () => {
  const source = serializeMcpServerJson("github", {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret" },
    customServerField: "preserve-me",
  } as never);
  const recognized = parseMcpJsonServers(source);
  assert.equal(recognized.length, 1);
  assert.equal(recognized[0]?.name, "github");
  assert.equal(recognized[0]?.entry.command, "npx");
  assert.equal((recognized[0]?.entry as Record<string, unknown>).customServerField, "preserve-me");

  assert.deepEqual(
    parseMcpJsonServers('{"mcp-servers":{"filesystem":{"command":"node","args":["server.js"]}}}'),
    [{ name: "filesystem", entry: { command: "node", args: ["server.js"] } }],
  );
  assert.throws(() => parseMcpJsonServers('{"mcpServers":{"broken":{"args":[]}}}'), /command or URL/);
  assert.throws(() => parseMcpJsonServers('{"command":"npx"}'), /mcpServers/);
});

test("MCP manager serializes duplicate concurrent saves", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-manager-race-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const userPath = join(tempDir, "mcp.json");
  const store = new McpManagerStore(tempDir, userPath);

  const results = await Promise.allSettled([
    store.save({ name: "shared", scope: "user", entry: { command: "first" } }),
    store.save({ name: "shared", scope: "user", entry: { command: "second" } }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String(results.find((result) => result.status === "rejected")?.reason), /already exists/);
  const saved = JSON.parse(readFileSync(userPath, "utf8"));
  assert.ok(saved.mcpServers.shared.command === "first" || saved.mcpServers.shared.command === "second");
});

test("MCP manager keeps disabled servers visible while excluding them from runtime", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-manager-disabled-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const userPath = join(tempDir, "mcp.json");
  writeFileSync(userPath, JSON.stringify({
    mcpServers: {
      enabled: { command: "enabled-server" },
      disabled: { command: "disabled-server", enabled: false },
    },
  }, null, 2));

  const store = new McpManagerStore(tempDir, userPath);
  const snapshot = await store.load();
  assert.ok(snapshot.servers.some((server) => server.name === "disabled"));
  assert.deepEqual(Object.keys(loadMcpManagementConfig(userPath, tempDir).mcpServers).sort(), ["disabled", "enabled"]);
  assert.deepEqual(Object.keys(loadMcpConfig(userPath, tempDir).mcpServers), ["enabled"]);

  const disabled = snapshot.servers.find((server) => server.name === "disabled");
  assert.ok(disabled);
  await store.toggle(disabled);
  assert.deepEqual(Object.keys(loadMcpConfig(userPath, tempDir).mcpServers).sort(), ["disabled", "enabled"]);
});

test("MCP manager accepts a complete pasted configuration document", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-manager-document-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const userPath = join(tempDir, "mcp.json");
  const store = new McpManagerStore(tempDir, userPath);

  await store.replaceEditableConfig(JSON.stringify({
    comment: "editable",
    mcpServers: { example: { command: "npx", args: ["example-mcp"] } },
  }));
  assert.match(store.getEditableConfig().text, /"example"/);
  assert.equal((JSON.parse(readFileSync(userPath, "utf8")) as { comment: string }).comment, "editable");
  await assert.rejects(() => store.replaceEditableConfig("[]"), /配置必须是 JSON 对象/);
});

test("MCP adapter await sites use lifecycle-fenced initialization", async () => {
  const adapterSource = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(adapterSource, /state\s*=\s*await initPromise/);
  assert.equal((adapterSource.match(/await awaitInitializedState\(\)/g) ?? []).length, 4);
  assert.match(adapterSource, /async openManager\(ctx\)/);

  const directSource = readFileSync(new URL("../src/mcp/direct-tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(directSource, /state\s*=\s*await initPromise/);
  assert.match(directSource, /getInitPromise\(\) === initPromise/);
});

test("MCP adapter 仅注册单一 MCP 管理入口", () => {
  const commands = new Set<string>();
  const tools = new Set<string>();
  const flags = new Set<string>();
  const events = new Set<string>();
  const pi = {
    registerCommand(name: string) { commands.add(name); },
    registerTool(tool: { name: string }) { tools.add(tool.name); },
    registerFlag(name: string) { flags.add(name); },
    on(name: string) { events.add(name); },
    getAllTools() { return []; },
  } as unknown as Parameters<typeof mcpAdapter>[0];

  mcpAdapter(pi);

  assert.deepEqual([...commands], ["mcp", "mcp-auth"]);
  assert.ok(tools.has("mcp"));
  assert.ok(flags.has("mcp-config"));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_shutdown"));
  assert.ok(events.has("tool_result"));
});
