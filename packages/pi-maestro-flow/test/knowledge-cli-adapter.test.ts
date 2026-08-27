import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KnowledgeCliAdapter,
  resolveLatestSessionId,
} from "../src/knowledge/cli-adapter.ts";
import type { RunCliResult, RunCliRunner } from "../src/session/cli-adapter.ts";

test("knowledge stage assembles the full CLI argv", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "stage", "spec", "Decision: use the fence", "fence before mutation",
      "--session", "session-1",
      "--run", "run-9",
      "--action", "supersede",
      "--category", "arch",
      "--evidence", "run:run-9,artifact:a1",
      "--signal", "validated",
      "--signal-ids", "spec:project:rules-1,spec:project:rules-2",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return {
      exitCode: 0,
      argv: args,
      stdout: JSON.stringify({
        session_id: "session-1",
        run_id: "run-9",
        candidate_id: "KDC-0123456789abcdef",
        signal_recorded: 2,
      }),
      stderr: "",
    };
  }));

  const result = await adapter.stage({
    target: "spec",
    title: "Decision: use the fence",
    content: "fence before mutation",
    sessionId: "session-1",
    runId: "run-9",
    action: "supersede",
    category: "arch",
    evidence: ["run:run-9", "artifact:a1"],
    signal: "validated",
    signalIds: ["spec:project:rules-1", "spec:project:rules-2"],
  });

  assert.equal(result.candidate_id, "KDC-0123456789abcdef");
  assert.equal(result.signal_recorded, 2);
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, "run-9");
});

test("knowledge stage minimal invocation omits optional flags", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "stage", "knowhow", "Reusable recipe", "content text",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, {
      session_id: "s", run_id: "r", candidate_id: "KDC-aaaabbbbccccdddd", signal_recorded: 0,
    });
  }));

  const result = await adapter.stage({
    target: "knowhow",
    title: "Reusable recipe",
    content: "content text",
  });
  assert.equal(result.candidate_id, "KDC-aaaabbbbccccdddd");
  assert.equal(result.signal_recorded, 0);
});

test("knowledge stage validates option pairing", async () => {
  const adapter = new KnowledgeCliAdapter("/proj");
  await assert.rejects(
    adapter.stage({
      target: "spec", title: "t", content: "c", signal: "cited",
    }),
    /signal requires signalIds/,
  );
  await assert.rejects(
    adapter.stage({
      target: "spec", title: "t", content: "c", signalIds: ["spec:project:x"],
    }),
    /signalIds requires signal/,
  );
  await assert.rejects(
    adapter.stage({ target: "spec", title: " ", content: "c" }),
    /title must be non-empty/,
  );
});

test("knowledge stage allows session-only (session-source authority)", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "stage", "spec", "Decision: use the fence", "fence before mutation",
      "--session", "session-1",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, {
      session_id: "session-1", origin: "session", candidate_id: "KDC-0123456789abcdef", signal_recorded: 0,
    });
  }));

  const result = await adapter.stage({
    target: "spec",
    title: "Decision: use the fence",
    content: "fence before mutation",
    sessionId: "session-1",
  });

  assert.equal(result.candidate_id, "KDC-0123456789abcdef");
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, undefined);
  assert.equal(result.origin, "session");
});

test("knowledge stage surfaces CLI failures", async () => {
  const adapter = new KnowledgeCliAdapter(
    "/proj",
    fakeRunner((args) => ({
      exitCode: 1,
      argv: args,
      stdout: "",
      stderr: "Error: candidate content is required",
    })),
  );
  await assert.rejects(
    adapter.stage({ target: "spec", title: "t", content: "c" }),
    /failed \(1\): Error: candidate content is required/,
  );
});

test("knowledge record assembles the full CLI argv", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "record", "spec:S-1", "knowhow:K-1",
      "--signal", "consumed",
      "--source", "search",
      "--run", "run-9",
      "--session", "session-1",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, {
      session_id: "session-1", run_id: "run-9", recorded: 2,
    });
  }));

  const result = await adapter.recordInputs({
    knowledgeIds: ["spec:S-1", "knowhow:K-1"],
    signal: "consumed",
    source: "search",
    runId: "run-9",
    sessionId: "session-1",
  });
  assert.equal(result.recorded, 2);
  assert.equal(result.session_id, "session-1");
});

test("knowledge record defaults to consumed/search without explicit options", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "record", "spec:rules-7",
      "--signal", "consumed",
      "--source", "search",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, { session_id: "s", run_id: "r", recorded: 1 });
  }));

  const result = await adapter.recordInputs({ knowledgeIds: ["spec:rules-7"] });
  assert.equal(result.recorded, 1);
});

test("knowledge record passes evidence anchors", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "record", "spec:S-1",
      "--signal", "validated",
      "--source", "manual",
      "--evidence", "run:run-9,artifact:a1",
      "--run", "run-9",
      "--session", "session-1",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, { session_id: "session-1", run_id: "run-9", recorded: 1 });
  }));

  const result = await adapter.recordInputs({
    knowledgeIds: ["spec:S-1"],
    signal: "validated",
    source: "manual",
    evidence: ["run:run-9", "artifact:a1"],
    runId: "run-9",
    sessionId: "session-1",
  });
  assert.equal(result.recorded, 1);
});

test("knowledge record validates ids", async () => {
  const adapter = new KnowledgeCliAdapter("/proj");
  await assert.rejects(
    adapter.recordInputs({ knowledgeIds: [] }),
    /knowledgeIds must be non-empty/,
  );
  await assert.rejects(
    adapter.recordInputs({ knowledgeIds: ["  "] }),
    /knowledgeIds must be non-empty/,
  );
});

