import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleProxyRequest } from "../src/extension/index.ts";
import {
  WindowThreadStore,
  type WindowThreadEntry,
  type WindowThreadEntryInput,
} from "../src/sessions/session-core.ts";
import {
  formatWorkspaceWindowInbox,
  loadWorkspaceWindowInbox,
  resolveWindowInboxAnchor,
} from "../src/sessions/window-inbox.ts";
import type { TeammateState } from "../src/shared/types.ts";

const WORKSPACE_ID = "a".repeat(64);
const OWNER_A = "b".repeat(32);
const OWNER_B = "c".repeat(32);
const NONCE = "d".repeat(32);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-window-inbox-"));
}

function threadInput(overrides: Partial<WindowThreadEntryInput> = {}): WindowThreadEntryInput {
  return {
    messageId: "message-1",
    workspaceId: WORKSPACE_ID,
    peerOwnerId: OWNER_A,
    peerOwnerNonce: NONCE,
    direction: "incoming",
    source: "monitor",
    messageKind: "message",
    mode: "follow_up",
    body: "worker reply",
    status: "pending",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function persistedThreadEntries(build: (store: WindowThreadStore) => void): WindowThreadEntry[] {
  const persisted: WindowThreadEntry[] = [];
  const store = new WindowThreadStore({ persist: (entry) => persisted.push(entry) });
  build(store);
  return persisted;
}

function writeSession(
  dir: string,
  fileName: string,
  options: {
    id: string;
    name?: string;
    threads?: readonly WindowThreadEntry[];
    injectedMessageIds?: readonly string[];
    extraLines?: readonly string[];
  },
): string {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: options.id, timestamp: "2026-08-10T09:00:00.000Z", cwd: dir }),
    ...(options.name ? [JSON.stringify({ type: "session_info", id: "info", parentId: null, timestamp: "2026-08-10T09:00:00.001Z", name: options.name })] : []),
    ...(options.threads ?? []).map((entry, index) => JSON.stringify({
      type: "custom",
      customType: "teammate-window-thread",
      data: entry,
      id: `thread-${index}`,
      parentId: null,
      timestamp: new Date(entry.updatedAt).toISOString(),
    })),
    ...(options.injectedMessageIds ?? []).map((messageId, index) => JSON.stringify({
      type: "custom_message",
      customType: "teammate-message",
      content: "injected",
      display: true,
      details: { messageId, mode: "follow_up" },
      id: `message-${index}`,
      parentId: null,
      timestamp: "2026-08-10T09:00:01.000Z",
    })),
    ...(options.extraLines ?? []),
  ];
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

