import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  entryToRows,
  findLatestSessionFile,
  findValidSessionFile,
  groupTranscriptTurns,
  loadTranscript,
  loadTranscriptFromMemory,
  parseTeammateSessionRecords,
  projectMessage,
  resolveSessionFile,
  scanWorkspaceSessionDirs,
  summarizeSessionFile,
  type TranscriptSource,
} from "../src/transcript/session-transcript.ts";
import {
  TEAMMATE_SESSION_CUSTOM_TYPE,
  type HistoricalAgentRecord,
  type TranscriptRow,
} from "../src/shared/transcript.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Loose fixture builder: session files are parsed without validation, so
 * fixtures mirror raw JSONL shapes rather than satisfying the full union.
 */
function sessionEntry(
  entry: { type: SessionEntry["type"] } & Record<string, unknown>,
): SessionEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    ...entry,
  } as SessionEntry;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teammate-transcript-"));
}

function writeFile(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

const HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2026-08-01T00:00:00.000Z",
  cwd: "/tmp/work",
});

const USER_M1 = JSON.stringify({
  type: "message",
  id: "m1",
  parentId: null,
  timestamp: "2026-08-01T00:00:01.000Z",
  message: { role: "user", content: "hello", timestamp: 1754000000001 },
});

const ASSISTANT_M2 = JSON.stringify({
  type: "message",
  id: "m2",
  parentId: "m1",
  timestamp: "2026-08-01T00:00:02.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "hi there" },
    ],
    model: "anthropic/claude-sonnet-4",
    timestamp: 1754000000002,
  },
});

const TOOL_M3 = JSON.stringify({
  type: "message",
  id: "m3",
  parentId: "m2",
  timestamp: "2026-08-01T00:00:03.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "Read", arguments: { path: "a.ts" } },
    ],
    model: "anthropic/claude-sonnet-4",
    timestamp: 1754000000003,
  },
});

const RESULT_M4 = JSON.stringify({
  type: "message",
  id: "m4",
  parentId: "m3",
  timestamp: "2026-08-01T00:00:04.000Z",
  message: {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "Read",
    content: [{ type: "text", text: "file body" }],
    isError: false,
    timestamp: 1754000000004,
  },
});

const COMPACTION_C1 = JSON.stringify({
  type: "compaction",
  id: "c1",
  parentId: "m4",
  timestamp: "2026-08-01T00:00:05.000Z",
  summary: "summarized earlier turns",
  firstKeptEntryId: "m2",
  tokensBefore: 1234,
});

const USER_M5 = JSON.stringify({
  type: "message",
  id: "m5",
  parentId: "c1",
  timestamp: "2026-08-01T00:00:06.000Z",
  message: { role: "user", content: "continue", timestamp: 1754000000006 },
});

const MODEL_CHANGE_MC1 = JSON.stringify({
  type: "model_change",
  id: "mc1",
  parentId: "m5",
  timestamp: "2026-08-01T00:00:07.000Z",
  provider: "anthropic",
  modelId: "claude-opus",
});

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

test("projectMessage: user text message → one user row", () => {
  const entry = sessionEntry({
    type: "message",
    message: { role: "user", content: "hello", timestamp: 100 },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "user");
  assert.equal(rows[0]?.text, "hello");
  assert.equal(rows[0]?.entryId, entry.id);
  assert.equal(rows[0]?.timestamp, 100);
});

test("projectMessage: assistant multi-block → thinking/tool/text rows in order", () => {
  const entry = sessionEntry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "toolCall", id: "t1", name: "Grep", arguments: { pattern: "x" } },
        { type: "text", text: "found it" },
      ],
      model: "p/m",
      timestamp: 200,
    },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.deepEqual(rows.map((r) => r.kind), ["thinking", "tool", "assistant"]);
  assert.equal(rows[1]?.toolName, "Grep");
  assert.equal(rows[1]?.toolCallId, "t1");
  assert.equal(rows[1]?.text, JSON.stringify({ pattern: "x" }, null, 2));
  assert.equal(rows[2]?.model, "p/m");
});

test("projectMessage: toolResult preserves name/id/error", () => {
  const entry = sessionEntry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "Read",
      content: [{ type: "text", text: "body" }],
      isError: true,
      timestamp: 300,
    },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "tool_result");
  assert.equal(rows[0]?.toolName, "Read");
  assert.equal(rows[0]?.toolCallId, "t1");
  assert.equal(rows[0]?.isError, true);
  assert.equal(rows[0]?.text, "body");
});

