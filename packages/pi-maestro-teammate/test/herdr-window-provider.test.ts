import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";
import {
  HERDR_PROTOCOL,
  HERDR_RESOURCE_TOKEN,
  HERDR_VERSION,
  HerdrApiError,
  HerdrProviderError,
  HerdrRequestClient,
  HerdrRollbackError,
  closeHerdrWindowExact,
  createHerdrWindow,
  probeHerdrStatus,
  type HerdrAgentInfo,
  type HerdrExecFile,
  type HerdrPaneInfo,
  type HerdrStatus,
  type HerdrWindowCapture,
  type HerdrWindowClient,
  type HerdrWorkspaceCreated,
  type HerdrWorkspaceInfo,
} from "../src/extension/herdr-window-provider.ts";

const HERDR_082_SCHEMA_FIXTURE = {
  title: "Herdr API",
  protocol: 20,
} as const;

const STATUS: HerdrStatus = {
  running: true,
  version: HERDR_VERSION,
  protocol: HERDR_PROTOCOL,
  socket: "/local/herdr.sock",
  session: "monitor",
  compatible: true,
};

function statusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "running",
    running: true,
    version: HERDR_VERSION,
    protocol: HERDR_PROTOCOL,
    compatible: true,
    socket: "/local/herdr.sock",
    session: "monitor",
    restart_needed: false,
    ...overrides,
  });
}

function execResult(stdout: string): HerdrExecFile {
  return (_file, _args, _options, callback) => callback(null, stdout, "");
}

function providerCode(error: unknown): string | undefined {
  return error instanceof HerdrProviderError ? error.code : undefined;
}

test("provider protocol matches the Herdr 0.8.2 bundled API schema", () => {
  assert.equal(HERDR_082_SCHEMA_FIXTURE.title, "Herdr API");
  assert.equal(HERDR_PROTOCOL, HERDR_082_SCHEMA_FIXTURE.protocol);
});

test("status probe uses the exact bounded local command and maps a missing binary", async () => {
  let invocation: { file: string; args: readonly string[]; timeout: number; maxBuffer: number } | undefined;
  const missing: HerdrExecFile = (file, args, options, callback) => {
    invocation = { file, args, timeout: options.timeout, maxBuffer: options.maxBuffer };
    const error = Object.assign(new Error("secret executable path"), {
      code: "ENOENT",
      killed: false,
      signal: undefined,
      cmd: "secret",
    });
    callback(error, "", "secret stderr");
  };
  await assert.rejects(
    probeHerdrStatus("monitor", { execFile: missing, timeoutMs: 123, maxBytes: 456 }),
    (error) => providerCode(error) === "binary_missing" && !String(error).includes("secret"),
  );
  assert.deepEqual(invocation, {
    file: "herdr",
    args: ["--session", "monitor", "status", "server", "--json"],
    timeout: 123,
    maxBuffer: 456,
  });
});

test("status probe rejects a stopped server, incompatible protocol, and malformed status", async () => {
  await assert.rejects(
    probeHerdrStatus("monitor", { execFile: execResult(statusJson({
      status: "not_running", running: false, version: null, protocol: null, compatible: null,
    })) }),
    (error) => providerCode(error) === "server_down",
  );
  await assert.rejects(
    probeHerdrStatus("default", { execFile: execResult(statusJson({
      status: "not_running",
      running: false,
      version: null,
      protocol: null,
      compatible: null,
      socket: "C:\\Users\\test\\AppData\\Roaming\\herdr\\herdr.sock",
      session: null,
    })) }),
    (error) => providerCode(error) === "server_down",
  );
  await assert.rejects(
    probeHerdrStatus("monitor", { execFile: execResult(statusJson({ protocol: HERDR_PROTOCOL + 1 })) }),
    (error) => providerCode(error) === "protocol_mismatch",
  );
  await assert.rejects(
    probeHerdrStatus("monitor", { execFile: execResult("{broken") }),
    (error) => providerCode(error) === "malformed_status",
  );
});

class ScriptedSocket extends Duplex {
  readonly writes: string[] = [];

