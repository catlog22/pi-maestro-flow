import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileHandle } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createTeammateInteractionQueue,
  handleChildInteractionRequest,
} from "../src/extension/index.ts";
import { registerTeammatePermissionBroker } from "../src/runs/child-extensions.ts";
import {
  appendPermissionAuditRecord,
  buildPermissionAuditRecord,
  flushPermissionAuditWrites,
  permissionAuditFilePath,
  schedulePermissionAudit,
  setPermissionAuditFileOpenForTests,
  setPermissionAuditWriterForTests,
  type PermissionAuditRecord,
} from "../src/runs/shared/permission-audit.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

const stubPi = {
  events: { emit() {} },
  sendMessage() {},
} as unknown as ExtensionAPI;

function makeFixture(root: string): {
  state: TeammateState;
  agent: ActiveAgent;
  parentSessionFile: string;
} {
  const parentSessionFile = path.join(root, "parent-session.jsonl");
  const now = Date.now();
  const agent: ActiveAgent = {
    agent: "general",
    name: "audited-worker",
    correlationId: "audit-child-1234",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
    depth: 0,
    sleepMs: 0,
  };
  return {
    parentSessionFile,
    agent,
    state: {
      baseCwd: root,
      currentSessionId: "parent-session",
      mainSessionFile: parentSessionFile,
      activeRuns: new Map([[agent.correlationId, agent]]),
      namedAgents: new Map([[agent.name!, agent.correlationId]]),
    },
  };
}

function permissionEvent(
  requestId: string,
  correlationId: string,
  authorization?: "parent",
): Record<string, unknown> {
  return {
    type: "teammate_interaction_request",
    requestId,
    interaction: "permission",
    correlationId,
    payload: {
      ...(authorization ? { authorization } : {}),
      toolName: "bash",
      input: {
        command: "curl -H 'Authorization: Bearer top-secret-token' https://example.test",
        password: "never-store-this",
      },
      reason: "Need access with token=secret-value",
    },
  };
}

function readRecords(filePath: string): PermissionAuditRecord[] {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PermissionAuditRecord);
}

function posixMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function auditDecisionRecord(requestId: string): PermissionAuditRecord {
  return buildPermissionAuditRecord({
    event: "permission_decision",
    requestId,
    toolName: "bash",
    action: "deny",
    source: "headless",
  });
}

