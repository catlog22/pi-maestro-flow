import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createCompactHistoryInventoryProvider,
  createSessionHistoryInventoryProvider,
  createSessionHistoryTool,
  executeSessionHistory,
} from "../src/tools/session-history.ts";
import { createResourceTool, resolveResource } from "../src/tools/resource.ts";
import { COMMAND_HISTORY_BOOTSTRAP } from "../src/compaction/recovery-focus.ts";
import {
  MAX_SESSION_HISTORY_FILES,
  sessionEntryUri,
} from "pi-maestro-teammate/v1/session-history";

function header(id: string): unknown {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-01T00:00:00.000Z",
    cwd: "/workspace",
  };
}

function user(id: string, parentId: string | null, content: string): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

function assistant(id: string, parentId: string, text: string): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "must stay hidden" },
        { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "secret-path" } },
        { type: "text", text },
      ],
      model: "provider/model",
      timestamp: 2,
    },
  };
}

function hidden(id: string, parentId: string): unknown {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:03.000Z",
    customType: "internal",
    content: "do not expose",
    display: false,
  };
}

function compaction(id: string, parentId: string, summary: string): unknown {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:04.000Z",
    summary,
    firstKeptEntryId: parentId,
    tokensBefore: 1_000,
  };
}

function writeTranscript(file: string, entries: unknown[]): Promise<void> {
  return writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function context(cwd: string, sessionFile: string, sessionId = "current-session"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

test("session_history prefers history reads without banning local JSON/JSONL files", () => {
  const tool = createSessionHistoryTool();
  assert.match(tool.description, /Prefer this tool/);
  assert.match(tool.description, /Use read for local JSON\/JSONL source files when requested/);
  assert.match(tool.description, /unavailable, over-budget, or incomplete/);
  assert.match(tool.promptSnippet ?? "", /use read for local files/);
  assert.doesNotMatch((tool.promptGuidelines ?? []).join("\n"), /never infer or provide a transcript filesystem path/);
});

test("session_history prioritizes current and recent workspace sessions beyond the scan cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-"));
  try {
    const sessions = join(root, "sessions");
    const currentFile = join(sessions, "000-current-session.jsonl");
    const recentFile = join(sessions, "2026-09-01T09-17-32-193Z_recent-session.jsonl");
    const archivedFile = join(sessions, "2026-01-01T00-00-00-000Z_archived-session.jsonl");
    await mkdir(sessions, { recursive: true });
    await Promise.all(Array.from({ length: MAX_SESSION_HISTORY_FILES }, (_, index) => writeTranscript(
      join(sessions, `2026-08-31T00-00-00-000Z_archive-${String(index).padStart(3, "0")}.jsonl`),
      [header(`archive-${index}`), user(`archive-user-${index}`, null, "unrelated history")],
    )));
    await writeTranscript(currentFile, [header("current-session"), user("u1", null, "current task")]);
    await writeTranscript(recentFile, [
      header("recent-session"),
      user("recent-u", null, "recent fallback needle"),
      assistant("recent-a", "recent-u", "prior approach"),
    ]);
    await writeTranscript(archivedFile, [
      header("archived-session"),
      user("archived-u", null, "archived evidence"),
    ]);

    const ctx = context(root, currentFile);
    const tool = createSessionHistoryTool();
    const call = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;

    const listed = await call("list", {
      action: "list_sessions",
      scope: "workspace_sessions",
      limit: 1,
    }, new AbortController().signal, undefined, ctx);
    assert.deepEqual(
      (JSON.parse(resultText(listed)) as { sessions: Array<{ sessionId: string }> }).sessions.map((session) => session.sessionId),
      ["current-session"],
    );

    const search = await call("search", {
      action: "search",
      scope: "workspace_sessions",
      query: "FALLBACK NEEDLE",
    }, new AbortController().signal, undefined, ctx);
    const searchPayload = JSON.parse(resultText(search)) as {
      matches: Array<{ sessionId: string; entryId: string; resourceUri: string }>;
      filesRead: number;
      truncated: boolean;
    };
    assert.deepEqual(searchPayload.matches.map((match) => match.sessionId), ["recent-session"]);
    assert.equal(searchPayload.filesRead, MAX_SESSION_HISTORY_FILES);
    assert.equal(searchPayload.truncated, true);

    const readTurn = await call("read-turn", {
      action: "read_turn",
      scope: "workspace_sessions",
      sessionId: "recent-session",
      turn: 1,
    }, new AbortController().signal, undefined, ctx);
    assert.equal((JSON.parse(resultText(readTurn)) as { found: boolean }).found, true);

    const archivedTurn = await call("read-archived-turn", {
      action: "read_turn",
      scope: "workspace_sessions",
      sessionId: "archived-session",
      turn: 1,
    }, new AbortController().signal, undefined, ctx);
    assert.equal((JSON.parse(resultText(archivedTurn)) as { found: boolean }).found, true);

    const resource = await resolveResource(
      searchPayload.matches[0]!.resourceUri,
      root,
      undefined,
      { sessionHistory: createSessionHistoryInventoryProvider(ctx, "all") },
    );
    assert.match(resource.content, /recent fallback needle/);
    assert.doesNotMatch(resource.content, /recent-session\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current-session search includes only associated teammates by default and supports opting out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-associated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  const teammateDirectory = join(root, "current", "worker");
  const unrelatedDirectory = join(root, "other", "worker");
  await mkdir(teammateDirectory, { recursive: true });
  await mkdir(unrelatedDirectory, { recursive: true });
  await writeTranscript(current, [header("current-session"), user("root-u", null, "needle alpha beta")]);
  await writeTranscript(join(teammateDirectory, "child.jsonl"), [
    header("child-session"),
    user("child-u", null, "needle beta alpha"),
    assistant("child-a", "child-u", "child-only evidence"),
    hidden("child-hidden", "child-a"),
  ]);
  await writeTranscript(join(root, "other.jsonl"), [header("other-session"), user("other-u", null, "needle unrelated workspace")]);
  await writeTranscript(join(unrelatedDirectory, "child.jsonl"), [header("other-child"), user("other-child-u", null, "needle unrelated teammate")]);
  const ctx = context(root, current);
  const request = { action: "search", query: "needle" };
  const combined = JSON.parse(resultText(await executeSessionHistory(request, ctx)));
  assert.deepEqual(combined.matches.map((match: { sessionId: string; source: string; parentSessionId?: string }) =>
    [match.sessionId, match.source, match.parentSessionId]), [
    ["current-session", "current_session", undefined],
    ["child-session", "teammates", "current-session"],
  ]);
  assert.equal(combined.filesRead, 2);
  assert.equal(combined.coverage, "complete");
  assert.equal(resultText(await executeSessionHistory(request, ctx)).includes(root), false);
  const explicit = JSON.parse(resultText(await executeSessionHistory({ ...request, scope: "current_session", includeTeammates: true }, ctx)));
  assert.deepEqual(explicit, combined);
  const isolated = JSON.parse(resultText(await executeSessionHistory({ ...request, includeTeammates: false }, ctx)));
  assert.deepEqual(isolated.matches.map((match: { sessionId: string }) => match.sessionId), ["current-session"]);
  assert.equal(isolated.filesRead, 1);
  assert.equal("source" in isolated.matches[0], false);
  const terms = JSON.parse(resultText(await executeSessionHistory({ action: "search", query: "alpha beta", mode: "terms", sort: "relevance", offset: 1, limit: 1 }, ctx)));
  assert.equal(terms.matchCount, 2);
  assert.equal(terms.matches[0].sessionId, "child-session");
  const childOnly = JSON.parse(resultText(await executeSessionHistory({ action: "search", query: "child-only evidence" }, ctx)));
  assert.equal(childOnly.matches[0].source, "teammates");
  const resource = await resolveResource(childOnly.matches[0].resourceUri, root, undefined, {
    sessionHistory: createSessionHistoryInventoryProvider(ctx, "all"),
  });
  assert.match(resource.content, /child-only evidence/);
  assert.doesNotMatch(resource.content, /must stay hidden|do not expose|secret-path/);
  const childTurn = JSON.parse(resultText(await executeSessionHistory({ action: "read_turn", scope: "teammates", sessionId: "child-session", turn: 1 }, ctx)));
  assert.equal(childTurn.found, true);
  const rootOnlyRead = JSON.parse(resultText(await executeSessionHistory({ action: "read_turn", sessionId: "child-session", turn: 1 }, ctx)));
  assert.equal(rootOnlyRead.found, false);
  const workspace = JSON.parse(resultText(await executeSessionHistory({ ...request, scope: "workspace_sessions" }, ctx)));
  assert.deepEqual(workspace.matches.map((match: { sessionId: string }) => match.sessionId), ["current-session", "other-session"]);
  const teammateOnly = JSON.parse(resultText(await executeSessionHistory({ ...request, scope: "teammates" }, ctx)));
  assert.deepEqual(teammateOnly.matches.map((match: { sessionId: string }) => match.sessionId), ["child-session"]);
  const noHostId = { cwd: root, sessionManager: { getSessionFile: () => current } } as unknown as ExtensionContext;
  const inferred = JSON.parse(resultText(await executeSessionHistory(request, noHostId)));
  assert.deepEqual(inferred.matches, combined.matches);
});

test("exact teammate resources remain readable when workspace sessions fill the scan budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-resource-teammate-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "000-current.jsonl");
  await writeTranscript(current, [header("current-session"), user("root-u", null, "current request")]);
  await Promise.all(Array.from({ length: MAX_SESSION_HISTORY_FILES }, (_, index) => writeTranscript(
    join(root, `2026-10-01_archive-${index}.jsonl`),
    [header(`archive-${index}`), user(`archive-u-${index}`, null, "unrelated workspace")],
  )));
  const childId = "late-child-session";
  const childDirectory = join(root, "000-current", "worker");
  await mkdir(childDirectory, { recursive: true });
  await writeTranscript(join(childDirectory, `2026-10-12_${childId}.jsonl`), [
    header(childId), user("child-u", null, "child request"),
    assistant("child-a", "child-u", "late-child-evidence answer"),
    { type: "message", id: "child-r", parentId: "child-a", timestamp: "2026-08-01T00:00:03.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "late-child-evidence result" }] } },
    hidden("child-hidden", "child-r"),
  ]);
  const ctx = context(root, current);
  const found = JSON.parse(resultText(await executeSessionHistory({
    action: "search", query: "late-child-evidence", include: ["assistant", "tool_result"],
  }, ctx)));
  assert.deepEqual(found.matches.map((match: { entryId: string }) => match.entryId), ["child-a", "child-r"]);
  const resource = createResourceTool();
  for (const match of found.matches) {
    const read = await resource.execute("exact-child", { uri: match.resourceUri, offset: 1, limit: 10 }, new AbortController().signal, undefined, ctx);
    assert.match(resultText(read), /late-child-evidence/);
    assert.doesNotMatch(resultText(read), /must stay hidden|secret-path|do not expose|unrelated workspace/);
  }
  await assert.rejects(() => resource.execute("hidden-child", {
    uri: sessionEntryUri(childId, "child-hidden"),
  }, new AbortController().signal, undefined, ctx), /not found or not visible/);
});

test("exact teammate turn reads prioritize the discovered session across worker directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-teammate-exact-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  await writeTranscript(current, [header("current-session"), user("root-u", null, "request")]);
  const earlier = join(root, "current", "a-worker");
  const later = join(root, "current", "z-worker");
  await mkdir(earlier, { recursive: true });
  await mkdir(later, { recursive: true });
  await Promise.all(Array.from({ length: MAX_SESSION_HISTORY_FILES }, (_, index) => writeTranscript(
    join(earlier, `archive-${index}.jsonl`),
    [header(`archive-${index}`), user(`archive-u-${index}`, null, "unrelated teammate")],
  )));
  const childId = "requested-child";
  await writeTranscript(join(later, `2026-10-12_${childId}.jsonl`), [
    header(childId), user("child-u", null, "late requested evidence"),
    assistant("child-a", "child-u", "verified child answer"), hidden("child-hidden", "child-a"),
  ]);
  const ctx = context(root, current);
  const found = JSON.parse(resultText(await executeSessionHistory({
    action: "search", scope: "teammates", query: "late requested evidence", scanOffset: MAX_SESSION_HISTORY_FILES,
  }, ctx)));
  assert.equal(found.matches[0].sessionId, childId);
  const read = JSON.parse(resultText(await executeSessionHistory({
    action: "read_turn", scope: "teammates", sessionId: childId, turn: found.matches[0].turn,
  }, ctx)));
  assert.equal(read.found, true);
  assert.equal(read.filesRead, MAX_SESSION_HISTORY_FILES);
  assert.deepEqual(read.turn.entries.map((entry: { entryId: string }) => entry.entryId), ["child-u", "child-a"]);
  assert.doesNotMatch(JSON.stringify(read), /must stay hidden|secret-path|do not expose/);
  const resource = await createResourceTool().execute("late-child", {
    uri: found.matches[0].resourceUri,
  }, new AbortController().signal, undefined, ctx);
  assert.match(resultText(resource), /late requested evidence/);
});

