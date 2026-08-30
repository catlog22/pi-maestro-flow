import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteConnection, RemoteConnectionFactory } from "../src/remote/driver.ts";
import type {
  RemoteInitializeParams,
  RemoteInitializeResult,
  RemoteProtocolNotification,
  RemoteRequestMethod,
  RemoteRequestParamsByMethod,
  RemoteResultByMethod,
  RemoteRunAttachParams,
  RemoteRunAttachResult,
  RemoteRunCancelParams,
  RemoteRunCancelResult,
  RemoteRunInputParams,
  RemoteRunInputResult,
  RemoteRunListResult,
  RemoteRunStartParams,
  RemoteRunStartResult,
  RemoteWindowListParams,
  RemoteWindowListResult,
  RemoteWindowObserveParams,
  RemoteWindowObserveResult,
  RemoteWindowReceiptParams,
  RemoteWindowReceiptResult,
  RemoteWindowSendParams,
  RemoteWindowSendResult,
} from "../src/remote/protocol.ts";
import type { RemoteStatus, RemoteWorkerIdentity, ResolvedRemoteWorkspace } from "../src/remote/types.ts";
import { RemoteWindowMonitor } from "../src/extension/remote-window-monitor.ts";
import {
  buildWorkspaceOwnerSnapshot,
  createWorkspacePeerIdentity,
  workspaceIdForCwd,
} from "../src/sessions/workspace-peer-core.ts";

class NotificationQueue implements AsyncIterable<RemoteProtocolNotification> {
  readonly values: RemoteProtocolNotification[] = [];
  readonly waiters: Array<(value: IteratorResult<RemoteProtocolNotification>) => void> = [];
  closed = false;

