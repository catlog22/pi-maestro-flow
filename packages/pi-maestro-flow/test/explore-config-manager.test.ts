import assert from "node:assert/strict";
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

test("malformed canonical config blocks fallback and is never overwritten", async (t) => {
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

  await assert.rejects(
    () => loadExploreConfigState(configPath, legacyPath),
    /Cannot parse/,
  );

  const command = createHarness(configPath, legacyPath);
  const { ctx, notifications } = createContext();
  await command.handler("list", ctx);
  assert.equal(readFileSync(configPath, "utf8"), malformed);
  assert.match(notifications.at(-1)?.message ?? "", /Cannot parse/);
  assert.equal(notifications.at(-1)?.level, "error");
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
