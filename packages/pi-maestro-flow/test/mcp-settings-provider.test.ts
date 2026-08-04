import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import { createMcpSettingsProvider } from "../src/settings/mcp-settings-provider.ts";

interface Harness {
  provider: ReturnType<typeof createMcpSettingsProvider>;
  configPath: string;
  directory: string;
  context: SettingsContextV1;
}

function harness(initialConfig: Record<string, unknown> = { mcpServers: {} }): Harness {
  const directory = mkdtempSync(join(tmpdir(), "mcp-settings-e2e-"));
  const configPath = join(directory, "mcp.json");
  writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));
  const provider = createMcpSettingsProvider({ getConfigPath: () => configPath });
  return { provider, configPath, directory, context: { cwd: "/project", locale: "en" } };
}

test("mcp read surfaces servers with a masked bearerToken placeholder", async (t) => {
  const { provider, directory, configPath, context } = harness({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], lifecycle: "lazy" },
      gateway: { url: "https://mcp.example.com/sse", auth: "bearer", bearerToken: "tok-live" },
      legacy: { command: "legacy", enabled: false },
    },
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const snapshot = await provider.read({ context });
  const servers = snapshot.effective.values.find((entry) => entry.key === "mcp.servers")?.value as Array<Record<string, unknown>>;
  assert.equal(servers.length, 3);
  const gateway = servers.find((entry) => entry.name === "gateway")!;
  assert.equal(gateway.bearerToken, SETTINGS_SECRET_SET_PLACEHOLDER, "read must never expose the plaintext token");
  assert.equal(gateway.url, "https://mcp.example.com/sse");
  assert.equal(gateway.auth, "bearer");
  const filesystem = servers.find((entry) => entry.name === "filesystem")!;
  assert.equal(filesystem.enabled, true, "absent enabled defaults to true");
  assert.deepEqual(filesystem.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
  const legacy = servers.find((entry) => entry.name === "legacy")!;
  assert.equal(legacy.enabled, false);

  const rows = snapshot.effective.values.find((entry) => entry.key === "mcp.overview")?.value as Array<Record<string, unknown>>;
  assert.ok(rows.some((row) => row.labelKey === "mcp.overview.servers" && String(row.value) === "3"));
  assert.ok(rows.some((row) => row.labelKey === "mcp.overview.enabled" && String(row.value) === "2"));
  assert.ok(rows.some((row) => row.labelKey === "mcp.overview.file" && String(row.value) === configPath));
});

test("mcp commit adds a server, keeps an untouched secret and preserves unknown keys", async (t) => {
  const { provider, configPath, directory, context } = harness({
    settings: { toolPrefix: "server" },
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "filesystem"], lifecycle: "lazy" },
      gateway: {
        url: "https://mcp.example.com/sse",
        auth: "bearer",
        bearerToken: "tok-original",
        env: { API: "1" },
        headers: { "X-Key": "abc" },
      },
    },
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const changes = [
    { operation: "set" as const, key: "mcp.servers", scope: "global" as const, value: [
      { name: "filesystem", enabled: true, command: "npx", args: ["-y", "filesystem"], url: "", auth: "oauth", bearerToken: null },
      { name: "gateway", enabled: true, command: "", args: [], url: "https://mcp.example.com/sse", auth: "bearer", bearerToken: SETTINGS_SECRET_SET_PLACEHOLDER },
      { name: "new-server", enabled: true, command: "uvx", args: ["mcp-server-new"], url: "", auth: "oauth", bearerToken: "tok-new" },
    ] },
  ];
  const transactionId = "tx-mcp-1";
  const prepared = await provider.prepare!({ context, transactionId, changes, expectedRevisions: [] });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId, prepareToken: transactionId });
  assert.ok(committed.changedKeys.includes("mcp.servers"));

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers: Record<string, Record<string, unknown>>;
    settings: Record<string, unknown>;
  };
  assert.equal(config.mcpServers["gateway"]!.bearerToken, "tok-original", "placeholder on an existing server must keep the original token");
  assert.equal(config.mcpServers["new-server"]!.bearerToken, "tok-new", "a fresh plaintext token must be written once");
  assert.equal((config.mcpServers["gateway"]!.env as Record<string, string>).API, "1", "unknown env keys are preserved");
  assert.equal((config.mcpServers["gateway"]!.headers as Record<string, string>)["X-Key"], "abc", "unknown header keys are preserved");
  assert.equal(config.mcpServers["filesystem"]!.lifecycle, "lazy", "untouched fields are preserved");
  assert.equal(config.settings.toolPrefix, "server", "top-level unknown keys are preserved");
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["filesystem", "gateway", "new-server"]);
});

test("mcp validate rejects servers with an empty name", async (t) => {
  const { provider, directory, context } = harness();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const invalid = await provider.validate!({
    context, transactionId: "tx-mcp-3",
    changes: [{ operation: "set", key: "mcp.servers", scope: "global", value: [{ name: "  ", enabled: true }] }],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0]?.code, "invalid-servers");

  const valid = await provider.validate!({
    context, transactionId: "tx-mcp-3",
    changes: [{ operation: "set", key: "mcp.servers", scope: "global", value: [{ name: "ok", enabled: true }] }],
  });
  assert.equal(valid.valid, true);
});
