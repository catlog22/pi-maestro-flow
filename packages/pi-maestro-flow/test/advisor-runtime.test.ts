import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as supervision from "pi-maestro-teammate/v1/supervision";
import registerAdvisor, { setAdvisorTeammateRuntimeForTest } from "../src/advisor/extension.ts";
import {
  buildAdvisorPrompt,
  createAdvisorRuntimeState,
  DEFAULT_ADVISOR_CONFIG,
  formatAdvisory,
  normalizeAdvisorConfig,
  normalizeAdvisorVerdict,
  parseAdvisorVerdictText,
  redactAdvisorText,
  resolveAdvisorModel,
  serializeToolCheckpoint,
  serializeTranscriptTail,
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
  assert.equal(legacy.reviewEveryToolResults, 3);
  assert.equal(legacy.model, undefined);
  assert.equal(resolveAdvisorModel(legacy, { provider: "main", id: "primary" }), "main/primary");

  const dedicated = normalizeAdvisorConfig({ ...legacy, model: " advisor/provider-model ", reviewEveryToolResults: 5 });
  assert.equal(dedicated.model, "advisor/provider-model");
  assert.equal(dedicated.reviewEveryToolResults, 5);
  assert.equal(resolveAdvisorModel(dedicated, { provider: "main", id: "primary" }), "advisor/provider-model");
  assert.equal(normalizeAdvisorConfig({ reviewEveryToolResults: 0 }).reviewEveryToolResults, 3);
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

test("tool checkpoints are non-blocking, reject failed runs, and recover after lifecycle abort", async () => {
  const originalCwd = process.cwd();
  const cwd = await mkdtemp(join(tmpdir(), "advisor-extension-test-"));
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const sent: Array<{ message: any; options: any }> = [];
  let finishRun: ((result?: any) => void) | undefined;
  let requestedModel: string | undefined;
  let requestedFallbacks: string[] | undefined;
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

  const pi = {
    events: { emit() {} },
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    model: { provider: "main", id: "primary" },
    modelRegistry: {
      async refresh() {},
      getAvailable: () => [
        { provider: "main", id: "primary", reasoning: true },
        { provider: "dedicated", id: "reviewer", reasoning: true },
      ],
    },
    ui: { notify() {} },
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
    registerAdvisor(pi);
    handlers.get("session_start")?.[0]?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

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
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
    setAdvisorTeammateRuntimeForTest(undefined);
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  }
});
