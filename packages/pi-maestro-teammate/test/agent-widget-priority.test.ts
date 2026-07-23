import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentStatusWidget } from "../src/extension/index.ts";

test("agent widget keeps failed work and the live edge visible in the compact budget", () => {
  const now = Date.now();
  const progress = Array.from({ length: 8 }, (_, taskIndex) => ({
    agent: "worker",
    name: `worker-${taskIndex + 1}`,
    correlationId: `worker-${taskIndex + 1}`,
    taskIndex,
    dependencies: [],
    status: taskIndex === 7 ? "running" as const : "failed" as const,
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
    sleepMs: 0,
    progress,
  };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const compact = renderAgentStatusWidget([parent], 30, theme).join("\n");
  assert.match(compact, /worker-1.*failed/);
  assert.match(compact, /1 running/);
  assert.match(compact, /■ @worker-8/);
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
