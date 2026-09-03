import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  DEFAULT_SESSION_HISTORY_INCLUDE,
  MAX_SESSION_HISTORY_BYTES,
  MAX_SESSION_HISTORY_MATCHES,
  MAX_SESSION_HISTORY_SNIPPET_CHARS,
  SESSION_HISTORY_INCLUDES,
  SessionHistoryService,
  sessionEntryUri,
  type SessionHistoryInventoryEntry,
} from "../src/transcript/session-history.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teammate-session-history-"));
}
function writeTranscript(dir: string, name: string, lines: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}
function header(id: string): unknown {
  return { type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00.000Z", cwd: "/workspace" };
}
function user(id: string, parentId: string | null, content: string): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content, timestamp: 1 } };
}
function assistant(id: string, parentId: string, text: string): unknown {
  return {
    type: "message", id, parentId, timestamp: "2026-08-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden internal thought" },
        { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "secret-argument" } },
        { type: "text", text },
      ],
      model: "provider/model", timestamp: 2,
    },
  };
}
function toolResult(id: string, parentId: string, text: string): unknown {
  return {
    type: "message", id, parentId, timestamp: "2026-08-01T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text }], isError: false, timestamp: 3 },
  };
}
function compaction(id: string, parentId: string, timestamp: string, summary: string): unknown {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    summary,
    firstKeptEntryId: parentId,
    tokensBefore: 1_000,
  };
}
function inventory(...paths: string[]): SessionHistoryInventoryEntry[] {
  return paths.map((file) => ({ path: file, fileName: path.basename(file) }));
}

test("projects only approved default categories from the active chain", async () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, "active.jsonl", [
    header("session-active"),
    user("u1", null, "first question"),
    user("abandoned", "u1", "abandoned branch only"),
    assistant("a2", "u1", "visible answer"),
    toolResult("r3", "a2", "tool output explicit only"),
    { type: "model_change", id: "model", parentId: "r3", timestamp: "2026-08-01T00:00:04.000Z", provider: "secret-provider", modelId: "secret-model" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: "2026-08-01T00:00:05.000Z", thinkingLevel: "secret-level" },
    { type: "branch_summary", id: "branch", parentId: "thinking", timestamp: "2026-08-01T00:00:06.000Z", summary: "secret branch" },
    { type: "custom_message", id: "custom", parentId: "branch", timestamp: "2026-08-01T00:00:07.000Z", customType: "visible", content: "visible custom", display: true },
  ]);
  const service = new SessionHistoryService({ inventory: { generation: 7, entries: inventory(file) } });

  assert.deepEqual(DEFAULT_SESSION_HISTORY_INCLUDE, SESSION_HISTORY_INCLUDES.slice(0, 4));
  const listed = await service.list();
  assert.equal(listed.generation, 7);
  assert.equal(listed.sessions[0]?.resourceUri, "session://session-active");

  const read = await service.read({ sessionId: "session-active", turn: 1 });
  assert.equal(read.found, true);
  assert.equal("sessions" in read, false);
  assert.equal("turns" in read, false);
  assert.equal("session" in read, false);
  assert.deepEqual(read.turn?.entries.map((entry) => [entry.entryId, entry.kind]), [
    ["u1", "user"], ["a2", "assistant"], ["custom", "visible_custom"],
  ]);
  const serialized = JSON.stringify(read);
  assert.doesNotMatch(serialized, /secret-argument|provider\/model|secret-provider|secret-model|secret-level|secret branch|toolCallId|toolName|isError/);
  assert.equal(read.turn?.entries[1]?.resourceUri, sessionEntryUri("session-active", "a2"));
});

test("compaction timeline is newest-first, bounded, and keeps exact entry URIs", async () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, "compact.jsonl", [
    header("compact-session"),
    user("u1", null, "first phase"),
    compaction("cp-1", "u1", "2026-08-01T00:00:02.000Z", "first compact"),
    user("u2", "cp-1", "second phase"),
    compaction("cp-2", "u2", "2026-08-01T00:00:04.000Z", "second compact"),
  ]);
  const service = new SessionHistoryService(inventory(file));

  const result = await service.compactions({ limit: 1 });
  assert.equal(result.checkpointCount, 2);
  assert.deepEqual(result.checkpoints.map((entry) => entry.entryId), ["cp-2"]);
  assert.equal(result.checkpoints[0]?.resourceUri, sessionEntryUri("compact-session", "cp-2"));
  assert.equal(result.checkpoints[0]?.kind, "compaction");
  assert.equal(result.truncated, true);
  assert.equal(result.omissions.some((item) => item.reason === "result-limit"), true);
});

