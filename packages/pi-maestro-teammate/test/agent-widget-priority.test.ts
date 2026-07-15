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