function tryCreateLink(target: string, link: string, directory: boolean): boolean {
  try {
    fs.symlinkSync(
      target,
      link,
      process.platform === "win32" && directory ? "junction" : directory ? "dir" : "file",
    );
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

test("permission audit derives an isolated parent-session path and writes redacted private JSONL asynchronously", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-session-"));
  try {
    const firstSession = path.join(root, "first.jsonl");
    const secondSession = path.join(root, "second.jsonl");
    const firstAudit = permissionAuditFilePath(firstSession)!;
    const secondAudit = permissionAuditFilePath(secondSession)!;

    assert.equal(firstAudit, path.join(root, "first", "audit", "permissions.jsonl"));
    assert.equal(secondAudit, path.join(root, "second", "audit", "permissions.jsonl"));

    schedulePermissionAudit({
      parentSessionFile: firstSession,
      event: "permission_request",
      requestId: "request-1",
      correlationId: "child-1",
      agent: "redundant-label",
      toolName: "bash",
      input: {
        command: "curl -H 'Authorization: Bearer top-secret-token' https://example.test",
        apiKey: "secret-key-value",
      },
      action: "request",
      source: "child",
      reason: `Bearer another-secret token=raw-secret ${"x".repeat(2_000)}`,
      timestamp: 1_700_000_000_000,
    });
    schedulePermissionAudit({
      parentSessionFile: secondSession,
      event: "permission_decision",
      requestId: "request-2",
      agent: "fallback-agent",
      toolName: "write",
      input: { path: "src/app.ts", content: "sensitive file body" },
      action: "deny",
      source: "headless",
    });

    assert.equal(fs.existsSync(firstAudit), false, "filesystem work must not run inline");
    assert.equal(fs.existsSync(secondAudit), false, "each parent session gets its own deferred stream");
    await flushPermissionAuditWrites();

    const first = readRecords(firstAudit)[0];
    const second = readRecords(secondAudit)[0];
    assert.deepEqual({ version: first.version, event: first.event, requestId: first.requestId }, {
      version: 1,
      event: "permission_request",
      requestId: "request-1",
    });
    assert.equal(first.timestamp, "2023-11-14T22:13:20.000Z");
    assert.equal(first.correlationId, "child-1");
    assert.equal(first.agent, undefined, "agent label is omitted when correlationId already locates the child");
    assert.match(first.preview ?? "", /\[redacted\]/);
    assert.doesNotMatch(first.preview ?? "", /top-secret-token|secret-key-value/);
    assert.ok(Buffer.byteLength(first.reason ?? "", "utf8") <= 1024);
    assert.doesNotMatch(first.reason ?? "", /another-secret|raw-secret/);
    assert.equal(second.agent, "fallback-agent");
    assert.match(second.preview ?? "", /path=src\/app\.ts/);
    assert.doesNotMatch(second.preview ?? "", /sensitive file body/);

    if (process.platform !== "win32") {
      assert.equal(posixMode(path.dirname(firstAudit)), 0o700);
      assert.equal(posixMode(firstAudit), 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a slow permission audit writer never delays the permission reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-slow-"));
  const { state, agent } = makeFixture(root);
  const replies: Array<Record<string, any>> = [];
  let releaseWriter!: () => void;
  let writerStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const started = new Promise<void>((resolve) => { writerStarted = resolve; });
  const restoreWriter = setPermissionAuditWriterForTests(async () => {
    writerStarted();
    await blocked;
  });
  try {
    const handling = handleChildInteractionRequest(
      stubPi,
      state,
      permissionEvent("slow-write", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      { hasUI: false, cwd: root } as ExtensionContext,
    );

    assert.equal(replies[0]?.result.action, "deny", "reply is synchronous with respect to queued audit I/O");
    await started;
    assert.equal(replies.length, 1, "a blocked writer cannot alter or delay the reply");
    releaseWriter();
    await handling;
    await flushPermissionAuditWrites();
  } finally {
    releaseWriter();
    restoreWriter();
    await flushPermissionAuditWrites();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("permission audit rotation retains only active plus two history files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-rotate-"));
  const filePath = path.join(root, "audit", "permissions.jsonl");
  try {
    for (let index = 1; index <= 4; index += 1) {
      const record = buildPermissionAuditRecord({
        event: "permission_decision",
        requestId: `rotate-${index}`,
        toolName: "bash",
        input: { command: `command-${index}` },
        action: "deny",
        source: "headless",
        timestamp: index,
      });
      await appendPermissionAuditRecord(filePath, record, 1);
    }

    assert.equal(readRecords(filePath)[0].requestId, "rotate-4");
    assert.equal(readRecords(`${filePath}.1`)[0].requestId, "rotate-3");
    assert.equal(readRecords(`${filePath}.2`)[0].requestId, "rotate-2");
    assert.equal(fs.existsSync(`${filePath}.3`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("permission audit refuses a symbolic-link active file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-link-"));
  const target = path.join(root, "target.jsonl");
  const link = path.join(root, "session", "audit", "permissions.jsonl");
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(target, "original\n");
    if (!tryCreateLink(target, link, false)) {
      t.skip("the platform does not permit file symlink creation");
      return;
    }
    await assert.rejects(appendPermissionAuditRecord(link, auditDecisionRecord("link")), /not a regular file/);
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("permission audit refuses a symbolic-link or junction session root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-root-link-"));
  const target = path.join(root, "escaped-root");
  const sessionRoot = path.join(root, "parent-session");
  const filePath = path.join(sessionRoot, "audit", "permissions.jsonl");
  try {
    fs.mkdirSync(target);
    if (!tryCreateLink(target, sessionRoot, true)) {
      t.skip("the platform does not permit directory link creation");
      return;
    }
    await assert.rejects(
      appendPermissionAuditRecord(filePath, auditDecisionRecord("root-link")),
      /not a real directory/,
    );
    assert.equal(fs.existsSync(path.join(target, "audit")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("permission audit refuses a symbolic-link or junction audit directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-dir-link-"));
  const sessionRoot = path.join(root, "parent-session");
  const target = path.join(root, "escaped-audit");
  const auditDirectory = path.join(sessionRoot, "audit");
  const filePath = path.join(auditDirectory, "permissions.jsonl");
  try {
    fs.mkdirSync(sessionRoot);
    fs.mkdirSync(target);
    if (!tryCreateLink(target, auditDirectory, true)) {
      t.skip("the platform does not permit directory link creation");
      return;
    }
    await assert.rejects(
      appendPermissionAuditRecord(filePath, auditDecisionRecord("audit-dir-link")),
      /not a real directory/,
    );
    assert.equal(fs.existsSync(path.join(target, "permissions.jsonl")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("permission audit refuses symbolic-link rotation files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-rotation-link-"));
  const filePath = path.join(root, "parent-session", "audit", "permissions.jsonl");
  const target = path.join(root, "rotation-target.jsonl");
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(auditDecisionRecord("active"))}\n`);
    fs.writeFileSync(target, "original\n");
    if (!tryCreateLink(target, `${filePath}.1`, false)) {
      t.skip("the platform does not permit file symlink creation");
      return;
    }
    await assert.rejects(
      appendPermissionAuditRecord(filePath, auditDecisionRecord("rotation-link"), 1),
      /not a regular file/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
    assert.equal(readRecords(filePath)[0].requestId, "active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker, UI, and headless permission decisions are audited without changing their actions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-sources-"));
  const { state, agent, parentSessionFile } = makeFixture(root);
  const replies: Array<Record<string, any>> = [];
  const unregister = registerTeammatePermissionBroker(async () => ({
    action: "allow_once",
    reason: "broker allowed",
  }));
  try {
    await handleChildInteractionRequest(
      stubPi,
      state,
      permissionEvent("broker-request", agent.correlationId, "parent"),
      (reply) => replies.push(reply as Record<string, any>),
      { hasUI: false, cwd: root } as ExtensionContext,
    );
    await handleChildInteractionRequest(
      stubPi,
      state,
      permissionEvent("ui-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      {
        hasUI: true,
        cwd: root,
        ui: { async select() { return "Always allow"; } },
      } as unknown as ExtensionContext,
    );
    await handleChildInteractionRequest(
      stubPi,
      state,
      permissionEvent("headless-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      { hasUI: false, cwd: root } as ExtensionContext,
    );
    agent.expectsStructuredOutput = true;
    await handleChildInteractionRequest(
      stubPi,
      state,
      {
        type: "teammate_interaction_request",
        requestId: "automatic-request",
        interaction: "permission",
        correlationId: agent.correlationId,
        payload: { toolName: "structured_output", input: { value: { ok: true } } },
      },
      (reply) => replies.push(reply as Record<string, any>),
      { hasUI: false, cwd: root } as ExtensionContext,
    );
    await flushPermissionAuditWrites();

    assert.deepEqual(replies.map((reply) => reply.result.action), ["allow_once", "always_allow", "deny", "allow_once"]);
    const decisions = readRecords(permissionAuditFilePath(parentSessionFile)!)
      .filter((record) => record.event === "permission_decision");
    assert.deepEqual(decisions.map((record) => [record.requestId, record.action, record.source]), [
      ["broker-request", "allow_once", "broker"],
      ["ui-request", "always_allow", "ui"],
      ["headless-request", "deny", "headless"],
      ["automatic-request", "allow_once", "automatic"],
    ]);
  } finally {
    unregister();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queue cancellation and timeout decisions retain their distinct audit sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-queue-"));
  const { state, agent, parentSessionFile } = makeFixture(root);
  const queue = createTeammateInteractionQueue(stubPi, state, 40);
  const replies: Array<Record<string, any>> = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { select: () => new Promise<string>(() => {}) },
  } as unknown as ExtensionContext;
  try {
    queue.enqueue(
      permissionEvent("timeout-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    queue.enqueue(
      permissionEvent("cancel-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    assert.equal(queue.cancelForAgent(agent.correlationId, "agent terminated"), 1);

    queue.enqueue(
      permissionEvent("duplicate-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    queue.enqueue(
      permissionEvent("duplicate-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    assert.equal(queue.cancelForAgent(agent.correlationId, "cleanup duplicate"), 1);
    await flushPermissionAuditWrites();

    assert.deepEqual(replies.map((reply) => reply.result.action), ["cancel", "cancel", "cancel", "cancel"]);
    const decisions = readRecords(permissionAuditFilePath(parentSessionFile)!)
      .filter((record) => record.event === "permission_decision");
    assert.deepEqual(decisions.map((record) => [record.requestId, record.source]), [
      ["timeout-request", "queue_timeout"],
      ["cancel-request", "queue_cancel"],
      ["duplicate-request", "queue_error"],
      ["duplicate-request", "queue_cancel"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queue decision latch rejects duplicate decisions when aborted UI returns or throws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-decision-once-"));
  const { state, agent, parentSessionFile } = makeFixture(root);
  const queue = createTeammateInteractionQueue(stubPi, state, 30);
  const replies: Array<Record<string, any>> = [];
  let promptIndex = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      select(_title: string, _options: string[], dialog?: { signal?: AbortSignal }) {
        const current = promptIndex;
        promptIndex += 1;
        return new Promise<string | undefined>((resolve, reject) => {
          dialog?.signal?.addEventListener("abort", () => {
            if (current === 0) resolve(undefined);
            else reject(new Error("UI aborted while closing"));
          }, { once: true });
        });
      },
    },
  } as unknown as ExtensionContext;
  try {
    queue.enqueue(
      permissionEvent("abort-return", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    queue.enqueue(
      permissionEvent("abort-throw", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      ctx,
      agent.correlationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flushPermissionAuditWrites();

    assert.equal(promptIndex, 2, "both abort completion behaviors execute in the handler");
    assert.deepEqual(replies.map((reply) => reply.result.action), ["cancel", "cancel"]);
    const decisions = readRecords(permissionAuditFilePath(parentSessionFile)!)
      .filter((record) => record.event === "permission_decision");
    assert.deepEqual(decisions.map((record) => [record.requestId, record.source]), [
      ["abort-return", "queue_timeout"],
      ["abort-throw", "queue_timeout"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an interaction admitted without a session never falls back after a session switch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-null-session-"));
  const { state, agent } = makeFixture(root);
  state.mainSessionFile = undefined;
  const queue = createTeammateInteractionQueue(stubPi, state, 1_000);
  const replies: Array<Record<string, any>> = [];
  let resolveChoice!: (choice: string) => void;
  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => { markOpened = resolve; });
  try {
    queue.enqueue(
      permissionEvent("null-session-switch", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      {
        cwd: root,
        hasUI: true,
        ui: {
          select() {
            markOpened();
            return new Promise<string>((resolve) => { resolveChoice = resolve; });
          },
        },
      } as unknown as ExtensionContext,
      agent.correlationId,
    );
    await opened;
    const replacementSessionFile = path.join(root, "replacement.jsonl");
    state.mainSessionFile = replacementSessionFile;
    resolveChoice("Deny");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPermissionAuditWrites();

    assert.equal(replies[0]?.result.action, "deny");
    assert.equal(
      fs.existsSync(permissionAuditFilePath(replacementSessionFile)!),
      false,
      "an explicit null admission must not use the later session",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an interaction keeps its admission-time parent session across a later session switch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-session-switch-"));
  const { state, agent, parentSessionFile } = makeFixture(root);
  const queue = createTeammateInteractionQueue(stubPi, state, 1_000);
  const replies: Array<Record<string, any>> = [];
  try {
    queue.enqueue(
      permissionEvent("session-switch-request", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      {
        cwd: root,
        hasUI: true,
        ui: { async select() { return "Deny"; } },
      } as unknown as ExtensionContext,
      agent.correlationId,
    );
    const replacementSessionFile = path.join(root, "replacement.jsonl");
    state.mainSessionFile = replacementSessionFile;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPermissionAuditWrites();

    assert.equal(replies[0]?.result.action, "deny");
    const records = readRecords(permissionAuditFilePath(parentSessionFile)!);
    assert.deepEqual(records.map((record) => record.event), ["permission_request", "permission_decision"]);
    assert.equal(fs.existsSync(permissionAuditFilePath(replacementSessionFile)!), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit open validation failure closes its handle and cannot block a permission reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-audit-failure-"));
  const { state, agent } = makeFixture(root);
  const replies: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const handleCloseCounts: number[] = [];
  const statFailure = new Error("injected audit handle stat failure");
  const restoreOpen = setPermissionAuditFileOpenForTests(async () => {
    const handleIndex = handleCloseCounts.push(0) - 1;
    return {
      async stat() {
        throw statFailure;
      },
      async close() {
        handleCloseCounts[handleIndex] += 1;
        assert.equal(handleCloseCounts[handleIndex], 1, "each rejected handle must close exactly once");
        throw new Error("injected audit handle close failure");
      },
    } as unknown as FileHandle;
  });
  const originalWarn = console.warn;
  try {
    console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };

    const handling = handleChildInteractionRequest(
      stubPi,
      state,
      permissionEvent("write-failure", agent.correlationId),
      (reply) => replies.push(reply as Record<string, any>),
      { hasUI: false, cwd: root } as ExtensionContext,
    );
    assert.equal(replies[0]?.result.action, "deny", "headless reply is produced before deferred I/O settles");
    await handling;
    await flushPermissionAuditWrites();

    assert.equal(replies.length, 1);
    assert.deepEqual(handleCloseCounts, [1, 1], "request and decision audit handles are both reclaimed");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /permission audit write failed/i);
    assert.match(warnings[0], /injected audit handle stat failure/);
    assert.ok(Buffer.byteLength(warnings[0], "utf8") < 1024);
  } finally {
    console.warn = originalWarn;
    restoreOpen();
    await flushPermissionAuditWrites();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