  constructor(private readonly respond: (request: Record<string, unknown>, socket: ScriptedSocket) => void) {
    super();
  }

  connect(): void {
    queueMicrotask(() => this.emit("connect"));
  }

  send(value: string | Buffer): void {
    this.push(value);
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = chunk.toString("utf8");
    this.writes.push(text);
    this.respond(JSON.parse(text), this);
    callback();
  }
}

function socketClient(
  respond: (request: Record<string, unknown>, socket: ScriptedSocket) => void,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): HerdrRequestClient {
  return new HerdrRequestClient("/local/herdr.sock", {
    ...options,
    idFactory: () => "request-1",
    connect: () => {
      const socket = new ScriptedSocket(respond);
      socket.connect();
      return socket;
    },
  });
}

test("socket client accepts one matching newline-delimited response", async () => {
  const client = socketClient((request, socket) => {
    socket.send(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
  });
  assert.deepEqual(await client.request("workspace.close", { workspace_id: "w1" }), { type: "ok" });
});

test("socket client rejects malformed, oversized, and multi-response boundaries", async () => {
  const malformed = socketClient((_request, socket) => socket.send("not-json\n"));
  await assert.rejects(malformed.request("ping", {}), (error) => providerCode(error) === "malformed_response");

  const oversized = socketClient((_request, socket) => socket.send("x".repeat(33)), { maxResponseBytes: 32 });
  await assert.rejects(oversized.request("ping", {}), (error) => providerCode(error) === "response_too_large");

  const multiple = socketClient((request, socket) => socket.send(
    `${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`,
  ));
  await assert.rejects(multiple.request("ping", {}), (error) => providerCode(error) === "response_boundary");
});

test("socket client bounds timeout and caller abort", async () => {
  const timeoutClient = socketClient(() => undefined, { timeoutMs: 10 });
  await assert.rejects(timeoutClient.request("ping", {}), (error) => providerCode(error) === "timeout");

  const controller = new AbortController();
  const abortClient = socketClient(() => queueMicrotask(() => controller.abort()));
  await assert.rejects(abortClient.request("ping", {}, controller.signal), (error) => providerCode(error) === "aborted");
});

test("socket and Herdr errors never leak request env, argv, server text, or socket errors", async () => {
  const secret = "TOP-SECRET-VALUE";
  const apiError = socketClient((request, socket) => socket.send(`${JSON.stringify({
    id: request.id,
    error: { code: "invalid_params", message: `server echoed ${secret}` },
  })}\n`));
  await assert.rejects(
    apiError.request("workspace.create", { env: { TOKEN: secret }, args: [secret] }),
    (error) => error instanceof HerdrApiError
      && error.code === "invalid_params"
      && !String(error).includes(secret),
  );

  const transport = socketClient((_request, socket) => socket.emit("error", new Error(secret)));
  await assert.rejects(
    transport.request("workspace.create", { env: { TOKEN: secret } }),
    (error) => providerCode(error) === "transport" && !String(error).includes(secret),
  );
});

function workspace(nonce = "nonce-1"): HerdrWorkspaceInfo {
  return {
    workspaceId: "w1",
    activeTabId: "w1:t1",
    focused: false,
    tokens: nonce ? { [HERDR_RESOURCE_TOKEN]: nonce } : {},
  };
}

function pane(nonce = "nonce-1", terminalId = "term-1"): HerdrPaneInfo {
  return {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId,
    focused: false,
    agent: null,
    tokens: nonce ? { [HERDR_RESOURCE_TOKEN]: nonce } : {},
  };
}

function agent(): HerdrAgentInfo {
  return {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "term-1",
    name: "worker",
    agent: "pi",
  };
}

class FakeClient implements HerdrWindowClient {
  workspaceRecord = workspace("");
  paneRecord = pane("");
  missing = false;
  closeCalls = 0;
  startCalls = 0;
  paneGets = 0;
  workspaceGets = 0;
  createdInput?: { cwd: string; label: string; env: Readonly<Record<string, string>> };
  startImpl: () => Promise<HerdrAgentInfo> = async () => agent();
  paneMetadataImpl: () => Promise<void> = async () => undefined;

  async createWorkspace(input: { cwd: string; label: string; env: Readonly<Record<string, string>> }): Promise<HerdrWorkspaceCreated> {
    this.createdInput = input;
    return { workspace: this.workspaceRecord, tabId: "w1:t1", rootPane: this.paneRecord };
  }

  async getWorkspace(): Promise<HerdrWorkspaceInfo> {
    this.workspaceGets++;
    if (this.missing) throw new HerdrApiError("workspace_not_found");
    return this.workspaceRecord;
  }

  async getPane(): Promise<HerdrPaneInfo> {
    this.paneGets++;
    return this.paneRecord;
  }

  async reportWorkspaceMetadata(_workspaceId: string, nonce: string): Promise<void> {
    this.workspaceRecord = workspace(nonce);
  }

  async reportPaneMetadata(_paneId: string, nonce: string): Promise<void> {
    await this.paneMetadataImpl();
    this.paneRecord = pane(nonce, this.paneRecord.terminalId);
  }

  async startAgent(): Promise<HerdrAgentInfo> {
    this.startCalls++;
    return this.startImpl();
  }

  async closeWorkspace(): Promise<void> {
    this.closeCalls++;
    this.missing = true;
  }
}

function capture(overrides: Partial<HerdrWindowCapture> = {}): HerdrWindowCapture {
  return {
    herdrSession: "monitor",
    herdrSocket: "/local/herdr.sock",
    herdrVersion: HERDR_VERSION,
    herdrProtocol: HERDR_PROTOCOL,
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "term-1",
    agentName: "worker",
    sessionName: "pi-worker",
    resourceNonce: "nonce-1",
    ...overrides,
  };
}

function createInput() {
  return {
    herdrSession: "monitor",
    cwd: "/project",
    agentName: "worker",
    sessionName: "pi-worker",
    piArgs: ["--mode", "rpc", "--name", "pi-worker"],
    authorize: () => true,
  };
}

function dependencies(client: FakeClient) {
  return {
    statusProbe: async () => STATUS,
    clientFactory: () => client,
    nonceFactory: () => "nonce-1",
    wait: async () => undefined,
  };
}

test("creation passes managed env only through workspace JSON and returns an exact verified capture", async () => {
  const client = new FakeClient();
  const result = await createHerdrWindow(createInput(), dependencies(client));
  assert.deepEqual(result.capture, capture());
  assert.equal(client.createdInput?.cwd, "/project");
  assert.equal(client.createdInput?.label, "worker");
  assert.equal(client.createdInput?.env.PI_TEAMMATE_MANAGED_WINDOW, "1");
  assert.equal(client.startCalls, 1);
  assert.equal(client.closeCalls, 0);
});

test("creation revalidates authority after awaits and rolls back only the captured resource", async () => {
  const client = new FakeClient();
  let checks = 0;
  const input = { ...createInput(), authorize: () => ++checks < 6 };
  await assert.rejects(createHerdrWindow(input, dependencies(client)), (error) => providerCode(error) === "authority_lost");
  assert.equal(client.closeCalls, 1);
  assert.equal(client.missing, true);
});

test("busy root shell retries only while the exact pane and terminal stay pinned", async () => {
  const client = new FakeClient();
  client.startImpl = async () => {
    if (client.startCalls === 1) throw new HerdrApiError("agent_pane_busy");
    return agent();
  };
  const result = await createHerdrWindow(createInput(), dependencies(client));
  assert.deepEqual(result.capture, capture());
  assert.equal(client.startCalls, 2);
  assert.ok(client.paneGets >= 4, "busy retry performs before-delay, after-delay, and final exact reads");
});

test("busy retry refuses a replacement terminal and rollback never closes the replacement", async () => {
  const client = new FakeClient();
  client.startImpl = async () => {
    client.paneRecord = pane("nonce-1", "term-replacement");
    throw new HerdrApiError("agent_pane_busy");
  };
  await assert.rejects(
    createHerdrWindow(createInput(), dependencies(client)),
    (error) => error instanceof HerdrRollbackError
      && error.code === "rollback_failed"
      && error.capture.workspaceId === "w1"
      && error.capture.terminalId === "term-1",
  );
  assert.equal(client.closeCalls, 0);
});

test("partial creation failure rolls back after ownership metadata was established", async () => {
  const client = new FakeClient();
  client.startImpl = async () => { throw new HerdrApiError("agent_name_taken"); };
  await assert.rejects(createHerdrWindow(createInput(), dependencies(client)), HerdrApiError);
  assert.equal(client.closeCalls, 1);
});

test("exact close verifies token and all IDs before workspace.close", async () => {
  const client = new FakeClient();
  client.workspaceRecord = workspace("nonce-1");
  client.paneRecord = pane("nonce-1");
  let closeStarted = 0;
  const result = await closeHerdrWindowExact(capture(), {
    authorize: () => true,
    onCloseStarted: () => { closeStarted++; },
  }, dependencies(client));
  assert.deepEqual(result, { status: "closed", closed: true });
  assert.equal(closeStarted, 1);
  assert.equal(client.closeCalls, 1);
});

test("exact close tolerates active-tab rotation while retaining immutable pane identity", async () => {
  const client = new FakeClient();
  client.workspaceRecord = { ...workspace("nonce-1"), activeTabId: "w1:t2" };
  client.paneRecord = pane("nonce-1");
  const result = await closeHerdrWindowExact(capture(), { authorize: () => true }, dependencies(client));
  assert.deepEqual(result, { status: "closed", closed: true });
  assert.equal(client.closeCalls, 1);
});

test("exact close revalidates authority after termination starts", async () => {
  const client = new FakeClient();
  client.workspaceRecord = workspace("nonce-1");
  client.paneRecord = pane("nonce-1");
  let authorized = true;
  await assert.rejects(
    closeHerdrWindowExact(capture(), {
      authorize: () => authorized,
      onCloseStarted: () => { authorized = false; },
    }, dependencies(client)),
    (error) => providerCode(error) === "authority_lost",
  );
  assert.equal(client.closeCalls, 1);
});

test("exact close fails closed on token or ID replacement", async () => {
  const tokenReplacement = new FakeClient();
  tokenReplacement.workspaceRecord = workspace("other-nonce");
  tokenReplacement.paneRecord = pane("nonce-1");
  await assert.rejects(
    closeHerdrWindowExact(capture(), { authorize: () => true }, dependencies(tokenReplacement)),
    (error) => providerCode(error) === "verification_failed",
  );
  assert.equal(tokenReplacement.closeCalls, 0);

  const terminalReplacement = new FakeClient();
  terminalReplacement.workspaceRecord = workspace("nonce-1");
  terminalReplacement.paneRecord = pane("nonce-1", "term-other");
  await assert.rejects(
    closeHerdrWindowExact(capture(), { authorize: () => true }, dependencies(terminalReplacement)),
    (error) => providerCode(error) === "verification_failed",
  );
  assert.equal(terminalReplacement.closeCalls, 0);
});

test("exact close reports already-exited only when the captured workspace is missing", async () => {
  const client = new FakeClient();
  client.missing = true;
  const result = await closeHerdrWindowExact(capture(), { authorize: () => true }, dependencies(client));
  assert.deepEqual(result, { status: "already-exited", closed: false });
  assert.equal(client.closeCalls, 0);
});

test("exact close refuses a changed server identity and never invokes a group close", async () => {
  const client = new FakeClient();
  client.workspaceRecord = workspace("nonce-1");
  client.paneRecord = pane("nonce-1");
  const changed = { ...STATUS, socket: "/local/replacement.sock" };
  await assert.rejects(
    closeHerdrWindowExact(capture(), { authorize: () => true }, {
      statusProbe: async () => changed,
      clientFactory: () => client,
    }),
    (error) => providerCode(error) === "verification_failed",
  );
  assert.equal(client.closeCalls, 0);
});
