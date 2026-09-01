import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { KnowledgeReviewView } from "../src/knowledge/cli-adapter.ts";
import type { LoadedPlanArtifactDocument } from "../src/tools/plan.ts";
import {
  defaultArtifactExportPath,
  executeArtifactCommand,
  orderArtifacts,
  planArtifactItem,
  writeArtifactMarkdownExclusive,
} from "../src/tools/session-artifact-command.ts";
import {
  artifactExportOwnershipDir,
  listArtifactExportOwnership,
  recordArtifactExportOwnership,
} from "../src/tools/session-artifact-export-store.ts";
import { lockSettingsResource } from "../src/settings/resource-lock.ts";
import {
  SessionArtifactOverlay,
  type SessionArtifactItem,
  type SessionArtifactOverlayAction,
} from "../src/tui/session-artifact-overlay.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function planDocuments(): LoadedPlanArtifactDocument[] {
  return [
    {
      entry: {
        id: "plan-current",
        kind: "current",
        revision: 3,
        checksum: "a".repeat(64),
        createdAt: "2026-08-28T10:00:00.000Z",
        path: "current.md",
      },
      markdown: "# Current Plan\n\n- ship artifacts",
    },
    {
      entry: {
        id: "plan-review:reviews/review.md",
        kind: "review",
        revision: 2,
        checksum: "b".repeat(64),
        createdAt: "2026-08-28T09:00:00.000Z",
        path: "reviews/review.md",
        role: "reviewer",
      },
      markdown: "# Review\n\nAdd copy/export acceptance checks.",
    },
  ];
}

