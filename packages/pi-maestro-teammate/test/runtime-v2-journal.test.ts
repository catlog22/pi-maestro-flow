import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RUNTIME_V2_REVISION, RUNTIME_V2_VERSION, type ActorAddressV2, type RuntimeEventDraftV2 } from "../src/runtime-v2/contracts.ts";
import { RuntimeV2ShadowJournal } from "../src/runtime-v2/journal.ts";

const actor: ActorAddressV2 = {
  version: RUNTIME_V2_VERSION,
  revision: RUNTIME_V2_REVISION,
  workspaceId: "workspace-a",
  actorKind: "remote",
  actorId: "run-a",
  generation: 1,
};

function draft(streamId: string, occurredAt: number): RuntimeEventDraftV2 {
  return {
    version: 2,
    revision: 1,
    streamId,
    actor,
    occurredAt,
    kind: "tool.started",
    toolCallId: `tool-${occurredAt}`,
    toolName: "read",
  };
}

function onlyStreamDirectory(root: string): string {
  const streams = path.join(root, "streams");
  return path.join(streams, fs.readdirSync(streams)[0]!);
}

test("Runtime V2 journal lists workspace-scoped prefix streams in keyset pages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-list-"));
  try {
    const journal = new RuntimeV2ShadowJournal(root);
    journal.append(draft("flow-schedule/schedule/a", 10));
    journal.append(draft("flow-schedule/schedule/b", 20));
    journal.append({ ...draft("flow-schedule/schedule/c", 30), actor: { ...actor, workspaceId: "workspace-b" } });
    journal.append(draft("flow-schedule/dispatch/d", 40));
    const first = journal.listStreams({ workspaceId: "workspace-a", prefix: "flow-schedule/schedule/", limit: 1 });
    assert.deepEqual(first, ["flow-schedule/schedule/a"]);
    assert.deepEqual(journal.listStreams({
      workspaceId: "workspace-a",
      prefix: "flow-schedule/schedule/",
      afterStreamId: first[0],
      limit: 1,
    }), ["flow-schedule/schedule/b"]);
    assert.deepEqual(journal.listStreams({ workspaceId: "workspace-b", prefix: "flow-schedule/schedule/", limit: 10 }), [
      "flow-schedule/schedule/c",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime V2 journal binds a stream to its first workspace for append, list, and replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-owner-"));
  try {
    const journal = new RuntimeV2ShadowJournal(root);
    journal.append(draft("flow-schedule/schedule/shared", 10));
    assert.throws(
      () => journal.append({
        ...draft("flow-schedule/schedule/shared", 20),
        actor: { ...actor, workspaceId: "workspace-b" },
      }),
      /workspace owner mismatch/,
    );
    assert.deepEqual(journal.listStreams({
      workspaceId: "workspace-a",
      prefix: "flow-schedule/schedule/",
      limit: 10,
    }), ["flow-schedule/schedule/shared"]);
    assert.deepEqual(journal.listStreams({
      workspaceId: "workspace-b",
      prefix: "flow-schedule/schedule/",
      limit: 10,
    }), []);
    const replayed = journal.replay("flow-schedule/schedule/shared");
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]?.actor.workspaceId, "workspace-a");
    assert.equal(journal.read("flow-schedule/schedule/shared")?.metadata.workspaceId, "workspace-a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime V2 journal assigns per-stream sequence and replays after a cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-sequence-"));
  try {
    const journal = new RuntimeV2ShadowJournal(root);
    assert.equal(journal.append(draft("stream-a", 10)).sequence, 1);
    assert.equal(journal.append(draft("stream-a", 20)).sequence, 2);
    assert.deepEqual(journal.replay("stream-a", 1).map((event) => event.sequence), [2]);
    assert.equal(journal.read("stream-a")?.metadata.eventCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime V2 journal repairs only an incomplete final JSONL record and stale metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-tail-"));
  try {
    const journal = new RuntimeV2ShadowJournal(root);
    journal.append(draft("stream-a", 10));
    const directory = onlyStreamDirectory(root);
    const eventsPath = path.join(directory, "events.jsonl");
    const metadataPath = path.join(directory, "metadata.json");
    fs.appendFileSync(eventsPath, "{\"kind\":\"run.settled\"", "utf8");
    const stale = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    stale.lastSequence = 99;
    fs.writeFileSync(metadataPath, `${JSON.stringify(stale)}\n`, "utf8");

    const recovered = journal.read("stream-a");
    assert.deepEqual(recovered?.events.map((event) => event.sequence), [1]);
    assert.equal(recovered?.metadata.lastSequence, 1);
    assert.equal(fs.readFileSync(eventsPath, "utf8").endsWith("\n"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime V2 journal normalizes legacy V2 records only while reading", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-legacy-"));
  try {
    const journal = new RuntimeV2ShadowJournal(root);
    journal.append(draft("stream-a", 10));
    const eventsPath = path.join(onlyStreamDirectory(root), "events.jsonl");
    const legacy = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    legacy.version = "2";
    delete legacy.revision;
    legacy.actor.version = "2";
    delete legacy.actor.revision;
    legacy.kind = "tool_start";
    fs.writeFileSync(eventsPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const event = journal.read("stream-a")?.events[0];
    assert.equal(event?.kind, "tool.started");
    assert.equal(event?.revision, 1);
    assert.equal(journal.read("stream-a")?.metadata.workspaceId, "workspace-a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime V2 journal quarantines corruption and enforces stream bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-v2-corrupt-"));
  try {
    const quarantined: string[] = [];
    const journal = new RuntimeV2ShadowJournal(root, { maxEvents: 1, onQuarantine: (directory) => quarantined.push(directory) });
    journal.append(draft("stream-a", 10));
    assert.throws(() => journal.append(draft("stream-a", 20)), /limit exceeded/);
    fs.writeFileSync(path.join(onlyStreamDirectory(root), "events.jsonl"), "{malformed}\n", "utf8");
    assert.equal(journal.read("stream-a"), undefined);
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readdirSync(path.join(root, "corrupt-streams")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
