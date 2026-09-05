import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GatewayConfigValidationError,
  applyGatewayConfigPatch,
  defaultGatewayConfig,
  loadGatewayConfig,
  normalizeGatewayConfig,
  parseGatewayConfigDocument,
  writeGatewayConfigPatch,
} from "../src/gateway/config.ts";

const yaml = `# keep this header\nserver:\n    host: "127.0.0.1"\n    port: 9191\nauth:\n    mode: bearer\n    token: "secret"\nsecurity:\n    commands:\n        default: confirm\n        allow:\n            - "^pi\\\\b"\n        confirm: []\n        deny: []\n        auto_allow_readonly: null\n    files:\n        max_read_bytes: 2048\n        max_patch_files: 3\n        allow: []\n        confirm: []\n        deny: []\nworkspaces:\n    - path: "."\n      ttl_seconds: 60\ntransport:\n    stdio:\n        enabled: true\nlimits:\n    max_request_bytes: 2048\nlogging:\n    level: info\nstate:\n    root_dir: ".pi/gateway/v1"\nretention:\n    jobs: 3600\nunknown_section:\n    keep: true\n    comment: "must survive"\n`;

test("Gateway config normalizes legacy snake-case sections and rejects invalid known fields", () => {
  const document = parseGatewayConfigDocument(yaml);
  assert.equal(document.config.version, 1);
  assert.equal(document.config.server.port, 9191);
  assert.equal(document.config.transport.http.host, "127.0.0.1");
  assert.equal(document.config.transport.http.port, 9191);
  assert.equal(document.config.security.commands.default, "confirm");
  assert.equal(document.config.security.files.maxReadBytes, 2048);
  assert.equal(document.config.limits.maxRequestBytes, 2048);
  assert.equal(document.config.workspaces[0]?.ttlMs, 60_000);
  assert.deepEqual(document.unknownSections.unknown_section, { keep: true, comment: "must survive" });

  assert.throws(() => normalizeGatewayConfig({ server: { port: "9191" } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ security: { commands: { default: "maybe" } } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ limits: { max_request_bytes: 99_999_999 } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ transport: { http: { port: 0 } } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ transport: { http: { tls: { enabled: true } } } }), /requires certFile and keyFile/);
  assert.throws(() => normalizeGatewayConfig({ security: { trustedFullAccess: { enabled: true, workspaceRoots: ["."] } } }), /auth.mode cannot be open/);
  const trusted = normalizeGatewayConfig({ auth: { mode: "bearer", token: "secret" }, security: { trusted_full_access: { enabled: true, workspace_roots: ["."] } }, transport: { http: { tls: { enabled: true, cert_file: "cert.pem", key_file: "key.pem" } } } });
  assert.deepEqual(trusted.security.trustedFullAccess, { enabled: true, workspaceRoots: ["."] });
  assert.equal(trusted.transport.http.tls.enabled, true);
  assert.equal(normalizeGatewayConfig({ auth: { mode: "oauth", oauth: { password: "pw", token_secret: "legacy-secret" } } }).auth.mode, "oauth");
  assert.equal(normalizeGatewayConfig({ state: { sessions_root: ".pi/gateway/v1/sessions" } }).state.sessionsRoot, ".pi/gateway/v1/sessions");
  const legacyListener = normalizeGatewayConfig({ server: { host: "0.0.0.0", port: 9293 } });
  assert.equal(legacyListener.transport.http.host, "0.0.0.0");
  assert.equal(legacyListener.transport.http.port, 9293);
  const legacyWorkspaces = normalizeGatewayConfig({ workspaces: [
    { name: "permanent", path: "D:/permanent" },
    { name: "leased", path: "D:/leased", expires_at: new Date(Date.now() + 60_000).toISOString(), owner_token: "legacy" },
  ] });
  assert.equal(legacyWorkspaces.workspaces[0]?.mode, "permanent");
  assert.equal(legacyWorkspaces.workspaces[1]?.mode, "lease");
  assert.ok((legacyWorkspaces.workspaces[1]?.ttlMs ?? 0) > 0);

  const mcpxCompatible = normalizeGatewayConfig({
    auth: {
      mode: "oauth",
      oauth_client_id: "flat-client",
      oauth_client_secret: "flat-secret",
      oauth: {
        password: "pw",
        client_id: "nested-client",
        client_secret: "nested-secret",
        redirect_uris: [],
      },
    },
    security: { files: { max_patch_lines: 2_000 } },
    state: { retention: { enabled: true } },
    transport: { session_idle_ttl: "24h" },
    limits: { max_result_bytes: 262_144 },
    logging: { enabled: true, dir: "" },
  });
  assert.equal(mcpxCompatible.auth.oauth?.password, "pw");
  assert.equal(mcpxCompatible.limits.maxOutputBytes, 262_144);

  const flatOauth = normalizeGatewayConfig({ auth: {
    mode: "oauth",
    oauth_password: "flat-password",
    oauth_server_url: "https://gateway.example.com",
    oauth_token_ttl: 60,
    oauth_client_id: "flat-client",
  } });
  assert.equal(flatOauth.auth.oauth?.password, "flat-password");
  assert.equal(flatOauth.auth.oauth?.serverUrl, "https://gateway.example.com");
  assert.equal(flatOauth.auth.oauth?.tokenTtlMs, 60_000);
  assert.throws(() => normalizeGatewayConfig({ auth: { oauth_client_typo: "no" } }), /auth\.oauth_client_typo is not a recognized field/);
});

test("Gateway config patch distinguishes preserve, replace, and clear while retaining unknown sections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "config.yaml");
  await writeFile(path, yaml, "utf8");

  // Omitted nested fields are preserved, while one field is replaced.
  let updated = await writeGatewayConfigPatch(path, { server: { port: 9292 } as never });
  assert.equal(updated.config.server.port, 9292);
  assert.equal(updated.config.server.host, "127.0.0.1");
  assert.match(updated.raw, /unknown_section:/);
  assert.match(updated.raw, /comment: "must survive"/);

  // Arrays replace the selected list rather than append to it.
  updated = await writeGatewayConfigPatch(path, { security: { commands: { allow: ["echo *"] } } } as never);
  assert.deepEqual(updated.config.security.commands.allow, ["echo *"]);
  assert.equal(updated.config.security.commands.default, "confirm");

  // Null clears a field/section at the write boundary; normalized reads use defaults.
  updated = await writeGatewayConfigPatch(path, { state: null });
  assert.deepEqual(updated.config.state, {});
  const rawAfterClear = await readFile(path, "utf8");
  assert.doesNotMatch(rawAfterClear, /^state:/m);
  assert.match(rawAfterClear, /^unknown_section:/m);

  const loaded = await loadGatewayConfig(path);
  assert.equal(loaded.server.port, 9292);
  assert.equal(loaded.security.commands.allow[0], "echo *");
});

test("default config is canonical and patch application keeps omitted values", () => {
  const base = defaultGatewayConfig();
  const patched = applyGatewayConfigPatch(base, { server: { port: 9999 } as never });
  assert.equal(patched.server.port, 9999);
  assert.equal(patched.server.host, base.server.host);
  const cleared = applyGatewayConfigPatch(patched, { logging: null, server: { port: null } as never });
  assert.equal(cleared.logging.level, "info");
  assert.equal(cleared.server.port, 9090);
});
