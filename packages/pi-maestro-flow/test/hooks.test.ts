import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
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
