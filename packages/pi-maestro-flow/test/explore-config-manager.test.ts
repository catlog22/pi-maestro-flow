import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadExploreConfigState,
  registerExploreConfigManager,
} from "../src/providers/explore-config-manager.ts";

function createHarness(configPath: string, legacyPath: string) {
  const commands = new Map<string, any>();
  registerExploreConfigManager({
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any, { configPath, legacyPath });
  return commands.get("explore-manager");
}

function createContext(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: tmpdir(),
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      async select() { return undefined; },
      async input() { return undefined; },
      async confirm() { return true; },
      ...overrides,
    },
  } as any;
  return { ctx, notifications };
}

test("registers /explore-manager and lists legacy endpoints without leaking secrets", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-list-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(legacyPath, JSON.stringify({
    endpoints: {
      flash: {
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "secret-must-not-leak",
        model: "deepseek-v4-flash",
      },
      "unsafe\nendpoint\x1b[2J": {
        baseUrl: "https://unsafe.example.com/v1",
        apiKey: "another-secret",
        model: "unsafe\rmodel\x1b[2J",
      },
    },
    maxTurns: 7,
  }));

  const command = createHarness(configPath, legacyPath);
  assert.ok(command);
  const { ctx, notifications } = createContext();
  await command.handler("list", ctx);

  const output = notifications.at(-1)?.message ?? "";
  assert.match(output, /flash · deepseek-v4-flash · openai · 可用配置/);
  assert.match(output, /api-explore\.json（legacy，保存后迁移）/);
  assert.match(output, /maxTurns=7/);
  assert.doesNotMatch(output, /secret-must-not-leak|another-secret/);
  assert.doesNotMatch(output, /[\r\x1b]/);
  assert.equal(existsSync(configPath), false);
});

test("edits a legacy endpoint through the structured form and migrates losslessly", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-edit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const legacyRoot = {
    rootSentinel: { keep: true },
    proxy: { enabled: true, httpsProxy: "http://127.0.0.1:7890" },
    endpoints: {
      flash: {
        baseUrl: "https://old.example.com/v1",
        apiKey: "preserved-secret",
        model: "old-model",
        format: "openai",
        unknownEndpointField: "keep-me",
      },
      sibling: {
        baseUrl: "https://sibling.example.com/v1",
        apiKey: "sibling-secret",
        model: "sibling-model",
      },
    },
  };
  const legacyBytes = JSON.stringify(legacyRoot);
  writeFileSync(legacyPath, legacyBytes);

  const command = createHarness(configPath, legacyPath);
  const confirmations: string[] = [];
  const { ctx, notifications } = createContext({
    async custom() {
      return {
        values: {
          endpoint: "flash",
          baseUrl: "https://new.example.com/v1",
          model: "deepseek-v4-flash",
          format: "openai-responses",
          apiKey: "preserved-secret",
          maxTurns: "9",
          concurrency: "2",
          extraBody: "{\"reasoning_effort\":\"high\"}",
        },
      };
    },
    async confirm(_title: string, message: string) {
      confirmations.push(message);
      return true;
    },
  });
  await command.handler("edit flash", ctx);

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.rootSentinel, { keep: true });
  assert.deepEqual(saved.proxy, legacyRoot.proxy);
  assert.deepEqual(saved.endpoints.sibling, legacyRoot.endpoints.sibling);
  assert.equal(saved.endpoints.flash.baseUrl, "https://new.example.com/v1");
  assert.equal(saved.endpoints.flash.apiKey, "preserved-secret");
  assert.equal(saved.endpoints.flash.model, "deepseek-v4-flash");
  assert.equal(saved.endpoints.flash.format, "openai-responses");
  assert.equal(saved.endpoints.flash.maxTurns, 9);
  assert.equal(saved.endpoints.flash.concurrency, 2);
  assert.deepEqual(saved.endpoints.flash.extraBody, { reasoning_effort: "high" });
  assert.equal(saved.endpoints.flash.unknownEndpointField, "keep-me");
  assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
  assert.match(confirmations[0] ?? "", /deepseek-v4-flash/);
  assert.match(notifications.at(-1)?.message ?? "", /已迁移到 api\.json/);
});

