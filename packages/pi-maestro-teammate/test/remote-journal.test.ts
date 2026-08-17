import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RemoteRunJournal } from "../src/remote/journal.ts";
import type { RemoteRunStartParams } from "../src/remote/protocol.ts";
import type { RemoteRunCapture, RemoteRunEvent } from "../src/remote/types.ts";

function request(commandId: string, runId: string): RemoteRunStartParams {
  return {
    commandId,
    targetId: "linux-a/pi",
    monitorOwnerNonce: "owner-a",
    name: runId,
    objective: "exercise journal recovery",
    cwd: "/srv/project",
    driver: "pi-rpc",
    command: ["/usr/bin/pi", "--mode", "rpc"],
  };
}

function createRun(journal: RemoteRunJournal, runId: string): RemoteRunCapture {
  const capture: RemoteRunCapture = {
    ...journal.identity,
    runId,
    generation: 1,
    monitorOwnerNonce: "owner-a",
    targetId: "linux-a/pi",
  };
  journal.createRun(capture, request(`start-${runId}`, runId));
  return capture;
}

function stateEvent(capture: RemoteRunCapture, sequence: number): RemoteRunEvent {
  return {
    type: "run/state",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence,
    status: "running",
    updatedAt: 100 + sequence,
  };
}

function runDirectory(root: string, runId: string): string {
  const runs = path.join(root, "runs");
  const directory = fs.readdirSync(runs).find((entry) => {
    const metadata = path.join(runs, entry, "metadata.json");
    if (!fs.existsSync(metadata)) return false;
    return JSON.parse(fs.readFileSync(metadata, "utf8")).capture?.runId === runId;
  });
  if (!directory) throw new Error(`Run directory not found for ${runId}`);
  return path.join(runs, directory);
}

function allFileText(directory: string): string {
  const parts: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) parts.push(allFileText(entryPath));
    else if (entry.isFile()) parts.push(fs.readFileSync(entryPath, "utf8"));
  }
  return parts.join("\n");
}

