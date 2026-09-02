import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  createSessionHistoryInventoryProvider,
  createSessionHistoryTool,
} from "../src/tools/session-history.ts";
import { resolveResource } from "../src/tools/resource.ts";
import { sessionEntryUri } from "pi-maestro-teammate/v1/session-history";

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

function writeTranscript(file: string, entries: unknown[]): Promise<void> {
  return writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function context(cwd: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

test("session_history scopes are bounded and expose exact entry URIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-"));
  try {
    const sessions = join(root, "sessions");
    const currentFile = join(sessions, "root-session.jsonl");
    const olderFile = join(sessions, "older-session.jsonl");
    const teammateDir = join(sessions, "root-session", "worker-a");
    const teammateFile = join(teammateDir, "worker.jsonl");
    await mkdir(teammateDir, { recursive: true });
    await writeTranscript(currentFile, [
      header("current-session"),
      user("u1", null, "current question"),
      // This branch is not the final written leaf and must stay omitted.
      user("abandoned", "u1", "abandoned needle"),
      assistant("a2", "u1", "visible needle answer"),
      hidden("hidden", "a2"),
    ]);
    await writeTranscript(olderFile, [header("older-session"), user("old-u", null, "older text")]);
    await writeTranscript(teammateFile, [header("teammate-session"), user("team-u", null, "teammate needle")]);

    const ctx = context(root, currentFile);
    const tool = createSessionHistoryTool();
    const call = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;

    const current = await call("list-current", { action: "list_sessions", scope: "current_session" }, new AbortController().signal, undefined, ctx);
    const currentPayload = JSON.parse(resultText(current)) as { sessions: Array<{ sessionId: string }> };
    assert.deepEqual(currentPayload.sessions.map((entry) => entry.sessionId), ["current-session"]);

    const teammates = await call("list-teammates", { action: "list_sessions", scope: "teammates" }, new AbortController().signal, undefined, ctx);
    const teammatePayload = JSON.parse(resultText(teammates)) as { sessions: Array<{ sessionId: string }> };
    assert.deepEqual(teammatePayload.sessions.map((entry) => entry.sessionId), ["teammate-session"]);

    const search = await call("search", {
      action: "search",
      scope: "workspace_sessions",
      query: "NEEDLE",
    }, new AbortController().signal, undefined, ctx);
    assert.equal(search.isError, undefined);
    const searchPayload = JSON.parse(resultText(search)) as {
      matches: Array<{ sessionId: string; entryId: string; resourceUri: string }>;
      filesRead: number;
      bytesRead: number;
      truncated: boolean;
      omissions: unknown[];
    };
    assert.deepEqual(searchPayload.matches.map((match) => match.sessionId), ["current-session"]);
    assert.equal(searchPayload.matches[0]?.resourceUri, sessionEntryUri("current-session", "a2"));
    assert.equal(searchPayload.filesRead, 2);
    assert.ok(searchPayload.bytesRead > 0);
    assert.equal(searchPayload.truncated, false);
    assert.deepEqual(searchPayload.omissions, []);
    assert.doesNotMatch(resultText(search), /must stay hidden|secret-path|abandoned needle/);

    const readTurn = await call("read-turn", {
      action: "read_turn",
      scope: "current_session",
      sessionId: "current-session",
      turn: 1,
      limit: 10,
    }, new AbortController().signal, undefined, ctx);
    const turnPayload = JSON.parse(resultText(readTurn)) as Record<string, unknown>;
    assert.equal(turnPayload.found, true);
    assert.equal((turnPayload.turn as { turn?: number } | undefined)?.turn, 1);
    assert.equal("sessions" in turnPayload, false);
    assert.equal("turns" in turnPayload, false);
    assert.equal("session" in turnPayload, false);
    assert.doesNotMatch(resultText(readTurn), /must stay hidden|secret-path|provider\/model|toolCallId|toolName/);

    const resource = await resolveResource(
      searchPayload.matches[0]!.resourceUri,
      root,
      undefined,
      { sessionHistory: createSessionHistoryInventoryProvider(ctx, "all") },
    );
    assert.equal(resource.cached, false);
    assert.match(resource.content, /visible needle answer/);
    assert.doesNotMatch(resource.content, /must stay hidden|secret-path/);
    assert.doesNotMatch(resource.content, /root-session\.jsonl/);
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
    const inventory = createSessionHistoryInventoryProvider(ctx, "all");

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

test("session history registration has the exact approved read-only contract", () => {
  const tools: ToolDefinition[] = [];
  const tool = createSessionHistoryTool();
  tools.push(tool as ToolDefinition);
  assert.equal(tools[0]?.name, "session_history");
  const schema = tool.parameters as {
    properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    additionalProperties?: boolean;
  };
  assert.deepEqual(schema.properties?.action?.enum, ["list_sessions", "search", "read_turn"]);
  assert.deepEqual(schema.properties?.scope?.enum, ["current_session", "workspace_sessions", "teammates"]);
  assert.deepEqual(schema.properties?.include?.items?.enum, ["user", "assistant", "visible_custom", "compaction", "tool_result"]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["action", "scope", "query", "sessionId", "turn", "include", "limit"]);
  assert.equal(schema.additionalProperties, false);
  assert.match(tool.description, /read-only/);
  assert.doesNotMatch(JSON.stringify(schema), /delete|update|write|maxFiles|maxMatches|includeToolResults/i);
});
