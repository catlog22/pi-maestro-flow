import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  CodexHookConfigError,
  loadCodexHooks,
  validateCodexHooks,
} from "../src/hooks/schema.ts";
import {
  getMatchingCommandHooks,
  runMatchingCommandHooks,
} from "../src/hooks/runner.ts";
import {
  isHookConfigTrusted,
  loadHookToggles,
  revokeHookConfigTrust,
  setHookEnabled,
  trustHookConfig,
} from "../src/hooks/trust.ts";
import { registerCodexHookAdapter } from "../src/hooks/pi-adapter.ts";
import { buildHookReviewEntries } from "../src/hooks/review.ts";
import { HookReviewOverlay, type HookReviewAction } from "../src/hooks/review-tui.ts";
import {
  MaestroHookInstallerOverlay,
  type MaestroHookInstallerAction,
} from "../src/hooks/installer-tui.ts";
import {
  MaestroHookInstallerStore,
  hooksForPreset,
  maestroHookDefinitions,
  mergeMaestroHooks,
} from "../src/hooks/installer-store.ts";
import { createPermissionController } from "../src/permissions/controller.ts";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("loads Codex-compatible hooks from .pi/hooks.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-config-"));
  const configDir = join(root, ".pi");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "^Bash$",
        hooks: [{
          type: "command",
          command: "node policy.js",
          command_windows: "node policy.windows.js",
          statusMessage: "Checking command",
        }],
      }],
    },
  }));

  try {
    const loaded = await loadCodexHooks(root);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.hash?.length, 64);
    const handler = loaded.config.hooks.PreToolUse?.[0].hooks[0];
    assert.equal(handler?.type, "command");
    if (handler?.type === "command") {
      assert.equal(handler.commandWindows, "node policy.windows.js");
      assert.equal(handler.timeout, 600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed event and matcher definitions", () => {
  assert.throws(
    () => validateCodexHooks({ hooks: { UnknownEvent: [] } }),
    (error: unknown) => error instanceof CodexHookConfigError,
  );
  assert.throws(
    () => validateCodexHooks({
      hooks: {
        PreToolUse: [{ matcher: "[", hooks: [{ type: "command", command: "echo ok" }] }],
      },
    }),
    /matcher is invalid/,
  );
});

test("rejects unknown hook fields and non-positive timeouts", () => {
  assert.throws(
    () => validateCodexHooks({ hooks: {}, typo: true }),
    /root\.typo is not supported/,
  );
  assert.throws(
    () => validateCodexHooks({ hooks: { Stop: [{ timeOut: 1, hooks: [] }] } }),
    /timeOut is not supported/,
  );
  assert.throws(
    () => validateCodexHooks({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo ok", timeOut: 1 }] }] },
    }),
    /timeOut is not supported/,
  );
  assert.throws(
    () => validateCodexHooks({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo ok", timeout: 0 }] }] },
    }),
    /timeout must be a positive integer/,
  );
  assert.doesNotThrow(() => validateCodexHooks({ $schema: "./hooks.schema.json", hooks: {} }));
});

test("published JSON Schema matches runtime command validation", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/hooks.schema.json", import.meta.url), "utf8"),
  ) as JsonSchemaType;
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  const validConfig = {
    $schema: "./hooks.schema.json",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo ok", command_windows: "echo ok", timeout: 1 }] }],
    },
  };
  const unknownField = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo ok", timeOut: 1 }] }] },
  };
  const zeroTimeout = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo ok", timeout: 0 }] }] },
  };

  assert.equal(validate(validConfig).valid, true);
  assert.equal(validate(unknownField).valid, false);
  assert.equal(validate(zeroTimeout).valid, false);
  assert.doesNotThrow(() => validateCodexHooks(validConfig));
  assert.throws(() => validateCodexHooks(unknownField), CodexHookConfigError);
  assert.throws(() => validateCodexHooks(zeroTimeout), CodexHookConfigError);
});

