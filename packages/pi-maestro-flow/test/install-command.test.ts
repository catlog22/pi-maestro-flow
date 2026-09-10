import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  INSTALL_ITEMS,
  STATUS_GLYPH,
  resolveInstallItems,
  probeInstallStatus,
  readInstallDoc,
  type InstallStatus,
} from "../src/install/install-items.ts";
import { composeInstallMessageForTest } from "../src/install/install-command.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("install registry declares nine items with stable ids", () => {
  const ids = INSTALL_ITEMS.map((item) => item.id);
  assert.deepEqual(ids, ["init", "teammate-models", "computer-use", "computer-use-weights", "self-evolve", "browser-bridge", "smart-search", "mcp", "openai-tunnel"]);
  for (const item of INSTALL_ITEMS) {
    assert.ok(item.title.length > 0 && item.description.length > 0, `${item.id} needs title+description`);
    assert.ok(item.promptIntro.length > 0, `${item.id} needs promptIntro`);
    assert.ok(["core", "optional", "external"].includes(item.category), `${item.id} bad category`);
  }
  const browserBridge = INSTALL_ITEMS.find((item) => item.id === "browser-bridge")!;
  assert.match(`${browserBridge.title}\n${browserBridge.description}\n${browserBridge.promptIntro}`, /显式|app\.channel='extension'/);
  assert.match(browserBridge.promptIntro, /browser status/);
  assert.match(browserBridge.promptIntro, /断连不回退 managed/);
  const openAiTunnel = INSTALL_ITEMS.find((item) => item.id === "openai-tunnel")!;
  assert.equal(openAiTunnel.category, "external");
  assert.match(`${openAiTunnel.title}\n${openAiTunnel.description}\n${openAiTunnel.promptIntro}`, /实验|experimental/i);
  assert.match(openAiTunnel.promptIntro, /环境变量名称/);
  assert.match(openAiTunnel.promptIntro, /不得自动下载/);
  assert.match(openAiTunnel.promptIntro, /不得创建或预配 tunnel/);
});

test("categories are ordered core → optional → external", () => {
  const order = { core: 0, optional: 1, external: 2 };
  for (let i = 1; i < INSTALL_ITEMS.length; i++) {
    assert.ok(order[INSTALL_ITEMS[i - 1].category] <= order[INSTALL_ITEMS[i].category], "categories must not regress");
  }
});

test("every install doc ships in the package optional/ dir", () => {
  for (const item of INSTALL_ITEMS) {
    const path = join(packageRoot, "optional", item.docFile);
    assert.ok(existsSync(path), `${item.docFile} must be published in optional/`);
  }
});

test("probeInstallStatus returns a known status for each item and never throws", () => {
  for (const item of INSTALL_ITEMS) {
    const status = probeInstallStatus(item.id);
    assert.ok(["not-installed", "installed", "partial", "unknown"].includes(status), `${item.id} bad status ${status}`);
  }
  // unknown id does not throw
  assert.equal(probeInstallStatus("nonexistent"), "unknown");
});

