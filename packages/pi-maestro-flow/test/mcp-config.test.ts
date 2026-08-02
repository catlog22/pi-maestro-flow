import assert from "node:assert/strict";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  getAuthEntry,
  getAuthEntryFilePath,
  removeAuthEntry,
  saveAuthEntry,
} from "../src/mcp/mcp-auth.ts";
import {
  loadMcpConfig,
  loadMcpManagementConfig,
  writeMcpConfigDocument,
} from "../src/mcp/config.ts";

test("MCP config writes replace regular files privately without temp residue", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-secure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{}}');
  if (process.platform !== "win32") chmodSync(configPath, 0o666);

  writeMcpConfigDocument(configPath, JSON.stringify({
    mcpServers: { secure: { command: "secure-server" } },
  }));

  assert.equal(lstatSync(configPath).isFile(), true);
  assert.equal(lstatSync(configPath).isSymbolicLink(), false);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(configPath).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.secure.command, "secure-server");
  assert.deepEqual(readdirSync(tempDir).filter((name) => name.endsWith(".tmp")), []);
});

test("MCP config writes reject symlink and non-regular destinations", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-target-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const victimPath = join(tempDir, "victim.json");
  const linkPath = join(tempDir, "linked.json");
  writeFileSync(victimPath, '{"unchanged":true}');
  try {
    symlinkSync(victimPath, linkPath, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating symlinks requires Windows Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () => writeMcpConfigDocument(linkPath, '{"mcpServers":{}}'),
    /Refusing to replace non-regular MCP config/,
  );
  assert.equal(readFileSync(victimPath, "utf8"), '{"unchanged":true}');

  const directoryPath = join(tempDir, "directory.json");
  mkdirSync(directoryPath);
  assert.throws(
    () => writeMcpConfigDocument(directoryPath, '{"mcpServers":{}}'),
    /Refusing to replace non-regular MCP config/,
  );
  assert.deepEqual(readdirSync(tempDir).filter((name) => name.endsWith(".tmp")), []);
});

test("MCP project config writes create a private .pi directory", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-mcp-project-private-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const piDir = join(workspace, ".pi");
  const configPath = join(piDir, "mcp.json");

  writeMcpConfigDocument(configPath, '{"mcpServers":{}}');

  assert.equal(lstatSync(piDir).isDirectory(), true);
  assert.equal(lstatSync(piDir).isSymbolicLink(), false);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(piDir).mode & 0o777, 0o700);
  }
  assert.equal(lstatSync(configPath).isFile(), true);
});

