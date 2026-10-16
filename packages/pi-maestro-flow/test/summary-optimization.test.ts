import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import {
  buildMaestroCompactionPrompt,
  buildSummaryCompletionOptions,
  completeSummaryWithRetries,
  createMaestroCompaction,
  formatSummaryProgress,
  SUMMARY_STATUS_KEY,
  SummaryTimeoutError,
  type MaestroCompactionDetails,
  type SummaryInputFit,
  type SummaryMetrics,
  type SummaryResponse,
} from "../src/compaction/maestro-compaction.ts";

function model(reasoning = true): Model<Api> {
  return {
    id: "summary-model", provider: "summary-test", api: "summary-test", name: "Summary test",
    baseUrl: "https://invalid.example", reasoning, input: ["text"], contextWindow: 400_000, maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function details(): MaestroCompactionDetails {
  return {
    kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: "summary-checkpoint",
    sessionId: "summary-session", projectRoot: "D:/repo", createdAt: "2026-10-15T00:00:00Z",
    todo: { stateVersion: 2, revision: 1, tasks: [] },
    goal: { stateVersion: 2, goals: [] },
    plan: { mode: "act", status: "empty", revision: 0, handoffStatus: "none" },
    activeSkills: [], references: [], knowhowPath: "D:/repo/checkpoint.md",
  };
}

function event(signal = new AbortController().signal) {
  return {
    type: "session_before_compact" as const, branchEntries: [], signal,
    preparation: {
      firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
      tokensBefore: 360_145, previousSummary: "Earlier confirmed constraint: keep the public API compatible.",
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
  };
}

function context(notifications: string[] = []) {
  return {
    cwd: "D:/repo", model: model(), sessionManager: { getSessionId: () => "summary-session" },
    ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
  };
}

const fit: SummaryInputFit = { messages: [], prompt: "checkpoint input", estimatedRequestTokens: 10, maxTokens: 512, droppedRounds: 0 };

test("summary reasoning is independently disabled without passing the truthy off string", () => {
  const options = buildSummaryCompletionOptions({ apiKey: "test", maxTokens: 512, signal: new AbortController().signal, model: model() });
  assert.equal(options.reasoning, undefined);
  assert.equal(options.maxTokens, 512);
  assert.equal(options.cacheRetention, "none");
  assert.equal(buildSummaryCompletionOptions({ ...options, model: model(), thinkingLevel: "low" }).reasoning, "low");
  assert.equal(buildSummaryCompletionOptions({ ...options, model: model(false), thinkingLevel: "high" }).reasoning, undefined);
});

test("summary reasoning clamps off to the lowest supported model level", () => {
  const target = { ...model(), thinkingLevelMap: { off: null, minimal: null, low: "low" } };
  const options = buildSummaryCompletionOptions({ apiKey: "test", maxTokens: 512, signal: new AbortController().signal, model: target });
  assert.equal(options.reasoning, "low");
});

test("summary progress reports actual summary budget rather than the original context size", () => {
  assert.equal(formatSummaryProgress({ estimatedInputTokens: 1200, outputTokenLimit: 512, attempts: 2, thinkingLevel: "off", elapsedMs: 12_345, phase: "requesting" }),
    "SUMMARY in≈1200 out≤512 off attempt 2 12s · requesting");
});

test("summary deadline requests cancellation but waits for provider settlement", async () => {
  let providerSignal: AbortSignal | undefined;
  let finish!: () => void;
  const provider = new Promise<SummaryResponse>((resolve) => { finish = () => resolve({ stopReason: "stop", content: [{ type: "text", text: "too late" }] }); });
  let settled = false;
  const operation = completeSummaryWithRetries({
    initialFit: fit, signal: new AbortController().signal, timeoutMs: 15,
    trimForPromptTooLong: () => undefined,
    attempt: async (_fit, signal) => { providerSignal = signal; return provider; },
  });
  const checked = assert.rejects(operation, SummaryTimeoutError).then(() => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(providerSignal?.aborted, true);
    assert.equal(settled, false, "a local timer cannot prove the host/provider has stopped");
  } finally {
    finish();
    await checked;
  }
});

test("summary deadline also bounds retry backoff without admitting another request", async () => {
  let attempts = 0;
  await assert.rejects(completeSummaryWithRetries({
    initialFit: fit, signal: new AbortController().signal, timeoutMs: 15,
    trimForPromptTooLong: () => undefined,
    attempt: async () => { attempts += 1; throw new Error("WebSocket error"); },
  }), SummaryTimeoutError);
  assert.equal(attempts, 1);
});

test("summary cancellation before admission never invokes the provider", async () => {
  const controller = new AbortController();
  const reason = new Error("user cancelled compaction");
  controller.abort(reason);
  let attempts = 0;
  await assert.rejects(completeSummaryWithRetries({
    initialFit: fit, signal: controller.signal, trimForPromptTooLong: () => undefined,
    attempt: async () => { attempts += 1; return { stopReason: "stop", content: [] }; },
  }), (error) => error === reason);
  assert.equal(attempts, 0);
});

for (const [name, response] of [
  ["truncated", { stopReason: "length", content: [{ type: "text", text: "partial checkpoint" }] }],
  ["aborted", { stopReason: "aborted", content: [{ type: "text", text: "partial checkpoint" }] }],
  ["tool-calling", { stopReason: "stop", content: [{ type: "text", text: "checkpoint" }, { type: "toolCall" }] }],
] satisfies Array<[string, SummaryResponse]>) {
  test(`${name} summaries never save a checkpoint or silently start native fallback`, async () => {
    const notifications: string[] = [];
    const result = await createMaestroCompaction(event() as never, context(notifications) as never, {
      detailsSnapshot: details(), completeSummary: async () => response,
    });
    assert.deepEqual(result, { cancel: true });
    assert.match(notifications[0]!, /no checkpoint was saved/);
    assert.doesNotMatch(notifications[0]!, /falling back/);
  });
}

test("summary total timeout never silently restarts the same expensive input natively", async () => {
  const result = await createMaestroCompaction(event() as never, context() as never, {
    detailsSnapshot: details(), completeSummary: async () => { throw new SummaryTimeoutError(15); },
  });
  assert.deepEqual(result, { cancel: true });
});

test("a late summary after user cancellation cannot become a checkpoint", async () => {
  const controller = new AbortController();
  const result = await createMaestroCompaction(event(controller.signal) as never, context() as never, {
    detailsSnapshot: details(), completeSummary: async () => {
      controller.abort(new Error("cancelled"));
      return { stopReason: "stop", content: [{ type: "text", text: "late checkpoint" }] };
    },
  });
  assert.deepEqual(result, { cancel: true });
});

test("compact JSON preserves previous summary and authoritative state without pretty-print overhead", () => {
  const input = { conversationText: 'User says "keep this"\n继续任务', previousSummary: "Earlier facts", runtimeState: details(), customInstructions: "preserve constraints" };
  const packed = buildMaestroCompactionPrompt(input);
  assert.deepEqual(JSON.parse(packed), {
    conversationText: input.conversationText, previousSummary: input.previousSummary,
    runtimeState: input.runtimeState, operatorFocus: input.customInstructions,
  });
  assert.ok(packed.length < JSON.stringify(JSON.parse(packed), null, 2).length);
});

test("successful summaries persist measured request metrics without rewriting authority", async () => {
  const snapshot = details();
  const metrics: SummaryMetrics = { model: "test/summary", thinkingLevel: "off", estimatedInputTokens: 100, outputTokenLimit: 512, inputTokens: 90, outputTokens: 12, elapsedMs: 20, attempts: 1, droppedRounds: 0 };
  const result = await createMaestroCompaction(event() as never, context() as never, {
    detailsSnapshot: snapshot,
    completeSummary: async () => ({ stopReason: "stop", content: [{ type: "text", text: "confirmed checkpoint" }], metrics }),
  });
  assert.ok(result?.compaction);
  assert.equal(result.compaction.firstKeptEntryId, "kept");
  const recorded = result.compaction.details as MaestroCompactionDetails;
  assert.deepEqual(recorded.summaryMetrics, metrics);
  assert.equal(recorded.todo, snapshot.todo);
});

test("standalone summary uses the SDK simple adapter, isolated settings and bounded signal end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "summary-optimization-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sourceId = "summary-optimization-test";
  const captured: Array<{ options?: SimpleStreamOptions; text: string }> = [];
  const statuses: Array<{ key: string; value?: string }> = [];
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { summary: { thinkingLevel: "off", timeoutMs: 1000 } } }));
    registerApiProvider({
      api: "summary-test",
      stream() { throw new Error("raw adapter must not be used for summary reasoning"); },
      streamSimple(target, transcript, options) {
        const user = transcript.messages.find((message) => message.role === "user");
        const text = user && Array.isArray(user.content) ? user.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
        captured.push({ options, text });
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", api: target.api, provider: target.provider, model: target.id,
          content: [{ type: "text", text: "confirmed facts only" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 90, output: 12, cacheRead: 5, cacheWrite: 0, totalTokens: 107, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    }, sourceId);
    const parent = new AbortController();
    const result = await createMaestroCompaction(event(parent.signal) as never, {
      ...context(), cwd: root, thinkingLevel: "high",
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "test-only" }; } },
      ui: { notify() {}, setStatus(key: string, value?: string) { statuses.push({ key, value }); } },
    } as never, { detailsSnapshot: details() });
    assert.ok(result?.compaction);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.options?.reasoning, undefined, "main-session high must not leak into standalone summaries");
    assert.notEqual(captured[0]!.options?.signal, parent.signal, "the provider receives the shared bounded signal");
    assert.equal(captured[0]!.options?.cacheRetention, "none");
    const payload = JSON.parse(captured[0]!.text);
    assert.equal(payload.previousSummary, event().preparation.previousSummary);
    assert.deepEqual(payload.runtimeState.todo, details().todo);
    const metrics = (result.compaction.details as MaestroCompactionDetails).summaryMetrics;
    assert.equal(metrics?.thinkingLevel, "off");
    assert.equal(metrics?.inputTokens, 95);
    assert.equal(metrics?.outputTokens, 12);
    assert.equal(metrics?.attempts, 1);
    assert.ok(metrics!.estimatedInputTokens < event().preparation.tokensBefore);
    assert.ok(statuses.some(({ key, value }) => key === SUMMARY_STATUS_KEY && value?.includes("attempt 1")));
    assert.deepEqual(statuses.at(-1), { key: SUMMARY_STATUS_KEY, value: undefined });
  } finally {
    unregisterApiProviders(sourceId);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