test("Maestro Hook installer presets merge owned hooks and preserve user hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-maestro-hook-installer-"));
  const configDir = join(root, ".pi");
  const configPath = join(configDir, "hooks.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    $schema: "./hooks.schema.json",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: "echo user", timeout: 9 },
        { type: "command", command: "maestro hooks run workflow-guard", timeout: 600 },
      ] }],
      UserPromptSubmit: [{ hooks: [
        { type: "command", command: "maestro hooks run kg-unified-injector", timeout: 600 },
      ] }],
    },
  }));
  const store = new MaestroHookInstallerStore(root);

  try {
    const initial = await store.load();
    assert.deepEqual(initial.installedNames, ["workflow-guard"]);
    assert.equal(initial.thirdPartyHandlers, 1);
    assert.ok(initial.definitions.some((definition) => definition.name === "session-context"));

    const installed = await store.apply(hooksForPreset("minimal"));
    assert.equal(installed.installedPreset, "minimal");
    const loaded = await loadCodexHooks(root);
    assert.equal(loaded.config.$schema, "./hooks.schema.json");
    const commands = Object.values(loaded.config.hooks)
      .flatMap((groups) => groups ?? [])
      .flatMap((group) => group.hooks)
      .filter((handler) => handler.type === "command")
      .map((handler) => handler.command);
    assert.ok(commands.includes("echo user"));
    assert.equal(commands.some((command) => command.includes("kg-unified-injector")), false);
    assert.deepEqual(
      commands.filter((command) => command.startsWith("maestro hooks run ")),
      hooksForPreset("minimal").map((name) => `maestro hooks run ${name}`),
    );

    await store.uninstall();
    const uninstalled = await loadCodexHooks(root);
    const remaining = Object.values(uninstalled.config.hooks)
      .flatMap((groups) => groups ?? [])
      .flatMap((group) => group.hooks)
      .filter((handler) => handler.type === "command")
      .map((handler) => handler.command);
    assert.deepEqual(remaining, ["echo user"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Maestro Hook installer defaults to standard and refuses malformed config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-maestro-hook-malformed-"));
  const store = new MaestroHookInstallerStore(root);
  const configPath = join(root, ".pi", "hooks.json");

  try {
    const missing = await store.load();
    assert.deepEqual(missing.suggestedNames, hooksForPreset("standard"));
    assert.equal(missing.installedPreset, "none");
    assert.equal(maestroHookDefinitions().filter((definition) => definition.permissionAdvisory).length, 3);

    await mkdir(dirname(configPath), { recursive: true });
    const malformed = "{ broken installer config\n";
    await writeFile(configPath, malformed);
    await assert.rejects(store.apply(hooksForPreset("minimal")));
    assert.equal(await readFile(configPath, "utf8"), malformed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent Maestro Hook installer writes remain valid and preserve user hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-maestro-hook-concurrent-"));
  const configDir = join(root, ".pi");
  const configPath = join(configDir, "hooks.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep", timeout: 5 }] }] },
  }));
  const store = new MaestroHookInstallerStore(root);

  try {
    const levels = ["minimal", "standard", "full", "none"] as const;
    await Promise.all(Array.from({ length: 24 }, (_, index) => store.apply(hooksForPreset(levels[index % levels.length]))));
    const loaded = await loadCodexHooks(root);
    const commands = Object.values(loaded.config.hooks)
      .flatMap((groups) => groups ?? [])
      .flatMap((group) => group.hooks)
      .filter((handler) => handler.type === "command")
      .map((handler) => handler.command);
    assert.ok(commands.includes("echo keep"));
    assert.deepEqual((await readdir(configDir)).filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Maestro Hook installer TUI supports presets, filtering, actions, and narrow rendering", () => {
  const definitions = maestroHookDefinitions();
  const snapshot = {
    configPath: ".pi/hooks.json",
    configExists: false,
    definitions,
    installedNames: [],
    suggestedNames: hooksForPreset("standard"),
    installedPreset: "none" as const,
    thirdPartyHandlers: 2,
  };
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  let action: MaestroHookInstallerAction | undefined;
  const overlay = new MaestroHookInstallerOverlay({
    snapshot,
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });

  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }
  overlay.handleInput("/");
  overlay.handleInput("guard");
  assert.match(overlay.render(100).join("\n"), /workflow-guard/);
  overlay.handleInput("A");
  assert.equal(action, undefined, "filter mode reserves ordinary letters for text");
  overlay.handleInput("\x1b");
  overlay.handleInput("2");
  overlay.handleInput("A");
  assert.equal(action?.kind, "apply");
  assert.deepEqual(action?.uiState.selectedNames, hooksForPreset("minimal"));

  action = undefined;
  const discard = new MaestroHookInstallerOverlay({
    snapshot,
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });
  discard.handleInput("\x1b");
  assert.equal(action, undefined);
  assert.match(discard.render(100).join("\n"), /有未应用修改/);
  discard.handleInput("\x1b");
  assert.equal(action?.kind, "close");
});

test("mergeMaestroHooks rejects unknown selections", () => {
  assert.throws(() => mergeMaestroHooks({ hooks: {} }, ["not-a-maestro-hook"]));
});

