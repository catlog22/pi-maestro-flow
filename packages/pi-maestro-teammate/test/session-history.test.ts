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
function writeLargeTranscript(dir: string, id: string, mebibytes: number): string {
  const file = writeTranscript(dir, `${id}.jsonl`, [header(id)]);
  const padding = `${" ".repeat(1024 * 1024 - 1)}\n`;
  for (let index = 0; index < mebibytes; index += 1) fs.appendFileSync(file, padding);
  fs.appendFileSync(file, `${JSON.stringify(user("u1", null, "large history needle"))}\n`);
  return file;
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

test("same-handle reads fail closed for symlinks and invalid headers", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = writeTranscript(dir, "target.jsonl", [header("target"), user("u1", null, "target")]);
  const link = path.join(dir, "link.jsonl");
  let linked = false;
  try { fs.symlinkSync(target, link, "file"); linked = true; } catch { /* Windows privilege policy. */ }
  const invalid = writeTranscript(dir, "invalid.jsonl", [user("u1", null, "not a header")]);
  const result = await new SessionHistoryService(inventory(...(linked ? [link] : []), invalid)).list();
  assert.equal(result.sessions.length, 0);
  assert.equal(result.omissions.some((item) => item.reason === "invalid-header"), true);
  if (linked && process.platform !== "win32") {
    assert.equal(result.omissions.some((item) => item.reason === "symlink"), true);
  }
});

test("history list, search, turn and URI reads accept files larger than 32 MiB", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeLargeTranscript(dir, "large-session", 49);
  const size = fs.statSync(file).size;
  const service = new SessionHistoryService([{ ...inventory(file)[0]!, sizeBytes: size * 2 }]);
  assert.equal(MAX_SESSION_HISTORY_BYTES, Infinity);
  const listed = await service.list();
  assert.equal(listed.sessions[0]?.sizeBytes, size);
  assert.equal(listed.bytesRead, size);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.omissions, []);
  assert.equal((await service.search("needle")).matches[0]?.sessionId, "large-session");
  const read = await service.read({ sessionId: "large-session", turn: 1 });
  assert.equal(read.found, true);
  assert.equal(read.turn?.userText, "large history needle");
  const entry = await service.readUri(sessionEntryUri("large-session", "u1"));
  assert.equal(entry.selectedEntry?.entries[0]?.text, "large history needle");
});