test("custom inventories retain authorization without inventing teammate provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-custom-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  const other = join(root, "other.jsonl");
  const childDirectory = join(root, "current", "worker");
  await mkdir(childDirectory, { recursive: true });
  await writeTranscript(current, [header("current-session"), user("root-u", null, "needle")]);
  await writeTranscript(other, [header("other-session"), user("other-u", null, "needle")]);
  await writeTranscript(join(childDirectory, "child.jsonl"), [header("child-session"), user("child-u", null, "needle")]);
  const inventory = [{ path: current }, { path: other }];
  for (const options of [{ inventory }, { inventoryFactory: () => inventory }]) {
    const result = await executeSessionHistory({ action: "search", query: "needle" }, context(root, current), options);
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(resultText(result));
    assert.deepEqual(payload.matches.map((match: { sessionId: string }) => match.sessionId), ["current-session", "other-session"]);
    assert.equal(payload.filesRead, 2);
    for (const match of payload.matches) {
      assert.equal("source" in match, false);
      assert.equal("parentSessionId" in match, false);
    }
  }
});

test("associated teammate search shares file and match pagination with the current session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-associated-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  await writeTranscript(current, [header("current-session"), user("root-u", null, "needle")]);
  for (const name of ["a", "b"]) {
    const directory = join(root, "current", name);
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 55 }, (_, index) => writeTranscript(
      join(directory, `${String(index).padStart(3, "0")}.jsonl`),
      [header(`${name}-${index}`), user("u", null, "needle")],
    )));
  }
  const ctx = context(root, current);
  const request = { action: "search", query: "needle", limit: 20 };
  const first = JSON.parse(resultText(await executeSessionHistory(request, ctx)));
  assert.equal(first.filesRead, MAX_SESSION_HISTORY_FILES);
  assert.equal(first.matchCount, MAX_SESSION_HISTORY_FILES);
  assert.deepEqual(first.scan, { offset: 0, hasMore: true, nextOffset: 100 });
  assert.equal(first.matches[0].source, "current_session");
  const seen: string[] = first.matches.map((match: { sessionId: string }) => match.sessionId);
  for (const offset of [20, 40, 60, 80]) {
    const page = JSON.parse(resultText(await executeSessionHistory({ ...request, offset }, ctx)));
    assert.equal(page.matchCount, 100);
    seen.push(...page.matches.map((match: { sessionId: string }) => match.sessionId));
  }
  const last = JSON.parse(resultText(await executeSessionHistory({ ...request, scanOffset: first.scan.nextOffset }, ctx)));
  assert.equal(last.filesRead, 11);
  assert.equal(last.matchCount, 11);
  assert.equal(last.scan.offset, 100);
  assert.equal(last.scan.hasMore, false);
  assert.equal(last.coverage, "partial");
  assert.equal(last.matchCountRelation, "lower_bound");
  assert.ok(last.matches.every((match: { source: string; parentSessionId: string }) =>
    match.source === "teammates" && match.parentSessionId === "current-session"));
  seen.push(...last.matches.map((match: { sessionId: string }) => match.sessionId));
  assert.equal(seen.length, 111);
  assert.equal(new Set(seen).size, 111);
});