test("Hook review TUI supports bounded rendering, explicit filtering, toggles, and trust actions", () => {
  const config = validateCodexHooks({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: "echo check", timeout: 5 },
        { type: "prompt", prompt: "unsupported prompt" },
      ] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "echo \x1b[2Jwrite\nforged\u202ehidden", timeout: 5 }] }],
    },
  });
  const entries = buildHookReviewEntries({
    config,
    filePath: ".pi/hooks.json",
    hash: "hash",
    exists: true,
  }, {});
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  let action: HookReviewAction | undefined;
  const overlay = new HookReviewOverlay({
    entries,
    trusted: false,
    configPath: ".pi/hooks.json",
    hash: "hash",
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });

  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
  overlay.handleInput("/");
  overlay.handleInput("write");
  const renderedUnsafe = overlay.render(80).join("\n");
  assert.match(renderedUnsafe, /echo \\x1b\[2Jwrite\\nforged\\u202ehidden/);
  assert.doesNotMatch(renderedUnsafe, /\x1b|\u202e/);
  assert.doesNotMatch(overlay.render(80).join("\n"), /echo check/);
  overlay.handleInput("T");
  assert.equal(action, undefined, "筛选模式不能触发字母功能键");
  overlay.handleInput("\x1b");
  overlay.handleInput("T");
  assert.equal(action?.kind, "toggle-trust");

  action = undefined;
  const toggle = new HookReviewOverlay({
    entries,
    trusted: true,
    configPath: ".pi/hooks.json",
    hash: "hash",
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });
  toggle.handleInput(" ");
  assert.equal(action?.kind, "toggle");
  assert.equal(action?.hookId, entries[0].id);

  action = undefined;
  const install = new HookReviewOverlay({
    entries,
    trusted: true,
    configPath: ".pi/hooks.json",
    hash: "hash",
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });
  install.handleInput("I");
  assert.equal(action?.kind, "install");
});

test("Hook review detail exposes the complete long command before trust", () => {
  const command = Array.from({ length: 80 }, (_, index) => `token-${String(index).padStart(2, "0")}`).join(" ");
  const config = validateCodexHooks({
    hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 5 }] }] },
  });
  const entries = buildHookReviewEntries({
    config,
    filePath: ".pi/hooks.json",
    hash: "hash",
    exists: true,
  }, {});
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  let action: HookReviewAction | undefined;
  const overlay = new HookReviewOverlay({
    entries,
    trusted: false,
    configPath: ".pi/hooks.json",
    hash: "hash",
    theme,
    locale: "zh-CN",
    requestRender() {},
    done(next) { action = next; },
  });

  assert.doesNotMatch(overlay.render(32).join("\n"), /token-79/);
  overlay.handleInput("\r");
  assert.equal(action, undefined, "Enter opens detail instead of trusting the config");
  let detail = overlay.render(32).join("\n");
  assert.match(detail, /token-00/);
  for (let index = 0; index < 20 && !detail.includes("token-79"); index++) {
    overlay.handleInput("\x1b[6~");
    detail = overlay.render(32).join("\n");
  }
  assert.match(detail, /token-79/);
  for (const line of overlay.render(10)) assert.ok(visibleWidth(line) <= 10);
  overlay.handleInput("T");
  assert.equal(action, undefined, "detail mode cannot trigger trust shortcuts");
  overlay.handleInput("\x1b");
  overlay.handleInput("T");
  assert.equal(action?.kind, "toggle-trust");
});

test("matches regex groups and skips async or non-command handlers", () => {
  const config = validateCodexHooks({
    hooks: {
      PreToolUse: [
        { matcher: "Bash|Edit", hooks: [{ type: "command", command: "echo sync" }] },
        { matcher: "*", hooks: [{ type: "command", command: "echo async", async: true }] },
        { hooks: [{ type: "prompt", prompt: "ignored" }] },
      ],
    },
  });
  assert.deepEqual(
    getMatchingCommandHooks(config, "PreToolUse", ["Edit"]).map((hook) => hook.command),
    ["echo sync"],
  );
});