test("history scans have no cumulative byte budget", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const one = writeLargeTranscript(dir, "large-one", 17);
  const two = writeLargeTranscript(dir, "large-two", 17);
  const result = await new SessionHistoryService(inventory(one, two)).search("needle");
  assert.ok(result.bytesRead > 32 * 1024 * 1024);
  assert.deepEqual(result.matches.map((match) => match.sessionId), ["large-one", "large-two"]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.omissions, []);
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

test("context_edit entries project replacements within the surviving scope", async () => {
  const dir = tmpDir();
  // cp-1 keeps from "a3" onward: r2 falls outside the scope, so a later edit
  // targeting it is inert for the projection — the history shows the original
  // bytes the model last saw. Edits to in-scope entries apply; a null
  // replacement omits the entry (and its turn).
  const file = writeTranscript(dir, "edited.jsonl", [
    header("edit-session"),
    user("u1", null, "first phase"),
    toolResult("r2", "u1", "raw verbose output"),
    assistant("a3", "r2", "original answer"),
    compaction("cp-1", "a3", "2026-08-01T00:00:04.000Z", "checkpoint"),
    user("u4", "cp-1", "second phase"),
    { type: "context_edit", id: "e1", parentId: "u4", timestamp: "2026-08-01T00:00:05.000Z", targetId: "r2", replacement: { content: [{ type: "text", text: "edited output" }] } },
    { type: "context_edit", id: "e2", parentId: "e1", timestamp: "2026-08-01T00:00:06.000Z", targetId: "a3", replacement: { content: "rewritten answer" } },
    { type: "context_edit", id: "e3", parentId: "e2", timestamp: "2026-08-01T00:00:07.000Z", targetId: "u4", replacement: { content: "replaced question" } },
    user("u5", "e3", "third phase"),
    { type: "context_edit", id: "e4", parentId: "u5", timestamp: "2026-08-01T00:00:08.000Z", targetId: "u5", replacement: null },
  ]);
  const service = new SessionHistoryService(inventory(file));

  const first = await service.read({ sessionId: "edit-session", turn: 1 });
  assert.equal(first.found, true);
  const a3 = first.turn?.entries.find((entry) => entry.entryId === "a3");
  assert.equal(a3?.text, "rewritten answer", "string replacements render as a text block");

  const tools = await service.read({ sessionId: "edit-session", turn: 1, include: ["tool_result"] });
  const r2 = tools.turn?.entries.find((entry) => entry.entryId === "r2");
  assert.equal(r2?.text, "raw verbose output", "out-of-scope edits stay inert");

  const second = await service.read({ sessionId: "edit-session", turn: 2 });
  assert.equal(second.turn?.userText, "replaced question", "in-scope edits apply");

  // The null-edited user message is omitted, so its turn never forms.
  const omitted = await service.read({ sessionId: "edit-session", turn: 3 });
  assert.equal(omitted.found, false);
});

test("terms normalizes mixed languages, order, whitespace and NFKC without changing literal defaults", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeTranscript(dir, "terms.jsonl", [
    header("terms"),
    user("mixed", null, "修复  Session\nHistory café ＦＵＬＬ"),
    user("partial", "mixed", "Session History only"),
  ]);
  const service = new SessionHistoryService(inventory(file));
  for (const query of ["session 修复", "修复  HISTORY\nSESSION", "Cafe\u0301 full 修复", "ＦＵＬＬ café"] ) {
    const result = await service.search(query, { mode: "terms" });
    assert.deepEqual(result.matches.map((match) => match.entryId), ["mixed"], query);
    assert.equal(result.matchCount, 1);
    assert.equal(result.hasMore, false);
    assert.equal(result.truncated, false);
  }
  assert.equal((await service.search("修复 Session")).matchCount, 0, "literal must not fold whitespace");
  assert.equal((await service.search("cafe\u0301")).matchCount, 0, "literal must not normalize accents");
  assert.equal((await service.search("full")).matchCount, 0, "literal must not fold width");
  for (const query of [" ", "  ", "\n", "SESSION", "café"]) {
    const defaults = await service.search(query);
    assert.deepEqual(defaults, await service.search(query, { mode: "literal", sort: "source", offset: 0 }));
  }
  assert.equal((await service.search("session session", { mode: "terms" })).matchCount, 2, "duplicates count entries, not occurrences");
  assert.equal((await service.search("修复session", { mode: "terms" })).matchCount, 0, "no implicit Chinese segmentation");
});

test("terms keeps assistant text blocks independent and respects the safe projection", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeTranscript(dir, "blocks.jsonl", [
    header("blocks"), user("u", null, "ordinary"),
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [
      { type: "text", text: "alpha" }, { type: "text", text: "beta" },
      { type: "thinking", thinking: "alpha beta hidden" },
      { type: "toolCall", name: "secret", arguments: { text: "alpha beta" } },
    ] } },
    toolResult("tool", "a", "beta alpha"),
  ]);
  const service = new SessionHistoryService(inventory(file));
  assert.equal((await service.search("alpha beta", { mode: "terms" })).matchCount, 0);
  assert.equal((await service.search("alpha\nbeta")).matchCount, 0);
  assert.equal((await service.search("alpha", { mode: "terms" })).matchCount, 1);
  const explicit = await service.search("alpha beta", { mode: "terms", include: ["tool_result"] });
  assert.deepEqual(explicit.matches.map((match) => match.entryId), ["tool"]);
});

test("normalized long snippets point into the original source, not normalized offsets", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefixes = [" \n".repeat(2500), "e\u0301".repeat(2500), "ﬃ".repeat(2500), "\u1100\u1161".repeat(2500), "\u3131\u314f".repeat(2500)];
  for (const [index, prefix] of prefixes.entries()) {
    const original = `${prefix}实际 ＮＥＥＤＬＥ cafe\u0301 ${"z".repeat(1500)}`;
    const file = writeTranscript(dir, `snippet-${index}.jsonl`, [header(`snippet-${index}`), user("u", null, original)]);
    const result = await new SessionHistoryService(inventory(file)).search("needle café", { mode: "terms" });
    const snippet = result.matches[0]!.snippet;
    assert.match(snippet, /实际 ＮＥＥＤＬＥ cafe\u0301/);
    assert.ok(snippet.length <= MAX_SESSION_HISTORY_SNIPPET_CHARS);
    assert.doesNotMatch(snippet, /needle café/);
  }
});