test("session_history current_session reads only the active session and exposes checkpoint recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-recovery-"));
  try {
    const sessions = join(root, "sessions");
    const currentFile = join(sessions, "root-session.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeTranscript(currentFile, [
      header("current-session"),
      user("u1", null, "current question"),
      // This branch is not the final written leaf and must stay omitted.
      user("abandoned", "u1", "abandoned needle"),
      assistant("a2", "u1", "visible needle answer"),
      hidden("hidden", "a2"),
      compaction("cp-entry", "hidden", [
        '<recovery_capsule version="2">',
        "- Capsule: Maestro New Context Recovery Capsule v2; no model summary was generated.",
        "- Checkpoint ID: checkpoint-1",
        "- Previous Checkpoint: checkpoint-0",
        "</recovery_capsule>",
      ].join("\n")),
    ]);
    for (let index = 0; index < 25; index += 1) {
      await writeTranscript(join(sessions, `older-${index}.jsonl`), [
        header(`older-${index}`),
        user(`old-${index}`, null, "older needle"),
      ]);
    }

    const ctx = context(root, currentFile);
    const tool = createSessionHistoryTool({ isCompactRecoveryEnabled: () => true });
    const call = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;

    const timeline = await call("timeline", { action: "timeline" }, new AbortController().signal, undefined, ctx);
    const timelinePayload = JSON.parse(resultText(timeline)) as {
      checkpoints: Array<{ entryId: string; checkpointId?: string; previousCheckpointId?: string; source: string; resourceUri: string }>;
      filesRead: number;
    };
    assert.equal(timelinePayload.filesRead, 1);
    assert.deepEqual(timelinePayload.checkpoints, [{
      sessionId: "current-session",
      entryId: "cp-entry",
      turn: 1,
      resourceUri: sessionEntryUri("current-session", "cp-entry"),
      timestamp: Date.parse("2026-08-01T00:00:04.000Z"),
      source: "new-context",
      checkpointId: "checkpoint-1",
      previousCheckpointId: "checkpoint-0",
      summary: "Checkpoint checkpoint-1",
    }]);

    const invalidTimeline = await call("timeline-workspace", {
      action: "timeline",
      scope: "workspace_sessions",
    }, new AbortController().signal, undefined, ctx);
    assert.equal(invalidTimeline.isError, true);
    assert.match(resultText(invalidTimeline), /only with scope=current_session/);

    const search = await call("search", { action: "search", scope: "current_session", query: "NEEDLE" }, new AbortController().signal, undefined, ctx);
    const searchPayload = JSON.parse(resultText(search)) as {
      matches: Array<{ sessionId: string; entryId: string; resourceUri: string }>;
      filesRead: number;
    };
    assert.deepEqual(searchPayload.matches.map((match) => match.sessionId), ["current-session"]);
    assert.equal(searchPayload.matches[0]?.resourceUri, sessionEntryUri("current-session", "a2"));
    assert.equal(searchPayload.filesRead, 1);
    assert.doesNotMatch(resultText(search), /older needle|must stay hidden|secret-path|abandoned needle/);

    const readTurn = await call("read-turn", {
      action: "read_turn",
      turn: 1,
      limit: 10,
    }, new AbortController().signal, undefined, ctx);
    const turnPayload = JSON.parse(resultText(readTurn)) as Record<string, unknown>;
    assert.equal(turnPayload.found, true);
    assert.equal((turnPayload.turn as { turn?: number } | undefined)?.turn, 1);
    assert.equal("sessions" in turnPayload, false);
    assert.doesNotMatch(resultText(readTurn), /must stay hidden|secret-path|provider\/model|toolCallId|toolName/);

    const checkpoint = await call("checkpoint", {
      action: "read_checkpoint",
      checkpointId: "checkpoint-1",
    }, new AbortController().signal, undefined, ctx);
    const checkpointPayload = JSON.parse(resultText(checkpoint)) as Record<string, unknown>;
    assert.equal(checkpointPayload.found, true);
    assert.match(resultText(checkpoint), /Recovery Capsule v2/);

    const resource = await resolveResource(
      searchPayload.matches[0]!.resourceUri,
      root,
      undefined,
      { sessionHistory: createCompactHistoryInventoryProvider(ctx) },
    );
    assert.equal(resource.cached, false);
    assert.match(resource.content, /visible needle answer/);
    assert.doesNotMatch(resource.content, /must stay hidden|secret-path|root-session\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint IDs use safe structured metadata and exact lookup beyond substring pages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-checkpoint-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "current.jsonl");
  const target = "f7d1fe8c-3162-4e3d-9198-5660620a4f32";
  const rows: unknown[] = [header("current-session"), user("u", null, "request")];
  let parent = "u";
  for (let index = 0; index < 25; index++) {
    const id = `decoy-${index}`;
    rows.push(compaction(id, parent, `<recovery_capsule version="2">\n- Capsule: Maestro New Context Recovery Capsule v2; no model summary was generated.\n- Checkpoint ID: decoy-id-${index}\n- Previous Checkpoint: ${target}\n</recovery_capsule>`));
    parent = id;
  }
  rows.push({ ...(compaction("real-entry", parent, "summary without identity") as object), details: {
    kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: target, previousCheckpointId: "old-id",
    projectRoot: root, knowhowPath: "/secret-path", todo: { state: "must stay hidden" },
  } });
  rows.push({ ...(compaction("reset-entry", "real-entry", "- Checkpoint ID: summary-spoof") as object), details: {
    kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: "reset-id",
    newContext: { source: "command", carryForward: "must stay hidden" },
  } });
  rows.push(compaction("native-entry", "reset-entry", "native summary"));
  rows.push(compaction("unmarked", "native-entry", "- Checkpoint ID:\t unmarked-id  \r\n"));
  await writeTranscript(file, rows);
  const ctx = context(root, file);
  const timeline = JSON.parse(resultText(await executeSessionHistory({ action: "timeline" }, ctx)));
  const real = timeline.checkpoints.find((entry: { entryId: string }) => entry.entryId === "real-entry");
  assert.equal(real.checkpointId, target);
  assert.equal(real.previousCheckpointId, "old-id");
  assert.equal(real.source, "compaction");
  assert.equal(real.summary, `Checkpoint ${target}`);
  assert.equal(timeline.checkpoints.find((entry: { entryId: string }) => entry.entryId === "reset-entry").source, "new-context");
  assert.doesNotMatch(JSON.stringify(timeline), /secret-path|must stay hidden|projectRoot|knowhowPath|details/);
  for (const checkpointId of [target, "real-entry", "reset-id", "native-entry", "decoy-id-0", "unmarked-id"]) {
    const read = JSON.parse(resultText(await executeSessionHistory({ action: "read_checkpoint", checkpointId }, ctx)));
    assert.equal(read.found, true, checkpointId);
    assert.equal(read.filesRead, 1);
    assert.doesNotMatch(JSON.stringify(read), /secret-path|must stay hidden|projectRoot|knowhowPath|details/);
    if (checkpointId === target) assert.equal(read.selectedEntryId, "real-entry");
  }
  for (const checkpointId of ["old-id", "summary-spoof"]) {
    const read = JSON.parse(resultText(await executeSessionHistory({ action: "read_checkpoint", checkpointId }, ctx)));
    assert.equal(read.found, false, checkpointId);
    assert.equal(read.truncated, false);
    assert.deepEqual(read.omissionCounts, {});
  }
  const other = join(root, "other.jsonl");
  await writeTranscript(other, [header("other-session"), user("u", null, "other"), {
    ...(compaction("foreign-entry", "u", "foreign") as object),
    details: { kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: "foreign-id" },
  }]);
  const read = JSON.parse(resultText(await executeSessionHistory({ action: "read_checkpoint", checkpointId: "foreign-id" }, ctx, { inventory: [{ path: file }, { path: other }] })));
  assert.equal(read.found, false, "exact lookup remains bound to the host current session");
});

