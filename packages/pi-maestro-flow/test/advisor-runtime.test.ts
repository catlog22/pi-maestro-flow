import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as supervision from "pi-maestro-teammate/v1/supervision";
import registerAdvisor, {
  loadAdvisorWorkspaceConfig,
  setAdvisorTeammateRuntimeForTest,
} from "../src/advisor/extension.ts";
import {
  automaticAdvisorEnabled,
  buildAdvisorPrompt,
  buildAdvisorToolInventory,
  buildManualAdvisorPrompt,
  createAdvisorRuntimeState,
  DEFAULT_ADVISOR_CONFIG,
  ensureAdvisorUserTail,
  formatAdvisory,
  isAdvisorExecutorBlocked,
  manualAdvisorEnabled,
  normalizeAdvisorConfig,
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
  redactAdvisorText,
  resolveAdvisorModel,
  serializeAdvisorConversation,
  serializeToolCheckpoint,
  serializeTranscriptTail,
  stripInflightAdvisorCall,
  verdictDeliveryMode,
} from "../src/advisor/runtime.ts";

function message(role: string, content: string, extra: Record<string, unknown> = {}): unknown {
  return { role, content, ...extra };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for advisor test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("serializeTranscriptTail extracts text and collapses to one line per message", () => {
  const messages = [
    message("user", "Fix the leak"),
    message("assistant", "Looking at src/auth.ts"),
    message("toolResult", "12:34 found", { toolName: "read" }),
  ] as never;
  const out = serializeTranscriptTail(messages);
  assert.match(out, /USER: Fix the leak/);
  assert.match(out, /ASSISTANT: Looking at src\/auth.ts/);
  assert.match(out, /TOOL read: 12:34 found/);
  assert.equal(out.split("\n").length, 3);
});

test("serializeTranscriptTail handles content blocks and custom entries", () => {
  const messages = [
    message("user", [{ text: "part1" }, { text: " part2" }]),
    message("assistant", "ok", { customType: undefined }),
  ] as never;
  const out = serializeTranscriptTail(messages);
  assert.match(out, /USER: part1 part2/);
});

test("serializeTranscriptTail bounds by message count and total chars", () => {
  const messages = Array.from({ length: 20 }, (_, i) => message("user", `msg ${i}`)) as never;
  const byCount = serializeTranscriptTail(messages, 3, 10_000);
  assert.equal(byCount.split("\n").length, 3);
  const byChars = serializeTranscriptTail(messages, 20, 40);
  assert.ok(byChars.length <= 40, `expected <= 40 chars, got ${byChars.length}`);
});

test("serializeToolCheckpoint includes bounded input, result and failure state", () => {
  const out = serializeToolCheckpoint({
    toolName: "bash",
    input: { command: "npm test", apiKey: "super-secret-value" },
    content: [{ text: "failed assertion with Bearer abc.def.ghi" }],
    isError: true,
  }, 160);
  assert.match(out, /TOOL CHECKPOINT bash \(error\)/);
  assert.match(out, /npm test/);
  assert.match(out, /failed assertion/);
  assert.doesNotMatch(out, /super-secret-value|abc\.def\.ghi/);
  assert.match(out, /\[REDACTED\]/);
  assert.ok(out.length <= 160);
  assert.equal(redactAdvisorText("password=hunter2"), "password=[REDACTED]");
});

test("advisor redaction covers common cross-provider credential formats", () => {
  const input = [
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    "Authorization: Basic dXNlcjpwYXNz",
    "Cookie: session=secret-cookie; path=/",
    'password="value with spaces"',
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "https://user:pass@example.com/private",
    "ghp_1234567890abcdefghijklmnop",
    "github_pat_1234567890_abcdefghijklmnop",
    "eyJabcdefghi.abcdefghijkl.abcdefghijkl",
  ].join("\n");
  const redacted = redactAdvisorText(input);
  for (const secret of [
    "private-material",
    "dXNlcjpwYXNz",
    "secret-cookie",
    "value with spaces",
    "aws-secret-value",
    "user:pass",
    "ghp_1234567890abcdefghijklmnop",
    "github_pat_1234567890_abcdefghijklmnop",
    "eyJabcdefghi.abcdefghijkl.abcdefghijkl",
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(redacted, /\[REDACTED\]/);
});

test("advisor config preserves legacy defaults and resolves dedicated or main model", () => {
  const legacy = normalizeAdvisorConfig({ enabled: true, guide: "focus", cooldownMs: 0 });
  assert.equal(legacy.mode, "automatic");
  assert.equal(legacy.consultThinking, "high");
  assert.deepEqual(legacy.disabledForModels, []);
  assert.equal(legacy.reviewEveryToolResults, 3);
  assert.equal(legacy.automaticReviewCooldownMs, 0);
  assert.equal(legacy.maxAutomaticReviewsPerSession, 0);
  assert.equal(legacy.model, undefined);
  assert.equal(resolveAdvisorModel(legacy, { provider: "main", id: "primary" }), "main/primary");
  assert.equal(automaticAdvisorEnabled(legacy), true);
  assert.equal(manualAdvisorEnabled(legacy), false);

  const dedicated = normalizeAdvisorConfig({
    ...legacy,
    mode: "hybrid",
    model: " advisor/provider-model ",
    consultThinking: "xhigh",
    reviewEveryToolResults: 5,
    disabledForModels: [
      "main:primary",
      { model: "other/executor", minThinking: "high" },
      { model: "bad/executor", minThinking: "invalid" },
    ] as never,
  });
  assert.equal(dedicated.model, "advisor/provider-model");
  assert.equal(dedicated.mode, "hybrid");
  assert.equal(dedicated.consultThinking, "xhigh");
  assert.deepEqual(dedicated.disabledForModels, [
    "main/primary",
    { model: "other/executor", minThinking: "high" },
  ]);
  assert.equal(dedicated.reviewEveryToolResults, 5);
  assert.equal(resolveAdvisorModel(dedicated, { provider: "main", id: "primary" }), "advisor/provider-model");
  assert.equal(automaticAdvisorEnabled(dedicated), true);
  assert.equal(manualAdvisorEnabled(dedicated), true);
  assert.equal(isAdvisorExecutorBlocked(dedicated, { provider: "main", id: "primary" }, "low"), true);
  assert.equal(isAdvisorExecutorBlocked(dedicated, { provider: "other", id: "executor" }, "medium"), false);
  assert.equal(isAdvisorExecutorBlocked(dedicated, { provider: "other", id: "executor" }, "high"), true);

  const manual = normalizeAdvisorConfig({ ...legacy, mode: "manual" });
  assert.equal(automaticAdvisorEnabled(manual), false);
  assert.equal(manualAdvisorEnabled(manual), true);
  const invalid = normalizeAdvisorConfig({ mode: "invalid", consultThinking: "extreme" } as never);
  assert.equal(invalid.mode, "automatic");
  assert.equal(invalid.consultThinking, "high");
  assert.equal(normalizeAdvisorConfig({ reviewEveryToolResults: 0 }).reviewEveryToolResults, 0);
});

test("workspace advisor config prefers canonical, maps legacy, applies env last, and fails closed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "advisor-config-source-"));
  const configDir = join(cwd, ".pi");
  const canonicalPath = join(configDir, "advisor.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "settings.json"), JSON.stringify({
    advisor: { enabled: false },
    monitor: {
      advisor: {
        enabled: true,
        cooldownMs: 12_345,
        maxReviewsPerSession: 2,
        tailMessages: 3,
        maxMessageChars: 100,
      },
    },
  }));

  try {
    const legacy = await loadAdvisorWorkspaceConfig(cwd, {});
    assert.equal(legacy.source, "legacy");
    assert.equal(legacy.config.enabled, true);
    assert.equal(legacy.config.mode, "automatic");
    assert.equal(legacy.config.cooldownMs, 12_345);
    assert.equal(legacy.config.automaticReviewCooldownMs, 12_345);
    assert.equal(legacy.config.maxAutomaticReviewsPerSession, 2);
    assert.equal(legacy.config.maxTailMessages, 3);
    assert.equal(legacy.config.maxTailChars, 300);
    assert.equal(legacy.config.reviewEveryToolResults, 0);
    await assert.rejects(readFile(canonicalPath, "utf8"), { code: "ENOENT" });

    await writeFile(canonicalPath, JSON.stringify({
      enabled: false,
      mode: "hybrid",
      cooldownMs: 9,
      automaticReviewCooldownMs: 8,
      maxAutomaticReviewsPerSession: 7,
      reviewEveryToolResults: 0,
    }));
    const canonical = await loadAdvisorWorkspaceConfig(cwd, {
      PI_ADVISOR: "on",
      PI_ADVISOR_COOLDOWN_MS: "77",
      PI_ADVISOR_MAX_REVIEWS: "4",
    });
    assert.equal(canonical.source, "canonical");
    assert.equal(canonical.envOverridden, true);
    assert.equal(canonical.baseConfig.enabled, false);
    assert.equal(canonical.config.enabled, true);
    assert.equal(canonical.config.mode, "hybrid");
    assert.equal(canonical.config.cooldownMs, 77);
    assert.equal(canonical.config.automaticReviewCooldownMs, 77);
    assert.equal(canonical.config.maxAutomaticReviewsPerSession, 4);
    assert.equal(canonical.config.reviewEveryToolResults, 0);

    await writeFile(canonicalPath, "");
    const malformed = await loadAdvisorWorkspaceConfig(cwd, { PI_ADVISOR: "on" });
    assert.equal(malformed.source, "canonical-invalid");
    assert.equal(malformed.config.enabled, false, "malformed canonical config ignores env and legacy fallbacks");
    assert.equal(malformed.envOverridden, false);
    assert.match(malformed.warning ?? "", /malformed.*disabled/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("manual advisor context removes the in-flight call, preserves evidence, and redacts secrets", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Inspect password=hunter2 sessionToken=TOPSECRET" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need a second opinion" },
        { type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "advisor-call", name: "advisor", arguments: {} },
        { type: "image", mimeType: "image/png", data: "base64-pixels" },
      ],
    },
    { role: "toolResult", toolCallId: "read-call", toolName: "read", content: [{ type: "text", text: "file body authToken=AUTHSECRET" }] },
    { role: "compactionSummary", summary: "Preserve this resolved summary idToken=IDSECRET", content: undefined },
    { role: "bashExecution", command: "printf safe", output: "safe output", content: undefined },
    { role: "bashExecution", command: "printf hidden", output: "HIDDEN", excludeFromContext: true, content: undefined },
  ];
  const stripped = stripInflightAdvisorCall(messages, "advisor-call");
  const prepared = ensureAdvisorUserTail(stripped);
  assert.equal(prepared.at(-1)?.role, "user");
  const conversation = serializeAdvisorConversation(prepared);
  assert.match(conversation, /\[tool call\] read/);
  assert.doesNotMatch(conversation, /\[tool call\] advisor/);
  assert.match(conversation, /\[image image\/png\]/);
  assert.match(conversation, /Preserve this resolved summary/);
  assert.match(conversation, /BASH: printf safe[\s\S]*safe output/);
  assert.doesNotMatch(conversation, /base64-pixels|hunter2|TOPSECRET|AUTHSECRET|IDSECRET|HIDDEN/);
  assert.match(conversation, /password=\[REDACTED\]/);
  assert.match(conversation, /sessionToken=\[REDACTED\]/);
  assert.match(conversation, /authToken=\[REDACTED\]/);
  assert.match(conversation, /idToken=\[REDACTED\]/);

  const inventory = buildAdvisorToolInventory([
    { name: "write", description: "Write a file" },
    { name: "read", description: "Read a file" },
  ]);
  assert.equal(inventory, "- read: Read a file\n- write: Write a file");
  const prompt = buildManualAdvisorPrompt(DEFAULT_ADVISOR_CONFIG, conversation, inventory);
  assert.match(prompt, /<resolved-conversation>/);
  assert.match(prompt, /<available-tools>[\s\S]*- read/);
  assert.match(prompt, /plan, a correction, or a stop signal/);
});