test("search pagination visits 27 matches once and preserves scan totals on every boundary", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeTranscript(dir, "pages.jsonl", [header("pages"),
    ...Array.from({ length: 27 }, (_, index) => user(`u${index}`, index ? `u${index - 1}` : null, `needle ${index}`)),
  ]);
  const service = new SessionHistoryService(inventory(file));
  for (const sort of ["source", "relevance"] as const) {
    const seen: string[] = [];
    let offset = 0;
    do {
      const page = await service.search("needle", { sort, offset, limit: 10 });
      assert.equal(page.matchCount, 27);
      seen.push(...page.matches.map((match) => match.entryId));
      assert.equal(page.hasMore, offset < 20);
      assert.equal(page.truncated, page.hasMore);
      assert.equal(page.nextOffset, offset < 20 ? offset + 10 : undefined);
      assert.equal(page.omissions.find((omission) => omission.reason === "result-limit")?.count, offset < 20 ? 27 - offset - 10 : undefined);
      offset = page.nextOffset ?? 27;
    } while (offset < 27);
    assert.deepEqual(seen, Array.from({ length: 27 }, (_, index) => `u${index}`));
    assert.equal(new Set(seen).size, 27);
  }
  for (const offset of [27, 28, Number.MAX_SAFE_INTEGER]) {
    const page = await service.search("needle", { offset });
    assert.deepEqual(page.matches, []);
    assert.equal(page.matchCount, 27);
    assert.equal(page.hasMore, false);
    assert.equal("nextOffset" in page, false);
    assert.equal(page.truncated, false);
  }
});

test("relevance ranks exact/phrase/tightest span with deterministic source ties", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const texts = ["beta xxxx alpha", "beta alpha", "before alpha beta after", "alpha beta", "beta alpha", "beta xxxxxxxxx alpha ... beta alpha"];
  const file = writeTranscript(dir, "ranked.jsonl", [header("ranked"), ...texts.map((text, index) => user(`u${index}`, index ? `u${index - 1}` : null, text))]);
  const service = new SessionHistoryService(inventory(file));
  assert.deepEqual((await service.search("alpha beta", { mode: "terms" })).matches.map((match) => match.entryId), texts.map((_, index) => `u${index}`));
  const ranked = await service.search("alpha beta", { mode: "terms", sort: "relevance" });
  assert.deepEqual(ranked.matches.map((match) => match.entryId), ["u3", "u2", "u1", "u4", "u5", "u0"]);
  assert.deepEqual(ranked, await service.search("alpha beta", { mode: "terms", sort: "relevance" }));
  assert.deepEqual((await service.search("alpha beta", { sort: "relevance" })).matches.map((match) => match.entryId), ["u3", "u2"]);
});

test("search validates options before scanning and non-search rejects search-only options", async () => {
  let scans = 0;
  const service = new SessionHistoryService(() => { scans += 1; return []; });
  for (const offset of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.search("needle", { offset }), /offset/);
  }
  for (const scanOffset of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.search("needle", { scanOffset }), /scanOffset/);
  }
  await assert.rejects(service.search("", { scanOffset: 0 }), /query/);
  await assert.rejects(service.search("needle", { scanOffset: 0, limit: 0 }), /limit/);
  await assert.rejects(service.search("needle", { scanOffset: 0, include: [] }), /include/);
  for (const query of [" ", "\n\t", "\u3000"]) {
    await assert.rejects(service.search(query, { mode: "terms" }), /non-whitespace/);
  }
  await assert.rejects(service.search("needle", { mode: "regex" as "literal" }), /mode/);
  await assert.rejects(service.search("needle", { sort: "date" as "source" }), /sort/);
  for (const extra of [{ offset: 0 }, { scanOffset: 0 }, { mode: "literal" }, { sort: "source" }]) {
    await assert.rejects(service.list({ limit: 1, ...extra }), /only for search/);
    await assert.rejects(service.compactions({ limit: 1, ...extra }), /only for search/);
    await assert.rejects(service.read({ sessionId: "session", ...extra }), /only for search/);
  }
  assert.equal(scans, 0);
});

test("last search page keeps file-limit truncation when the scan is incomplete", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = Array.from({ length: 101 }, (_, index) => writeTranscript(dir, `${index}.jsonl`, [header(`s${index}`), user("u", null, "needle")]));
  const result = await new SessionHistoryService(inventory(...files)).search("needle", { offset: 99, limit: 1 });
  assert.equal(result.filesRead, 100);
  assert.equal(result.matchCount, 100);
  assert.equal(result.hasMore, false);
  assert.equal(result.truncated, true);
  assert.equal("nextOffset" in result, false);
  assert.ok(result.omissions.some((omission) => omission.reason === "file-limit"));
  assert.ok(!result.omissions.some((omission) => omission.reason === "result-limit"));
});