test("timeline and read_turn paginate bounded entries without changing defaults or visibility", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-entry-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "current.jsonl");
  const rows: unknown[] = [header("current-session"), user("u", null, "request")];
  let parent = "u";
  for (let index = 0; index < 24; index++) {
    rows.push(assistant(`a-${index}`, parent, `answer ${index}`));
    parent = `a-${index}`;
  }
  for (let index = 0; index < 25; index++) {
    rows.push(compaction(`cp-${String(index).padStart(2, "0")}`, parent, `summary ${index}`));
    parent = `cp-${String(index).padStart(2, "0")}`;
  }
  await writeTranscript(file, rows);
  const ctx = context(root, file);
  for (const action of ["timeline", "read_turn"]) {
    const params = { action, ...(action === "read_turn" ? { turn: 1, include: ["user", "assistant"] } : {}) };
    const first = JSON.parse(resultText(await executeSessionHistory(params, ctx)));
    assert.deepEqual(first, JSON.parse(resultText(await executeSessionHistory({ ...params, offset: 0 }, ctx))));
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 20);
    assert.equal(first.truncated, true);
    assert.equal(first.omissionCounts["result-limit"], 5);
    const next = JSON.parse(resultText(await executeSessionHistory({ ...params, offset: first.nextOffset }, ctx)));
    assert.equal(next.hasMore, false);
    assert.equal("nextOffset" in next, false);
    assert.equal(next.truncated, false);
    assert.deepEqual(next.omissionCounts, {});
    const entries = action === "timeline" ? next.checkpoints : next.turn.entries;
    assert.equal(entries.length, 5);
    if (action === "timeline") assert.equal(next.checkpointCount, 25);
    else {
      assert.equal(next.found, true);
      assert.equal(next.turn.rowCount, 5);
      assert.equal(next.turn.entries[0].entryId, "a-19");
      assert.ok(next.turn.entries.every((entry: { kind: string }) => entry.kind === "assistant"));
    }
    const past = JSON.parse(resultText(await executeSessionHistory({ ...params, offset: Number.MAX_SAFE_INTEGER }, ctx)));
    assert.equal(past.hasMore, false);
    assert.equal(past.truncated, false);
    assert.deepEqual(action === "timeline" ? past.checkpoints : past.turn.entries, []);
    for (const extra of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: null }, { limit: 21 }]) {
      assert.equal((await executeSessionHistory({ ...params, ...extra }, ctx)).isError, true);
    }
  }
});