test("advisor runtime state separates evaluations, failures and uneventful verdicts", () => {
  assert.deepEqual(createAdvisorRuntimeState(), {
    evaluations: 0,
    failures: 0,
    deliveries: 0,
    suppressed: 0,
    uneventful: 0,
  });
});

test("buildAdvisorPrompt includes guide block, tail and JSON constraint", () => {
  const prompt = buildAdvisorPrompt({ ...DEFAULT_ADVISOR_CONFIG, guide: "watch for bypassing the queue" }, "USER: x\nASSISTANT: y");
  assert.match(prompt, /<attention>/);
  assert.match(prompt, /watch for bypassing the queue/);
  assert.match(prompt, /<transcript-tail>/);
  assert.match(prompt, /USER: x/);
  assert.match(prompt, /"on-track" \| "concern" \| "blocker"/);
});

test("buildAdvisorPrompt omits the attention block without a guide", () => {
  const prompt = buildAdvisorPrompt(DEFAULT_ADVISOR_CONFIG, "USER: x");
  assert.doesNotMatch(prompt, /<attention>/);
});

test("normalizeAdvisorVerdict accepts valid verdicts and rejects garbage", () => {
  assert.deepEqual(normalizeAdvisorVerdict({ status: "on-track" }), { status: "on-track", reason: undefined, message: undefined });
  assert.equal(normalizeAdvisorVerdict({ status: "warning" }), undefined);
  assert.equal(normalizeAdvisorVerdict(null), undefined);
  assert.equal(normalizeAdvisorVerdict("on-track"), undefined);
});