test("scan pagination visits 201 unique candidates and match pagination stays within each window", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = Array.from({ length: 201 }, (_, index) => writeTranscript(dir, `${index}.jsonl`, [
    header(`s${index}`), user("u", null, index < 100 ? "ordinary text" : "needle"),
  ]));
  // Repeated inventory paths do not consume a scan position, even across the boundary.
  const entries = inventory(...files.flatMap((file) => [file, file]));
  const service = new SessionHistoryService(entries);
  const first = await service.search("needle");
  assert.deepEqual(first, await service.search("needle", { scanOffset: 0 }));
  assert.deepEqual(first.matches, []);
  assert.equal(first.matchCount, 0);
  assert.equal(first.hasMore, false);
  assert.equal(first.nextOffset, undefined);
  assert.deepEqual(first.scan, { offset: 0, hasMore: true, nextOffset: 100 });
  assert.equal(first.filesRead, 100);
  assert.equal(first.omissionCounts["file-limit"], 101);

  const seen: string[] = [];
  for (const scanOffset of [100, 200]) {
    let offset = 0;
    do {
      const page = await service.search("needle", { scanOffset, offset, limit: 20 });
      assert.equal(page.filesRead, scanOffset === 100 ? 100 : 1);
      assert.equal(page.matchCount, scanOffset === 100 ? 100 : 1);
      assert.equal(page.coverage, "partial", "a final nonzero scan offset is still partial corpus coverage");
      assert.equal(page.matchCountRelation, "lower_bound");
      assert.deepEqual(page.scan, scanOffset === 100
        ? { offset: 100, hasMore: true, nextOffset: 200 }
        : { offset: 200, hasMore: false });
      assert.equal(page.hasMore, scanOffset === 100 && offset < 80);
      assert.equal(page.truncated, page.scan.hasMore || page.hasMore);
      seen.push(...page.matches.map((match) => match.sessionId));
      offset = page.nextOffset ?? page.matchCount;
    } while (offset < (scanOffset === 100 ? 100 : 1));
  }
  assert.deepEqual(seen, files.slice(100).map((_, index) => `s${index + 100}`));
  assert.equal(new Set(seen).size, 101);
  assert.equal("path" in first.scan, false);
});

test("coverage distinguishes complete, partial, failed and genuinely empty inventories", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const valid = writeTranscript(dir, "valid.jsonl", [header("valid"), user("u", null, "needle")]);
  const invalid = writeTranscript(dir, "invalid.jsonl", [user("u", null, "needle")]);
  const missing = path.join(dir, "missing.jsonl");
  const cases = [
    { entries: [], coverage: "complete", matchCount: 0 },
    { entries: inventory(valid), coverage: "complete", matchCount: 1 },
    { entries: inventory(valid, valid), coverage: "complete", matchCount: 1 },
    { entries: inventory(valid, invalid, missing), coverage: "partial", matchCount: 1 },
    { entries: inventory(invalid, missing), coverage: "failed", matchCount: 0 },
    { entries: [{ path: "relative.jsonl" }], coverage: "partial", matchCount: 0 },
  ] as const;
  for (const { entries, coverage, matchCount } of cases) {
    const result = await new SessionHistoryService(entries).search("needle");
    assert.equal(result.coverage, coverage);
    assert.equal(result.matchCountRelation, coverage === "complete" ? "exact" : "lower_bound");
    assert.equal(result.matchCount, matchCount);
    assert.deepEqual(result.scan, { offset: 0, hasMore: false });
  }
  const failed = await new SessionHistoryService(() => { throw new Error("inventory unavailable"); }).search("needle");
  assert.equal(failed.coverage, "failed");
  assert.equal(failed.matchCountRelation, "lower_bound");
  assert.deepEqual(failed.omissionCounts, { "inventory-error": 1 });
  assert.equal(failed.omissionsTruncated, false);
  assert.equal(failed.filesRead, 0);

  const skipped = await new SessionHistoryService(inventory(valid)).search("needle", { scanOffset: 1 });
  assert.equal(skipped.coverage, "partial");
  assert.equal(skipped.matchCountRelation, "lower_bound");
  assert.deepEqual(skipped.scan, { offset: 1, hasMore: false });
  const huge = await new SessionHistoryService(inventory(valid)).search("needle", { scanOffset: Number.MAX_SAFE_INTEGER });
  assert.equal(huge.filesRead, 0);
  assert.deepEqual(huge.scan, { offset: Number.MAX_SAFE_INTEGER, hasMore: false });
});