test("session resources revalidate active-chain visibility and reject arbitrary paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-resource-"));
  try {
    const currentFile = join(root, "session.jsonl");
    await writeTranscript(currentFile, [
      header("session-visible"),
      user("u1", null, "visible"),
      assistant("a2", "u1", "answer"),
      hidden("hidden", "a2"),
    ]);
    const ctx = context(root, currentFile);
    const inventory = createCompactHistoryInventoryProvider(ctx);

    await assert.rejects(
      () => resolveResource(sessionEntryUri("session-visible", "abandoned"), root, undefined, { sessionHistory: inventory }),
      /not found or not visible/,
    );
    await assert.rejects(
      () => resolveResource(sessionEntryUri("session-visible", "hidden"), root, undefined, { sessionHistory: inventory }),
      /not found or not visible/,
    );
    await assert.rejects(
      () => resolveResource("session://session-visible/entry/..%2Fsecret", root, undefined, { sessionHistory: inventory }),
      /Invalid session/,
    );
    await assert.rejects(
      () => resolveResource("session://../../etc/passwd", root, undefined, { sessionHistory: inventory }),
      /Invalid session/,
    );

    // The active-chain entry can disappear between discovery and resource read;
    // the resolver must scan again and fail closed rather than serving stale data.
    await writeTranscript(currentFile, [header("session-visible"), user("u1", null, "new branch")]);
    await assert.rejects(
      () => resolveResource(sessionEntryUri("session-visible", "a2"), root, undefined, { sessionHistory: inventory }),
      /not found or not visible/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session_history preserves an explicit host policy blocking checkpoint reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-recovery-disabled-"));
  try {
    const currentFile = join(root, "session.jsonl");
    await writeTranscript(currentFile, [header("current-session"), user("u1", null, "visible")]);
    let inventoryRead = false;
    const tool = createSessionHistoryTool({
      isCompactRecoveryEnabled: () => false,
      inventory: () => {
        inventoryRead = true;
        return [{ path: currentFile }];
      },
    });
    const call = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    const result = await call("disabled", { action: "timeline" }, new AbortController().signal, undefined, context(root, currentFile));
    assert.equal(result.isError, true);
    assert.match(resultText(result), /host history policy/);
    assert.equal(inventoryRead, false, "disabled calls must not open the session file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint reads remain available when deterministic new-context reset is disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-reset-disabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { newContext: { enabled: false } } }));
  const file = join(root, "current.jsonl");
  await writeTranscript(file, [
    header("current-session"), user("u", null, "Original accepted scope"),
    { ...(compaction("ordinary-entry", "u", "Ordinary summary without ID labels") as object), details: {
      kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: "ordinary-id",
    } },
    { ...(compaction("reset-entry", "ordinary-entry", "Recovery capsule") as object), details: {
      kind: "maestro-session-checkpoint", schemaVersion: 4, checkpointId: "reset-id", newContext: { source: "tool" },
    } },
  ]);
  const ctx = context(root, file);
  const timeline = await executeSessionHistory({ action: "timeline" }, ctx);
  assert.notEqual(timeline.isError, true);
  assert.equal(JSON.parse(resultText(timeline)).checkpointCount, 2);
  for (const checkpointId of ["ordinary-id", "reset-id"]) {
    const result = await executeSessionHistory({ action: "read_checkpoint", checkpointId }, ctx);
    assert.notEqual(result.isError, true);
    const read = JSON.parse(resultText(result));
    assert.equal(read.found, true);
    const resource = await resolveResource(read.selectedEntry.resourceUri, root, undefined, {
      sessionHistory: createCompactHistoryInventoryProvider(ctx),
    });
    assert.match(resource.content, checkpointId === "ordinary-id" ? /Ordinary summary without ID labels/ : /Recovery capsule/);
  }
});

test("session_history reports an unavailable host transcript instead of a complete empty search", async () => {
  const ctx = { cwd: process.cwd(), sessionManager: {} } as unknown as ExtensionContext;
  const result = await executeSessionHistory({ action: "search", query: "needle" }, ctx);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(resultText(result), /current session transcript is unavailable/i);
  assert.doesNotMatch(resultText(result), /matchCount/);

  const supplied = await executeSessionHistory(
    { action: "search", query: "needle" }, ctx, { inventory: [] },
  );
  assert.equal((supplied as { isError?: boolean }).isError, undefined);
  assert.equal(JSON.parse(resultText(supplied)).matchCount, 0);
});

test("session history reports workspace inventory enumeration errors instead of complete empty searches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-inventory-error-"));
  try {
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "not a directory", "utf8");
    const current = join(blocked, "current.jsonl");
    const ctx = context(root, current);
    const candidateAccelerator = {
      async search() { return { available: true, complete: true, entries: [{ path: current }] }; },
      destroy() {},
    };
    for (const settings of [{}, { mode: "terms" }, { mode: "literal" }]) {
      for (const options of [{}, { candidateAccelerator }]) {
        const result = await executeSessionHistory(
          { action: "search", scope: "workspace_sessions", query: "needle", ...settings }, ctx, options,
        );
        const text = resultText(result);
        const payload = JSON.parse(text);
        assert.deepEqual(payload.matches, []);
        assert.deepEqual(payload.omissions, [{ reason: "inventory-error" }]);
        assert.equal(payload.filesRead, 0);
        assert.equal(payload.coverage, "failed");
        assert.equal(payload.matchCountRelation, "lower_bound");
        assert.deepEqual(payload.omissionCounts, { "inventory-error": 1 });
        assert.equal(payload.omissionsTruncated, false);
        assert.equal(text.includes(root), false);
        assert.doesNotMatch(text, /not-a-directory|ENOTDIR/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session_history command bootstrap reads the checkpoint turn, not a newer user turn", async (t) => {
  for (const answerCount of [1, 8]) {
    await t.test(answerCount === 1 ? "preceding exchange" : "truncated exchange", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-flow-command-history-"));
      try {
        const file = join(root, "current.jsonl");
        const answers = Array.from({ length: answerCount }, (_, index) =>
          assistant(`a2-${index}`, index === 0 ? "u2" : `a2-${index - 1}`, `constraint acknowledged ${index}`));
        await writeTranscript(file, [
          header("current-session"),
          user("u1", null, "superseded request"),
          assistant("a1", "u1", "old answer"),
          user("u2", "a1", "confirmed constraint: do not deploy"),
          ...answers,
          compaction("cp-entry", `a2-${answerCount - 1}`, [
            '<recovery_capsule version="2">',
            "- Capsule: Maestro New Context Recovery Capsule v2; no model summary was generated.",
            "- Checkpoint ID: command-checkpoint",
            "</recovery_capsule>",
          ].join("\n")),
          user("u3", "cp-entry", "new request after reset"),
        ]);
        const ctx = context(root, file);
        const timeline = await executeSessionHistory({
          action: "timeline", scope: "current_session", limit: 1,
        }, ctx);
        assert.notEqual(timeline.isError, true);
        const payload = JSON.parse(resultText(timeline)) as {
          checkpoints: Array<{ sessionId: string; checkpointId: string; turn: number }>;
        };
        assert.equal(payload.checkpoints.length, 1);
        const checkpoint = payload.checkpoints[0]!;
        assert.equal(checkpoint.sessionId, "current-session");
        assert.equal(checkpoint.checkpointId, "command-checkpoint");
        assert.equal(checkpoint.turn, 2);
        const recovered = await executeSessionHistory({
          action: "read_turn", scope: "current_session", turn: checkpoint.turn,
          include: ["user", "assistant"], limit: 6,
        }, ctx);
        assert.notEqual(recovered.isError, true);
        const result = JSON.parse(resultText(recovered)) as {
          found: boolean; truncated: boolean;
          turn: { entries: Array<{ kind: string; text: string }> };
        };
        assert.equal(result.found, true);
        assert.equal(result.truncated, answerCount === 8);
        assert.equal(result.turn.entries.length, Math.min(answerCount + 1, 6));
        assert.equal(result.turn.entries[0]?.text, "confirmed constraint: do not deploy");
        assert.ok(result.turn.entries.every((entry) => entry.kind === "user" || entry.kind === "assistant"));
        assert.doesNotMatch(resultText(recovered), /superseded request|new request after reset|must stay hidden|secret-path/);

        const missing = await executeSessionHistory({
          action: "read_turn", scope: "current_session", turn: 99,
          include: ["user", "assistant"], limit: 6,
        }, ctx);
        assert.equal(JSON.parse(resultText(missing)).found, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("session history allows absent teammate roots but reports other enumeration errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-teammate-inventory-error-"));
  try {
    const current = join(root, "current.jsonl");
    await writeTranscript(current, [header("current-session"), user("u1", null, "needle")]);
    const ctx = context(root, current);
    const request = { action: "search", scope: "teammates", query: "needle" };
    const absent = JSON.parse(resultText(await executeSessionHistory(request, ctx)));
    assert.deepEqual(absent.matches, []);
    assert.deepEqual(absent.omissions, []);
    assert.equal(absent.truncated, false);
    await writeFile(join(root, "current"), "not a directory", "utf8");
    const failed = JSON.parse(resultText(await executeSessionHistory(request, ctx)));
    assert.deepEqual(failed.omissions, [{ reason: "inventory-error" }]);
    assert.equal(failed.filesRead, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session history registration exposes unified recovery and historical discovery", () => {
  const tool = createSessionHistoryTool();
  const schema = tool.parameters as {
    properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    additionalProperties?: boolean;
  };
  assert.equal(tool.name, "session_history");
  assert.deepEqual(schema.properties?.action?.enum, ["list_sessions", "search", "read_turn", "timeline", "read_checkpoint"]);
  assert.deepEqual(schema.properties?.scope?.enum, ["current_session", "workspace_sessions", "teammates"]);
  assert.deepEqual(schema.properties?.include?.items?.enum, ["user", "assistant", "visible_custom", "compaction", "tool_result"]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["action", "scope", "includeTeammates", "query", "mode", "sort", "offset", "scanOffset", "sessionId", "turn", "checkpointId", "include", "limit"]);
  assert.deepEqual(schema.properties?.mode?.enum, ["literal", "terms"]);
  assert.deepEqual(schema.properties?.sort?.enum, ["source", "relevance"]);
  assert.equal(schema.additionalProperties, false);
  const guidance = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidance, /capsule and live Todo\/Goal\/Plan\/Workflow state first/);
  assert.match(guidance, /scope=current_session/);
  assert.ok(tool.description.includes(COMMAND_HISTORY_BOOTSTRAP));
  assert.match(guidance, /even without an apparent missing fact/);
  assert.match(guidance, /Do not repeat a completed bootstrap for the same checkpoint/);
  assert.match(guidance, /other resets and subsequent reads remain need-driven/);
  assert.match(guidance, /mandatory Maestro knowledge search/);
  assert.match(guidance, /no relevant hits/);
  assert.match(guidance, /scope=workspace_sessions/);
  assert.match(guidance, /not authoritative knowledge/);
  assert.doesNotMatch(`${tool.description}\n${guidance}`, /compact_history/);
  assert.doesNotMatch(JSON.stringify(schema), /delete|update|write|maxFiles|maxMatches|includeToolResults/i);
  assert.match(tool.description, /associated teammate transcripts by default/);
  assert.match(tool.description, /includeTeammates=false/);
  assert.match(tool.description, /read_turn and checkpoint recovery remain current-transcript-only/);
  assert.match(tool.description, /NFKC/);
  assert.match(tool.description, /not a frozen snapshot/);
});

test("tool forwards terms, relevance and pagination end to end with source defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-search-options-"));
  try {
    const current = join(root, "current.jsonl");
    const texts = ["beta 修复 alpha", "before 修复 alpha beta", "修复 alpha beta", ...Array.from({ length: 25 }, (_, index) => `beta 修复 alpha ${index}`)];
    await writeTranscript(current, [header("current-session"), ...texts.map((text, index) => user(`u${index}`, index ? `u${index - 1}` : null, text))]);
    const ctx = context(root, current);
    const defaults = JSON.parse(resultText(await executeSessionHistory({ action: "search", query: "修复 alpha beta" }, ctx)));
    assert.deepEqual(defaults.matches.map((match: { entryId: string }) => match.entryId), ["u1", "u2"]);
    assert.equal(defaults.discovery.source, "bounded-inventory");
    const source = JSON.parse(resultText(await executeSessionHistory({ action: "search", query: "修复 alpha beta", mode: "terms" }, ctx)));
    assert.equal(source.matches[0].entryId, "u0");
    const seen: string[] = [];
    for (const offset of [0, 10, 20]) {
      const request = { action: "search", query: "修复  alpha\nbeta", mode: "terms", sort: "relevance", offset, limit: 10 };
      const result = await executeSessionHistory(request, ctx);
      assert.equal((result as { isError?: boolean }).isError, undefined);
      const payload = JSON.parse(resultText(result));
      assert.equal(payload.matchCount, 28);
      assert.equal(payload.hasMore, offset < 20);
      assert.equal(payload.nextOffset, offset < 20 ? offset + 10 : undefined);
      assert.equal(payload.truncated, offset < 20);
      assert.equal(payload.filesRead, 1);
      seen.push(...payload.matches.map((match: { entryId: string }) => match.entryId));
      assert.deepEqual(payload, JSON.parse(resultText(await executeSessionHistory(request, ctx))));
    }
    assert.equal(seen.length, 28);
    assert.equal(new Set(seen).size, 28);
    assert.deepEqual(seen.slice(0, 3), ["u2", "u1", "u0"]);
    const end = JSON.parse(resultText(await executeSessionHistory({ action: "search", query: "alpha", offset: 28 }, ctx)));
    assert.deepEqual(end.matches, []);
    assert.equal(end.matchCount, 28);
    assert.equal(end.hasMore, false);
    assert.equal("nextOffset" in end, false);
    assert.equal(end.truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tool rejects search-only misuse and invalid search settings before accessing inventory", async () => {
  let reads = 0;
  const options = { inventory: () => { reads += 1; return []; } };
  const ctx = { cwd: process.cwd(), sessionManager: {} } as unknown as ExtensionContext;
  for (const action of ["list_sessions", "read_turn", "timeline", "read_checkpoint"]) {
    for (const extra of [{ offset: 0 }, { scanOffset: 0 }, { mode: "literal" }, { sort: "source" }, { includeTeammates: true }, { includeTeammates: false }]) {
      if ("offset" in extra && (action === "timeline" || action === "read_turn")) continue;
      const result = await executeSessionHistory({ action, turn: 1, checkpointId: "checkpoint", ...extra }, ctx, options);
      assert.equal((result as { isError?: boolean }).isError, true);
      assert.match(resultText(result), /only for search/);
    }
  }
  for (const extra of [{ offset: -1 }, { offset: 0.5 }, { offset: "0" }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { scanOffset: -1 }, { scanOffset: 0.5 }, { scanOffset: "0" }, { scanOffset: Number.MAX_SAFE_INTEGER + 1 }, { mode: "regex" }, { sort: "date" }, { mode: "terms", query: " \n\u3000" }]) {
    const result = await executeSessionHistory({ action: "search", query: "needle", ...extra }, ctx, options);
    assert.equal((result as { isError?: boolean }).isError, true);
  }
  for (const includeTeammates of [null, "true", 1]) {
    const result = await executeSessionHistory({ action: "search", query: "needle", includeTeammates }, ctx, options);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /must be a boolean/);
  }
  for (const scope of ["workspace_sessions", "teammates"]) {
    const result = await executeSessionHistory({ action: "search", scope, query: "needle", includeTeammates: true }, ctx, options);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /only for search with scope=current_session/);
  }
  assert.equal(reads, 0);
  const literalSpaces = await executeSessionHistory({ action: "search", query: " \n" }, ctx, options);
  assert.equal((literalSpaces as { isError?: boolean }).isError, undefined);
  assert.equal(reads, 1);
});

test("workspace scan continuation reaches files beyond the discovery window without raising read budgets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-file-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  await writeTranscript(current, [header("current-session"), user("u", null, "ordinary")]);
  await Promise.all(Array.from({ length: 804 }, (_, index) => writeTranscript(
    join(root, `${String(index).padStart(4, "0")}.jsonl`),
    [header(`s${index}`), user("u", null, index === 0 ? "older needle" : "ordinary")],
  )));
  const ctx = context(root, current);
  let scanOffset = 0;
  const found: string[] = [];
  const visited: number[] = [];
  do {
    const result = await executeSessionHistory({
      action: "search", scope: "workspace_sessions", query: "older needle", mode: "terms", scanOffset,
    }, ctx);
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(resultText(result));
    assert.equal(payload.coverage, "partial");
    assert.equal(payload.matchCountRelation, "lower_bound");
    assert.equal(payload.hasMore, false, "no match pages does not mean no more files");
    assert.equal(payload.scan.offset, scanOffset);
    assert.ok(payload.filesRead <= MAX_SESSION_HISTORY_FILES);
    assert.equal(resultText(result).includes(root), false);
    visited.push(scanOffset);
    found.push(...payload.matches.map((match: { sessionId: string }) => match.sessionId));
    if (!payload.scan.hasMore) break;
    assert.ok(payload.scan.nextOffset > scanOffset);
    scanOffset = payload.scan.nextOffset;
  } while (visited.length < 10);
  assert.deepEqual(visited, [0, 100, 200, 300, 400, 500, 600, 700, 800]);
  assert.deepEqual(found, ["s0"]);
});

test("teammate file windows cross directory boundaries and report the directory discovery cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-history-teammate-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current.jsonl");
  await writeTranscript(current, [header("current-session"), user("u", null, "ordinary")]);
  const ctx = context(root, current);
  const absent = JSON.parse(resultText(await executeSessionHistory({ action: "search", scope: "teammates", query: "needle" }, ctx)));
  assert.equal(absent.coverage, "complete");
  assert.equal(absent.matchCountRelation, "exact");
  for (const name of ["a", "b"]) {
    const dir = join(root, "current", name);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 55 }, (_, index) => writeTranscript(
      join(dir, `${String(index).padStart(3, "0")}.jsonl`),
      [header(`${name}-${index}`), user("u", null, "needle")],
    )));
  }
  const request = { action: "search", scope: "teammates", query: "needle" };
  const first = JSON.parse(resultText(await executeSessionHistory(request, ctx)));
  assert.equal(first.filesRead, 100);
  assert.equal(first.matchCount, 100);
  assert.deepEqual(first.scan, { offset: 0, hasMore: true, nextOffset: 100 });
  const last = JSON.parse(resultText(await executeSessionHistory({ ...request, scanOffset: first.scan.nextOffset }, ctx)));
  assert.equal(last.filesRead, 10);
  assert.equal(last.matchCount, 10);
  assert.equal(last.coverage, "partial");
  assert.equal(last.scan.hasMore, false);
  assert.equal(last.hasMore, false);
  assert.ok(last.matches.every((match: { sessionId: string }) => match.sessionId.startsWith("b-")));

  await Promise.all(Array.from({ length: MAX_SESSION_HISTORY_FILES * 4 - 1 }, (_, index) =>
    mkdir(join(root, "current", `empty-${String(index).padStart(3, "0")}`))));
  const capped = JSON.parse(resultText(await executeSessionHistory({ ...request, scanOffset: 110 }, ctx)));
  assert.equal(capped.coverage, "partial", "directory discovery cap cannot claim complete empty coverage");
  assert.equal(capped.truncated, true);
  assert.equal(capped.scan.hasMore, false, "unknown directories do not invent a file continuation");
});