  push(value: RemoteProtocolNotification): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<RemoteProtocolNotification> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeConnection implements RemoteConnection {
  readonly status: RemoteStatus = "ready";
  identity?: RemoteWorkerIdentity;
  readonly notificationsQueue = new NotificationQueue();
  closeCount = 0;
  monitorOwnerNonce = "";
  capture = {
    workspaceRef: "prod/app",
    authorityId: "prod",
    gatewayWorkerId: "worker-1",
    gatewayInstanceNonce: "instance-1",
    monitorOwnerNonce: "monitor-1",
    workspaceId: workspaceIdForCwd("/srv/app"),
    ownerId: "b".repeat(32),
    ownerNonce: "c".repeat(32),
    generation: 1,
    transportVersion: 1 as const,
    capabilities: ["observe", "steer", "follow_up", "receipt", "reply"] as const,
    cancel: false as const,
  };

  async initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult> {
    this.monitorOwnerNonce = params.monitorOwnerNonce;
    this.capture = { ...this.capture, monitorOwnerNonce: params.monitorOwnerNonce };
    this.identity = { workerId: "worker-1", instanceNonce: "instance-1" };
    return {
      ...this.identity,
      protocolVersion: "remote/2",
      concurrency: 4,
      activeRuns: 0,
      status: "ready",
      windowBridge: {
        pluginId: "pi-maestro-teammate",
        pluginVersion: "2.2.0",
        workspacePeerVersions: [1],
        relayVersions: [1],
        runtimeVersions: [1],
      },
    };
  }

  request<Method extends RemoteRequestMethod>(
    _method: Method,
    _params: RemoteRequestParamsByMethod[Method],
  ): Promise<RemoteResultByMethod[Method]> {
    throw new Error("generic request is not used by this fake");
  }

  start(_params: RemoteRunStartParams): Promise<RemoteRunStartResult> { throw new Error("run-only method"); }
  attach(_params: RemoteRunAttachParams): Promise<RemoteRunAttachResult> { throw new Error("run-only method"); }
  input(_params: RemoteRunInputParams): Promise<RemoteRunInputResult> { throw new Error("run-only method"); }
  cancel(_params: RemoteRunCancelParams): Promise<RemoteRunCancelResult> { throw new Error("run-only method"); }
  list(_commandId: string, _monitorOwnerNonce: string): Promise<RemoteRunListResult> { return Promise.resolve({ runs: [] }); }

  windowList(_params: RemoteWindowListParams): Promise<RemoteWindowListResult> {
    return Promise.resolve({
      windows: [{
        capture: this.capture,
        sessionId: "session-1",
        sessionName: "remote-window",
        status: "running",
        agentCount: 0,
        publishedAt: Date.now(),
        cancel: false,
      }],
    });
  }

  windowObserve(_params: RemoteWindowObserveParams): Promise<RemoteWindowObserveResult> {
    const identity = createWorkspacePeerIdentity("/srv/app", {
      ownerId: this.capture.ownerId,
      ownerNonce: this.capture.ownerNonce,
    });
    const owner = buildWorkspaceOwnerSnapshot(identity, {
      agents: [],
      settled: [],
      sessionId: "session-1",
      sessionName: "remote-window",
      relay: { versions: [1], capabilities: ["receipt", "reply"] },
    });
    return Promise.resolve({
      capture: this.capture,
      owner,
      observedAt: Date.now(),
    });
  }

  windowSend(params: RemoteWindowSendParams): Promise<RemoteWindowSendResult> {
    return Promise.resolve({
      receipt: {
        capture: this.capture,
        messageId: params.messageId,
        requestedMode: params.mode,
        status: "queued",
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        relayId: "d".repeat(32),
      },
    });
  }

  windowReceipt(params: RemoteWindowReceiptParams): Promise<RemoteWindowReceiptResult> {
    if (params.direction === "incoming") return Promise.resolve({ acknowledged: true });
    return Promise.resolve({
      receipt: {
        capture: this.capture,
        messageId: params.messageId,
        requestedMode: "steer",
        status: "injected",
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        relayId: "d".repeat(32),
      },
    });
  }

  notifications(): AsyncIterable<RemoteProtocolNotification> { return this.notificationsQueue; }
  async close(): Promise<void> {
    this.closeCount += 1;
    this.notificationsQueue.close();
  }
}

function config() {
  return {
    version: 3 as const,
    hosts: {
      prod: {
        host: "prod.example",
        user: "dev",
        port: 22,
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    targets: {},
    workspaces: {
      "prod/app": {
        host: "prod",
        cwd: "/srv/app",
        requiredPlugin: "pi-maestro-teammate" as const,
        minimumWindowProtocol: 1,
      },
    },
  };
}

class FakeFactory implements RemoteConnectionFactory {
  readonly connection = new FakeConnection();
  workspace?: ResolvedRemoteWorkspace;
  connect(): Promise<RemoteConnection> { throw new Error("target connections are not used"); }
  connectWorkspace(workspace: ResolvedRemoteWorkspace): Promise<RemoteConnection> {
    this.workspace = workspace;
    return Promise.resolve(this.connection);
  }
}

test("run-only ACP, Pi-RPC, and CLI targets never become remote window endpoints", async () => {
  const factory = new FakeFactory();
  const monitor = new RemoteWindowMonitor({
    config: {
      version: 3,
      hosts: config().hosts,
      targets: {
        "prod/acp": { host: "prod", cwd: "/srv/acp", driver: "acp", command: ["/usr/bin/acp"] },
        "prod/pi-run": { host: "prod", cwd: "/srv/pi", driver: "pi-rpc", command: ["/usr/bin/pi", "--mode", "rpc"] },
      },
      workspaces: {},
    },
    connectionFactory: factory,
    monitorOwnerNonce: "monitor-1",
    isCurrent: () => true,
  });
  try {
    const listed = await monitor.list();
    assert.deepEqual(listed.windows, []);
    assert.deepEqual(listed.diagnostics, []);
    assert.equal(factory.workspace, undefined, "window discovery connected to a run-only target");
    const acpAddress = `ssh-window:prod/acp:${"b".repeat(32)}`;
    assert.equal(monitor.capture(acpAddress), undefined);
    await assert.rejects(
      monitor.observe(acpAddress),
      /run-only; use remote-worker and observe kind=remote/,
    );
  } finally {
    await monitor.close();
  }
});

test("RemoteWindowMonitor discovers exact ssh-window targets and routes observe/send/receipt", async () => {
  const factory = new FakeFactory();
  let current = true;
  const monitor = new RemoteWindowMonitor({
    config: config(),
    connectionFactory: factory,
    monitorOwnerNonce: "monitor-1",
    isCurrent: () => current,
    commandIdFactory: (() => { let id = 0; return () => `command-${++id}`; })(),
  });
  try {
    const listed = await monitor.list();
    assert.equal(listed.diagnostics.length, 0);
    assert.equal(listed.windows[0]?.target, `ssh-window:prod/app:${"b".repeat(32)}`);
    assert.equal(listed.windows[0]?.cancel, false);
    assert.equal(factory.workspace?.cwd, "/srv/app");
    const target = listed.windows[0]!.target;
    assert.equal((await monitor.observe(target)).owner.sessionName, "remote-window");
    assert.equal((await monitor.send(target, "steer", "hello", {
      messageId: "message-1",
      source: "monitor",
      messageKind: "coordination",
    })).status, "queued");
    assert.equal((await monitor.receipt(target, "message-1"))?.status, "injected");

    current = false;
    await assert.rejects(monitor.observe(target), /not current/);
  } finally {
    current = true;
    await monitor.close();
  }
  assert.equal(factory.connection.closeCount, 1);
});

test("RemoteWindowMonitor forwards only notifications matching the discovered capture", async () => {
  const factory = new FakeFactory();
  const observed: string[] = [];
  const monitor = new RemoteWindowMonitor({
    config: config(),
    connectionFactory: factory,
    monitorOwnerNonce: "monitor-1",
    isCurrent: () => true,
    onNotification: (target, notification) => observed.push(`${target}:${notification.type}`),
  });
  try {
    const target = (await monitor.list()).windows[0]!.target;
    factory.connection.notificationsQueue.push({
      jsonrpc: "2.0",
      method: "window/state",
      params: {
        type: "window/state",
        capture: factory.connection.capture,
        state: "updated",
        observedAt: Date.now(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(observed, [`${target}:window/state`]);

    factory.connection.notificationsQueue.push({
      jsonrpc: "2.0",
      method: "window/state",
      params: {
        type: "window/state",
        capture: { ...factory.connection.capture, ownerNonce: "e".repeat(32) },
        state: "unavailable",
        observedAt: Date.now(),
        reason: "owner-replaced",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(observed.length, 1);
  } finally {
    await monitor.close();
  }
});