test("manages the legacy root-level endpoint as default without changing CLI semantics", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-legacy-default-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(legacyPath, JSON.stringify({
    baseUrl: "https://old-default.example.com/v1",
    apiKey: "default-secret",
    model: "old-default-model",
    format: "openai",
    maxTurns: 7,
    rootSentinel: true,
    endpoints: {
      sibling: { baseUrl: "https://sibling.example.com/v1", apiKey: "sibling-secret", model: "sibling-model" },
    },
  }));
  const command = createHarness(configPath, legacyPath);
  const listed = createContext();
  await command.handler("list", listed.ctx);
  assert.match(listed.notifications.at(-1)?.message ?? "", /default · old-default-model/);

  const edited = createContext({
    async custom() {
      return {
        values: {
          endpoint: "default",
          baseUrl: "https://new-default.example.com/v1",
          model: "new-default-model",
          format: "openai-responses",
          apiKey: "default-secret",
          maxTurns: "",
          concurrency: "",
          extraBody: "{\"effort\":\"high\"}",
        },
      };
    },
    async confirm() { return true; },
  });
  await command.handler("edit default", edited.ctx);

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.baseUrl, "https://new-default.example.com/v1");
  assert.equal(saved.apiKey, "default-secret");
  assert.equal(saved.model, "new-default-model");
  assert.equal(saved.format, "openai-responses");
  assert.deepEqual(saved.extraBody, { effort: "high" });
  assert.equal(saved.maxTurns, 7);
  assert.equal(saved.rootSentinel, true);
  assert.equal(saved.endpoints.default, undefined);
  assert.equal(saved.endpoints.sibling.model, "sibling-model");
});

test("adds and deletes endpoints while preserving siblings and creating a backup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-crud-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(configPath, JSON.stringify({
    endpoints: {
      keep: {
        baseUrl: "https://keep.example.com/v1",
        apiKey: "keep-secret",
        model: "keep-model",
      },
    },
    circuitBreaker: { threshold: 3 },
  }));

  const command = createHarness(configPath, legacyPath);
  const { ctx } = createContext({
    async custom() {
      return {
        values: {
          endpoint: "new-endpoint",
          baseUrl: "https://new.example.com/v1",
          model: "new-model",
          format: "anthropic",
          apiKey: "new-secret",
          maxTurns: "",
          concurrency: "",
          extraBody: "",
        },
      };
    },
    async confirm() { return true; },
  });

  await command.handler("add new-endpoint", ctx);
  let saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.endpoints.keep.model, "keep-model");
  assert.equal(saved.endpoints["new-endpoint"].format, "anthropic");
  assert.deepEqual(saved.circuitBreaker, { threshold: 3 });

  await command.handler("delete new-endpoint", ctx);
  saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.endpoints["new-endpoint"], undefined);
  assert.equal(saved.endpoints.keep.apiKey, "keep-secret");
  assert.ok(readdirSync(dir).some((name) => name.startsWith("api.json.bak-")));
});

test("updates Explore runtime defaults and preserves endpoint configuration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-defaults-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(configPath, JSON.stringify({
    endpoints: {
      flash: {
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "secret",
        model: "deepseek-v4-flash",
      },
    },
    maxTurns: 5,
    concurrency: 4,
    treeDepth: 3,
  }));

  const command = createHarness(configPath, legacyPath);
  const { ctx } = createContext({
    async custom() {
      return { values: { maxTurns: "11", concurrency: "", treeDepth: "6" } };
    },
  });
  await command.handler("defaults", ctx);

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.maxTurns, 11);
  assert.equal(saved.concurrency, undefined);
  assert.equal(saved.treeDepth, 6);
  assert.equal(saved.endpoints.flash.apiKey, "secret");
});

