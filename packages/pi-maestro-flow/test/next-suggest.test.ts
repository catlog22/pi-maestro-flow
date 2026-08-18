import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_NEXT_SUGGEST_CONFIG,
  loadNextSuggestConfig,
  saveNextSuggestConfig,
} from "../src/next-suggest/config.ts";
import { extractTurnContext, resolveSuggestionModel } from "../src/next-suggest/engine.ts";
import { renderSuggestionPrompt } from "../src/next-suggest/template.ts";

async function withDefaultsPath(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "next-suggest-"));
  const path = join(dir, "api-manager.json");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("next-suggest config falls back to defaults when the file is missing", async () => {
  await withDefaultsPath(async (path) => {
    assert.deepEqual(await loadNextSuggestConfig(path), DEFAULT_NEXT_SUGGEST_CONFIG);
  });
});

test("next-suggest config round-trips through api-manager.json", async () => {
  await withDefaultsPath(async (path) => {
    await saveNextSuggestConfig(
      { enabled: true, modelRef: "maestro-qwen/qwen3.8-max-preview", thinking: "high", maxSuggestionChars: 120, acceptKey: "alt+shift+n" },
      path,
    );
    assert.deepEqual(await loadNextSuggestConfig(path), {
      enabled: true,
      modelRef: "maestro-qwen/qwen3.8-max-preview",
      thinking: "high",
      maxSuggestionChars: 120,
      acceptKey: "alt+shift+n",
    });
  });
});

test("next-suggest config normalizes malformed entries", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        nextSuggest: { enabled: "yes", modelRef: 42, thinking: "off", maxSuggestionChars: -5, acceptKey: "ctrl+q" },
      }),
      "utf8",
    );
    // "yes" coerces to true and "off" is a legal thinking level; numeric/unknown values fall back.
    assert.deepEqual(await loadNextSuggestConfig(path), {
      ...DEFAULT_NEXT_SUGGEST_CONFIG,
      enabled: true,
      thinking: "off" as const,
    });
  });
});

test("next-suggest config keeps a pre-existing api-manager.json intact", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, modelDefaults: { "p/m": "high" }, managedProviders: ["p"] }),
      "utf8",
    );
    await saveNextSuggestConfig({ ...DEFAULT_NEXT_SUGGEST_CONFIG, enabled: true }, path);
    const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed.modelDefaults, { "p/m": "high" });
    assert.deepEqual(parsed.managedProviders, ["p"]);
    assert.equal((parsed.nextSuggest as { enabled?: boolean }).enabled, true);
  });
});

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "end",
    timestamp: Date.now(),
  } as AgentMessage;
}

function toolCallMessage(name: string, input: Record<string, unknown>): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: `call-${name}`, name, input, timestamp: Date.now() }],
    api: "openai-completions",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "end",
    timestamp: Date.now(),
  } as AgentMessage;
}

test("extractTurnContext collects recent user prompts and assistant text", () => {
  const context = extractTurnContext([
    userMessage("first request"),
    toolCallMessage("bash", { command: "npm test test/foo.test.ts" }),
    assistantMessage("I ran the tests and they pass."),
    userMessage("fix the failing test"),
  ]);
  assert.deepEqual(context.recentUserPrompts, ["fix the failing test", "first request"]);
  assert.ok(context.latestAssistantText.includes("tests and they pass"));
  assert.ok(context.toolSignals.some((signal) => signal === "tool_call:bash"));
  assert.ok(context.touchedFiles.includes("test/foo.test.ts"));
});

test("resolveSuggestionModel follows the session model by default", () => {
  const sessionModel = { provider: "p", id: "session-model" } as never;
  const resolved = resolveSuggestionModel(
    {} as never,
    { model: sessionModel, modelRegistry: { getAll: () => [] } } as never,
    { ...DEFAULT_NEXT_SUGGEST_CONFIG, modelRef: "session" },
  );
  assert.equal(resolved?.model, sessionModel);
});

test("resolveSuggestionModel pins a configured provider/model", () => {
  const sessionModel = { provider: "p", id: "session-model" } as never;
  const pinned = { provider: "p2", id: "m2" } as never;
  const resolved = resolveSuggestionModel(
    {} as never,
    {
      model: sessionModel,
      modelRegistry: { getAll: () => [pinned] },
    } as never,
    { ...DEFAULT_NEXT_SUGGEST_CONFIG, modelRef: "p2/m2" },
  );
  assert.equal(resolved?.model, pinned);
});

test("resolveSuggestionModel falls back to the session model for unknown refs", () => {
  const sessionModel = { provider: "p", id: "session-model" } as never;
  const resolved = resolveSuggestionModel(
    {} as never,
    { model: sessionModel, modelRegistry: { getAll: () => [] } } as never,
    { ...DEFAULT_NEXT_SUGGEST_CONFIG, modelRef: "missing/model" },
  );
  assert.equal(resolved?.model, sessionModel);
});

test("renderSuggestionPrompt embeds signals and the no-suggestion token", () => {
  const prompt = renderSuggestionPrompt({
    turnStatus: "success",
    recentUserPrompts: ["fix the failing test"],
    toolSignals: ["tool_call:bash"],
    touchedFiles: ["test/foo.test.ts"],
    unresolvedQuestions: [],
    latestAssistantText: "I ran the tests and they pass.",
    maxSuggestionChars: 120,
    noSuggestionToken: "__NO_SUGGESTION__",
  });
  assert.ok(prompt.includes("fix the failing test"));
  assert.ok(prompt.includes("__NO_SUGGESTION__"));
  assert.ok(prompt.includes("test/foo.test.ts"));
  assert.ok(prompt.includes("under 120 characters"));
});