test("knowledge record allows session-only (session-source authority)", async () => {
  const adapter = new KnowledgeCliAdapter("/proj", fakeRunner((args) => {
    assert.deepEqual(args, [
      "knowledge", "record", "spec:S-1",
      "--signal", "consumed",
      "--source", "search",
      "--session", "session-1",
      "--json",
      "--workflow-root", "/proj",
    ]);
    return jsonResult(args, { session_id: "session-1", run_id: "", recorded: 1 });
  }));

  const result = await adapter.recordInputs({
    knowledgeIds: ["spec:S-1"],
    sessionId: "session-1",
  });
  assert.equal(result.recorded, 1);
  assert.equal(result.session_id, "session-1");
});

test("knowledge record surfaces CLI failures", async () => {
  const adapter = new KnowledgeCliAdapter(
    "/proj",
    fakeRunner((args) => ({
      exitCode: 1,
      argv: args,
      stdout: "",
      stderr: "Error: No unique active Run found",
    })),
  );
  await assert.rejects(
    adapter.recordInputs({ knowledgeIds: ["spec:S-1"] }),
    /failed \(1\): Error: No unique active Run found/,
  );
});

test("knowledge resolveMany prefers its batch signal and otherwise preserves each item signal", async () => {
  const itemController = new AbortController();
  const batchController = new AbortController();
  const received: Array<AbortSignal | undefined> = [];
  const runner: RunCliRunner = async (args, _cwd, options) => {
    received.push(options?.signal);
    return jsonResult([...args], { candidates: [] });
  };
  const adapter = new KnowledgeCliAdapter("/proj", runner);
  const item = {
    candidateId: "candidate-1",
    as: "unique" as const,
    reason: "reviewed",
    signal: itemController.signal,
  };

  assert.deepEqual(await adapter.resolveMany("session-1", [item]), { resolved: 1, failed: [] });
  assert.deepEqual(
    await adapter.resolveMany("session-1", [item], { signal: batchController.signal }),
    { resolved: 1, failed: [] },
  );
  assert.deepEqual(received, [itemController.signal, batchController.signal]);
});

test("knowledge resolveMany rethrows aborts instead of recording a per-item failure", async () => {
  let calls = 0;
  const runner: RunCliRunner = async () => {
    calls += 1;
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  };
  const adapter = new KnowledgeCliAdapter("/proj", runner);

  await assert.rejects(
    () => adapter.resolveMany("session-1", [
      { candidateId: "candidate-1", as: "unique", reason: "reviewed" },
      { candidateId: "candidate-2", as: "unique", reason: "reviewed" },
    ]),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("knowledge adapter forwards AbortSignal without changing existing domain options", async () => {
  const controller = new AbortController();
  const received: Array<AbortSignal | undefined> = [];
  const runner: RunCliRunner = async (args, _cwd, options) => {
    received.push(options?.signal);
    return jsonResult([...args], args[1] === "record"
      ? { session_id: "session-1", run_id: "run-1", recorded: 1 }
      : { schema_version: "knowledge-review/1.0", session_id: "session-1", candidates: [] });
  };
  const adapter = new KnowledgeCliAdapter("/proj", runner);

  await adapter.review("session-1", { refresh: true, signal: controller.signal });
  await adapter.recordInputs(
    { knowledgeIds: ["spec:S-1"], signal: "validated" },
    { signal: controller.signal },
  );

  assert.deepEqual(received, [controller.signal, controller.signal]);
});

type FakeRunner = (args: string[]) => Promise<RunCliResult>;

function fakeRunner(handler: (args: string[]) => RunCliResult): FakeRunner {
  return async (args) => handler(args);
}

function jsonResult(args: string[], value: unknown): RunCliResult {
  return { exitCode: 0, argv: args, stdout: JSON.stringify(value), stderr: "" };
}

test("latest knowledge session ignores newer legacy and invalid directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-knowledge-session-"));
  try {
    const sessionsDir = join(root, ".workflow", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeCanonicalSession(sessionsDir, "valid-older", new Date("2026-01-01T00:00:00Z"));
    await writeCanonicalSession(sessionsDir, "valid-latest", new Date("2026-02-01T00:00:00Z"));

    await mkdir(join(sessionsDir, "legacy-ui-craft-20260710-161213"));
    await mkdir(join(sessionsDir, "malformed"));
    await writeFile(join(sessionsDir, "malformed", "session.json"), "{not-json", "utf8");
    await mkdir(join(sessionsDir, "identity-mismatch"));
    await writeFile(
      join(sessionsDir, "identity-mismatch", "session.json"),
      JSON.stringify({ session_id: "different-id" }),
      "utf8",
    );

    assert.equal(resolveLatestSessionId(root), "valid-latest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest knowledge session returns null without a valid canonical session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-knowledge-session-empty-"));
  try {
    const sessionsDir = join(root, ".workflow", "sessions");
    await mkdir(join(sessionsDir, "legacy-only"), { recursive: true });
    await mkdir(join(sessionsDir, "mismatch"));
    await writeFile(join(sessionsDir, "mismatch", "session.json"), JSON.stringify({ session_id: "other" }), "utf8");

    assert.equal(resolveLatestSessionId(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeCanonicalSession(sessionsDir: string, id: string, mtime: Date): Promise<void> {
  const dir = join(sessionsDir, id);
  const sessionPath = join(dir, "session.json");
  await mkdir(dir);
  await writeFile(sessionPath, JSON.stringify({ session_id: id }), "utf8");
  await utimes(sessionPath, mtime, mtime);
}
