import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryRows,
  historyLabel,
  historyRowKey,
} from "../src/extension/teammate-core.ts";
import type { WorkspaceSessionScan } from "../src/transcript/session-transcript.ts";

function scan(overrides: Partial<WorkspaceSessionScan> = {}): WorkspaceSessionScan {
  return {
    sessionFile: "/s/sess-1.jsonl",
    sessionId: "abcdef12",
    startedAt: 1754000000000,
    mtimeMs: 1754000000000,
    messageCount: 12,
    firstMessage: "initial prompt",
    ...overrides,
  };
}

test("buildHistoryRows: one row per scan with completed status", () => {
  const rows = buildHistoryRows([scan(), scan({ sessionFile: "/s/other.jsonl" })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.correlationId, historyRowKey(scan()));
  assert.equal(rows[1]?.correlationId, historyRowKey(scan({ sessionFile: "/s/other.jsonl" })));
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[0]?.agent, "teammate");
  assert.equal(rows[0]?.lastMessage, "initial prompt");
  assert.equal(rows[0]?.startedAt, 1754000000000);
});

test("buildHistoryRows: empty scans → empty rows", () => {
  assert.deepEqual(buildHistoryRows([]), []);
});

test("historyLabel: session id truncated + message count", () => {
  assert.equal(historyLabel(scan()), "history abcdef12 · 12 msgs");
  assert.equal(historyLabel(scan({ messageCount: 0, sessionId: undefined })), "history session");
});

test("historyRowKey: stable per session file, independent of scan order", () => {
  const a = scan();
  const b = scan({ sessionFile: "/s/sess-2.jsonl" });
  assert.equal(historyRowKey(a), historyRowKey(a));
  assert.notEqual(historyRowKey(a), historyRowKey(b));
  // Re-scanning with different positions yields the same key.
  assert.equal(historyRowKey({ ...a, startedAt: 0, messageCount: 1 }), historyRowKey(a));
});

// ---------------------------------------------------------------------------
// selector panel: 8-row window, page hint, completed history rendering
// ---------------------------------------------------------------------------

import { renderAgentSelectorPanel } from "../src/extension/teammate-core.ts";

function row(index: number, status: "running" | "completed" = "running") {
  return {
    correlationId: `cid-${index}`,
    agent: "worker",
    label: `w${index}`,
    status,
    startedAt: Date.now(),
    depth: 0,
    treePrefix: "",
    recentTools: [],
  };
}

test("selector panel: 8-row window with range; page hint in footer", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i));
  const head = renderAgentSelectorPanel(rows, 0, "", 80).join("\n");
  assert.match(head, /1-8\/12/);
  assert.match(head, /PgUp\/PgDn page/);
  assert.match(head, /w0/);
  assert.doesNotMatch(head, /w9/);

  const tail = renderAgentSelectorPanel(rows, 11, "", 80).join("\n");
  assert.match(tail, /5-12\/12/);
  assert.match(tail, /w11/);
});

test("selector panel: completed history rows render as Done, not Running", () => {
  const rows = [row(0, "completed"), row(1)];
  const panel = renderAgentSelectorPanel(rows, 0, "", 80).join("\n");
  // The completed row shows a dim ✓ + Done; only the live row says Running.
  assert.match(panel, /\x1b\[2m✓\x1b\[22m \x1b\[1mworker\/w0\x1b\[22m \x1b\[2mDone/);
  assert.match(panel, /w1/);
  assert.match(panel, /Running/);
});