test("MCP project config writes reject a symlinked .pi directory", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-project-pi-link-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const workspace = join(tempDir, "workspace");
  const outside = join(tempDir, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  try {
    symlinkSync(outside, join(workspace, ".pi"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating symlinks requires Windows Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () => writeMcpConfigDocument(join(workspace, ".pi", "mcp.json"), '{"mcpServers":{}}'),
    /Refusing unsafe MCP project config directory/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("MCP project config writes reject an aliased workspace intermediate", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-project-alias-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const workspace = join(tempDir, "workspace");
  const outside = join(tempDir, "outside");
  const alias = join(workspace, "alias");
  mkdirSync(workspace);
  mkdirSync(outside);
  try {
    symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating symlinks requires Windows Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () => writeMcpConfigDocument(join(alias, ".pi", "mcp.json"), '{"mcpServers":{}}'),
    /Refusing unsafe MCP project config directory/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("MCP project config writes reject parent replacement before rename", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-project-parent-race-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const workspace = join(tempDir, "workspace");
  const outside = join(tempDir, "outside");
  const piDir = join(workspace, ".pi");
  const originalPiDir = join(workspace, ".pi-original");
  mkdirSync(piDir, { recursive: true });
  mkdirSync(outside);

  const originalOpenSync = fs.openSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (path, flags, mode) => {
    if (!replaced) {
      replaced = true;
      fs.renameSync(piDir, originalPiDir);
      symlinkSync(outside, piDir, process.platform === "win32" ? "junction" : "dir");
    }
    return originalOpenSync(path, flags, mode);
  });

  assert.throws(
    () => writeMcpConfigDocument(join(piDir, "mcp.json"), '{"mcpServers":{}}'),
    /Refusing MCP project config parent outside workspace/,
  );
  assert.equal(existsSync(join(outside, "mcp.json")), false);
  assert.deepEqual(readdirSync(outside), []);
});

test("MCP global config writes retain trusted recursive directory creation", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-global-parent-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "trusted-agent", "nested", "mcp.json");

  writeMcpConfigDocument(configPath, '{"mcpServers":{}}');

  assert.equal(lstatSync(configPath).isFile(), true);
});

test("MCP config writes reject destination replacement before rename", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-replacement-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "mcp.json");
  const victimPath = join(tempDir, "victim.json");
  writeFileSync(configPath, '{"mcpServers":{"old":{"command":"old"}}}');
  writeFileSync(victimPath, '{"unchanged":true}');

  const originalFsyncSync = fs.fsyncSync;
  let replaced = false;
  t.mock.method(fs, "fsyncSync", (fd) => {
    originalFsyncSync(fd);
    if (!replaced) {
      replaced = true;
      fs.rmSync(configPath);
      symlinkSync(victimPath, configPath, "file");
    }
  });

  assert.throws(
    () => writeMcpConfigDocument(configPath, '{"mcpServers":{"next":{"command":"next"}}}'),
    /Refusing to replace non-regular MCP config/,
  );
  assert.equal(readFileSync(victimPath, "utf8"), '{"unchanged":true}');
  assert.deepEqual(readdirSync(tempDir).filter((name) => name.endsWith(".tmp")), []);
});

test("MCP config write failures clean up the private temp file", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-failure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{"old":{"command":"old"}}}');

  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("forced MCP config rename failure"), { code: "EACCES" });
  });

  assert.throws(
    () => writeMcpConfigDocument(configPath, '{"mcpServers":{"next":{"command":"next"}}}'),
    /forced MCP config rename failure/,
  );
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.old.command, "old");
  assert.deepEqual(readdirSync(tempDir).filter((name) => name.endsWith(".tmp")), []);
});

test("MCP OAuth storage repairs private permissions and leaves no temp files", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-private-"));
  const previous = process.env.MCP_OAUTH_DIR;
  process.env.MCP_OAUTH_DIR = tempDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = previous;
    rmSync(tempDir, { recursive: true, force: true });
  });
  if (process.platform !== "win32") chmodSync(tempDir, 0o777);

  saveAuthEntry("secure-server", { tokens: { accessToken: "secret" } }, "https://example.test");
  const filePath = getAuthEntryFilePath("secure-server");
  const serverDir = join(filePath, "..");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(tempDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(serverDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(filePath).mode & 0o777, 0o600);
    chmodSync(tempDir, 0o777);
    chmodSync(serverDir, 0o777);
    chmodSync(filePath, 0o666);
  }

  assert.equal(getAuthEntry("secure-server")?.tokens?.accessToken, "secret");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(tempDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(serverDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(filePath).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(serverDir).filter((name) => name.endsWith(".tmp")), []);
});

