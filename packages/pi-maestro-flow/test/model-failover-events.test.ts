import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  appendModelFailoverSettlement,
  listModelFailoverEvents,
  MAX_MODEL_FAILOVER_EVENTS,
  MODEL_FAILOVER_EVENTS_FILE,
} from "../src/providers/model-failover-events.ts";

function tempHomeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mf-events-"));
}

const baseSettlement = {
  protocolVersion: 1,
  recoveryId: "recovery-1",
  outcome: "fallback-scheduled",
  model: "provider/a",
  fallbackModel: "provider/b",
  replayFence: { completedTools: [] as string[], blocked: false },
};

test("append then list round-trips settlement records in order", () => {
  const home = tempHomeDir();
  appendModelFailoverSettlement({ ...baseSettlement, recoveryId: "r1" }, { homeDir: home });
  appendModelFailoverSettlement(
    { ...baseSettlement, recoveryId: "r2", outcome: "success" },
    { homeDir: home, failureKind: "provider" },
  );

  const records = listModelFailoverEvents(home);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.recoveryId, "r1");
  assert.equal(records[1]!.recoveryId, "r2");
  assert.equal(records[1]!.failureKind, "provider");
  assert.equal(records[1]!.fallbackModel, "provider/b");
  assert.ok(records[1]!.at > 0);
  assert.ok(fs.existsSync(path.join(home, ".pi", "agent", MODEL_FAILOVER_EVENTS_FILE)));
});

test("stream is bounded at MAX_MODEL_FAILOVER_EVENTS, keeping the newest", () => {
  const home = tempHomeDir();
  for (let index = 0; index < MAX_MODEL_FAILOVER_EVENTS + 25; index += 1) {
    appendModelFailoverSettlement(
      { ...baseSettlement, recoveryId: `r${index}` },
      { homeDir: home },
    );
  }
  const records = listModelFailoverEvents(home, MAX_MODEL_FAILOVER_EVENTS + 1);
  assert.equal(records.length, MAX_MODEL_FAILOVER_EVENTS);
  assert.equal(records[0]!.recoveryId, "r25");
  assert.equal(records.at(-1)!.recoveryId, `r${MAX_MODEL_FAILOVER_EVENTS + 24}`);
});

test("limit and corrupt-line tolerance", () => {
  const home = tempHomeDir();
  appendModelFailoverSettlement({ ...baseSettlement, recoveryId: "r1" }, { homeDir: home });
  appendModelFailoverSettlement({ ...baseSettlement, recoveryId: "r2" }, { homeDir: home });
  appendModelFailoverSettlement({ ...baseSettlement, recoveryId: "r3" }, { homeDir: home });

  const filePath = path.join(home, ".pi", "agent", MODEL_FAILOVER_EVENTS_FILE);
  // Torn write: corrupt the middle line; the reader must skip it.
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  lines[1] = "{not-json";
  fs.writeFileSync(filePath, lines.join("\n"));

  assert.equal(listModelFailoverEvents(home, 2).length, 2);
  const all = listModelFailoverEvents(home, 100);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.recoveryId, "r1");
  assert.equal(all[1]!.recoveryId, "r3");
});

test("missing stream returns an empty list without throwing", () => {
  const home = tempHomeDir();
  assert.deepEqual(listModelFailoverEvents(home), []);
  assert.equal(fs.existsSync(path.join(home, ".pi", "agent", MODEL_FAILOVER_EVENTS_FILE)), false);
});
