import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  revokeHookConfigTrust,
  trustHookConfig,
} from "../src/hooks/trust.ts";
import { registerCodexHookAdapter } from "../src/hooks/pi-adapter.ts";

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

test("matches regex groups and skips async or non-command handlers", () => {
  const config = validateCodexHooks({
    hooks: {
      PreToolUse: [
        { matcher: "Bash|apply_patch", hooks: [{ type: "command", command: "echo sync" }] },
        { matcher: "*", hooks: [{ type: "command", command: "echo async", async: true }] },
        { hooks: [{ type: "prompt", prompt: "ignored" }] },
      ],
    },
  });
  assert.deepEqual(
    getMatchingCommandHooks(config, "PreToolUse", ["apply_patch", "Edit"]).map((hook) => hook.command),
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
  await writeFile(scriptPath, "setTimeout(() => process.stdout.write('{}'), 1000);");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
  const config = validateCodexHooks({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command, timeout: 0 }] }],
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

test("Pi adapter maps PreToolUse deny output to tool_call blocking", async () => {
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
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath });

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
    }, ctx) as { block?: boolean; reason?: string };
    assert.equal(result.block, true);
    assert.equal(result.reason, "blocked by policy");
    assert.deepEqual(notifications, []);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0].options, { triggerTurn: false });
    assert.deepEqual(sentMessages[0].message, {
      customType: "codex-hook-output",
      content: `Codex Hook: PreToolUse\nCommand: ${command}\nOutput:\nblocked by policy`,
      display: true,
      details: { event: "PreToolUse", command },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter does not append a Stop continuation behind a pending message", async () => {
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
  const fakePi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage(message: string) { continuations.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    model: { id: "test-model" },
    hasPendingMessages: () => true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    for (const handler of handlers.get("agent_end") ?? []) {
      await handler({ type: "agent_end", messages: [{ role: "assistant", content: [] }] }, ctx);
    }

    assert.deepEqual(continuations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter maps PreToolUse ask and PermissionRequest decisions", async () => {
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
        behavior: "allow",
        updatedPermissions: [{
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Bash", ruleContent: "npm test" }]
        }]
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
      async select() {
        prompts++;
        return "Allow once";
      },
    },
  } as unknown as ExtensionContext;
  const adapter = registerCodexHookAdapter(fakePi, { trustFilePath: trustPath });

  try {
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
    assert.equal(prompts, 1);
    assert.deepEqual(input, { command: "npm test" });

    const decision = await adapter.requestPermission(
      { toolName: "bash", input: { command: "npm test" } },
      ctx,
      "Bash(npm test)",
      false,
    );
    assert.equal(decision?.behavior, "allow");
    assert.deepEqual(decision?.updatedPermissions, [{
      type: "addRules",
      behavior: "allow",
      destination: "session",
      rules: [{ toolName: "Bash", ruleContent: "npm test" }],
    }]);

    const brokerInput = { command: "npm run nested" };
    assert.equal(await adapter.beforeToolCall({
      toolName: "bash",
      toolCallId: "nested-tool-ask",
      input: brokerInput,
    }, ctx), undefined);
    assert.equal(prompts, 2);
    assert.deepEqual(brokerInput, { command: "npm test" });
    assert.deepEqual(await adapter.requestPermission(
      { toolName: "bash", input: brokerInput },
      ctx,
      "Bash(npm test)",
      false,
    ), { behavior: "allow" });

    const childHandlers = new Map<string, Handler[]>();
    const childPi = {
      on(name: string, handler: Handler) {
        childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]);
      },
      registerCommand() {},
      sendMessage() {},
      sendUserMessage() {},
    } as unknown as ExtensionAPI;
    registerCodexHookAdapter(childPi, {
      trustFilePath: trustPath,
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
    assert.equal(prompts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter injects UserPromptSubmit context as a message, not the system prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hooks-context-"));
  const configDir = join(root, ".pi");
  const trustPath = join(root, "user", "hook-trust.json");
  const scriptPath = join(root, "context.cjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(scriptPath, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
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
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath });

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
    assert.deepEqual(result.message, {
      customType: "codex-hook-context",
      content: "dynamic hook context",
      display: false,
      details: { source: "hooks" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter sends a visible bounded message for every executed command hook", async () => {
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
  registerCodexHookAdapter(fakePi, { trustFilePath: trustPath });

  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    const [inputHandler] = handlers.get("input") ?? [];
    await inputHandler({ source: "user", text: "continue" }, ctx);

    assert.equal(sentMessages.length, 2);
    for (const entry of sentMessages) {
      assert.equal(entry.message.customType, "codex-hook-output");
      assert.equal(entry.message.display, true);
      assert.deepEqual(entry.options, { triggerTurn: false });
      assert.match(entry.message.content ?? "", /^Codex Hook: UserPromptSubmit\nCommand: /);
      assert.ok((entry.message.content ?? "").length <= 4000);
    }
    assert.match(sentMessages[0].message.content ?? "", new RegExp(firstCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(sentMessages[0].message.content ?? "", /first output:/);
    assert.match(sentMessages[0].message.content ?? "", /\[truncated\]$/);
    assert.match(sentMessages[1].message.content ?? "", new RegExp(secondCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(sentMessages[1].message.content ?? "", /"result": "second output"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
