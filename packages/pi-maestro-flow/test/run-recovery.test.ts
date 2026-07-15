import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  createMaestroCompaction,
  type MaestroCompactionDetails,
  type WorkflowRecoveryIdentity,
} from "../src/compaction/maestro-compaction.ts";
import { TodoSkillLoadError, TodoSkillLoader } from "../src/skills/skill-loader.ts";
import { SkillRuntime } from "../src/skills/skill-runtime.ts";

test("session-mode flows from skill frontmatter into compiled and activation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-session-mode-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, skillSource("run"));
  const skill = {
    name: "demo",
    description: "session mode test",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const resourceLoader = {
    async reload() {},
    getSkills: () => ({ skills: [skill], diagnostics: [] }),
  };
  const loader = new TodoSkillLoader({ cwd: root, agentDir: join(root, "agent"), resourceLoader });

  try {
    const loaded = await loader.load({ name: "demo" });
    assert.equal(loaded.sessionMode, "run");
    assert.equal(typeof loaded.compiledKey, "string");

    const activation = await new SkillRuntime(loader).activate([{ name: "demo", role: "primary" }]);
    assert.equal(activation.bindings[0]?.sessionMode, "run");
    assert.match(activation.stackRevision, /^[a-f0-9]{64}$/);

    await writeFile(skillPath, skillSource("invalid-mode"));
    await assert.rejects(
      loader.load({ name: "demo" }),
      (error: unknown) => error instanceof TodoSkillLoadError
        && error.code === "E_SKILL_FRONTMATTER_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint v2 preserves Workflow recovery identity across compactions", async () => {
  const workflow: WorkflowRecoveryIdentity = {
    sessionId: "workflow-session-1",
    runId: "run-003",
    todoId: "todo-003",
    stackRevision: "a".repeat(64),
    gates: { passed: 2, total: 3, failed: 1 },
    artifactRefs: ["artifact:plan", "artifact:review"],
    nextAction: "resolve GATE-003-02",
  };

  const first = await createMaestroCompaction(
    compactEvent([]),
    compactContext(),
    {
      checkpointId: () => "checkpoint-v2",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      getWorkflowIdentity: () => workflow,
      completeSummary: checkpointSummary,
    },
  );
  const firstDetails = first?.compaction?.details as MaestroCompactionDetails;
  assert.equal(firstDetails.schemaVersion, 2);
  assert.deepEqual(firstDetails.workflow, workflow);
  assert.notEqual(firstDetails.workflow?.artifactRefs, workflow.artifactRefs);

  const second = await createMaestroCompaction(
    compactEvent([{
      type: "compaction",
      id: "checkpoint-entry-v2",
      parentId: null,
      timestamp: "2026-07-15T00:00:01.000Z",
      summary: "previous checkpoint",
      firstKeptEntryId: "kept-1",
      tokensBefore: 100,
      details: firstDetails,
    }]),
    compactContext(),
    {
      checkpointId: () => "checkpoint-v2-next",
      now: () => new Date("2026-07-15T00:00:02.000Z"),
      completeSummary: checkpointSummary,
    },
  );
  const secondDetails = second?.compaction?.details as MaestroCompactionDetails;
  assert.deepEqual(secondDetails.workflow, workflow);
  assert.equal(secondDetails.previousCheckpointId, "checkpoint-v2");
});

function skillSource(sessionMode: string): string {
  return `---\nname: demo\ndescription: session mode test\nsession-mode: ${sessionMode}\n---\n# Demo`;
}

function compactEvent(branchEntries: unknown[]): Parameters<typeof createMaestroCompaction>[0] {
  return {
    preparation: {
      firstKeptEntryId: "kept-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
    },
    branchEntries,
    signal: new AbortController().signal,
    type: "session_before_compact",
  } as unknown as Parameters<typeof createMaestroCompaction>[0];
}

function compactContext(): Parameters<typeof createMaestroCompaction>[1] {
  return {
    cwd: "D:\\repo",
    model: { id: "faux", maxTokens: 2000 },
    sessionManager: { getSessionId: () => "host-session-1" },
  } as unknown as Parameters<typeof createMaestroCompaction>[1];
}

async function checkpointSummary() {
  return {
    stopReason: "stop",
    content: [{ type: "text", text: "## Session\n- Current Objective: recover safely" }],
  };
}