test("journal reconciles stale metadata from the durable event log before recovery append", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-stale-"));
  try {
    const first = new RemoteRunJournal(root);
    const capture = createRun(first, "stale-metadata");
    const initial = first.getRun(capture.runId)!;
    first.appendEvent(capture, stateEvent(capture, 1));

    const metadataPath = path.join(runDirectory(root, capture.runId), "metadata.json");
    fs.writeFileSync(metadataPath, `${JSON.stringify(initial)}\n`, "utf8");

    const recovered = new RemoteRunJournal(root);
    const record = recovered.getRun(capture.runId)!;
    assert.equal(record.snapshot.status, "lost");
    assert.equal(record.snapshot.lastSequence, 2);
    assert.deepEqual(recovered.readEvents(capture.runId).map((event) => event.sequence), [1, 2]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal truncates only an incomplete final JSONL record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-tail-"));
  try {
    const journal = new RemoteRunJournal(root);
    const capture = createRun(journal, "truncated-tail");
    journal.appendEvent(capture, stateEvent(capture, 1));
    const eventsPath = path.join(runDirectory(root, capture.runId), "events.jsonl");
    fs.appendFileSync(eventsPath, '{"type":"run/result"', "utf8");

    assert.deepEqual(journal.readEvents(capture.runId).map((event) => event.sequence), [1]);
    assert.equal(fs.readFileSync(eventsPath, "utf8").endsWith("\n"), true);
    assert.equal(fs.readFileSync(eventsPath, "utf8").includes('"run/result"'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal quarantines malformed runs without hiding valid runs or aborting startup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-corrupt-"));
  try {
    const first = new RemoteRunJournal(root);
    const corrupt = createRun(first, "corrupt-run");
    const valid = createRun(first, "valid-run");
    first.appendEvent(valid, {
      type: "run/result",
      workerId: valid.workerId,
      instanceNonce: valid.instanceNonce,
      runId: valid.runId,
      generation: valid.generation,
      sequence: 1,
      status: "completed",
      updatedAt: 200,
      result: "complete",
    });
    fs.writeFileSync(path.join(runDirectory(root, corrupt.runId), "events.jsonl"), "{malformed}\n", "utf8");
    fs.mkdirSync(path.join(root, "runs", "orphaned-run-directory"));

    const recovered = new RemoteRunJournal(root);
    assert.deepEqual(recovered.listRuns().map((record) => record.capture.runId), ["valid-run"]);
    assert.equal(fs.readdirSync(path.join(root, "corrupt-runs")).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal validates metadata and removes environment secret markers from persisted failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-secret-"));
  const name = "PI_REMOTE_TEST_SECRET_TOKEN";
  const marker = `marker-${Date.now()}-must-not-persist`;
  const previous = process.env[name];
  process.env[name] = marker;
  try {
    const journal = new RemoteRunJournal(root);
    const capture = createRun(journal, "secret-run");
    journal.appendEvent(capture, {
      type: "run/result",
      workerId: capture.workerId,
      instanceNonce: capture.instanceNonce,
      runId: capture.runId,
      generation: capture.generation,
      sequence: 1,
      status: "failed",
      updatedAt: 300,
      result: `failed with ${marker}`,
      error: `token=${marker}`,
      structuredOutput: { nested: marker },
    });
    const fingerprint = RemoteRunJournal.fingerprint("run/start", { marker: false });
    journal.beginCommand("secret-command", fingerprint);
    journal.completeCommand("secret-command", fingerprint, {
      ok: false,
      code: -32000,
      message: `authorization=${marker}`,
      data: { diagnostic: marker },
    });

    assert.equal(allFileText(root).includes(marker), false);

    const metadataPath = path.join(runDirectory(root, capture.runId), "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.snapshot.lastSequence = "invalid";
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    assert.equal(journal.getRun(capture.runId), undefined);
    assert.equal(fs.readdirSync(path.join(root, "corrupt-runs")).length, 1);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a version-1 remote state directory refuses to open and the error names both journal versions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-v1-worker-"));
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "worker.json"),
      JSON.stringify({ version: 1, workerId: "legacy-worker" }),
      "utf8",
    );

    assert.throws(
      () => new RemoteRunJournal(root),
      (error: unknown) => error instanceof Error
        && error.message.includes("version 1")
        && error.message.includes("version 2"),
    );
    // The identity file is read before anything else and its rejection escapes
    // the constructor, so the interrupted-run sweep never runs: an operator who
    // sees this error still has every byte of the old directory to move aside.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, "worker.json"), "utf8")),
      { version: 1, workerId: "legacy-worker" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a version-1 run record is quarantined instead of silently dropped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-v1-run-"));
  try {
    const first = new RemoteRunJournal(root);
    createRun(first, "legacy-run");
    const metadataPath = path.join(runDirectory(root, "legacy-run"), "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { version: number };
    metadata.version = 1;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");

    const second = new RemoteRunJournal(root);

    assert.equal(second.listRuns().some((record) => record.capture.runId === "legacy-run"), false);
    assert.equal(second.getRun("legacy-run"), undefined);
    // Moved aside rather than deleted: the refusal keeps its evidence.
    assert.equal(fs.readdirSync(path.join(root, "corrupt-runs")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a version-1 command record is refused and the error names both journal versions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-v1-command-"));
  try {
    const journal = new RemoteRunJournal(root);
    const fingerprint = RemoteRunJournal.fingerprint("run/start", { legacy: true });
    journal.beginCommand("legacy-command", fingerprint);
    const commandsDirectory = path.join(root, "commands");
    const commandFile = fs.readdirSync(commandsDirectory)[0]!;
    const commandPath = path.join(commandsDirectory, commandFile);
    const record = JSON.parse(fs.readFileSync(commandPath, "utf8")) as { version: number };
    record.version = 1;
    fs.writeFileSync(commandPath, JSON.stringify(record), "utf8");

    // getCommand is the only public route into parseCommandRecord, and it rethrows anything but ENOENT.
    assert.throws(
      () => journal.getCommand("legacy-command"),
      (error: unknown) => error instanceof Error
        && error.message.includes("version 1")
        && error.message.includes("version 2"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a quarantined run is reported to the observer instead of vanishing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-quarantine-observer-"));
  try {
    const first = new RemoteRunJournal(root);
    createRun(first, "observed-run");
    const directory = runDirectory(root, "observed-run");
    const metadataPath = path.join(directory, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { version: number };
    metadata.version = 1;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");

    const observed: { directory: string; error: unknown }[] = [];
    // The observer throws on purpose: quarantine runs on the recovery paths of getRun and listRuns, so a
    // failing observer must not turn recovery into a crash.
    const second = new RemoteRunJournal(root, {
      onQuarantine: (quarantinedDirectory, error) => {
        observed.push({ directory: quarantinedDirectory, error });
        throw new Error("observer failure");
      },
    });

    assert.deepEqual(second.listRuns(), []);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.directory, directory);
    assert.equal(observed[0]!.error instanceof Error, true);
    const quarantined = fs.readdirSync(path.join(root, "corrupt-runs"));
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]!.startsWith(path.basename(directory)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the version-1 refusal names the state directory and the corrupt runs remedy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-v1-remedy-"));
  try {
    fs.writeFileSync(
      path.join(root, "worker.json"),
      JSON.stringify({ version: 1, workerId: "legacy-worker" }),
      "utf8",
    );

    assert.throws(
      () => new RemoteRunJournal(root),
      (error: unknown) => error instanceof Error
        && error.message.includes(root)
        && error.message.includes("corrupt-runs"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
