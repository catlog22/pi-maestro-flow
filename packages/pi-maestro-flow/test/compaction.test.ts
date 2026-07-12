import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMaestroCompactionPrompt,
  createMaestroCompaction,
  mergeCompactionReferences,
  persistMaestroCompactionKnowhow,
  type MaestroCompactionDetails,
} from "../src/compaction/maestro-compaction.ts";
import {
  initTodo,
  onSessionShutdown,
  onSessionStart,
} from "../src/tools/todo.ts";

function details(): MaestroCompactionDetails {
  return {
    kind: "maestro-session-checkpoint",
    schemaVersion: 1,
    checkpointId: "checkpoint-2",
    previousCheckpointId: "checkpoint-1",
    sessionId: "session-1",
    projectRoot: "D:\\repo",
    createdAt: "2026-07-12T02:30:00.000Z",
    todo: {
      stateVersion: 2,
      revision: 3,
      activeTaskId: "todo-1",
      tasks: [{
        id: "todo-1",
        subject: "Implement compaction",
        status: "in_progress",
        blockedBy: [],
        skill: { name: "maestro-execute", args: "--continue" },
        createdAt: 1,
        updatedAt: 2,
      }],
    },
    activeSkills: [{
      name: "maestro-execute",
      args: "--continue",
      filePath: "C:\\skills\\maestro-execute\\SKILL.md",
      requiredFiles: [],
      deferredFiles: ["D:\\repo\\plan.md"],
      loadedAt: "2026-07-12T02:20:00.000Z",
      todoId: "todo-1",
    }],
    references: [{
      path: "D:\\repo\\plan.md",
      role: "read",
      status: "active",
      firstSeenCompaction: "checkpoint-1",
      lastConfirmedCompaction: "checkpoint-2",
    }],
    knowhowPath: "D:\\repo\\.workflow\\knowhow\\KNW-previous.md",
  };
}

test("compaction prompt carries previous summary, Todo, skill, and lineage state", () => {
  const prompt = buildMaestroCompactionPrompt({
    conversationText: "USER: continue",
    previousSummary: "previous checkpoint",
    runtimeState: details(),
    customInstructions: "Preserve test evidence",
  });

  assert.match(prompt, /<previous-summary>\nprevious checkpoint/);
  assert.match(prompt, /"activeTaskId": "todo-1"/);
  assert.match(prompt, /"name": "maestro-execute"/);
  assert.match(prompt, /D:\\\\repo\\\\plan\.md/);
  assert.match(prompt, /## Compaction Lineage/);
  assert.match(prompt, /Additional focus:\nPreserve test evidence/);
});

test("reference merge preserves inherited lineage and upgrades modified files", () => {
  const merged = mergeCompactionReferences(
    details().references,
    [
      { path: "d:\\repo\\plan.md", role: "modified" },
      { path: "D:\\repo\\notes.md", role: "read" },
    ],
    "checkpoint-3",
  );

  assert.equal(merged.length, 2);
  const plan = merged.find((reference) => reference.path.toLowerCase().endsWith("plan.md"));
  assert.equal(plan?.role, "modified");
  assert.equal(plan?.firstSeenCompaction, "checkpoint-1");
  assert.equal(plan?.lastConfirmedCompaction, "checkpoint-3");
});

test("custom compaction captures the persisted active Todo skill", async () => {
  const entries = [{
    type: "custom",
    customType: "todo-state",
    data: {
      version: 2,
      tasks: {
        active: {
          id: "active",
          subject: "Resume with skill",
          status: "in_progress",
          blockedBy: [],
          skill: { name: "maestro-execute", args: "--continue" },
          skillLoad: {
            loadedAt: "2026-07-12T02:20:00.000Z",
            filePath: "C:\\skills\\maestro-execute\\SKILL.md",
            requiredFiles: [],
            deferredFiles: ["D:\\repo\\plan.md"],
            totalBytes: 100,
          },
          createdAt: 1,
          updatedAt: 2,
        },
      },
    },
  }];
  initTodo({ appendEntry() {} } as never);
  const todoContext = {
    cwd: "D:\\repo",
    ui: { setStatus() {} },
    sessionManager: { getEntries: () => entries },
  };
  onSessionStart(todoContext);

  try {
    const result = await createMaestroCompaction(
      {
        preparation: {
          firstKeptEntryId: "kept-1",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 1000,
          fileOps: {
            read: new Set(["D:\\repo\\plan.md"]),
            written: new Set<string>(),
            edited: new Set<string>(),
          },
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
        },
        branchEntries: [{
          type: "compaction",
          id: "previous-entry",
          parentId: "parent-entry",
          timestamp: "2026-07-12T02:00:00.000Z",
          summary: "previous summary",
          firstKeptEntryId: "previous-kept",
          tokensBefore: 900,
          details: details(),
        }],
        signal: new AbortController().signal,
        type: "session_before_compact",
      } as never,
      {
        cwd: "D:\\repo",
        model: { id: "faux", maxTokens: 2000 },
        sessionManager: { getSessionId: () => "session-1" },
      } as never,
      {
        checkpointId: () => "checkpoint-active",
        now: () => new Date("2026-07-12T02:30:00.000Z"),
        completeSummary: async () => ({
          stopReason: "stop",
          content: [{ type: "text", text: "## Session\n- Current Objective: Resume with skill" }],
        }),
      },
    );
    const captured = result?.compaction?.details as MaestroCompactionDetails;
    assert.equal(captured.todo.activeTaskId, "active");
    assert.equal(captured.activeSkills[0]?.name, "maestro-execute");
    assert.equal(captured.activeSkills[0]?.deferredFiles[0], "D:\\repo\\plan.md");
    assert.equal(captured.previousCheckpointId, "checkpoint-2");
    const previousKnowhow = captured.references.find((reference) => reference.path.endsWith("KNW-previous.md"));
    assert.equal(previousKnowhow?.firstSeenCompaction, "checkpoint-active");
    assert.match(captured.knowhowPath, /session-compact-session-1-checkpoint-activ\.md$/);
  } finally {
    onSessionShutdown(todoContext);
  }
});

test("successful Maestro compaction is copied to a unique knowhow document", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-maestro-compact-"));
  const checkpoint = details();
  checkpoint.projectRoot = root;
  checkpoint.knowhowPath = join(root, ".workflow", "knowhow", "KNW-checkpoint.md");
  const event = {
    compactionEntry: {
      type: "compaction",
      id: "entry-1",
      parentId: "parent-1",
      timestamp: checkpoint.createdAt,
      summary: "## Session\n- Current Objective: Verify checkpoint copy",
      firstKeptEntryId: "kept-1",
      tokensBefore: 12345,
      details: checkpoint,
      fromHook: true,
    },
    fromExtension: true,
  } as never;
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => checkpoint.sessionId },
  } as never;

  try {
    const outputPath = await persistMaestroCompactionKnowhow(event, ctx);
    assert.ok(outputPath);
    const content = await readFile(outputPath!, "utf8");
    assert.match(content, /type: session/);
    assert.match(content, /status: active/);
    assert.match(content, /Verify checkpoint copy/);
    assert.match(content, /D:\\repo\\plan\.md/);
    assert.equal(checkpoint.knowhowPath, outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