test("projectMessage: user images render as markers", () => {
  const entry = sessionEntry({
    type: "message",
    message: {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      timestamp: 400,
    },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.equal(rows[0]?.text, "look at this\n[image:image/png]");
});

test("projectMessage: tool-only assistant turn yields an empty row", () => {
  const entry = sessionEntry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t9", name: "Bash", arguments: { command: "ls" } },
      ],
      model: "p/m",
      timestamp: 500,
    },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.deepEqual(rows.map((r) => r.kind), ["tool"]);
});

test("entryToRows: non-message entries collapse to meta rows", () => {
  assert.equal(
    entryToRows(
      sessionEntry({
        type: "compaction",
        summary: "early turns",
        firstKeptEntryId: "m0",
        tokensBefore: 500,
      }),
    ).length,
    1,
  );
  const modelRows = entryToRows(
    sessionEntry({ type: "model_change", provider: "anthropic", modelId: "opus" }),
  );
  assert.match(modelRows[0]?.text ?? "", /Model · anthropic\/opus/);
  const thinkingRows = entryToRows(
    sessionEntry({ type: "thinking_level_change", thinkingLevel: "high" }),
  );
  assert.match(thinkingRows[0]?.text ?? "", /Thinking · high/);
  assert.deepEqual(entryToRows(sessionEntry({ type: "label", targetId: "x", label: "l" })), []);
});

// ---------------------------------------------------------------------------
// loadTranscript (session file source)
// ---------------------------------------------------------------------------

test("loadTranscript: full chain with compaction and model change", async () => {
  const dir = tmpDir();
  const file = writeFile(dir, "session.jsonl", [
    HEADER,
    USER_M1,
    ASSISTANT_M2,
    TOOL_M3,
    RESULT_M4,
    COMPACTION_C1,
    USER_M5,
    MODEL_CHANGE_MC1,
  ]);
  const load = await loadTranscript({
    correlationId: "cid-1",
    sessionFile: file,
  });
  assert.equal(load.source, "session");
  assert.equal(load.compacted, true);
  assert.equal(load.sessionFile, file);
  assert.equal(load.anchorId, "mc1");
  assert.deepEqual(load.rows.map((r) => r.kind), [
    "user", // m1
    "thinking", // m2
    "assistant", // m2
    "tool", // m3
    "tool_result", // m4
    "meta", // c1 compaction
    "user", // m5
    "meta", // mc1 model change
  ]);
  assert.equal(load.rows[0]?.text, "hello");
  assert.match(load.rows[5]?.text ?? "", /↕ compacted 1234 tokens/);
  assert.equal(load.rows[3]?.toolName, "Read");
});

test("loadTranscript: trailing half-written line is tolerated", async () => {
  const dir = tmpDir();
  const file = writeFile(dir, "session.jsonl", [
    HEADER,
    USER_M1,
    '{"type":"message","id":"m9","parentId":"m1","timestamp":"2026-08-01T00:00:09.000Z","message":{"role":"user","content":"incomplete',
  ]);
  const load = await loadTranscript({ correlationId: "cid-1", sessionFile: file });
  assert.equal(load.source, "session");
  assert.equal(load.anchorId, "m1");
  assert.deepEqual(load.rows.map((r) => r.kind), ["user"]);
});

test("loadTranscript: header-only or unreadable file falls back to memory", async () => {
  const dir = tmpDir();
  const empty = writeFile(dir, "empty.jsonl", [HEADER]);
  const load = await loadTranscript({
    correlationId: "cid-1",
    sessionFile: empty,
    lastResult: "done",
  });
  assert.equal(load.source, "memory");
  assert.deepEqual(load.rows.map((r) => r.kind), ["assistant"]);

  const missing = await loadTranscript({
    correlationId: "cid-1",
    sessionFile: path.join(dir, "nope.jsonl"),
  });
  assert.equal(missing.source, "memory");
});