test("command hooks receive JSON stdin and return JSON stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-runner-"));
  const scriptPath = join(root, "hook.cjs");
  await writeFile(scriptPath, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: parsed.tool_input.command
    }
  }));
});
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  const config = validateCodexHooks({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  });

  try {
    const [result] = await runMatchingCommandHooks(
      config,
      "PreToolUse",
      ["Bash"],
      { tool_input: { command: "blocked command" } },
      root,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(
      (result.json?.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
      "blocked command",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command hook timeout is enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-timeout-"));
  const scriptPath = join(root, "slow.cjs");
  await writeFile(scriptPath, "setTimeout(() => process.stdout.write('{}'), 5000);");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  const config = validateCodexHooks({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command, timeout: 1 }] }],
    },
  });

  try {
    const [result] = await runMatchingCommandHooks(config, "Stop", [], {}, root);
    assert.equal(result.timedOut, true);
    assert.match(result.error ?? "", /timed out/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command hook completion terminates descendant processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-abort-"));
  const scriptPath = join(root, "tree.cjs");
  const pidPath = join(root, "descendant.pid");
  await writeFile(scriptPath, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
process.exit(0);
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  const config = validateCodexHooks({
    hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }] },
  });
  let descendantPid: number | undefined;

  try {
    const [result] = await runMatchingCommandHooks(config, "Stop", [], {}, root);
    descendantPid = Number(await readFile(pidPath, "utf8"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.error, undefined);
    assert.equal(isProcessRunning(descendantPid), false);
  } finally {
    if (descendantPid && isProcessRunning(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("command hook output is retained within the combined byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-output-limit-"));
  const scriptPath = join(root, "large-output.cjs");
  await writeFile(scriptPath, "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  const config = validateCodexHooks({
    hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }] },
  });

  try {
    const [result] = await runMatchingCommandHooks(config, "Stop", [], {}, root);
    assert.match(result.error ?? "", /output exceeded/);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trust is bound to the exact hooks.json hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-trust-"));
  const trustPath = join(root, "user", "hook-trust.json");
  const configPath = join(root, "project", ".pi", "hooks.json");
  try {
    assert.equal(await isHookConfigTrusted(trustPath, configPath, "hash-a"), false);
    await trustHookConfig(trustPath, configPath, "hash-a");
    assert.equal(await isHookConfigTrusted(trustPath, configPath, "hash-a"), true);
    assert.equal(await isHookConfigTrusted(trustPath, configPath, "hash-b"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("per-Hook toggles persist without changing config trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-toggle-"));
  const trustPath = join(root, "user", "hook-trust.json");
  const configPath = join(root, ".pi", "hooks.json");
  const config = validateCodexHooks({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: "echo first", timeout: 5 },
        { type: "command", command: "echo second", timeout: 5 },
      ] }],
    },
  });
  const loaded = { config, filePath: configPath, hash: "hash-a", exists: true };
  const entries = buildHookReviewEntries(loaded, {});
  const reordered = buildHookReviewEntries({
    ...loaded,
    config: validateCodexHooks({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [
          { type: "command", command: "echo second", timeout: 5 },
          { type: "command", command: "echo first", timeout: 5 },
        ] }],
      },
    }),
  }, {});
  assert.deepEqual(
    Object.fromEntries(entries.map((entry) => [entry.command, entry.id])),
    Object.fromEntries(reordered.map((entry) => [entry.command, entry.id])),
    "reordering distinct handlers must not reset their toggle IDs",
  );

  const duplicateConfig = validateCodexHooks({
    hooks: {
      Stop: [{ hooks: [
        { type: "command", command: "echo duplicate", timeout: 5 },
        { type: "command", command: "echo duplicate", timeout: 5 },
      ] }],
    },
  });
  const duplicateLoaded = { ...loaded, config: duplicateConfig };
  const duplicates = buildHookReviewEntries(duplicateLoaded, {});
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  assert.deepEqual(
    duplicates.map((entry) => entry.id),
    buildHookReviewEntries(duplicateLoaded, {}).map((entry) => entry.id),
  );
  assert.equal(
    getMatchingCommandHooks(duplicateConfig, "Stop", [], { [duplicates[0].id]: false }).length,
    1,
  );

  try {
    await trustHookConfig(trustPath, configPath, "hash-a");
    await setHookEnabled(trustPath, configPath, entries[0].id, false);
    const toggles = await loadHookToggles(trustPath, configPath);
    assert.equal(await isHookConfigTrusted(trustPath, configPath, "hash-a"), true);
    assert.equal(toggles[entries[0].id], false);
    assert.deepEqual(
      getMatchingCommandHooks(config, "PreToolUse", ["Bash"], toggles).map((handler) => handler.command),
      ["echo second"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed Hook trust state fails closed without being overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-malformed-trust-"));
  const trustPath = join(root, "user", "hook-trust.json");
  const configPath = join(root, ".pi", "hooks.json");
  await mkdir(dirname(trustPath), { recursive: true });

  try {
    for (const malformed of [
      "{not-json\n",
      JSON.stringify({ version: 1, trusted: { [configPath]: 42 }, toggles: {} }),
      JSON.stringify({ version: 1, trusted: {}, toggles: { [configPath]: { hook: "off" } } }),
    ]) {
      await writeFile(trustPath, malformed);
      await assert.rejects(isHookConfigTrusted(trustPath, configPath, "hash"));
      await assert.rejects(loadHookToggles(trustPath, configPath));
      await assert.rejects(setHookEnabled(trustPath, configPath, "hook", false));
      assert.equal(await readFile(trustPath, "utf8"), malformed);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hook fallback refuses to trust without a complete review TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-trust-preview-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: Array.from({ length: 10 }, (_, index) => ({
        hooks: [{
          type: "command",
          command: index === 0 ? "echo 0\x1b[2J\nforged\u202ehidden\x1b]8;;https://invalid.example\x07link\x1b]8;;\x07" : `echo ${index}`,
        }],
      })),
    },
  }));

  type Handler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: Handler | undefined;
  let confirmCalls = 0;
  const notifications: string[] = [];
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: Handler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      async confirm() {
        confirmCalls++;
        return true;
      },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("", ctx);
    const loaded = await loadCodexHooks(root);
    assert.equal(confirmCalls, 0);
    assert.equal(await isHookConfigTrusted(trustPath, loaded.filePath, loaded.hash ?? ""), false);
    assert.equal(notifications.some((message) => message.includes("信任未更改")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/hooks opens the installer for a missing config then routes to hash review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-install-command-"));
  const trustPath = join(root, "user", "hook-trust.json");
  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: CommandHandler | undefined;
  let customCalls = 0;
  let confirmCalls = 0;
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
      async confirm() { confirmCalls++; return true; },
      async custom(factory: Function) {
        return new Promise((resolve, reject) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          customCalls++;
          setImmediate(() => {
            try {
              const rendered = component.render(100).join("\n");
              if (customCalls === 1) {
                assert.match(rendered, /Maestro Flow Hooks 安装/);
                component.handleInput("2");
                component.handleInput("A");
              } else if (customCalls === 2) {
                assert.match(rendered, /已安装/);
                component.handleInput("\x1b");
              } else {
                assert.match(rendered, /Hook 审查/);
                component.handleInput("\x1b");
              }
            } catch (error) {
              reject(error);
            }
          });
        });
      },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("", ctx);
    const loaded = await loadCodexHooks(root);
    const snapshot = await new MaestroHookInstallerStore(root).load();
    assert.equal(customCalls, 3);
    assert.equal(confirmCalls, 1);
    assert.equal(snapshot.installedPreset, "minimal");
    assert.equal(await isHookConfigTrusted(trustPath, loaded.filePath, loaded.hash ?? ""), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/hooks install explicitly opens the dedicated installer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-install-explicit-"));
  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: CommandHandler | undefined;
  let rendered = "";
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
    ui: {
      notify() {},
      setStatus() {},
      async custom(factory: Function) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          rendered = component.render(100).join("\n");
          setImmediate(() => {
            component.handleInput("\x1b");
            component.handleInput("\x1b");
          });
        });
      },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: join(root, "trust.json"), locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("install", ctx);
    assert.match(rendered, /Maestro Flow Hooks 安装/);
    await assert.rejects(stat(join(root, ".pi", "hooks.json")), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/hooks install fails closed without an interactive TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-install-no-ui-"));
  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: CommandHandler | undefined;
  const notifications: string[] = [];
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: false,
    model: { id: "test-model" },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: join(root, "trust.json"), locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("install", ctx);
    assert.equal(notifications.some((message) => message.includes("需要交互式 TUI")), true);
    await assert.rejects(stat(join(root, ".pi", "hooks.json")), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/hooks opens the custom TUI by default and applies toggles immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-tui-command-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo managed", timeout: 5 }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);

  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: CommandHandler | undefined;
  let customCalls = 0;
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
      async confirm() { return true; },
      async custom(factory: Function) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          assert.equal(typeof component.render, "function");
          customCalls++;
          setImmediate(() => {
            if (customCalls === 1) component.handleInput("T");
            else if (customCalls === 2) component.handleInput(" ");
            else {
              assert.match(component.render(80).join("\n"), /○ 停用/);
              component.handleInput("\x1b");
            }
          });
        });
      },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("", ctx);
    const entries = buildHookReviewEntries(loaded, await loadHookToggles(trustPath, loaded.filePath));
    assert.equal(customCalls, 3);
    assert.equal(await isHookConfigTrusted(trustPath, loaded.filePath, loaded.hash ?? ""), true);
    assert.equal(entries[0].enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/hooks keeps toggle persistence failures inside the review overlay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-tui-failure-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo failure", timeout: 5 }] }] },
  }));

  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  let hooksCommand: CommandHandler | undefined;
  let customCalls = 0;
  let confirmCalls = 0;
  const notifications: string[] = [];
  const fakePi = {
    on() {},
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const theme = {
    fg(_role: string, text: string) { return text; },
    bold(text: string) { return text; },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      async confirm() { confirmCalls++; return false; },
      async custom(factory: Function) {
        return new Promise((resolve, reject) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          customCalls++;
          setImmediate(() => {
            if (customCalls === 1) {
              void mkdir(trustPath, { recursive: true }).then(() => component.handleInput(" "), reject);
            } else {
              assert.match(component.render(100).join("\n"), /更新失败/);
              component.handleInput("\x1b");
            }
          });
        });
      },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    assert.ok(hooksCommand);
    await hooksCommand("", ctx);
    assert.equal(customCalls, 2);
    assert.equal(confirmCalls, 0);
    assert.equal(notifications.some((message) => message.includes("TUI 不可用")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hook trust is the only gate for command execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-single-gate-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "mark.cjs");
  const markerPath = join(root, "ran.txt");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, `
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(${JSON.stringify(markerPath)}, "ran"));
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  }));

  type EventHandler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, EventHandler[]>();
  let hooksCommand: CommandHandler | undefined;
  const fakePi = {
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hooks") hooksCommand = definition.handler;
    },
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
      async confirm() { return true; },
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [toolHandler] = handlers.get("tool_call") ?? [];
    await toolHandler({ toolName: "bash", toolCallId: "before-trust", input: { command: "echo ok" } }, ctx);
    await assert.rejects(stat(markerPath), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");

    const loaded = await loadCodexHooks(root);
    await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "resume" }, ctx);
    }
    await toolHandler({ toolName: "bash", toolCallId: "after-trust", input: { command: "echo ok" } }, ctx);
    assert.equal(await readFile(markerPath, "utf8"), "ran");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent hook trust and revoke mutations preserve unrelated entries and clean up private temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-concurrent-trust-"));
  const trustDirectory = join(root, "user");
  const trustPath = join(trustDirectory, "hook-trust.json");
  const trustAliasDirectory = join(trustDirectory, "alias");
  const trustAliasPath = `${trustAliasDirectory}${sep}..${sep}hook-trust.json`;
  const configPaths = Array.from(
    { length: 32 },
    (_, index) => join(root, `project-${index}`, ".pi", "hooks.json"),
  );
  try {
    await mkdir(trustAliasDirectory, { recursive: true });
    await Promise.all(configPaths.map((configPath, index) => (
      trustHookConfig(index % 2 === 0 ? trustPath : trustAliasPath, configPath, `hash-${index}`)
    )));
    await Promise.all(configPaths.map((configPath, index) => (
      index % 2 === 0
        ? revokeHookConfigTrust(trustPath, configPath)
        : trustHookConfig(trustPath, configPath, `updated-hash-${index}`)
    )));

    const transientConfigPath = join(root, "transient", ".pi", "hooks.json");
    const trustTransient = trustHookConfig(trustPath, transientConfigPath, "transient-hash");
    const revokeTransient = revokeHookConfigTrust(trustPath, transientConfigPath);
    await Promise.all([trustTransient, revokeTransient]);

    for (const [index, configPath] of configPaths.entries()) {
      assert.equal(
        await isHookConfigTrusted(trustPath, configPath, `updated-hash-${index}`),
        index % 2 === 1,
      );
    }
    assert.equal(await isHookConfigTrusted(trustPath, transientConfigPath, "transient-hash"), false);
    assert.deepEqual((await readdir(trustDirectory)).filter((entry) => entry.endsWith(".tmp")), []);
    if (process.platform !== "win32") {
      assert.equal((await stat(trustPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh processes preserve concurrent Hook trust and toggle mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-cross-process-"));
  const trustPath = join(root, "user", "hook-trust.json");
  const workerPath = join(root, "worker.mjs");
  const trustModuleUrl = new URL("../src/hooks/trust.ts", import.meta.url).href;
  const workerCount = 12;
  const configPaths = Array.from(
    { length: workerCount },
    (_, index) => join(root, `project-${index}`, ".pi", "hooks.json"),
  );
  await writeFile(workerPath, `
import { setHookEnabled, trustHookConfig } from ${JSON.stringify(trustModuleUrl)};
const [trustPath, configPath, index, startAt] = process.argv.slice(2);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
await trustHookConfig(trustPath, configPath, \`hash-\${index}\`);
await setHookEnabled(trustPath, configPath, \`hook-\${index}\`, false);
`);

  const startAt = Date.now() + 1_000;
  await mkdir(`${trustPath}.lock`, { recursive: true });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(`${trustPath}.lock`, staleTime, staleTime);
  try {
    await Promise.all(configPaths.map((configPath, index) => new Promise<void>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [
        "--experimental-transform-types",
        workerPath,
        trustPath,
        configPath,
        String(index),
        String(startAt),
      ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", rejectChild);
      child.once("close", (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new Error(`Hook trust worker ${index} exited ${code}: ${stderr}`));
      });
    })));

    for (const [index, configPath] of configPaths.entries()) {
      assert.equal(await isHookConfigTrusted(trustPath, configPath, `hash-${index}`), true);
      assert.equal((await loadHookToggles(trustPath, configPath))[`hook-${index}`], false);
    }
    assert.deepEqual((await readdir(dirname(trustPath))).filter((entry) => entry.endsWith(".lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hook trust mutations recover a stale lock directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-stale-lock-"));
  const trustPath = join(root, "user", "hook-trust.json");
  const configPath = join(root, ".pi", "hooks.json");
  const lockPath = `${trustPath}.lock`;
  await mkdir(dirname(trustPath), { recursive: true });
  await mkdir(lockPath, { recursive: true });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  try {
    await trustHookConfig(trustPath, configPath, "hash");
    assert.equal(await isHookConfigTrusted(trustPath, configPath, "hash"), true);
    await assert.rejects(stat(lockPath), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter ignores PreToolUse deny output after the Hook is trusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-adapter-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "deny.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, "process.stderr.write('blocked by policy'); process.exit(2);");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [toolHandler] = handlers.get("tool_call") ?? [];
    const result = await toolHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "danger" },
    }, ctx);
    assert.equal(result, undefined);
    assert.deepEqual(notifications, []);
    assert.equal(sentMessages.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter ignores protocol output from failed hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-failed-output-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "failed.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, `
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
let output;
if (input.hook_event_name === "PreToolUse") {
  output = { hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "replaced" } } };
} else if (input.hook_event_name === "PermissionRequest") {
  output = { hookSpecificOutput: { decision: { behavior: "allow", updatedInput: { command: "replaced" } } } };
} else {
  output = {
    systemMessage: "must not notify",
    diagnostic: "x".repeat(5000),
    hookSpecificOutput: { additionalContext: "must not inject" }
  };
}
process.stdout.write(JSON.stringify(output));
process.exitCode = 1;
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
      PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [
        { type: "command", command, timeout: 5 },
        { type: "command", command, timeout: 5 },
      ] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const sentMessages: Array<{
    message: { customType?: string; content?: string; details?: unknown };
    options?: { triggerTurn?: boolean };
  }> = [];
  let prompts = 0;
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage(message: typeof sentMessages[number]["message"], options?: typeof sentMessages[number]["options"]) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      async select() {
        prompts++;
        return "仅本次允许";
      },
    },
  } as unknown as ExtensionContext;
  const adapter = registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const input = { command: "original" };
    const [toolHandler] = handlers.get("tool_call") ?? [];
    assert.equal(await toolHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "failed-tool",
      input,
    }, ctx), undefined);
    assert.deepEqual(input, { command: "original" });
    assert.equal(prompts, 0);

    assert.equal(await adapter.requestPermission(
      { toolName: "bash", input: { command: "original" } },
      ctx,
      "Bash(original)",
      false,
    ), undefined);

    const [inputHandler] = handlers.get("input") ?? [];
    await inputHandler({ source: "user", text: "continue" }, ctx);
    const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
    assert.equal(await beforeAgentStart({ prompt: "continue", systemPrompt: "stable" }, ctx), undefined);
    assert.equal(notifications.some((message) => message.includes("must not notify")), false);
    assert.deepEqual(notifications, []);
    assert.equal(sentMessages.length, 3);
    assert.match(sentMessages[0].message.content ?? "", /^Hook 失败 · PreToolUse/);
    assert.match(sentMessages[1].message.content ?? "", /^Hook 失败 · PermissionRequest/);
    assert.match(sentMessages[2].message.content ?? "", /^Hook 失败 · UserPromptSubmit（2）/);
    assert.match(sentMessages[2].message.content ?? "", /其他失败：\n2\./);
    assert.match(sentMessages[2].message.content ?? "", /\[truncated\]/);
    assert.ok((sentMessages[2].message.content ?? "").length < 3000);
    assert.deepEqual(sentMessages[2].message.details, { event: "UserPromptSubmit", count: 2 });
    for (const entry of sentMessages) {
      assert.equal(entry.message.customType, "codex-hook-failure");
      assert.deepEqual(entry.options, { triggerTurn: false });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter absorbs hook results after session shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-shutdown-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "slow.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, "setTimeout(() => process.stdout.write(JSON.stringify({systemMessage: 'late'})), 5000);");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{
        type: "command",
        command,
        timeout: 10,
        statusMessage: "running hook",
      }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  let sentMessages = 0;
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage() { sentMessages++; },
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [inputHandler] = handlers.get("input") ?? [];
    const pending = inputHandler({ source: "user", text: "continue" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [shutdownHandler] = handlers.get("session_shutdown") ?? [];
    shutdownHandler({ type: "session_shutdown" }, ctx);
    await pending;

    assert.deepEqual(notifications, []);
    assert.equal(sentMessages, 0);
    assert.deepEqual(statuses, ["⬡ Hook…", "running hook", undefined, undefined]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter does not append a Stop continuation behind recovery ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-stop-pending-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "stop.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'continue from the hook' }));");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const continuations: string[] = [];
  let pending = true;
  let skipStop = false;
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage(message: string) { continuations.push(message); },
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    hasPendingMessages: () => pending,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, {
    trustFilePath: trustPath,
    locale: "zh-CN",
    shouldSkipStopHook: () => skipStop,
  });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    for (const handler of handlers.get("agent_end") ?? []) {
      await handler({ type: "agent_end", messages: [{ role: "assistant", content: [] }] }, ctx);
    }
    assert.deepEqual(continuations, [], "a pending recovery owner suppresses the Stop continuation");

    pending = false;
    skipStop = true;
    for (const handler of handlers.get("agent_end") ?? []) {
      await handler({ type: "agent_end", messages: [{ role: "assistant", content: [] }] }, ctx);
    }
    assert.deepEqual(continuations, [], "provider-pressure recovery suppresses ordinary Stop hooks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter ignores Hook permission decisions but retains input updates", async () => {
  const permissionPrompts: Array<{ title: string; options: string[] }> = [];
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-permission-request-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "permission.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, `
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const hookSpecificOutput = input.hook_event_name === "PreToolUse"
  ? {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "review command",
      updatedInput: { command: "npm test" }
    }
  : {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "ignored permission decision"
      }
    };
process.stdout.write(JSON.stringify({ hookSpecificOutput }));
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
      PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  let prompts = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
      async select(title: string, options: string[]) {
        prompts++;
        permissionPrompts.push({ title, options });
        return "Allow once";
      },
    },
  } as unknown as ExtensionContext;
  const adapter = registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });
  const permissionController = createPermissionController({
    userSettingsPath: join(root, "user", "settings.json"),
  });

  try {
    await permissionController.reload(ctx);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const input = { command: "npm run unsafe" };
    const [toolHandler] = handlers.get("tool_call") ?? [];
    assert.equal(await toolHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-ask",
      input,
    }, ctx), undefined);
    assert.equal(prompts, 0);
    assert.deepEqual(input, { command: "npm test" });

    assert.equal(await permissionController.authorize(
      { toolName: "bash", input },
      ctx,
      "default",
      adapter,
    ), undefined);
    assert.equal(prompts, 1);
    assert.match(permissionPrompts[0].title, /^Permission required: bash/);
    assert.doesNotMatch(permissionPrompts[0].title, /review command|ignored permission decision/);
    assert.deepEqual(permissionPrompts[0].options, ["Allow once", "Always allow", "Deny"]);

    const brokerInput = { command: "npm run nested" };
    assert.equal(await adapter.beforeToolCall({
      toolName: "bash",
      toolCallId: "nested-tool-ask",
      input: brokerInput,
    }, ctx), undefined);
    assert.equal(prompts, 1);
    assert.deepEqual(brokerInput, { command: "npm test" });
    assert.equal(await permissionController.authorize(
      { toolName: "bash", input: brokerInput },
      ctx,
      "bypassPermissions",
      adapter,
    ), undefined);
    assert.equal(prompts, 1);

    const childHandlers = new Map<string, Handler[]>();
    const childPi = {
      on(name: string, handler: Handler) {
        childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]);
      },
      registerCommand() {},
      sendMessage() {},
      sendUserMessage() {},
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    registerCodexHookAdapter(childPi, {
      trustFilePath: trustPath,
      locale: "zh-CN",
      isTeammateChild: () => true,
    });
    for (const handler of childHandlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const childInput = { command: "npm run unsafe" };
    const [childToolHandler] = childHandlers.get("tool_call") ?? [];
    assert.equal(await childToolHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "child-tool-ask",
      input: childInput,
    }, ctx), undefined);
    assert.deepEqual(childInput, { command: "npm run unsafe" });
    assert.equal(prompts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter injects UserPromptSubmit context as a message, not the system prompt", async () => {
  const notices: Array<{ message: string; level: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-context-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "context.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  systemMessage: "notice-" + "x".repeat(600),
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "dynamic hook context"
  }
})));
`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify(message: string, level: string) { notices.push({ message, level }); },
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [inputHandler] = handlers.get("input") ?? [];
    await inputHandler({ source: "user", text: "continue" }, ctx);
    const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
    const result = await beforeAgentStart({
      prompt: "continue",
      systemPrompt: "stable system prompt",
    }, ctx) as {
      message?: { customType?: string; content?: string; display?: boolean };
      systemPrompt?: string;
    };

    assert.equal(result.systemPrompt, undefined);
    assert.equal(result.message?.customType, "codex-hook-context");
    assert.equal(result.message?.content, "dynamic hook context");
    assert.equal(result.message?.display, true);
    assert.equal((result.message as Record<string, unknown>)?.details != null, true);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "info");
    assert.equal(notices[0].message.length, 500);
    assert.match(notices[0].message, /\[truncated\]$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter keeps successful command hook output out of the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-visible-output-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const firstScript = join(root, "first.cjs");
  const secondScript = join(root, "second.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(firstScript, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('first output:' + 'x'.repeat(5000)));");
  await writeFile(secondScript, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({result: 'second output'})));");
  const firstCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(firstScript)}`;
  const secondCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(secondScript)}`;
  await writeFile(join(configDir, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [
        { type: "command", command: firstCommand, timeout: 5 },
        { type: "command", command: secondCommand, timeout: 5 },
      ] }],
    },
  }));
  const loaded = await loadCodexHooks(root);
  await trustHookConfig(trustPath, loaded.filePath, loaded.hash ?? "");

  type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{
    message: { customType?: string; content?: string; display?: boolean; details?: unknown };
    options?: { triggerTurn?: boolean };
  }> = [];
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage(message: typeof sentMessages[number]["message"], options?: typeof sentMessages[number]["options"]) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath, locale: "zh-CN" });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [inputHandler] = handlers.get("input") ?? [];
    await inputHandler({ source: "user", text: "continue" }, ctx);

    assert.equal(sentMessages.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