test("omission totals survive the 64 sample cap, including file and result limits", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failures = Array.from({ length: 80 }, (_, index) => path.join(dir, `missing-${index}.jsonl`));
  const valid = Array.from({ length: 25 }, (_, index) => writeTranscript(dir, `${index}.jsonl`, [
    header(`s${index}`), user("u", null, "needle"),
  ]));
  const result = await new SessionHistoryService(inventory(...failures, ...valid)).search("needle", { limit: 1 });
  assert.equal(result.filesRead, 20);
  assert.equal(result.matchCount, 20);
  assert.equal(result.coverage, "partial");
  assert.equal(result.omissions.length, 64);
  assert.equal(result.omissionsTruncated, true);
  assert.deepEqual(result.omissionCounts, { missing: 80, "file-limit": 5, "result-limit": 19 });
  assert.deepEqual(result.scan, { offset: 0, hasMore: true, nextOffset: 100 });
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 1);
  assert.ok(!result.omissions.some((item) => item.reason === "result-limit"));
  assert.doesNotMatch(JSON.stringify(result.omissionCounts), /missing-\d|jsonl|path|fileName/);
  assert.ok(Object.isFrozen(result.omissionCounts));

  const list = await new SessionHistoryService(inventory(...failures, ...valid)).list({ limit: 1 });
  assert.deepEqual(list.omissionCounts, result.omissionCounts);
  assert.equal(list.omissionsTruncated, true);
  const exactCap = await new SessionHistoryService(inventory(...failures.slice(0, 64))).search("needle");
  assert.equal(exactCap.omissions.length, 64);
  assert.equal(exactCap.omissionsTruncated, false);
  assert.deepEqual(exactCap.omissionCounts, { missing: 64 });
});

test("inventory windows honor base offsets, unseen candidates and discovery completeness", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const one = writeTranscript(dir, "one.jsonl", [header("one"), user("u", null, "needle")]);
  const two = writeTranscript(dir, "two.jsonl", [header("two"), user("u", null, "needle")]);
  const missing = path.join(dir, "missing.jsonl");
  const entries = [
    { path: "invalid-relative.jsonl" }, ...inventory(one, one, missing, two),
  ];
  const service = new SessionHistoryService({ generation: 9, entries, offset: 100, hasMore: true });
  const result = await service.search("needle", { scanOffset: 101 });
  assert.equal(result.generation, 9);
  assert.deepEqual(result.matches.map((match) => match.sessionId), ["two"]);
  assert.equal(result.filesRead, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextOffset, undefined);
  assert.deepEqual(result.scan, { offset: 101, hasMore: true, nextOffset: 103 });
  assert.deepEqual(result.omissionCounts, { "invalid-inventory": 1, duplicate: 1, missing: 1 });
  assert.equal(result.coverage, "partial");
  assert.equal(result.truncated, true);

  for (const hasMore of [false, true]) {
    const incomplete = await new SessionHistoryService({ entries: [], complete: false, hasMore }).search("needle");
    assert.equal(incomplete.coverage, "partial");
    assert.equal(incomplete.matchCountRelation, "lower_bound");
    assert.equal(incomplete.truncated, true);
    assert.deepEqual(incomplete.scan, { offset: 0, hasMore });
    assert.equal(incomplete.scan.nextOffset, undefined, "no candidate progress must not invent a continuation");
  }
  const completeWindow = await new SessionHistoryService({ entries: inventory(two), offset: 102 }).search("needle", { scanOffset: 102 });
  assert.equal(completeWindow.coverage, "partial");
  assert.equal(completeWindow.truncated, false);
  assert.deepEqual(completeWindow.scan, { offset: 102, hasMore: false });
  const discoverMore = await new SessionHistoryService({ entries: inventory(one), hasMore: true }).search("needle");
  assert.deepEqual(discoverMore.scan, { offset: 0, hasMore: true, nextOffset: 1 });
  assert.equal(discoverMore.truncated, true);
  assert.equal(discoverMore.coverage, "partial");
});

test("invalid inventory window metadata fails closed without reading candidates", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeTranscript(dir, "one.jsonl", [header("one"), user("u", null, "needle")]);
  for (const metadata of [
    { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { hasMore: "true" }, { complete: 0 }, { offset: 1 },
  ]) {
    const service = new SessionHistoryService(() => ({ entries: inventory(file), ...metadata }) as never);
    const result = await service.search("needle");
    assert.equal(result.coverage, "failed");
    assert.equal(result.filesRead, 0);
    assert.deepEqual(result.omissionCounts, { "inventory-error": 1 });
    assert.deepEqual(result.scan, { offset: 0, hasMore: false });
  }
});