test("MCP OAuth storage rejects symlink and non-regular token targets", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-target-"));
  const previous = process.env.MCP_OAUTH_DIR;
  process.env.MCP_OAUTH_DIR = tempDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = previous;
    rmSync(tempDir, { recursive: true, force: true });
  });

  saveAuthEntry("linked-file", { tokens: { accessToken: "initial" } });
  const filePath = getAuthEntryFilePath("linked-file");
  const serverDir = join(filePath, "..");
  rmSync(filePath);
  const victimPath = join(tempDir, "victim.json");
  writeFileSync(victimPath, '{"unchanged":true}');
  try {
    symlinkSync(victimPath, filePath, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating symlinks requires Windows Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () => saveAuthEntry("linked-file", { tokens: { accessToken: "replacement" } }),
    /Refusing unsafe MCP OAuth token file/,
  );
  assert.throws(
    () => removeAuthEntry("linked-file"),
    /Refusing unsafe MCP OAuth token file/,
  );
  assert.equal(readFileSync(victimPath, "utf8"), '{"unchanged":true}');
  assert.deepEqual(readdirSync(serverDir).filter((name) => name.endsWith(".tmp")), []);

  rmSync(filePath);
  mkdirSync(filePath);
  assert.throws(
    () => saveAuthEntry("linked-file", { tokens: { accessToken: "replacement" } }),
    /Refusing unsafe MCP OAuth token file/,
  );
});

test("MCP OAuth storage rejects symlink server directories", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-dir-target-"));
  const previous = process.env.MCP_OAUTH_DIR;
  process.env.MCP_OAUTH_DIR = tempDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = previous;
    rmSync(tempDir, { recursive: true, force: true });
  });
  const serverDir = join(getAuthEntryFilePath("linked-dir"), "..");
  const victimDir = join(tempDir, "victim-dir");
  mkdirSync(victimDir);
  try {
    symlinkSync(victimDir, serverDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating symlinks requires Windows Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () => saveAuthEntry("linked-dir", { tokens: { accessToken: "secret" } }),
    /Refusing unsafe MCP OAuth server directory/,
  );
  assert.deepEqual(readdirSync(victimDir), []);
});

test("MCP OAuth logout directly unlinks only the validated token file", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-logout-"));
  const previous = process.env.MCP_OAUTH_DIR;
  process.env.MCP_OAUTH_DIR = tempDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = previous;
    rmSync(tempDir, { recursive: true, force: true });
  });

  saveAuthEntry("logout-server", { tokens: { accessToken: "secret" } });
  const filePath = getAuthEntryFilePath("logout-server");
  const serverDir = join(filePath, "..");
  const markerPath = join(serverDir, "keep.txt");
  writeFileSync(markerPath, "keep");

  removeAuthEntry("logout-server");

  assert.equal(existsSync(filePath), false);
  assert.equal(readFileSync(markerPath, "utf8"), "keep");
  assert.equal(existsSync(serverDir), true);
});

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

test("MCP runtime excludes project-owned config and imports until the workspace is trusted", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-trust-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const userPath = join(tempDir, "agent", "mcp.json");
  mkdirSync(join(tempDir, "agent"), { recursive: true });
  mkdirSync(join(tempDir, ".pi"), { recursive: true });
  mkdirSync(join(tempDir, ".vscode"), { recursive: true });
  writeFileSync(userPath, JSON.stringify({
    imports: ["vscode"],
    mcpServers: { global: { command: "global-server" } },
  }));
  writeFileSync(join(tempDir, ".mcp.json"), JSON.stringify({
    mcpServers: { project: { command: "project-server" } },
  }));
  writeFileSync(join(tempDir, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { projectPi: { command: "project-pi-server" } },
  }));
  writeFileSync(join(tempDir, ".vscode", "mcp.json"), JSON.stringify({
    mcpServers: { vscode: { command: "vscode-server" } },
  }));

  assert.deepEqual(
    Object.keys(loadMcpConfig(userPath, tempDir, { includeProject: false }).mcpServers),
    ["global"],
  );
  assert.deepEqual(
    Object.keys(loadMcpConfig(userPath, tempDir, { includeProject: true }).mcpServers).sort(),
    ["global", "project", "projectPi", "vscode"],
  );
});

test("MCP adapter binds project config loading to workspace trust", () => {
  const adapterSource = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const initSource = readFileSync(new URL("../src/mcp/init.ts", import.meta.url), "utf8");
  assert.match(adapterSource, /includeProject:\s*false/);
  assert.match(initSource, /includeProject:\s*ctx\.isProjectTrusted\(\)/);
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