test("groupTranscriptTurns splits on user rows with stats and a preamble turn", () => {
  const row = (kind: TranscriptRow["kind"], text: string, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
    kind,
    role: kind === "tool_result" ? "toolResult" : kind === "user" ? "user" : "assistant",
    text,
    timestamp: 0,
    ...extra,
  });
  const turns = groupTranscriptTurns([
    row("system", "started"),
    row("user", "first ask"),
    row("thinking", "let me think"),
    row("tool", "a.ts", { toolName: "Read" }),
    row("tool_result", "ok", { toolName: "Read" }),
    row("assistant", "answer one"),
    row("user", "second ask"),
    row("assistant", "answer two"),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0]?.index, 0);
  assert.equal(turns[0]?.userText, "session start");
  assert.equal(turns[0]?.rowCount, 1);
  assert.equal(turns[1]?.index, 1);
  assert.equal(turns[1]?.userText, "first ask");
  assert.equal(turns[1]?.rowCount, 5);
  assert.equal(turns[1]?.toolCallCount, 1);
  assert.equal(turns[1]?.toolResultCount, 1);
  assert.equal(turns[1]?.textLength, "let me think".length + "answer one".length);
  assert.equal(turns[1]?.rows.length, 5);
  assert.equal(turns[2]?.index, 2);
  assert.equal(turns[2]?.userText, "second ask");
  assert.equal(turns[2]?.rowCount, 2);
  assert.equal(turns[2]?.toolCallCount, 0);
});

test("groupTranscriptTurns returns empty for no rows and keeps user-only turns", () => {
  assert.deepEqual(groupTranscriptTurns([]), []);
  const turns = groupTranscriptTurns([{ kind: "user", role: "user", text: "solo", timestamp: 1 }]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.index, 1);
  assert.equal(turns[0]?.rowCount, 1);
});

test("loadTranscriptFromMemory: outputLog heuristic + lastResult", () => {
  const load = loadTranscriptFromMemory({
    correlationId: "cid-1",
    outputLog: [
      "[00:00:01] ✓ Read a.ts",
      "[00:00:02] ◀ follow_up: keep going",
      "Started: 2026-08-01T00:00:00Z",
    ],
    lastResult: "all done",
  });
  assert.equal(load.source, "memory");
  assert.equal(load.anchorId, null);
  assert.deepEqual(load.rows.map((r) => r.kind), ["tool", "system", "system", "assistant"]);
  assert.equal(load.rows[3]?.text, "all done");
});

// ---------------------------------------------------------------------------
// resolveSessionFile / findLatestSessionFile
// ---------------------------------------------------------------------------

test("resolveSessionFile: explicit sessionFile wins", () => {
  const dir = tmpDir();
  const file = writeFile(dir, "a.jsonl", [HEADER]);
  const resolved = resolveSessionFile({ correlationId: "cid-1", sessionFile: file });
  assert.equal(resolved, file);
});

test("resolveSessionFile: cold-start derivation from parent session root", () => {
  const dir = tmpDir();
  const parent = writeFile(dir, "parent.jsonl", [HEADER]);
  const agentDir = path.join(dir, "parent", "cid-a");
  const file = writeFile(agentDir, "sess.jsonl", [HEADER]);
  assert.equal(
    resolveSessionFile({ correlationId: "cid-a", parentSessionFile: parent }),
    file,
  );
});

test("resolveSessionFile: missing sources → null", () => {
  const dir = tmpDir();
  assert.equal(resolveSessionFile({ correlationId: "cid-x" }), null);
  assert.equal(
    resolveSessionFile({
      correlationId: "cid-x",
      parentSessionFile: path.join(dir, "missing.jsonl"),
    }),
    null,
  );
});

test("findLatestSessionFile: picks newest jsonl, ignores other files", () => {
  const dir = tmpDir();
  const old = writeFile(dir, "a.jsonl", [HEADER]);
  const fresh = writeFile(dir, "b.jsonl", [HEADER]);
  const now = Date.now();
  fs.utimesSync(fresh, new Date(now), new Date(now + 1000));
  fs.utimesSync(old, new Date(now), new Date(now - 1000));
  assert.equal(findLatestSessionFile(dir), fresh);
  assert.equal(findLatestSessionFile(path.join(dir, "missing")), null);
});

// ---------------------------------------------------------------------------
// history recovery
// ---------------------------------------------------------------------------

test("scanWorkspaceSessionDirs: enumerates per-correlation dirs newest-first", () => {
  const dir = tmpDir();
  const parent = writeFile(dir, "parent.jsonl", [HEADER]);
  const dirA = path.join(dir, "parent", "cid-a");
  const dirB = path.join(dir, "parent", "cid-b");
  writeFile(dirA, "s1.jsonl", [HEADER, USER_M1]);
  writeFile(dirB, "s2.jsonl", [
    HEADER,
    USER_M5,
    '{"type":"message","id":"mb","parentId":"m5","timestamp":"2026-08-01T00:00:08.000Z","message":{"role":"assistant","content":[{"type":"text","text":"later reply"}],"timestamp":1754000000008}}',
  ]);
  const scans = scanWorkspaceSessionDirs(parent);
  assert.equal(scans.length, 2);
  // Newest first: b started 00:00:00 with a message at 00:00:08? Header
  // timestamps are identical, so order falls back to mtime — assert contents
  // rather than strict order.
  const byFile = new Map(scans.map((s) => [path.basename(path.dirname(s.sessionFile)), s]));
  const a = byFile.get("cid-a");
  const b = byFile.get("cid-b");
  assert.ok(a);
  assert.ok(b);
  assert.equal(a?.messageCount, 1);
  assert.equal(a?.firstMessage, "hello");
  assert.equal(b?.messageCount, 2);
  assert.equal(b?.firstMessage, "continue");
  assert.ok(a?.sessionId);
});

