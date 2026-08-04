import assert from "node:assert/strict";
import test from "node:test";
import {
  decideViewingInput,
  renderViewingWidget,
  renderViewingRow,
  VIEWING_MAX_MESSAGE_LINES,
} from "../src/tui/viewing-widget.ts";
import type { TranscriptRow } from "../src/shared/transcript.ts";

function row(kind: TranscriptRow["kind"], text: string, extra: Partial<TranscriptRow> = {}): TranscriptRow {
  return { kind, role: kind === "user" ? "user" : kind === "tool_result" ? "toolResult" : "assistant", text, timestamp: 1, ...extra };
}

test("decideViewingInput: routes only while viewing", () => {
  assert.deepEqual(decideViewingInput("hello", { viewing: false, canSend: true }), { action: "continue" });
  assert.deepEqual(decideViewingInput("hello", { viewing: true, canSend: true }), { action: "forward", text: "hello" });
});

test("decideViewingInput: slash commands go to the main conversation", () => {
  assert.deepEqual(decideViewingInput("/model fast", { viewing: true, canSend: true }), { action: "continue" });
});

test("decideViewingInput: read-only (history) agents swallow input", () => {
  assert.deepEqual(decideViewingInput("hello", { viewing: true, canSend: false }), { action: "handled" });
});

test("renderViewingWidget: header, tail-following rows, composer hint", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row("user", `message ${i}`));
  const lines = renderViewingWidget(
    { agentName: "explorer", agentRole: "explorer", status: "running", rows, canSend: true, transcriptSource: "session" },
    80,
  ).join("\n");
  assert.match(lines, /Viewing @explorer/);
    assert.match(lines, /Esc main/);
  // Tail-following: the newest message is visible, the oldest is not.
  assert.match(lines, /message 19/);
  assert.doesNotMatch(lines, /message 0/);
  assert.match(lines, /Type in the input box/);
});

test("renderViewingWidget: memory fallback marker and read-only hint", () => {
  const lines = renderViewingWidget(
    { agentRole: "teammate", status: "completed", rows: [], canSend: false, transcriptSource: "memory" },
    80,
  ).join("\n");
  assert.match(lines, /no persisted session/);
  assert.match(lines, /Read-only/);
  assert.match(lines, /No messages yet/);
});

test("renderViewingRow: kinds render without raw newlines escaping", () => {
  const samples = [
    row("user", "line1\nline2\nline3\nline4"),
    row("tool", "{\"path\":\"a.ts\"}", { toolName: "Read" }),
    row("thinking", "thought one\nthought two"),
    row("meta", "compacted 100 tokens"),
  ];
  for (const sample of samples) {
    for (const line of renderViewingRow(sample, 40)) {
      assert.ok(!line.includes("\n"), `row ${sample.kind} leaked a newline`);
    }
  }
});

test("VIEWING_MAX_MESSAGE_LINES bounds the widget body", () => {
  const rows = Array.from({ length: VIEWING_MAX_MESSAGE_LINES + 10 }, (_, i) => row("user", `m${i}`));
  const out = renderViewingWidget(
    { agentRole: "a", status: "running", rows, canSend: true, transcriptSource: "session" },
    80,
  );
  const body = out.filter((line) => /m\d+/.test(line));
  assert.equal(body.length, VIEWING_MAX_MESSAGE_LINES);
});

test("agent switcher row highlights the active agent", () => {
  const lines = renderViewingWidget(
    {
      agentName: "explorer",
      agentRole: "explorer",
      status: "running",
      rows: [],
      canSend: true,
      transcriptSource: "session",
      switches: [
        { label: "@explorer", active: true },
        { label: "@builder", active: false },
        { label: "@scout", active: false },
      ],
    },
    80,
  ).join("\n");
  assert.match(lines, /▸ @explorer/);
  assert.match(lines, /@builder/);
  assert.match(lines, /Esc main/);
});

test("single switchable agent renders no switcher row", () => {
  const lines = renderViewingWidget(
    { agentRole: "a", status: "running", rows: [], canSend: true, transcriptSource: "session" },
    80,
  ).join("\n");
  assert.doesNotMatch(lines, /▸ @/);
});