test("OpenAI tunnel install probe uses native Gateway config and required env references", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-openai-tunnel-install-probe-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID;
  const previousRuntimeKey = process.env.CONTROL_PLANE_API_KEY;
  const previousCustomTunnelId = process.env.CUSTOM_TUNNEL_ID;
  const previousCustomRuntimeKey = process.env.CUSTOM_RUNTIME_KEY;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.CONTROL_PLANE_TUNNEL_ID;
  delete process.env.CONTROL_PLANE_API_KEY;
  const configPath = join(agentDirectory, "gateway", "config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  const writeConfig = (enabled: boolean, tunnelIdEnv = "CONTROL_PLANE_TUNNEL_ID", runtimeKeyEnv = "CONTROL_PLANE_API_KEY") => writeFileSync(configPath, [
    "version: 2",
    "tunnels:",
    "  openai:",
    `    enabled: ${enabled}`,
    `    binary_path: ${JSON.stringify(process.execPath)}`,
    `    tunnel_id_env: ${tunnelIdEnv}`,
    `    runtime_key_env: ${runtimeKeyEnv}`,
    "    minimum_version: 0.0.14",
    "    credential_ttl_ms: 300000",
    "",
  ].join("\n"));
  try {
    assert.equal(probeInstallStatus("openai-tunnel"), "not-installed");

    writeFileSync(configPath, "version: 2\n");
    assert.equal(probeInstallStatus("openai-tunnel"), "not-installed", "an unrelated Gateway config is not a tunnel setup");

    writeConfig(false);
    assert.equal(probeInstallStatus("openai-tunnel"), "partial", "the experimental provider requires explicit enablement");

    writeConfig(true);
    assert.equal(probeInstallStatus("openai-tunnel"), "partial", "missing referenced credentials are partial");

    process.env.CONTROL_PLANE_TUNNEL_ID = "tunnel-test-reference";
    process.env.CONTROL_PLANE_API_KEY = "runtime-test-reference";
    assert.equal(probeInstallStatus("openai-tunnel"), "installed");

    writeConfig(true, "CUSTOM_TUNNEL_ID", "CUSTOM_RUNTIME_KEY");
    assert.equal(probeInstallStatus("openai-tunnel"), "partial", "probe follows configured env names instead of hard-coded defaults");
    process.env.CUSTOM_TUNNEL_ID = "tunnel-custom-reference";
    process.env.CUSTOM_RUNTIME_KEY = "runtime-custom-reference";
    assert.equal(probeInstallStatus("openai-tunnel"), "installed");
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    if (previousTunnelId === undefined) delete process.env.CONTROL_PLANE_TUNNEL_ID;
    else process.env.CONTROL_PLANE_TUNNEL_ID = previousTunnelId;
    if (previousRuntimeKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
    else process.env.CONTROL_PLANE_API_KEY = previousRuntimeKey;
    if (previousCustomTunnelId === undefined) delete process.env.CUSTOM_TUNNEL_ID;
    else process.env.CUSTOM_TUNNEL_ID = previousCustomTunnelId;
    if (previousCustomRuntimeKey === undefined) delete process.env.CUSTOM_RUNTIME_KEY;
    else process.env.CUSTOM_RUNTIME_KEY = previousCustomRuntimeKey;
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("browser bridge install probe requires a valid verified marker and config, never a port file", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-install-probe-"));
  const previous = process.env.PI_BROWSER_BRIDGE_DIR;
  process.env.PI_BROWSER_BRIDGE_DIR = directory;
  const writeJson = (name: string, value: unknown) => writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  const marker = {
    version: 1,
    protocol: "first-frame-token-v1",
    port: 19222,
    verifiedAt: "2026-08-30T00:00:00.000Z",
  };
  const config = { version: 1, port: 19222, token: "x".repeat(43) };
  try {
    assert.equal(probeInstallStatus("browser-bridge"), "not-installed");

    writeFileSync(join(directory, "browser-bridge.port"), "19222");
    assert.equal(
      probeInstallStatus("browser-bridge"),
      "not-installed",
      "a legacy port file is neither verified installation nor live connectivity",
    );

    writeJson("browser-bridge.json", config);
    assert.equal(probeInstallStatus("browser-bridge"), "not-installed", "config without a verified handshake is not installed");

    writeJson("browser-bridge.verified", { ...marker, verifiedAt: "invalid" });
    assert.equal(probeInstallStatus("browser-bridge"), "partial", "a malformed marker cannot prove historical verification");

    writeJson("browser-bridge.verified", { ...marker, protocol: "pairing-v1" });
    assert.equal(probeInstallStatus("browser-bridge"), "partial", "pairing credential delivery is not verified authentication");

    writeJson("browser-bridge.verified", marker);
    writeJson("browser-bridge.json", { ...config, token: "short" });
    assert.equal(probeInstallStatus("browser-bridge"), "partial", "verified history with incomplete config is partial");

    writeJson("browser-bridge.json", config);
    assert.equal(probeInstallStatus("browser-bridge"), "installed");

    writeJson("browser-bridge.verified", { ...marker, protocol: "challenge-hmac-sha256-v1" });
    assert.equal(probeInstallStatus("browser-bridge"), "installed", "HMAC possession proof is valid install evidence");
  } finally {
    if (previous === undefined) delete process.env.PI_BROWSER_BRIDGE_DIR;
    else process.env.PI_BROWSER_BRIDGE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveInstallItems attaches status, glyph, and docPath to every item", () => {
  const resolved = resolveInstallItems();
  assert.equal(resolved.length, INSTALL_ITEMS.length);
  for (const item of resolved) {
    assert.ok(Object.prototype.hasOwnProperty.call(STATUS_GLYPH, item.status), `${item.id} status has glyph`);
    assert.ok(typeof item.docPath === "string" || item.docPath === undefined, `${item.id} docPath type`);
  }
});

test("readInstallDoc returns shipped content and setup docs preserve explicit safety semantics", () => {
  const init = readInstallDoc("INIT-SETUP.md");
  assert.ok(typeof init === "string" && init.includes("## PURPOSE"), "INIT-SETUP.md must load with PURPOSE section");
  const browser = readInstallDoc("BROWSER-BRIDGE-SETUP.md") ?? "";
  assert.match(browser, /app\.channel: "extension"/);
  assert.match(browser, /authenticatedConnected/);
  assert.match(browser, /verified marker \+ 合法配置/);
  assert.match(browser, /不会 fallback/);
  assert.match(browser, /不是完整 Puppeteer/);
  const openAiTunnel = readInstallDoc("OPENAI-TUNNEL-SETUP.md") ?? "";
  for (const section of ["PURPOSE", "PREREQUISITES", "TASK", "INTERACTIVE INPUTS", "VERIFY", "ROLLBACK"]) {
    assert.match(openAiTunnel, new RegExp(`## ${section}`), `OpenAI tunnel doc needs ${section}`);
  }
  assert.match(openAiTunnel, /experimental/i);
  assert.match(openAiTunnel, /no auto-download/i);
  assert.match(openAiTunnel, /no provisioning/i);
  assert.match(openAiTunnel, /minimum_version: "0\.0\.14"/);
  assert.match(openAiTunnel, /tunnel_id_env: "CONTROL_PLANE_TUNNEL_ID"/);
  assert.match(openAiTunnel, /runtime_key_env: "CONTROL_PLANE_API_KEY"/);
  assert.match(openAiTunnel, /只保存环境变量名称/);
  assert.match(openAiTunnel, /不保存 tunnel id、runtime API key/);
  assert.equal(readInstallDoc("NONEXISTENT.md"), undefined);
});

test("composeInstallMessage prepends promptIntro, the execution instruction, and the full doc", () => {
  const item = INSTALL_ITEMS.find((i) => i.id === "init")!;
  const doc = readInstallDoc(item.docFile)!;
  const message = composeInstallMessageForTest(item, doc);
  assert.ok(message.startsWith(item.promptIntro), "message must start with promptIntro");
  assert.ok(message.includes("自主执行全部步骤"), "message must instruct autonomous execution");
  assert.ok(message.includes("INTERACTIVE INPUTS"), "message must reference interactive inputs");
  assert.ok(message.includes("## 安装文档"), "message must embed the doc header");
  assert.ok(message.includes(doc), "message must embed the full doc body");
});

test("STATUS_GLYPH covers every InstallStatus", () => {
  const statuses: InstallStatus[] = ["not-installed", "installed", "partial", "unknown"];
  for (const s of statuses) assert.ok(typeof STATUS_GLYPH[s] === "string", `glyph for ${s}`);
});