test("literal search uses categorical include and tool_result is explicit only", async () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, "search.jsonl", [
    header("search-session"), user("u1", null, "Find Needle"),
    assistant("a2", "u1", "needle answer"), toolResult("r3", "a2", "needle tool result"),
    { type: "message", id: "bash", parentId: "r3", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "bashExecution", command: "needle secret command", output: "needle output", timestamp: 4 } },
  ]);
  const service = new SessionHistoryService(inventory(file));
  const defaults = await service.search("NEEDLE");
  assert.deepEqual(defaults.matches.map((match) => match.entryId), ["u1", "a2"]);
  const explicit = await service.search("needle", { include: ["tool_result"] });
  assert.deepEqual(explicit.matches.map((match) => match.entryId), ["r3"]);
  assert.equal(explicit.matches[0]?.resourceUri, sessionEntryUri("search-session", "r3"));
  assert.doesNotMatch(JSON.stringify(explicit), /secret command|needle output|toolCallId|toolName/);
});

test("single limit bounds list, search, and selected-turn entries", async () => {
  const dir = tmpDir();
  const one = writeTranscript(dir, "one.jsonl", [header("one"), user("u1", null, "same"), assistant("a1", "u1", "same")]);
  const two = writeTranscript(dir, "two.jsonl", [header("two"), user("u2", null, "same")]);
  const service = new SessionHistoryService(inventory(one, two));
  assert.equal((await service.list({ limit: 1 })).sessions.length, 1);
  assert.equal((await service.search("same", { limit: 1 })).matches.length, 1);
  const read = await service.read({ sessionId: "one", turn: 1, limit: 1 });
  assert.equal(read.turn?.entries.length, 1);
  assert.equal(read.truncated, true);
  assert.equal(read.omissions.some((item) => item.reason === "result-limit"), true);

  const emptySelection = await service.read({ sessionId: "two", turn: 1, include: ["tool_result"] });
  assert.equal(emptySelection.found, true);
  assert.deepEqual(emptySelection.turn?.entries, []);
  assert.equal(emptySelection.turn?.userText, "");
});

test("same-handle bounded reads fail closed for symlinks and oversized files", async () => {
  const dir = tmpDir();
  const target = writeTranscript(dir, "target.jsonl", [header("target"), user("u1", null, "target")]);
  const link = path.join(dir, "link.jsonl");
  let linked = false;
  try { fs.symlinkSync(target, link, "file"); linked = true; } catch { /* Windows privilege policy. */ }
  const oversized = path.join(dir, "oversized.jsonl");
  const handle = fs.openSync(oversized, "w");
  fs.ftruncateSync(handle, MAX_SESSION_HISTORY_BYTES + 1);
  fs.closeSync(handle);
  const result = await new SessionHistoryService(inventory(...(linked ? [link] : []), oversized)).list();
  assert.equal(result.sessions.length, 0);
  assert.equal(result.omissions.some((item) => item.reason === "over-budget"), true);
  if (linked && process.platform !== "win32") {
    assert.equal(result.omissions.some((item) => item.reason === "symlink"), true);
  }
});

test("search match count and snippets stay bounded", async () => {
  const dir = tmpDir();
  const long = `${"x".repeat(MAX_SESSION_HISTORY_SNIPPET_CHARS)} needle ${"y".repeat(MAX_SESSION_HISTORY_SNIPPET_CHARS)}`;
  const file = writeTranscript(dir, "long.jsonl", [header("long"), user("u1", null, long)]);
  const result = await new SessionHistoryService(inventory(file)).search("needle");
  assert.ok(result.matches[0]!.snippet.length <= MAX_SESSION_HISTORY_SNIPPET_CHARS);

  const many = writeTranscript(dir, "many.jsonl", [
    header("many"),
    ...Array.from({ length: MAX_SESSION_HISTORY_MATCHES + 1 }, (_, index) => user(`u-${index}`, index === 0 ? null : `u-${index - 1}`, "same")),
  ]);
  const manyResult = await new SessionHistoryService(inventory(many)).search("same");
  assert.equal(manyResult.matches.length, MAX_SESSION_HISTORY_MATCHES);
  assert.equal(manyResult.matchCount, MAX_SESSION_HISTORY_MATCHES + 1);
  assert.equal(manyResult.truncated, true);
});
