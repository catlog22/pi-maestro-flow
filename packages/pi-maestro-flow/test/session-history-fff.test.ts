import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileFinderApi, GrepCursor, GrepMatch } from "@ff-labs/fff-node";
import {
  MAX_SESSION_HISTORY_BYTES,
  MAX_SESSION_HISTORY_FILES,
} from "pi-maestro-teammate/v1/session-history";
import {
  SESSION_HISTORY_FFF_MAX_PAGES,
  SESSION_HISTORY_FFF_PAGE_SIZE,
  SESSION_HISTORY_FFF_SCAN_TIMEOUT_MS,
  createSessionHistoryFffAccelerator,
  type SessionHistoryFffCandidateAccelerator,
} from "../src/tools/session-history-fff.ts";
import { executeSessionHistory } from "../src/tools/session-history.ts";

function header(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-01T00:00:00.000Z",
    cwd: "/workspace",
  });
}

function user(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  });
}

function context(cwd: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "current-session",
    },
  } as unknown as ExtensionContext;
}

function match(relativePath: string, modified: number): GrepMatch {
  return {
    relativePath,
    fileName: basename(relativePath),
    gitStatus: "clean",
    size: 128,
    modified,
    isBinary: false,
    totalFrecencyScore: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    lineNumber: 1,
    col: 0,
    byteOffset: 0,
    lineContent: "FFF raw transcript line must not escape",
    matchRanges: [[0, 1]],
  };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

test("session history FFF accelerator is lazy, literal, paginated, and path bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-"));
  try {
    const active = join(root, "active.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(active, `${header("active")}\n${user("u1", "needle")}\n`, "utf8");
    let createCount = 0;
    let scanTimeout = 0;
    const calls: Array<{ query: string; options: Record<string, unknown> }> = [];
    const cursor = {} as GrepCursor;
    const finder: FileFinderApi = {
      isDestroyed: false,
      destroy() { finder.isDestroyed = true; },
      async waitForScan(timeoutMs) { scanTimeout = timeoutMs ?? 0; return { ok: true, value: true }; },
      grep(query, options) {
        calls.push({ query, options: options as Record<string, unknown> });
        if (query === "needle" && options?.cursor === null) {
          return {
            ok: true,
            value: {
              items: [
                match("nested/not-authorized.jsonl", 100),
                match("active.jsonl", 1),
                match("older.jsonl", 2),
              ],
              totalMatched: 3,
              totalFilesSearched: 3,
              totalFiles: 3,
              filteredFileCount: 3,
              nextCursor: cursor,
            },
          };
        }
        if (query === "needle" && options?.cursor === cursor) {
          return {
            ok: true,
            value: {
              items: [
                match("newest.jsonl", 9),
                match("/outside.jsonl", 99),
              ],
              totalMatched: 2,
              totalFilesSearched: 2,
              totalFiles: 2,
              filteredFileCount: 2,
              nextCursor: null,
            },
          };
        }
        if (query === 'quoted "needle"') {
          return {
            ok: true,
            value: {
              items: [],
              totalMatched: 0,
              totalFilesSearched: 1,
              totalFiles: 1,
              filteredFileCount: 1,
              nextCursor: null,
            },
          };
        }
        assert.equal(query, 'quoted \\"needle\\"');
        return {
          ok: true,
          value: {
            items: [match("encoded.jsonl", 3)],
            totalMatched: 1,
            totalFilesSearched: 1,
            totalFiles: 1,
            filteredFileCount: 1,
            nextCursor: null,
          },
        };
      },
      fileSearch() { throw new Error("unused"); },
      glob() { throw new Error("unused"); },
      directorySearch() { throw new Error("unused"); },
      mixedSearch() { throw new Error("unused"); },
      multiGrep() { throw new Error("unused"); },
      scanFiles() { throw new Error("unused"); },
      isScanning() { return false; },
      getBasePath() { return { ok: true, value: root }; },
      getScanProgress() { throw new Error("unused"); },
      waitForScanBlocking() { throw new Error("unused"); },
      waitForIndexReady() { throw new Error("unused"); },
      reindex() { throw new Error("unused"); },
      refreshGitStatus() { throw new Error("unused"); },
      trackQuery() { throw new Error("unused"); },
      getHistoricalQuery() { throw new Error("unused"); },
      watch() { throw new Error("unused"); },
      healthCheck() { throw new Error("unused"); },
    };
    const accelerator = createSessionHistoryFffAccelerator({
      createFinder: ((options) => {
        createCount += 1;
        assert.equal(options.basePath, root);
        return { ok: true, value: finder };
      }) as never,
    });
    const ctx = context(root, active);

    assert.equal(createCount, 0, "finder construction must be lazy");
    const result = await accelerator.search("needle", ctx);
    assert.equal(createCount, 1);
    assert.equal(scanTimeout, SESSION_HISTORY_FFF_SCAN_TIMEOUT_MS);
    assert.equal(calls.length, 2, "identical raw and encoded forms should be deduplicated");
    assert.deepEqual(calls.map((call) => call.query), ["needle", "needle"]);
    for (const call of calls) {
      assert.equal(call.options.mode, "plain");
      assert.equal(call.options.smartCase, false);
      assert.equal(call.options.maxFileSize, MAX_SESSION_HISTORY_BYTES);
      assert.equal(call.options.maxMatchesPerFile, 1);
      assert.equal(call.options.pageSize, SESSION_HISTORY_FFF_PAGE_SIZE);
      assert.equal(call.options.beforeContext, 0);
      assert.equal(call.options.afterContext, 0);
      assert.equal(call.options.classifyDefinitions, false);
      assert.ok(Number(call.options.timeBudgetMs) > 0);
    }
    assert.deepEqual(result.entries.map((entry) => basename(entry.path)), [
      "active.jsonl",
      "newest.jsonl",
      "older.jsonl",
    ]);
    assert.equal(result.available, true);
    assert.equal(result.complete, true);
    assert.doesNotMatch(JSON.stringify(result), /raw transcript line|not-authorized|outside/);

    const encodedResult = await accelerator.search('quoted "needle"', ctx);
    assert.deepEqual(encodedResult.entries.map((entry) => basename(entry.path)), ["encoded.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session history FFF candidate inventory is capped and incomplete pagination is visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-cap-"));
  try {
    const active = join(root, "active.jsonl");
    const items = Array.from({ length: MAX_SESSION_HISTORY_FILES + 1 }, (_, index) =>
      match(index === 0 ? "active.jsonl" : `candidate-${index}.jsonl`, index));
    let calls = 0;
    const cursor = {} as GrepCursor;
    const finder = {
      isDestroyed: false,
      destroy() { finder.isDestroyed = true; },
      async waitForScan() { return { ok: true as const, value: true }; },
      grep() {
        calls += 1;
        return {
          ok: true as const,
          value: {
            items,
            totalMatched: items.length,
            totalFilesSearched: items.length,
            totalFiles: items.length,
            filteredFileCount: items.length,
            nextCursor: calls === 1 ? cursor : null,
          },
        };
      },
    } as unknown as FileFinderApi;
    const accelerator = createSessionHistoryFffAccelerator({
      createFinder: (() => ({ ok: true, value: finder })) as never,
      maxPages: 1,
    });
    const result = await accelerator.search("cap", context(root, active));
    assert.equal(result.entries.length, MAX_SESSION_HISTORY_FILES);
    assert.equal(result.complete, false);
    assert.ok(calls <= 2 * SESSION_HISTORY_FFF_MAX_PAGES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session history falls back to bounded inventory without exposing accelerator errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-fallback-"));
  try {
    const sessions = join(root, "sessions");
    const current = join(sessions, "current.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(current, `${header("current")}\n${user("u1", "fallback needle")}\n`, "utf8");
    const unavailable: SessionHistoryFffCandidateAccelerator = {
      async search() {
        return {
          available: false,
          complete: false,
          entries: [],
          diagnostic: "C:\\secret\\transcripts",
        } as never;
      },
      destroy() {},
    };
    const result = await executeSessionHistory(
      { action: "search", scope: "workspace_sessions", query: "NEEDLE" },
      context(root, current),
      { candidateAccelerator: unavailable },
    );
    const text = resultText(result);
    const payload = JSON.parse(text) as { matches: Array<{ sessionId: string }>; discovery?: { source?: string; reason?: string } };
    assert.deepEqual(payload.matches.map((item) => item.sessionId), ["current"]);
    assert.equal(payload.discovery?.source, "bounded-inventory");
    assert.equal(payload.discovery?.reason, "unavailable");
    assert.doesNotMatch(text, /secret|transcripts|current\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session history preserves top-level truncation for incomplete FFF candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-truncated-"));
  try {
    const sessions = join(root, "sessions");
    const current = join(sessions, "current.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(current, `${header("current")}\n${user("u1", "candidate needle")}\n`, "utf8");
    const incomplete: SessionHistoryFffCandidateAccelerator = {
      async search() {
        return {
          available: true,
          complete: false,
          entries: [{ path: current, fileName: "current.jsonl" }],
        };
      },
      destroy() {},
    };
    const result = await executeSessionHistory(
      { action: "search", scope: "workspace_sessions", query: "needle" },
      context(root, current),
      { candidateAccelerator: incomplete },
    );
    const payload = JSON.parse(resultText(result)) as {
      matches: unknown[];
      truncated: boolean;
      discovery?: { complete?: boolean };
    };
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.truncated, true);
    assert.equal(payload.discovery?.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session history rejects injected FFF paths outside the authorized workspace directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-security-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-outside-"));
  try {
    const sessions = join(root, "sessions");
    const current = join(sessions, "current.jsonl");
    const secret = join(outside, "secret.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(current, `${header("current")}\n${user("u1", "ordinary")}\n`, "utf8");
    await writeFile(secret, `${header("secret")}\n${user("u1", "secret needle")}\n`, "utf8");
    const malicious: SessionHistoryFffCandidateAccelerator = {
      async search() {
        return {
          available: true,
          complete: true,
          entries: [{ path: secret, fileName: "secret.jsonl" }],
        };
      },
      destroy() {},
    };
    const result = await executeSessionHistory(
      { action: "search", scope: "workspace_sessions", query: "needle" },
      context(root, current),
      { candidateAccelerator: malicious },
    );
    const text = resultText(result);
    const payload = JSON.parse(text) as { matches: unknown[] };
    assert.deepEqual(payload.matches, []);
    assert.doesNotMatch(text, /secret\.jsonl|secret needle/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("session history uses FFF only for workspace search", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-session-history-fff-scope-"));
  try {
    const sessions = join(root, "sessions");
    const current = join(sessions, "current.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(current, `${header("current")}\n${user("u1", "scope needle")}\n`, "utf8");
    let calls = 0;
    const accelerator: SessionHistoryFffCandidateAccelerator = {
      async search() {
        calls += 1;
        return { available: true, complete: true, entries: [{ path: current }] };
      },
      destroy() {},
    };
    const ctx = context(root, current);
    await executeSessionHistory({ action: "list_sessions", scope: "workspace_sessions" }, ctx, { candidateAccelerator: accelerator });
    await executeSessionHistory({ action: "search", scope: "current_session", query: "needle" }, ctx, { candidateAccelerator: accelerator });
    await executeSessionHistory({ action: "read_turn", scope: "workspace_sessions", sessionId: "current", turn: 1 }, ctx, { candidateAccelerator: accelerator });
    await executeSessionHistory({ action: "search", scope: "workspace_sessions", query: "needle" }, ctx, { candidateAccelerator: accelerator });
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
