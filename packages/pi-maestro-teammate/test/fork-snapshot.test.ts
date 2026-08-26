import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
  createForkSnapshot,
  type ForkSnapshotDiagnosticCode,
  type ForkSnapshotResult,
} from "../src/runs/fork-snapshot.ts";

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEADER = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-09-01T00:00:00.000Z",
  cwd: "/work",
};

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fork-snapshot-test-"));
}

function entry(id: string, parentId: string | null, value: Entry): Entry {
  return {
    id,
    parentId,
    timestamp: `2026-09-01T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
    ...value,
  };
}

function user(id: string, parentId: string | null, text = id): Entry {
  return entry(id, parentId, { type: "message", message: { role: "user", content: text } });
}

function assistant(id: string, parentId: string | null, toolCallIds: string[]): Entry {
  return entry(id, parentId, {
    type: "message",
    message: {
      role: "assistant",
      content: toolCallIds.map((toolCallId) => ({
        type: "toolCall",
        id: toolCallId,
        name: "tool",
        arguments: {},
      })),
    },
  });
}

function result(id: string, parentId: string, toolCallId: string): Entry {
  return entry(id, parentId, {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
  });
}

function writeSession(directory: string, entries: Entry[]): string {
  const sourcePath = path.join(directory, "source.jsonl");
  fs.writeFileSync(sourcePath, `${[HEADER, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`);
  return sourcePath;
}

function readSnapshot(snapshotPath: string): Entry[] {
  return fs.readFileSync(snapshotPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Entry);
}

function expectFailure(resultValue: ForkSnapshotResult, code: ForkSnapshotDiagnosticCode): void {
  assert.equal(resultValue.ok, false);
  if (resultValue.ok) return;
  assert.equal(resultValue.diagnostic.kind, "fork-snapshot-invalid");
  assert.equal(resultValue.diagnostic.code, code);
}

test("excludes the spawning assistant message, sibling calls, and all descendants", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("user-1", null),
    assistant("spawn-message", "user-1", ["spawn-call", "sibling-call"]),
    result("sibling-result", "spawn-message", "sibling-call"),
    entry("later-custom", "sibling-result", { type: "custom", customType: "state", data: { value: 1 } }),
  ]);
  const destinationPath = path.join(directory, "snapshot.jsonl");

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "path", path: destinationPath },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.excludedMessageId, "spawn-message");
  assert.equal(snapshot.retainedEntryCount, 1);
  assert.equal(snapshot.retainedLeafId, "user-1");
  assert.deepEqual(readSnapshot(snapshot.snapshotPath).map((value) => value.type === "session" ? "session" : value.id), [
    "session",
    "user-1",
  ]);
  assert.doesNotMatch(fs.readFileSync(snapshot.snapshotPath, "utf8"), /sibling-call|sibling-result|later-custom/);
});

test("retains the complete ancestor chain including compaction and custom entries", () => {
  const directory = fixtureDir();
  const entries = [
    user("old-user", null),
    entry("custom-state", "old-user", { type: "custom", customType: "state", data: { count: 2 } }),
    entry("custom-context", "custom-state", {
      type: "custom_message",
      customType: "context",
      content: "kept context",
      display: false,
    }),
    entry("compact", "custom-context", {
      type: "compaction",
      summary: "summary",
      firstKeptEntryId: "custom-context",
      tokensBefore: 100,
      retainedTail: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "retained-call", name: "tool", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "retained-call",
          toolName: "tool",
          content: [{ type: "text", text: "retained result" }],
          isError: false,
        },
      ],
    }),
    user("new-user", "compact"),
    assistant("spawn", "new-user", ["spawn-call"]),
  ];
  const sourcePath = writeSession(directory, entries);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.ok(snapshot.temporaryDirectory?.startsWith(directory));
  assert.deepEqual(readSnapshot(snapshot.snapshotPath).slice(1).map((value) => value.id), [
    "old-user",
    "custom-state",
    "custom-context",
    "compact",
    "new-user",
  ]);
});

test("forked provider context excludes pre-compaction history and contains no stored system prompt", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("pre-compaction-secret", null, "must not be projected after compaction"),
    user("kept-tail", "pre-compaction-secret", "recent retained context"),
    entry("compact", "kept-tail", {
      type: "compaction",
      summary: "summary of earlier context",
      firstKeptEntryId: "kept-tail",
      tokensBefore: 80_000,
    }),
    user("post-compaction", "compact", "current 70k-era context"),
    assistant("spawn", "post-compaction", ["spawn-call"]),
  ]);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const storedEntries = readSnapshot(snapshot.snapshotPath);
  assert.equal(
    storedEntries.some((value) => {
      const message = isEntry(value.message) ? value.message : undefined;
      return value.type === "message"
        && message?.content === "must not be projected after compaction";
    }),
    true,
    "the snapshot keeps ancestry for a valid Pi session tree",
  );

  const providerMessages = buildSessionContext(
    storedEntries as unknown as Parameters<typeof buildSessionContext>[0],
  ).messages;
  const providerContext = JSON.stringify(providerMessages);
  assert.doesNotMatch(providerContext, /must not be projected after compaction/);
  assert.match(providerContext, /summary of earlier context/);
  assert.match(providerContext, /recent retained context/);
  assert.match(providerContext, /current 70k-era context/);
  assert.doesNotMatch(providerContext, /"role":"system"/);
});

test("chooses the latest matching assistant on the active branch", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("user-1", null),
    assistant("old-call", "user-1", ["same-id"]),
    result("old-result", "old-call", "same-id"),
    user("user-2", "old-result"),
    assistant("new-call", "user-2", ["same-id"]),
  ]);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "same-id",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.excludedMessageId, "new-call");
  assert.deepEqual(readSnapshot(snapshot.snapshotPath).slice(1).map((value) => value.id), [
    "user-1",
    "old-call",
    "old-result",
    "user-2",
  ]);
});

test("rejects a broken active parent chain without writing a snapshot", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [assistant("spawn", "missing-parent", ["spawn-call"])]);
  const destinationPath = path.join(directory, "snapshot.jsonl");
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "path", path: destinationPath },
  });
  expectFailure(snapshot, "broken-parent-chain");
  assert.equal(fs.existsSync(destinationPath), false);
});

test("rejects an unknown spawning toolCall id", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [user("user-1", null)]);
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "unknown",
    destination: { kind: "temp", directory },
  });
  expectFailure(snapshot, "spawning-tool-call-not-found");
});

test("rejects an unmatched retained toolCall", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("user-1", null),
    assistant("unfinished", "user-1", ["unfinished-call"]),
    user("user-2", "unfinished"),
    assistant("spawn", "user-2", ["spawn-call"]),
  ]);
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });
  expectFailure(snapshot, "unmatched-tool-call");
});

test("rejects duplicate retained tool results", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    assistant("completed", null, ["completed-call"]),
    result("result-1", "completed", "completed-call"),
    result("result-2", "result-1", "completed-call"),
    assistant("spawn", "result-2", ["spawn-call"]),
  ]);
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });
  expectFailure(snapshot, "duplicate-tool-result");
});

test("rejects retained tool results for unknown calls", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("root-user", null),
    result("unknown-result", "root-user", "unknown-call"),
    assistant("spawn", "unknown-result", ["spawn-call"]),
  ]);
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });
  expectFailure(snapshot, "unknown-tool-result");
});

test("accepts completed same-loop tool calls with one result each", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("user-1", null),
    assistant("same-loop", "user-1", ["call-a", "call-b"]),
    result("result-a", "same-loop", "call-a"),
    result("result-b", "result-a", "call-b"),
    user("user-2", "result-b"),
    assistant("spawn", "user-2", ["spawn-call"]),
  ]);
  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.deepEqual(readSnapshot(snapshot.snapshotPath).slice(1).map((value) => value.id), [
    "user-1",
    "same-loop",
    "result-a",
    "result-b",
    "user-2",
  ]);
});

// --- Fork compaction boundary injection tests ---

/**
 * Build a long alternating user/assistant chain of `count` pairs plus a final
 * spawning assistant. Each user message carries a distinct marker so we can
 * assert which entries survive in the projected provider context.
 */
function largeHistory(count: number): Entry[] {
  const entries: Entry[] = [];
  let parent: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const uid = `u${i}`;
    const aid = `a${i}`;
    entries.push(user(uid, parent, `user-message-${i}`));
    entries.push(assistant(aid, uid, []));
    parent = aid;
  }
  // Final user + spawning assistant (the spawn tool call forks from here).
  entries.push(user("final-user", parent, "final user message"));
  entries.push(assistant("spawn", "final-user", ["spawn-call"]));
  return entries;
}

test("injects a compaction boundary when retained history exceeds the threshold", () => {
  const directory = fixtureDir();
  // 60 pairs (120 entries) + final-user + spawn = 122 entries; retained (before
  // spawn) = 121, well above FORK_COMPACTION_THRESHOLD (50).
  const sourcePath = writeSession(directory, largeHistory(60));

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.injectedCompactionBoundary, true);

  const stored = readSnapshot(snapshot.snapshotPath).slice(1); // drop header
  const compactions = stored.filter((value) => value.type === "compaction");
  assert.equal(compactions.length, 1, "exactly one synthetic compaction boundary");
  const compaction = compactions[0]!;
  assert.ok(typeof compaction.id === "string" && compaction.id.length > 0);
  assert.ok(typeof compaction.parentId === "string" && compaction.parentId.length > 0);
  assert.ok(typeof compaction.firstKeptEntryId === "string" && compaction.firstKeptEntryId.length > 0);
  assert.equal(compaction.firstKeptEntryId, compaction.parentId, "firstKeptEntryId points at the entry immediately before the compaction");
  // The entry after the compaction must parent on the compaction (tree intact).
  const compactionIdx = stored.findIndex((value) => value.id === compaction.id);
  const afterCompaction = stored[compactionIdx + 1]!;
  assert.equal(afterCompaction.parentId, compaction.id, "entry after compaction parents on the compaction");

  // Projection: buildSessionContext must exclude the oldest entries and lead
  // with the compaction summary message.
  const providerMessages = buildSessionContext(
    [HEADER, ...stored] as unknown as Parameters<typeof buildSessionContext>[0],
  ).messages;
  const context = JSON.stringify(providerMessages);
  assert.match(context, /fork compaction boundary/, "compaction summary text is projected");
  assert.doesNotMatch(context, /user-message-0"/, "oldest retained user message is omitted from projection");
  assert.match(context, /final user message/, "recent retained context survives");
  // Quantified: projection is dramatically smaller than the full 122 entries.
  assert.ok(providerMessages.length < 30, `projected context shrank to ${providerMessages.length} messages`);
});

test("does not inject when retained history is at or below the threshold", () => {
  const directory = fixtureDir();
  // 20 pairs + final-user + spawn = 42 entries; retained = 41, below threshold.
  const sourcePath = writeSession(directory, largeHistory(20));

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.injectedCompactionBoundary, undefined, "small history does not trigger injection");
  const stored = readSnapshot(snapshot.snapshotPath).slice(1);
  assert.equal(stored.filter((value) => value.type === "compaction").length, 0, "no synthetic compaction in snapshot");
});

test("does not inject when the retained chain already ends with a compaction", () => {
  const directory = fixtureDir();
  // A long chain that already ends with a real compaction before the spawn.
  const entries = [
    ...largeHistory(60).slice(0, 120), // 120 entries (60 pairs), parent at a59
    entry("existing-compact", "a59", {
      type: "compaction",
      summary: "existing summary",
      firstKeptEntryId: "a59",
      tokensBefore: 1000,
    }),
    user("new-user", "existing-compact", "post-compaction user"),
    assistant("spawn", "new-user", ["spawn-call"]),
  ];
  const sourcePath = writeSession(directory, entries);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.injectedCompactionBoundary, undefined, "existing compaction bounds context; no new boundary injected");
});

test("injected boundary keeps tool-call/tool-result pairs intact in the retained suffix", () => {
  const directory = fixtureDir();
  // Build a long history whose tail contains a paired tool call+result.
  const entries = largeHistory(60);
  // Replace the final two entries with a tool-bearing assistant + result + new user + spawn.
  entries.splice(entries.length - 2, 2); // remove final-user + spawn
  const lastAssistant = entries.at(-1)!.id as string;
  entries.push(user("tool-user", lastAssistant, "trigger tool"));
  entries.push(assistant("tool-assistant", "tool-user", ["tail-call"]));
  entries.push(result("tail-result", "tool-assistant", "tail-call"));
  entries.push(user("final-user", "tail-result", "final user message"));
  entries.push(assistant("spawn", "final-user", ["spawn-call"]));
  const sourcePath = writeSession(directory, entries);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  // Injection either happens with a safe cut point or fail-opens; either way the
  // snapshot must be valid and the tool pair in the retained suffix must not be split.
  if (snapshot.injectedCompactionBoundary) {
    const stored = readSnapshot(snapshot.snapshotPath).slice(1);
    const providerMessages = buildSessionContext(
      [HEADER, ...stored] as unknown as Parameters<typeof buildSessionContext>[0],
    ).messages;
    const context = JSON.stringify(providerMessages);
    // If the toolCall survives in projection, its matching toolResult must also
    // survive (the boundary must not split a toolCall from its toolResult).
    if (context.includes('"toolCallId":"tail-call"')) {
      assert.ok(
        context.includes('"role":"toolResult"') && context.includes('tail-call'),
        "matching toolResult survives with its toolCall",
      );
    }
  }
});

test("fail-open: no injection when no safe cut point exists", () => {
  const directory = fixtureDir();
  // Build >50 retained entries with NO user message anywhere in the retained
  // chain: a root assistant seeds the tree, then only assistant+result pairs
  // follow (all paired), ending at the spawning assistant. Every candidate
  // cut point has entries[cut-1] as a non-user message, so isSafeProtocolBoundary
  // rejects all of them and injection fail-opens (no valid compaction boundary).
  const entries: Entry[] = [];
  entries.push(assistant("root-a", null, []));
  let parent = "root-a";
  for (let i = 0; i < 55; i += 1) {
    const aid = `a${i}`;
    entries.push(assistant(aid, parent, [`call-${i}`]));
    entries.push(result(`r${i}`, aid, `call-${i}`));
    parent = `r${i}`;
  }
  entries.push(assistant("spawn", parent, ["spawn-call"]));
  const sourcePath = writeSession(directory, entries);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true, "fail-open keeps the fork valid");
  if (!snapshot.ok) return;
  assert.equal(snapshot.injectedCompactionBoundary, undefined, "no user-boundary cut point means no injection");
});

test("injectedCompactionBoundary field is absent when not injected", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, [
    user("u1", null, "hi"),
    assistant("spawn", "u1", ["spawn-call"]),
  ]);

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "temp", directory },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.ok(!("injectedCompactionBoundary" in snapshot), "field absent on non-injected snapshots");
});

test("integration: SessionManager-loadable snapshot with injected boundary truncates provider context", () => {
  const directory = fixtureDir();
  const sourcePath = writeSession(directory, largeHistory(60));

  const snapshot = createForkSnapshot({
    sourcePath,
    spawningToolCallId: "spawn-call",
    destination: { kind: "path", path: path.join(directory, "child-session.jsonl") },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.injectedCompactionBoundary, true);
  // The snapshot file is itself a valid session that a child would load. Read it
  // back through buildSessionContext (the same path SessionManager uses) and
  // assert the oldest history is gone while the compaction summary leads.
  const childEntries = readSnapshot(snapshot.snapshotPath);
  const providerMessages = buildSessionContext(
    childEntries as unknown as Parameters<typeof buildSessionContext>[0],
  ).messages;
  const context = JSON.stringify(providerMessages);
  assert.match(context, /fork compaction boundary/);
  assert.doesNotMatch(context, /user-message-0"/);
  assert.match(context, /final user message/);
});