function knowledgeReview(): KnowledgeReviewView {
  return {
    schema_version: "knowledge-review/1.0",
    session_id: "maestro-session-1",
    run_count: 1,
    ledger_count: 1,
    input_totals: { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
    unique_inputs: 0,
    candidates: [{
      candidate_id: "candidate-1",
      target: "knowhow",
      action: "propose",
      title: "Artifact export recipe",
      content: "# Recipe\n\nUse the session Artifact viewer.",
      category: "recipe",
      source_kind: "manual",
      occurrences: 1,
      first_recorded_at: "2026-08-28T11:00:00.000Z",
      last_recorded_at: "2026-08-28T11:00:00.000Z",
      status: "pending",
      run_ids: ["run-1"],
      stage: "observed",
      reconciliation: null,
      review: { freshness: "fresh", reconcile_commands: [], resolution_commands: [] },
    }],
  };
}

function commandContext(actions: Array<"copy" | "export" | "close">) {
  const notifications: Array<{ message: string; level: string }> = [];
  const renders: string[] = [];
  const ctx = {
    cwd: "D:/workspace",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
      async custom(factory: Function) {
        let result: SessionArtifactOverlayAction | undefined;
        const component = factory(
          { requestRender() {} },
          theme,
          {},
          (value: SessionArtifactOverlayAction) => { result = value; },
        );
        renders.push(component.render(100).join("\n"));
        const action = actions.shift() ?? "close";
        component.handleInput(action === "copy" ? "c" : action === "export" ? "e" : "\x1b");
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, renders };
}

test("Artifact overlay previews Markdown, switches narrow mode, and exposes copy/export actions", () => {
  const artifacts: SessionArtifactItem[] = [
    {
      id: "plan-current",
      source: "plan",
      title: "Current Plan · r3",
      detail: "current · revision 3",
      markdown: "# Plan\n\n- one\n- two",
    },
    {
      id: "knowledge:1",
      source: "knowledge",
      title: "Knowledge candidate",
      detail: "Knowledge knowhow · pending",
      markdown: "# Candidate\n\nBody\u001b[2J",
    },
  ];
  let action: SessionArtifactOverlayAction | undefined;
  const overlay = new SessionArtifactOverlay({
    sessionLabel: "Pi session-1",
    artifacts,
    theme,
    requestRender() {},
    done(value) { action = value; },
  });
  for (const width of [40, 80, 120]) {
    const lines = overlay.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }
  overlay.render(40);
  overlay.handleInput("\r");
  assert.match(overlay.render(40).join("\n"), /Plan/);
  overlay.handleInput("c");
  assert.deepEqual(action, { kind: "copy", selectedId: "plan-current" });
});

test("/artifact aggregates session Plan, Review, and staged Knowledge documents and copies Markdown", async () => {
  const harness = commandContext(["copy", "close"]);
  const copied: string[] = [];
  const loadedKnowledge: Array<[string, number]> = [];
  await executeArtifactCommand("", harness.ctx, {
    getKnowledgeSessionId: () => "maestro-session-1",
    loadPlanArtifacts: async () => planDocuments(),
    loadKnowledgeReview: async (_cwd, sessionId) => {
      assert.equal(sessionId, "maestro-session-1");
      return knowledgeReview();
    },
    copy: async (text) => { copied.push(text); },
    onKnowledgeLoaded: (sessionId, count) => { loadedKnowledge.push([sessionId, count]); },
  });

  assert.equal(copied[0], "# Current Plan\n\n- ship artifacts");
  assert.deepEqual(loadedKnowledge, [["maestro-session-1", 1]]);
  assert.match(harness.renders[0]!, /Current Plan/);
  assert.match(harness.renders[0]!, /Plan Review/);
  assert.match(harness.renders[0]!, /Artifact export recipe/);
  assert.match(harness.renders[0]!, /Pi pi-session-1 · Maestro maestro-session-1/);
  assert.ok(harness.notifications.some((notice) => /已复制 Artifact/.test(notice.message)));
});

test("/artifact exports the selected document as Markdown and preserves selection", async () => {
  const harness = commandContext(["export", "close"]);
  const writes: Array<{ markdown: string; path: string }> = [];
  await executeArtifactCommand("", harness.ctx, {
    loadPlanArtifacts: async () => planDocuments(),
    writeMarkdown: async (markdown, path) => { writes.push({ markdown, path }); },
    now: () => new Date("2026-08-28T12:34:56.000Z"),
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.markdown, "# Current Plan\n\n- ship artifacts");
  assert.match(writes[0]!.path.replaceAll("\\", "/"), /D:\/workspace\/artifact-20260828T123456Z-plan-current-plan-r3-[a-f0-9]{8}\.md$/i);
  assert.ok(harness.notifications.some((notice) => /已导出 Artifact/.test(notice.message)));
});

test("Artifact export never overwrites an existing predictable path", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-export-"));
  try {
    const preferred = join(root, "artifact.md");
    await writeFile(preferred, "existing", "utf8");
    const written = await writeArtifactMarkdownExclusive("new artifact", preferred);
    assert.notEqual(written, preferred);
    assert.equal(await readFile(preferred, "utf8"), "existing");
    assert.equal(await readFile(written, "utf8"), "new artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact ownership sidecar records full digests and rolls Markdown back on publication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-owner-"));
  try {
    const markdown = "# Managed\n\ncontent";
    const target = await writeArtifactMarkdownExclusive(markdown, join(root, "managed.md"));
    await recordArtifactExportOwnership({
      cwd: root,
      writtenPath: target,
      source: "plan",
      artifactId: "plan-current",
      markdown,
      createdAt: new Date("2026-08-28T12:34:56.000Z"),
    });
    const ownership = await listArtifactExportOwnership(root);
    assert.equal(ownership.length, 1);
    assert.equal(ownership[0]!.ownership?.artifactIdDigest.length, 64);
    assert.equal(ownership[0]!.ownership?.contentDigest.length, 64);
    assert.equal(ownership[0]!.ownership?.targetDigest.length, 64);
    assert.equal(ownership[0]!.protectionReason, undefined);
    if (process.platform !== "win32") {
      assert.equal((await stat(artifactExportOwnershipDir(root))).mode & 0o777, 0o700);
    }

    const rollbackRoot = await mkdtemp(join(tmpdir(), "artifact-owner-rollback-"));
    try {
      const rollbackTarget = await writeArtifactMarkdownExclusive("rollback", join(rollbackRoot, "rollback.md"));
      await writeFile(join(rollbackRoot, ".pi"), "occupied");
      await assert.rejects(() => recordArtifactExportOwnership({
        cwd: rollbackRoot,
        writtenPath: rollbackTarget,
        source: "review",
        artifactId: "review:1",
        markdown: "rollback",
        createdAt: new Date(),
      }));
      await assert.rejects(() => readFile(rollbackTarget));
    } finally {
      await rm(rollbackRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact ownership rollback never deletes a replacement pathname", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-owner-race-"));
  try {
    const markdown = "# Original";
    const target = await writeArtifactMarkdownExclusive(markdown, join(root, "race.md"));
    const input = {
      cwd: root,
      writtenPath: target,
      source: "plan",
      artifactId: "race-artifact",
      markdown,
      createdAt: new Date("2026-08-28T12:34:56.000Z"),
    };
    await recordArtifactExportOwnership(input);
    const store = artifactExportOwnershipDir(root);
    const release = await lockSettingsResource(join(store, ".artifact-export-store"));
    const pending = recordArtifactExportOwnership(input);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await unlink(target);
    await writeFile(target, "replacement", "utf8");
    await release();

    await assert.rejects(pending, /refused to delete a changed pathname/);
    assert.equal(await readFile(target, "utf8"), "replacement");
    assert.equal((await listArtifactExportOwnership(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact helpers pin current Plan and generate stable safe export paths", () => {
  const items = planDocuments().map(planArtifactItem);
  const ordered = orderArtifacts([
    { id: "knowledge:1", source: "knowledge", title: "Newest", detail: "", markdown: "", createdAt: "2026-08-28T12:00:00.000Z" },
    ...items,
  ]);
  assert.equal(ordered[0]!.id, "plan-current");
  assert.equal(ordered[1]!.id, "knowledge:1");
  const first = defaultArtifactExportPath("D:/workspace", ordered[0]!, new Date("2026-08-28T12:34:56.000Z"));
  const second = defaultArtifactExportPath("D:/workspace", ordered[0]!, new Date("2026-08-28T12:34:56.000Z"));
  assert.equal(first, second);
  assert.match(first.replaceAll("\\", "/"), /artifact-20260828T123456Z-plan-current-plan-r3-[a-f0-9]{8}\.md$/i);
});