test("parseAdvisorVerdictText extracts JSON from markdown fences", () => {
  const verdict = parseAdvisorVerdictText('```json\n{ "status": "blocker", "reason": "r", "message": "m" }\n```');
  assert.deepEqual(verdict, { status: "blocker", reason: "r", message: "m" });
  assert.equal(parseAdvisorVerdictText("no json here"), undefined);
});

test("verdictDeliveryMode maps severity to delivery mode", () => {
  assert.equal(verdictDeliveryMode({ status: "on-track" }), undefined);
  assert.equal(verdictDeliveryMode({ status: "concern" }), "interrupt");
  assert.equal(verdictDeliveryMode({ status: "blocker" }), "interrupt");
});

test("formatAdvisory wraps with severity and guidance, XML-escapes body", () => {
  const advisory = formatAdvisory('Do not use `a < b` & keep "quotes"', "concern");
  assert.match(advisory, /^<advisory severity="concern" guidance="weigh, don't blindly obey">\n/);
  assert.match(advisory, /a &lt; b/);
  assert.match(advisory, /&amp; keep/);
  assert.match(advisory, /<\/advisory>$/);
});

test("Flow owns the shared Advisor command in both package registration orders even while disabled", async () => {
  for (const teammateFirst of [true, false]) {
    const cwd = await mkdtemp(join(tmpdir(), `advisor-owner-${teammateFirst}-`));
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notices: string[] = [];
    let activeTools: string[] = [];
    let lowCommandCalls = 0;
    const pi = {
      events: { emit() {} },
      on() {},
      registerTool(tool: { name: string }) {
        activeTools = [...new Set([...activeTools, tool.name])];
      },
      registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "low",
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      model: { provider: "main", id: "primary" },
      modelRegistry: { getAvailable: () => [{ provider: "main", id: "primary" }] },
      ui: { notify(message: string) { notices.push(message); } },
    } as unknown as ExtensionContext;
    const registerLow = () => supervision.registerAdvisorRuntime({
      id: "pi-maestro-teammate/advisor",
      priority: 10,
      handleCommand() { lowCommandCalls++; },
    });
    let lowLease: ReturnType<typeof registerLow> | undefined;

    try {
      if (teammateFirst) lowLease = registerLow();
      registerAdvisor(pi);
      if (!teammateFirst) lowLease = registerLow();

      const advisorCommand = commands.get("advisor");
      assert.ok(advisorCommand, "the shared broker registers exactly one command on this host");
      assert.equal(getAdvisorOwnerForTest(), "pi-maestro-flow/advisor");
      await advisorCommand("status", ctx);
      assert.equal(lowCommandCalls, 0);
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /ADVISOR off/);
      assert.match(notices[0] ?? "", /owner: pi-maestro-flow\/advisor/);
    } finally {
      lowLease?.release();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

function getAdvisorOwnerForTest(): string | undefined {
  return supervision.getAdvisorRuntimeOwner();
}

test("tool checkpoints are non-blocking, reject failed runs, and recover after lifecycle abort", async () => {
  const originalCwd = process.cwd();
  const cwd = await mkdtemp(join(tmpdir(), "advisor-extension-test-"));
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const sent: Array<{ message: any; options: any }> = [];
  const notices: string[] = [];
  let activeTools = ["read"];
  let runtimeReady = false;
  let thinkingLevel = "low";
  let advisorTool: any;
  let advisorCommand: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let finishRun: ((result?: any) => void) | undefined;
  let requestedModel: string | undefined;
  let requestedFallbacks: string[] | undefined;
  let requestedThinking: string | undefined;
  let requestedPrompt: string | undefined;
  let runCount = 0;

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "advisor.json"), JSON.stringify({
    enabled: true,
    model: "dedicated/reviewer",
    cooldownMs: 0,
    maxTailMessages: 8,
    maxTailChars: 4_000,
    reviewEveryToolResults: 2,
  }));
  process.chdir(cwd);

  const validResult = (messageText = "Verify the generated changes before continuing.") => ({
    agent: "analyst",
    exitCode: 0,
    messages: [],
    model: "dedicated/reviewer",
    structuredOutput: {
      status: "concern",
      reason: "The tool sequence needs review.",
      message: messageText,
    },
  });
  const runTeammate = async (params: any) => {
    runCount++;
    requestedModel = params.tasks[0]?.model;
    requestedFallbacks = params.tasks[0]?.fallbackModels;
    requestedThinking = params.tasks[0]?.thinking;
    requestedPrompt = params.tasks[0]?.prompt;
    return await new Promise<any[]>((resolve) => {
      finishRun = (result = validResult()) => {
        finishRun = undefined;
        resolve([result]);
      };
    });
  };
  setAdvisorTeammateRuntimeForTest({
    supervision: supervision as never,
    runTeammate: runTeammate as never,
  });

  const models = [
    { provider: "main", id: "primary", name: "Primary", api: "openai-responses", reasoning: true },
    { provider: "dedicated", id: "reviewer", name: "Reviewer", api: "openai-responses", reasoning: true },
    { provider: "other", id: "executor", name: "Other", api: "openai-responses", reasoning: true },
    { provider: "dedicated", id: "plain", name: "Plain", api: "openai-responses", reasoning: false },
  ];
  const pi = {
    events: { emit() {} },
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      advisorTool = tool;
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    getAllTools: () => [
      { name: "read", description: "Read a project file", parameters: {} },
      { name: "advisor", description: "Ask the reviewer", parameters: {} },
    ],
    getActiveTools: () => {
      if (!runtimeReady) throw new Error("action APIs unavailable during extension loading");
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      if (!runtimeReady) throw new Error("action APIs unavailable during extension loading");
      activeTools = [...names];
    },
    getThinkingLevel: () => {
      if (!runtimeReady) throw new Error("action APIs unavailable during extension loading");
      return thinkingLevel;
    },
    registerCommand(name: string, options: any) {
      if (name === "advisor") advisorCommand = options.handler;
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      async refresh() {},
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "session",
          version: 3,
          id: "test-session",
          timestamp: new Date().toISOString(),
          cwd,
        },
        {
          type: "message",
          id: "old-user-entry",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: "Old history" }], timestamp: Date.now() },
        },
        {
          type: "compaction",
          id: "compaction-entry",
          parentId: "old-user-entry",
          timestamp: new Date().toISOString(),
          summary: "Preserve the API contract from the compaction summary. sessionToken=TOPSECRET",
          firstKeptEntryId: "missing-kept-entry",
          tokensBefore: 1000,
        },
        {
          type: "message",
          id: "assistant-entry",
          parentId: "compaction-entry",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I am considering the implementation." },
              { type: "toolCall", id: "advisor-call", name: "advisor", arguments: {} },
            ],
            api: "openai-responses",
            provider: "main",
            model: "primary",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ],
      getLeafId: () => "assistant-entry",
    },
    ui: { notify(message: string) { notices.push(message); } },
  } as unknown as ExtensionContext;
  const emitToolBatch = () => {
    const onToolResult = handlers.get("tool_result")?.[0];
    assert.ok(onToolResult);
    const first = onToolResult({ toolName: "read", input: { path: "a.ts" }, content: [], isError: false }, ctx);
    const second = onToolResult({ toolName: "edit", input: { path: "a.ts" }, content: [{ text: "done" }], isError: false }, ctx);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
  };

  try {
    assert.doesNotThrow(() => registerAdvisor(pi), "extension loading must not call action APIs");
    assert.ok(advisorTool, "manual advisor tool is registered");
    assert.ok(advisorCommand, "advisor command is registered");
    assert.equal(activeTools.includes("advisor"), true, "host initially registers the tool as active");
    runtimeReady = true;
    handlers.get("session_start")?.[0]?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(activeTools.includes("advisor"), false, "canonical automatic config keeps manual tool hidden");
    await advisorCommand?.("status", ctx);
    assert.match(notices.at(-1) ?? "", /owner: pi-maestro-flow\/advisor/);
    assert.match(notices.at(-1) ?? "", /config: canonical/);

    emitToolBatch();
    assert.equal(sent.length, 0);
    await waitFor(() => runCount === 1 && finishRun !== undefined);
    assert.equal(requestedModel, "dedicated/reviewer");
    assert.deepEqual(requestedFallbacks, []);
    finishRun?.();
    await waitFor(() => sent.length === 1);
    assert.match(String(sent[0]?.message.content), /<advisory severity="concern"/);
    assert.equal(sent[0]?.message.details.checkpoint, "tool_result");
    assert.equal(sent[0]?.options.deliverAs, "steer");
    assert.equal(sent[0]?.options.triggerTurn, false);

    emitToolBatch();
    await waitFor(() => runCount === 2 && finishRun !== undefined);
    finishRun?.({
      ...validResult("This failed run must not inject."),
      exitCode: 1,
      terminalStatus: "failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 1, "failed teammate output must not be injected");

    emitToolBatch();
    await waitFor(() => runCount === 3 && finishRun !== undefined);
    handlers.get("session_compact")?.[0]?.({}, ctx);
    emitToolBatch();
    await waitFor(() => runCount === 4 && finishRun !== undefined);
    finishRun?.(validResult("Review after compaction."));
    await waitFor(() => sent.length === 2);

    await advisorCommand?.("mode hybrid", ctx);
    assert.equal(activeTools.includes("advisor"), true);
    emitToolBatch();
    await waitFor(() => runCount === 5 && finishRun !== undefined);
    finishRun?.(validResult("Hybrid automatic review."));
    await waitFor(() => sent.length === 3);

    emitToolBatch();
    await waitFor(() => runCount === 6 && finishRun !== undefined);
    const higherAutomaticOwner = supervision.registerAdvisorRuntime({
      id: `test/higher-auto/${Date.now()}`,
      priority: 200,
      handleCommand() {},
    });
    assert.equal(activeTools.includes("advisor"), false, "ownership loss removes the manual tool");
    finishRun?.(validResult("Stale automatic guidance."));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 3, "a preempted automatic result must not be delivered");
    higherAutomaticOwner.release();
    await waitFor(() => activeTools.includes("advisor"));

    const manualPromise = advisorTool.execute("advisor-call", {}, undefined, undefined, ctx);
    await waitFor(() => runCount === 7 && finishRun !== undefined);
    assert.equal(requestedModel, "dedicated/reviewer");
    assert.equal(requestedThinking, "high");
    assert.match(requestedPrompt ?? "", /Preserve the API contract from the compaction summary/);
    assert.match(requestedPrompt ?? "", /<available-tools>[\s\S]*read/);
    assert.doesNotMatch(requestedPrompt ?? "", /TOPSECRET|\[tool call\] advisor/);
    assert.match(requestedPrompt ?? "", /sessionToken=\[REDACTED\]/);
    finishRun?.({
      agent: "analyst",
      exitCode: 0,
      model: "dedicated/reviewer",
      correlationId: "consult-1",
      messages: [{ role: "assistant", content: "Use the smallest compatible state transition." }],
    });
    const manualResult = await manualPromise;
    assert.equal(manualResult.content[0]?.text, "Use the smallest compatible state transition.");
    assert.equal(manualResult.details.status, "completed");
    assert.equal(sent.length, 3, "manual guidance must not inject an advisory message");

    const staleManualPromise = advisorTool.execute("advisor-call", {}, undefined, undefined, ctx);
    await waitFor(() => runCount === 8 && finishRun !== undefined);
    const higherManualOwner = supervision.registerAdvisorRuntime({
      id: `test/higher-manual/${Date.now()}`,
      priority: 200,
      handleCommand() {},
    });
    finishRun?.({
      agent: "analyst",
      exitCode: 0,
      messages: [{ role: "assistant", content: "Stale manual guidance." }],
    });
    const staleManualResult = await staleManualPromise;
    assert.equal(staleManualResult.details.status, "stale");
    assert.doesNotMatch(staleManualResult.content[0]?.text ?? "", /Stale manual guidance/);
    higherManualOwner.release();
    await waitFor(() => activeTools.includes("advisor"));

    await writeFile(join(cwd, ".pi", "advisor.json"), JSON.stringify({
      enabled: true,
      mode: "hybrid",
      model: "dedicated/reviewer",
      consultThinking: "high",
      cooldownMs: 0,
      maxTailMessages: 8,
      maxTailChars: 4_000,
      reviewEveryToolResults: 2,
      disabledForModels: [{ model: "main/primary", minThinking: "high" }],
    }));
    thinkingLevel = "low";
    handlers.get("session_start")?.[0]?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(activeTools.includes("advisor"), true);
    thinkingLevel = "high";
    await handlers.get("thinking_level_select")?.[0]?.({ level: "high" }, ctx);
    assert.equal(activeTools.includes("advisor"), false, "blocklist strips tool at threshold");
    thinkingLevel = "low";
    await handlers.get("thinking_level_select")?.[0]?.({ level: "low" }, ctx);
    assert.equal(activeTools.includes("advisor"), true, "tool returns below blocklist threshold");

    await advisorCommand?.("thinking medium", ctx);
    const persistedThinking = JSON.parse(await readFile(join(cwd, ".pi", "advisor.json"), "utf8"));
    assert.equal(persistedThinking.consultThinking, "medium");
    await advisorCommand?.("model dedicated/plain", ctx);
    await advisorCommand?.("thinking high", ctx);
    const persistedPlain = JSON.parse(await readFile(join(cwd, ".pi", "advisor.json"), "utf8"));
    assert.equal(persistedPlain.consultThinking, "medium", "unsupported thinking is not persisted for a non-reasoning model");
    assert.match(notices.join("\n"), /does not support thinking level high/);
    await advisorCommand?.("model dedicated/reviewer", ctx);
    await advisorCommand?.("mode manual", ctx);
    const beforeManualOnly = runCount;
    emitToolBatch();
    handlers.get("agent_end")?.[0]?.({ messages: [message("user", "manual only")] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runCount, beforeManualOnly, "manual mode disables automatic checkpoints");
    assert.match(notices.join("\n"), /Advisor mode: manual/);

    await writeFile(join(cwd, ".pi", "advisor.json"), JSON.stringify({
      enabled: true,
      mode: "automatic",
      model: "dedicated/reviewer",
      cooldownMs: 0,
      automaticReviewCooldownMs: 0,
      maxAutomaticReviewsPerSession: 1,
      maxTailMessages: 8,
      maxTailChars: 4_000,
      reviewEveryToolResults: 0,
    }));
    handlers.get("session_start")?.[0]?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeBudget = runCount;
    emitToolBatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runCount, beforeBudget, "reviewEveryToolResults 0 disables mid-execution checkpoints");
    handlers.get("agent_end")?.[0]?.({ messages: [message("user", "first budgeted review")] }, ctx);
    await waitFor(() => runCount === beforeBudget + 1 && finishRun !== undefined);
    finishRun?.(validResult("Budgeted review."));
    await waitFor(() => finishRun === undefined);
    handlers.get("agent_end")?.[0]?.({ messages: [message("user", "over budget")] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runCount, beforeBudget + 1, "automatic review budget is enforced per session");

    await writeFile(join(cwd, ".pi", "advisor.json"), JSON.stringify({
      enabled: true,
      mode: "automatic",
      model: "dedicated/reviewer",
      cooldownMs: 0,
      automaticReviewCooldownMs: 60_000,
      maxAutomaticReviewsPerSession: 0,
      maxTailMessages: 8,
      maxTailChars: 4_000,
      reviewEveryToolResults: 0,
    }));
    handlers.get("session_start")?.[0]?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeCooldown = runCount;
    handlers.get("agent_end")?.[0]?.({ messages: [message("user", "first cooled review")] }, ctx);
    await waitFor(() => runCount === beforeCooldown + 1 && finishRun !== undefined);
    finishRun?.(validResult("Cooled review."));
    await waitFor(() => finishRun === undefined);
    handlers.get("agent_end")?.[0]?.({ messages: [message("user", "inside cooldown")] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runCount, beforeCooldown + 1, "automatic review cooldown suppresses early re-dispatch");
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
    setAdvisorTeammateRuntimeForTest(undefined);
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  }
});