test("scanWorkspaceSessionDirs: missing parent → empty", () => {
  const dir = tmpDir();
  assert.deepEqual(scanWorkspaceSessionDirs(path.join(dir, "missing.jsonl")), []);
});

test("summarizeSessionFile: unreadable file → null", () => {
  assert.equal(summarizeSessionFile(path.join(tmpDir(), "nope.jsonl")), null);
});

test("parseTeammateSessionRecords: filters by custom type and shape", () => {
  const valid: HistoricalAgentRecord = {
    correlationId: "c1",
    agent: "explorer",
    name: "scan",
    sessionFile: "/s/x.jsonl",
    startedAt: 1754000000000,
    lastActivityAt: 1754000001000,
    status: "completed",
  };
  const entries: SessionEntry[] = [
    sessionEntry({
      type: "custom",
      customType: TEAMMATE_SESSION_CUSTOM_TYPE,
      data: valid,
    }),
    sessionEntry({ type: "custom", customType: "other-type", data: valid }),
    sessionEntry({
      type: "custom",
      customType: TEAMMATE_SESSION_CUSTOM_TYPE,
      data: { agent: 42 },
    }),
    sessionEntry({
      type: "message",
      message: { role: "user", content: "x", timestamp: 1 },
    }),
  ];
  const records = parseTeammateSessionRecords(entries);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], valid);
});

// ---------------------------------------------------------------------------
// cross-review fixes: display semantics, custom roles, fail-soft, summaries
// ---------------------------------------------------------------------------

test("custom_message with display:false is hidden entirely", () => {
  const hidden = sessionEntry({
    type: "custom_message",
    customType: "teammate-internal",
    content: "secret internal state",
    display: false,
  });
  assert.deepEqual(entryToRows(hidden), []);

  const shown = sessionEntry({
    type: "custom_message",
    customType: "teammate-note",
    content: "visible note",
    display: true,
  });
  const rows = entryToRows(shown);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "system");
  assert.equal(rows[0]?.entryId, shown.id);
});

test("projectMessage: bashExecution role renders command + output + exit", () => {
  const entry = sessionEntry({
    type: "message",
    message: {
      role: "bashExecution",
      command: "git status",
      output: " M src/a.ts",
      exitCode: 0,
      timestamp: 600,
    },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "system");
  assert.match(rows[0]?.text ?? "", /\$ git status/);
  assert.match(rows[0]?.text ?? "", /exit 0/);
});

test("projectMessage: custom role respects display flag", () => {
  const entry = (display: boolean) =>
    sessionEntry({
      type: "message",
      message: {
        role: "custom",
        customType: "x",
        content: "payload",
        display,
        timestamp: 700,
      },
    }) as Extract<SessionEntry, { type: "message" }>;
  assert.deepEqual(projectMessage(entry(false)), []);
  const rows = projectMessage(entry(true));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, "payload");
});

test("projectMessage: null message does not throw", () => {
  const entry = sessionEntry({
    type: "message",
    message: null,
  }) as Extract<SessionEntry, { type: "message" }>;
  assert.deepEqual(projectMessage(entry), []);
});

test("loadTranscript: one malformed entry does not drop the disk transcript", async () => {
  const dir = tmpDir();
  // c1 has a null summary — entryToRows throws on it (firstLine(null)).
  const badCompaction = JSON.stringify({
    type: "compaction",
    id: "c1",
    parentId: "m2",
    timestamp: "2026-08-01T00:00:05.000Z",
    summary: null,
    firstKeptEntryId: "m2",
    tokensBefore: 10,
  });
  const file = writeFile(dir, "session.jsonl", [
    HEADER,
    USER_M1,
    ASSISTANT_M2,
    badCompaction,
    USER_M5,
  ]);
  const load = await loadTranscript({ correlationId: "cid-1", sessionFile: file });
  assert.equal(load.source, "session"); // not degraded to memory
  const kinds = load.rows.map((r) => r.kind);
  assert.ok(kinds.includes("meta")); // ⚠ unreadable entry
  assert.ok(kinds.includes("user")); // m1 and m5 survive
});