test("malformed canonical config follows CLI fallback without overwriting either file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-malformed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const malformed = "{ not-json";
  writeFileSync(configPath, malformed);
  writeFileSync(legacyPath, JSON.stringify({
    endpoints: {
      fallback: { baseUrl: "https://fallback.example.com", apiKey: "secret", model: "fallback" },
    },
  }));

  const state = await loadExploreConfigState(configPath, legacyPath);
  assert.equal(state.source, "legacy");
  assert.match(state.warning ?? "", /api\.json 无效/);

  const command = createHarness(configPath, legacyPath);
  const { ctx, notifications } = createContext();
  await command.handler("list", ctx);
  assert.equal(readFileSync(configPath, "utf8"), malformed);
  assert.match(notifications.at(-1)?.message ?? "", /当前 CLI 回退到 legacy/);
  assert.match(notifications.at(-1)?.message ?? "", /fallback/);
});

test("malformed canonical config without a valid fallback is rejected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-malformed-only-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const malformed = "{ not-json";
  writeFileSync(configPath, malformed);

  await assert.rejects(() => loadExploreConfigState(configPath, legacyPath), /Cannot parse/);
  assert.equal(readFileSync(configPath, "utf8"), malformed);
});

test("rejects invalid endpoint names and tree depths without writing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-validation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const command = createHarness(configPath, legacyPath);
  const { ctx, notifications } = createContext({
    async custom() {
      return {
        values: {
          endpoint: "bad,name",
          baseUrl: "https://valid.example.com/v1",
          model: "model",
          format: "openai",
          apiKey: "secret",
          maxTurns: "",
          concurrency: "",
          extraBody: "",
        },
      };
    },
  });
  await command.handler("add bad,name", ctx);
  assert.equal(existsSync(configPath), false);
  assert.match(notifications.at(-1)?.message ?? "", /只能包含/);

  const defaults = createContext({
    async custom() { return { values: { maxTurns: "5", concurrency: "2", treeDepth: "7" } }; },
  });
  await command.handler("defaults", defaults.ctx);
  assert.equal(existsSync(configPath), false);
  assert.match(defaults.notifications.at(-1)?.message ?? "", /Tree depth 必须在 1-6/);
});

test("normalizes interactive endpoint names before collision checks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-name-collision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const before = JSON.stringify({
    endpoints: {
      flash: { baseUrl: "https://flash.example.com/v1", apiKey: "secret", model: "flash-model", sentinel: true },
    },
  });
  writeFileSync(configPath, before);
  const command = createHarness(configPath, legacyPath);
  let customCalled = false;
  const { ctx, notifications } = createContext({
    async input() { return " flash "; },
    async custom() { customCalled = true; return undefined; },
  });

  await command.handler("add", ctx);
  assert.equal(customCalled, false);
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.match(notifications.at(-1)?.message ?? "", /flash 已存在/);
});

test("serializes the complete read-modify-write transaction for concurrent additions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-concurrent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const command = createHarness(configPath, legacyPath);
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const contextFor = (name: string) => createContext({
    async custom() {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return {
        values: {
          endpoint: name,
          baseUrl: `https://${name}.example.com/v1`,
          model: `${name}-model`,
          format: "openai",
          apiKey: `${name}-secret`,
          maxTurns: "",
          concurrency: "",
          extraBody: "",
        },
      };
    },
    async confirm() { return true; },
  }).ctx;

  await Promise.all([
    command.handler("add alpha", contextFor("alpha")),
    command.handler("add beta", contextFor("beta")),
  ]);

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.endpoints.alpha.model, "alpha-model");
  assert.equal(saved.endpoints.beta.model, "beta-model");
});

