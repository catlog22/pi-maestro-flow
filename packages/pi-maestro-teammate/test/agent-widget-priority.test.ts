import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS } from "../src/shared/limits.ts";
import { renderAgentStatusWidget } from "../src/extension/index.ts";

test("agent widget keeps recent failed work and the latest live edge visible in the compact budget", () => {
  const now = Date.now();
  const progress = Array.from({ length: 8 }, (_, taskIndex) => ({
    agent: "worker",
    name: `worker-${taskIndex + 1}`,
    correlationId: `worker-${taskIndex + 1}`,
    taskIndex,
    dependencies: [],
    status: taskIndex === 7 ? "running" as const : "failed" as const,
    lastActivityAt: taskIndex === 7 ? now + 1 : now - taskIndex,
  }));
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
    progress,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const compact = renderAgentStatusWidget([parent], 30, theme).join("\n");
  assert.match(compact, /worker-1.*failed/);
  assert.match(compact, /1 running/);
  assert.match(compact, /■ @worker-8/);
});

test("agent widget leaves the final terminal column empty during live updates", () => {
  const now = Date.now();
  const agent = {
    agent: "scholar-ralph-executor",
    name: "scholar-ralph-executor",
    correlationId: "125d198c-live",
    startedAt: now - 65_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "scholar-ralph-executor",
      name: "scholar-ralph-executor",
      correlationId: "125d198c-live",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      toolCount: 15,
      inputTokens: 377_100,
      outputTokens: 8_000,
      cacheReadTokens: 128,
      cacheWriteTokens: 0,
      lastActivityAt: now,
    }],
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const width = 80;
  const lines = renderAgentStatusWidget([agent], width, theme);

  assert.equal(Math.max(...lines.map(visibleWidth)), width - 1);
  for (const line of lines) assert.ok(visibleWidth(line) < width);
});

test("agent widget trusts a settled lifecycle over a lifecycle-pending progress snapshot", () => {
  const now = Date.now();
  // The dispatch path rewrote this task back to "running" (lifecyclePending)
  // for the admission gate; the child record has since settled failed and its
  // tombstone is still visible. The row must not read as running.
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now - 60_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 5_000,
    status: "failed" as const,
    failedAt: now - 5_000,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "worker",
      name: "w1",
      correlationId: "w1",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      resultReadyAt: now - 6_000,
      lastActivityAt: now - 5_000,
    }],
  };
  const child = {
    agent: "worker",
    name: "w1",
    correlationId: "w1",
    spawnedBy: "parent",
    startedAt: now - 60_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 5_000,
    status: "failed" as const,
    failedAt: now - 5_000,
    depth: 0,
    sleepMs: 0,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([parent, child], 120, theme).join("\n");
  assert.match(output, /w1.*failed/);
  assert.doesNotMatch(output, /running|lifecycle pending/);
});

test("agent widget shows pending interaction instead of stalled", () => {
  const now = Date.now();
  const agent = {
    agent: "worker", name: "awaiting-human", correlationId: "awaiting-human",
    startedAt: now - 90_000, abortController: new AbortController(),
    inbox: [], outputLog: [], lastActivityAt: now - 60_000,
    status: "running" as const, depth: 0, sleepMs: 0,
    pendingInteractions: new Map([["question-1", {
      requestId: "question-1", interaction: "question" as const, createdAt: now, payload: {},
    }]]),
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([agent], 120, theme).join("\n");
  assert.match(output, /awaiting 1 prompt/);
  assert.doesNotMatch(output, /stalled/);
});

test("agent widget shows a pending task as stalled after its bounded queue deadline", () => {
  const now = Date.now();
  const agent = {
    agent: "worker", name: "queued", correlationId: "queued",
    startedAt: now - TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS,
    abortController: new AbortController(), inbox: [], outputLog: [],
    lastActivityAt: now - TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS,
    status: "pending" as const, phase: "starting" as const,
    depth: 0, sleepMs: 0,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([agent], 120, theme).join("\n");

  assert.match(output, /queued.*stalled/);
  assert.doesNotMatch(output, /waiting for dependencies/);
});

test("agent widget reads a completed container as terminal when the child record is pruned", () => {
  const now = Date.now();
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now - 60_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 5_000,
    status: "completed" as const,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "worker",
      name: "w1",
      correlationId: "w1",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      resultReadyAt: now - 6_000,
      lastActivityAt: now - 5_000,
    }],
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([parent], 120, theme).join("\n");
  assert.match(output, /w1.*completed/);
  assert.doesNotMatch(output, /running|lifecycle pending/);
});

test("agent widget keeps duration, split tokens, and stalled state visible", () => {
  const now = Date.now();
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now - 65_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 45_000,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "worker",
      name: "worker-live",
      correlationId: "worker-live",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      inputTokens: 1_234,
      outputTokens: 56,
      tokens: 1_290,
      lastActivityAt: now - 45_000,
    }],
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([parent], 120, theme).join("\n");

  assert.match(output, /@worker-live worker · 65s · in 1\.2k · out 56/);
  assert.match(output, /stalled 4[45]s/);
});

test("agent widget distinguishes a Pi result-ready turn from a stalled agent", () => {
  const now = Date.now();
  const parent = {
    agent: "graph",
    correlationId: "parent",
    startedAt: now - 65_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 45_000,
    status: "running" as const,
    depth: 0,
    sleepMs: 0,
    progress: [{
      agent: "explorer",
      name: "explorer",
      correlationId: "explorer-live",
      taskIndex: 0,
      dependencies: [],
      status: "running" as const,
      lastActivityAt: now - 45_000,
      resultReadyAt: now - 44_000,
    }],
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([parent], 120, theme).join("\n");

  assert.match(output, /result returned; lifecycle pending/);
  assert.doesNotMatch(output, /stalled/);
});

test("agent widget prefers a woken live agent over its stale completed snapshot", () => {
  const now = Date.now();
  const agent = {
    agent: "general",
    name: "sleeper",
    correlationId: "woken-agent",
    startedAt: now - 90_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running" as const,
    depth: 0,
    sleepMs: 60_000,
    progress: [{
      agent: "general",
      name: "sleeper",
      correlationId: "woken-agent",
      taskIndex: 0,
      dependencies: [],
      status: "completed" as const,
      lastActivityAt: now - 60_000,
    }],
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([agent], 120, theme).join("\n");

  assert.match(output, /1 running/);
  assert.match(output, /■ @sleeper/);
  assert.doesNotMatch(output, /completed/);
});

test("agent widget freezes duration while an agent is sleeping", () => {
  const now = Date.now();
  const agent = {
    agent: "general",
    name: "sleeper",
    correlationId: "sleeping-agent",
    startedAt: now - 90_000,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - 60_000,
    status: "sleeping" as const,
    sleptAt: now - 60_000,
    depth: 0,
    sleepMs: 0,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const output = renderAgentStatusWidget([agent], 120, theme).join("\n");

  assert.match(output, /@sleeper general · 30s/);
});