test("loadTranscript: anchorId comes from the last row-producing entry", async () => {
  const dir = tmpDir();
  const labelTail = JSON.stringify({
    type: "label",
    id: "lbl1",
    parentId: "m1",
    timestamp: "2026-08-01T00:00:08.000Z",
    targetId: "m1",
    label: "checkpoint",
  });
  const file = writeFile(dir, "session.jsonl", [HEADER, USER_M1, labelTail]);
  const load = await loadTranscript({ correlationId: "cid-1", sessionFile: file });
  assert.equal(load.source, "session");
  assert.equal(load.anchorId, "m1"); // not the label leaf
  assert.equal(load.rows[0]?.entryId, "m1");
});

test("summarizeSessionFile: requires a real header as the first entry", () => {
  const dir = tmpDir();
  // Empty file (crash artifact) → not a valid session.
  const empty = writeFile(dir, "empty.jsonl", [""]);
  assert.equal(summarizeSessionFile(empty), null);
  // Header not first → not a valid session.
  const lateHeader = writeFile(dir, "late.jsonl", [USER_M1, HEADER]);
  assert.equal(summarizeSessionFile(lateHeader), null);
  // Valid header → summary with mtime.
  const valid = writeFile(dir, "valid.jsonl", [HEADER, USER_M1]);
  const summary = summarizeSessionFile(valid);
  assert.ok(summary);
  assert.equal(summary?.messageCount, 1);
  assert.equal(summary?.firstMessage, "hello");
  assert.ok(summary?.mtimeMs > 0);
});

test("summarizeSessionFile: counts only the active leaf chain", async () => {
  const dir = tmpDir();
  // Abandoned branch: m-b1/m-b2 chain off m1; active chain stays m1 → m2.
  const branch = JSON.stringify({
    type: "message",
    id: "m-b1",
    parentId: "m1",
    timestamp: "2026-08-01T00:00:09.000Z",
    message: { role: "user", content: "abandoned branch", timestamp: 9 },
  });
  const file = writeFile(dir, "branch.jsonl", [HEADER, USER_M1, branch, ASSISTANT_M2]);
  const summary = summarizeSessionFile(file);
  assert.equal(summary?.messageCount, 2); // m1 + m2, not the branch message
  assert.equal(summary?.firstMessage, "hello");
});

test("findValidSessionFile: invalid newest file does not shadow a valid older one", () => {
  const dir = tmpDir();
  const valid = writeFile(path.join(dir, "agent"), "old-valid.jsonl", [HEADER, USER_M1]);
  const now = Date.now();
  fs.utimesSync(valid, new Date(now), new Date(now - 5000));
  const broken = writeFile(path.join(dir, "agent"), "new-broken.jsonl", [""]);
  fs.utimesSync(broken, new Date(now), new Date(now));
  assert.equal(findValidSessionFile(path.join(dir, "agent")), valid);
});

test("scanWorkspaceSessionDirs: deterministic newest-first with mtime tie-break", () => {
  const dir = tmpDir();
  const parent = writeFile(dir, "parent.jsonl", [HEADER]);
  const dirA = path.join(dir, "parent", "cid-a");
  const dirB = path.join(dir, "parent", "cid-b");
  const fileA = writeFile(dirA, "s1.jsonl", [HEADER, USER_M1]);
  const fileB = writeFile(dirB, "s2.jsonl", [HEADER, USER_M5]);
  const now = Date.now();
  // Identical header timestamps; mtimes decide.
  fs.utimesSync(fileA, new Date(now), new Date(now - 2000));
  fs.utimesSync(fileB, new Date(now), new Date(now - 1000));
  const scans = scanWorkspaceSessionDirs(parent);
  assert.equal(scans.length, 2);
  assert.equal(scans[0]?.sessionFile, fileB); // newer mtime first
  assert.equal(scans[1]?.sessionFile, fileA);
});

test("projectMessage: non-string/array user content renders an empty row", () => {
  const entry = sessionEntry({
    type: "message",
    message: { role: "user", content: 42, timestamp: 1 },
  }) as Extract<SessionEntry, { type: "message" }>;
  const rows = projectMessage(entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "user");
  assert.equal(rows[0]?.text, "");
});