test("window inbox rebuilds persisted revisions and infers injected messages", async () => {
  const dir = tmpDir();
  try {
    const current = writeSession(dir, "current.jsonl", { id: "current-session" });
    const threads = persistedThreadEntries((store) => {
      store.record(threadInput());
      store.record(threadInput({
        messageId: "message-2",
        direction: "outgoing",
        mode: "steer",
        body: "monitor request",
      }));
      store.record(threadInput({
        messageId: "message-2",
        direction: "outgoing",
        mode: "steer",
        body: "monitor request",
        status: "queued",
        updatedAt: 2_000,
        effectiveMode: "follow_up",
      }));
    });
    writeSession(dir, "monitor.jsonl", {
      id: "monitor-session-id",
      name: "mw-token-monitor",
      threads,
      injectedMessageIds: ["message-1"],
    });

    const result = await loadWorkspaceWindowInbox(current, { session: "monitor" });
    assert.equal(result.matchedSessionCount, 1);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries.find((entry) => entry.messageId === "message-1")?.status, "injected");
    assert.equal(result.entries.find((entry) => entry.messageId === "message-2")?.status, "queued");
    assert.equal(result.entries.find((entry) => entry.messageId === "message-2")?.revision, 2);
    const formatted = formatWorkspaceWindowInbox(result);
    assert.match(formatted, /incoming\/injected/);
    assert.match(formatted, /worker reply/);
    assert.match(formatted, /source=monitor/);
    assert.match(formatted, /kind=message/);
    assert.match(formatted, /requested=steer \| effective=follow_up/);
    const pendingWithoutReceipt = formatWorkspaceWindowInbox({
      ...result,
      entries: [{
        ...result.entries[0]!,
        status: "pending",
        mode: "steer",
        effectiveMode: undefined,
      }],
    });
    assert.match(pendingWithoutReceipt, /requested=steer \| effective=unknown/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window inbox filters archived sessions without treating them as live peers", async () => {
  const dir = tmpDir();
  try {
    const current = writeSession(dir, "current.jsonl", { id: "current-session" });
    const first = persistedThreadEntries((store) => {
      store.record(threadInput({ messageId: "a", peerOwnerId: OWNER_A, body: "first", status: "pending" }));
    });
    const second = persistedThreadEntries((store) => {
      store.record(threadInput({ messageId: "b", peerOwnerId: OWNER_B, body: "second", status: "rejected", updatedAt: 3_000 }));
    });
    writeSession(dir, "first.jsonl", { id: "first-session", name: "mw-one-first", threads: first });
    writeSession(dir, "second.jsonl", { id: "second-session", name: "mw-two-second", threads: second });

    const filtered = await loadWorkspaceWindowInbox(current, {
      peer: `owner:${OWNER_B}`,
      direction: "incoming",
      status: "rejected",
      limit: 1,
    });
    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.entries[0]?.messageId, "b");
    assert.equal(filtered.entries[0]?.current, false);
    assert.equal(filtered.entries[0]?.sessionName, "mw-two-second");
    assert.equal(filtered.matchedSessionCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window inbox rejects ambiguous archived session aliases and skips malformed files", async () => {
  const dir = tmpDir();
  try {
    const current = writeSession(dir, "current.jsonl", { id: "current-session" });
    const threads = persistedThreadEntries((store) => store.record(threadInput()));
    writeSession(dir, "one.jsonl", { id: "one", name: "mw-one-worker", threads });
    writeSession(dir, "two.jsonl", { id: "two", name: "mw-two-worker", threads });
    fs.writeFileSync(path.join(dir, "broken.jsonl"), "not-json\n", "utf8");

    await assert.rejects(
      loadWorkspaceWindowInbox(current, { session: "worker" }),
      /ambiguous/,
    );
    assert.equal((await loadWorkspaceWindowInbox(current, { session: "one" })).entries.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window inbox anchor prefers the root-owned session across context switches", () => {
  assert.equal(resolveWindowInboxAnchor("/root/main.jsonl", "/agent/checkpoint.jsonl"), "/root/main.jsonl");
  assert.equal(resolveWindowInboxAnchor(undefined, "/context/current.jsonl"), "/context/current.jsonl");
});

test("window inbox bounds aggregate archive bytes and reports partial scans", async () => {
  const dir = tmpDir();
  try {
    const current = writeSession(dir, "current.jsonl", { id: "current-session" });
    const threads = persistedThreadEntries((store) => store.record(threadInput({ body: "bounded result" })));
    writeSession(dir, "valid.jsonl", { id: "valid-session", name: "valid", threads });
    const oversized = path.join(dir, "oversized.jsonl");
    const fd = fs.openSync(oversized, "w");
    try {
      fs.writeSync(fd, `${JSON.stringify({ type: "session", version: 3, id: "oversized" })}\n`);
      fs.ftruncateSync(fd, 33 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }

    const result = await loadWorkspaceWindowInbox(current);
    assert.equal(result.entries.length, 1);
    assert.equal(result.archiveTruncated, true);
    assert.ok(result.skippedSessionFileCount >= 1);
    assert.match(formatWorkspaceWindowInbox(result), /Archive scan reached its byte or file budget/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window inbox enforces the admitted byte snapshot while a session grows", async () => {
  const dir = tmpDir();
  try {
    const initial = persistedThreadEntries((store) => store.record(threadInput({ messageId: "initial", body: "before scan" })));
    const current = writeSession(dir, "current.jsonl", { id: "current-session", threads: initial });
    const appended = persistedThreadEntries((store) => store.record(threadInput({
      messageId: "appended",
      body: "after scan started",
      createdAt: 2_000,
      updatedAt: 2_000,
    })))[0]!;

    const pending = loadWorkspaceWindowInbox(current, { session: "current" });
    fs.appendFileSync(current, `${JSON.stringify({
      type: "custom",
      customType: "teammate-window-thread",
      data: appended,
      id: "appended-thread",
      parentId: null,
      timestamp: new Date(appended.updatedAt).toISOString(),
    })}\n`, "utf8");

    const snapshot = await pending;
    assert.deepEqual(snapshot.entries.map((entry) => entry.messageId), ["initial"]);
    const refreshed = await loadWorkspaceWindowInbox(current, { session: "current" });
    assert.deepEqual(refreshed.entries.map((entry) => entry.messageId), ["appended", "initial"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("child proxy exposes the same persisted inbox view as the root tool", async () => {
  const dir = tmpDir();
  try {
    const current = writeSession(dir, "current.jsonl", { id: "current-session" });
    const threads = persistedThreadEntries((store) => store.record(threadInput({ body: "proxy-visible reply" })));
    writeSession(dir, "monitor.jsonl", { id: "monitor-session", name: "mw-token-monitor", threads });
    const state: TeammateState = {
      baseCwd: dir,
      currentSessionId: "current-session",
      mainSessionFile: current,
      activeRuns: new Map(),
      namedAgents: new Map(),
    };
    const pi = new Proxy({ events: { emit() {} } }, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return () => {};
      },
    }) as unknown as ExtensionAPI;
    let response: Record<string, unknown> | undefined;
    await handleProxyRequest(
      pi,
      state,
      { tool: "teammate-list", requestId: "inbox-proxy", params: { view: "inbox", session: "monitor" } },
      (message) => { response = message as Record<string, unknown>; },
    );

    const result = response?.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
      details?: { agents?: Array<{ kind?: string; body?: string }> };
    };
    assert.equal(result.isError, false);
    assert.match(result.content?.[0]?.text ?? "", /proxy-visible reply/);
    assert.equal(result.details?.agents?.[0]?.kind, "window-message");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
