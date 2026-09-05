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
} from "../src/tools/session-history.ts";
import { resolveResource } from "../src/tools/resource.ts";
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

test("session_history checkpoint recovery fails closed when new context is disabled", async () => {
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
    assert.match(resultText(result), /newContext\.enabled is false/);
    assert.equal(inventoryRead, false, "disabled calls must not open the session file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["action", "scope", "query", "sessionId", "turn", "checkpointId", "include", "limit"]);
  assert.equal(schema.additionalProperties, false);
  const guidance = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidance, /capsule and live Todo\/Goal\/Plan\/Workflow state first/);
  assert.match(guidance, /scope=current_session/);
  assert.match(guidance, /mandatory Maestro knowledge search/);
  assert.match(guidance, /no relevant hits/);
  assert.match(guidance, /scope=workspace_sessions/);
  assert.match(guidance, /not authoritative knowledge/);
  assert.doesNotMatch(`${tool.description}\n${guidance}`, /compact_history/);
  assert.doesNotMatch(JSON.stringify(schema), /delete|update|write|maxFiles|maxMatches|includeToolResults/i);
});