test("headless mode permits read commands only and command parsing is strict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-headless-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(configPath, JSON.stringify({
    endpoints: {
      flash: { baseUrl: "https://flash.example.com/v1", apiKey: "secret", model: "flash-model" },
    },
  }));
  const command = createHarness(configPath, legacyPath);
  const notifications: string[] = [];
  const ctx = {
    hasUI: false,
    ui: { notify(message: string) { notifications.push(message); } },
  } as any;

  await command.handler("add blocked", ctx);
  assert.match(notifications.at(-1) ?? "", /需要交互式 TUI/);
  await command.handler("show", ctx);
  assert.match(notifications.at(-1) ?? "", /请指定 endpoint/);
  await command.handler("LIST ignored", ctx);
  assert.match(notifications.at(-1) ?? "", /用法/);
  await command.handler("SHOW flash", ctx);
  assert.match(notifications.at(-1) ?? "", /Model：flash-model/);
  assert.doesNotMatch(notifications.at(-1) ?? "", /secret/);
});

test("fallback editor preserves extraBody without exposing it as an input default", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-fallback-secret-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  writeFileSync(configPath, JSON.stringify({
    endpoints: {
      flash: {
        baseUrl: "https://flash.example.com/v1",
        apiKey: "api-secret",
        model: "flash-model",
        format: "openai",
        extraBody: { token: "body-secret" },
      },
    },
  }));
  const command = createHarness(configPath, legacyPath);
  const inputDefaults: string[] = [];
  const { ctx } = createContext({
    async input(title: string, initial: string) {
      inputDefaults.push(initial);
      if (title === "API key（留空保留当前值）") return "";
      return initial;
    },
    async select(title: string, options: string[]) {
      if (title === "Format") return options[0];
      if (title === "Extra body JSON") return "保留当前值";
      return undefined;
    },
    async confirm() { return true; },
  });

  await command.handler("edit flash", ctx);
  assert.equal(inputDefaults.some((value) => value.includes("body-secret")), false);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.endpoints.flash.extraBody, { token: "body-secret" });
});

test("cross-process additions share the canonical file lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-explore-manager-process-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "api.json");
  const legacyPath = join(dir, "api-explore.json");
  const workerPath = join(dir, "worker.mjs");
  const modulePath = fileURLToPath(new URL("../src/providers/explore-config-manager.ts", import.meta.url));
  writeFileSync(workerPath, [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const [configPath, legacyPath, name, modulePath, barrierDir] = process.argv.slice(2);',
    'const { registerExploreConfigManager } = await import(pathToFileURL(modulePath).href);',
    'let command;',
    'registerExploreConfigManager({ registerCommand(_name, value) { command = value; } }, { configPath, legacyPath });',
    'await command.handler(`add ${name}`, {',
    '  hasUI: true,',
    '  ui: {',
    '    async custom() {',
    '      writeFileSync(join(barrierDir, `ready-${name}`), "");',
    '      while (!existsSync(join(barrierDir, "go"))) await new Promise((resolve) => setTimeout(resolve, 5));',
    '      return { values: { endpoint: name, baseUrl: `https://${name}.example.com/v1`, model: `${name}-model`, format: "openai", apiKey: `${name}-secret`, maxTurns: "", concurrency: "", extraBody: "" } };',
    '    },',
    '    async confirm() { return true; },',
    '    notify(message, level) { if (level === "error") throw new Error(message); },',
    '  },',
    '});',
  ].join("\n"));

  const startWorker = (name: string) => {
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      workerPath,
      configPath,
      legacyPath,
      name,
      modulePath,
      dir,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    return new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${output}`)));
    });
  };

  const alpha = startWorker("alpha");
  const beta = startWorker("beta");
  const deadline = Date.now() + 10_000;
  while ((!existsSync(join(dir, "ready-alpha")) || !existsSync(join(dir, "ready-beta"))) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const alphaReady = existsSync(join(dir, "ready-alpha"));
  const betaReady = existsSync(join(dir, "ready-beta"));
  writeFileSync(join(dir, "go"), "");
  assert.ok(alphaReady, "alpha worker did not reach the mutation barrier");
  assert.ok(betaReady, "beta worker did not reach the mutation barrier");
  await Promise.all([alpha, beta]);

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.endpoints.alpha.model, "alpha-model");
  assert.equal(saved.endpoints.beta.model, "beta-model");
  assert.equal(existsSync(`${configPath}.lock`), false);
});
