import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { managedWindowSpawnEnv } from "../runs/execution-infra.ts";

export const HERDR_VERSION = "0.8.2";
export const HERDR_PROTOCOL = 20;
export const HERDR_METADATA_SOURCE = "pi-maestro-teammate";
export const HERDR_RESOURCE_TOKEN = "pi_maestro_resource";

const DEFAULT_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_STATUS_MAX_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const DEFAULT_AGENT_START_TIMEOUT_MS = 30_000;
const DEFAULT_BUSY_ATTEMPTS = 3;
const DEFAULT_BUSY_DELAY_MS = 50;

type JsonRecord = Record<string, unknown>;

export type HerdrProviderErrorCode =
  | "binary_missing"
  | "status_probe_failed"
  | "status_timeout"
  | "status_too_large"
  | "malformed_status"
  | "server_down"
  | "version_mismatch"
  | "protocol_mismatch"
  | "incompatible"
  | "aborted"
  | "timeout"
  | "response_too_large"
  | "transport"
  | "malformed_response"
  | "response_boundary"
  | "verification_failed"
  | "authority_lost"
  | "rollback_failed";

export class HerdrProviderError extends Error {
  constructor(
    public readonly code: HerdrProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HerdrProviderError";
  }
}

export class HerdrRollbackError extends HerdrProviderError {
  constructor(
    public readonly capture: HerdrWindowCapture,
    options?: ErrorOptions,
  ) {
    super(
      "rollback_failed",
      "Herdr window creation failed and exact rollback could not be proven.",
      options,
    );
    this.name = "HerdrRollbackError";
  }
}

/** A server error with a deliberately redacted message. Request parameters and server text are never retained. */
export class HerdrApiError extends Error {
  constructor(public readonly code: string) {
    super(`Herdr request failed (${code}).`);
    this.name = "HerdrApiError";
  }
}

export interface HerdrStatus {
  running: true;
  version: string;
  protocol: number;
  socket: string;
  session: string;
  compatible: true;
}

interface ExecOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}

export type HerdrExecFile = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

const runExecFile: HerdrExecFile = (file, args, options, callback) => {
  execFile(file, args, options, callback);
};

export interface HerdrStatusProbeOptions {
  execFile?: HerdrExecFile;
  timeoutMs?: number;
  maxBytes?: number;
  binary?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function own(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function statusError(error: ExecFileException): HerdrProviderError {
  if (error.code === "ENOENT") {
    return new HerdrProviderError("binary_missing", "The local Herdr binary is not installed or is not executable.");
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new HerdrProviderError("status_too_large", "The Herdr status response exceeded its byte limit.");
  }
  if (error.killed || error.signal !== null) {
    return new HerdrProviderError("status_timeout", "The Herdr status probe timed out.");
  }
  return new HerdrProviderError("status_probe_failed", "The local Herdr status probe failed.");
}

function parseStatus(stdout: string, requestedSession: string): HerdrStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HerdrProviderError("malformed_status", "Herdr returned malformed status JSON.");
  }
  if (!isRecord(parsed)
    || typeof parsed.running !== "boolean"
    || !nonEmptyString(parsed.status)
    || !nonEmptyString(parsed.socket)
    || !own(parsed, "session")
    || !own(parsed, "version")
    || !own(parsed, "protocol")
    || !own(parsed, "compatible")) {
    throw new HerdrProviderError("malformed_status", "Herdr returned an invalid status document.");
  }
  const normalizedSession = parsed.session === null && requestedSession === "default"
    ? "default"
    : parsed.session;
  if (!nonEmptyString(normalizedSession) || normalizedSession !== requestedSession) {
    throw new HerdrProviderError("malformed_status", "Herdr returned an invalid status document.");
  }
  if (!parsed.running) {
    if (parsed.status !== "not_running"
      || parsed.version !== null
      || parsed.protocol !== null
      || parsed.compatible !== null) {
      throw new HerdrProviderError("malformed_status", "Herdr returned an inconsistent stopped-server status.");
    }
    throw new HerdrProviderError("server_down", "The requested local Herdr session is not running.");
  }
  if (parsed.status !== "running" || !nonEmptyString(parsed.version)
    || !Number.isSafeInteger(parsed.protocol) || typeof parsed.compatible !== "boolean") {
    throw new HerdrProviderError("malformed_status", "Herdr returned an inconsistent running-server status.");
  }
  if (parsed.version !== HERDR_VERSION) {
    throw new HerdrProviderError("version_mismatch", `Herdr ${HERDR_VERSION} is required.`);
  }
  if (parsed.protocol !== HERDR_PROTOCOL) {
    throw new HerdrProviderError("protocol_mismatch", `Herdr protocol ${HERDR_PROTOCOL} is required.`);
  }
  if (!parsed.compatible) {
    throw new HerdrProviderError("incompatible", "The running Herdr server is not compatible with this client.");
  }
  return {
    running: true,
    version: parsed.version,
    protocol: parsed.protocol,
    socket: parsed.socket,
    session: normalizedSession,
    compatible: true,
  };
}

/** Probes only an already-running named local session. It never starts Herdr and has no SSH path. */
export function probeHerdrStatus(
  session: string,
  options: HerdrStatusProbeOptions = {},
): Promise<HerdrStatus> {
  if (!nonEmptyString(session) || /[\0\r\n]/u.test(session)) {
    return Promise.reject(new HerdrProviderError("malformed_status", "A valid local Herdr session name is required."));
  }
  const timeout = options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  const maxBuffer = options.maxBytes ?? DEFAULT_STATUS_MAX_BYTES;
  return new Promise((resolve, reject) => {
    (options.execFile ?? runExecFile)(
      options.binary ?? "herdr",
      ["--session", session, "status", "server", "--json"],
      { encoding: "utf8", timeout, maxBuffer, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(statusError(error));
          return;
        }
        try {
          resolve(parseStatus(stdout, session));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export type HerdrSocketFactory = (socketPath: string) => Duplex;

export interface HerdrRequestClientOptions {
  connect?: HerdrSocketFactory;
  timeoutMs?: number;
  maxResponseBytes?: number;
  idFactory?: () => string;
}

export interface HerdrWorkspaceInfo {
  workspaceId: string;
  activeTabId: string;
  focused: boolean;
  tokens: Readonly<Record<string, string>>;
}

export interface HerdrPaneInfo {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  focused: boolean;
  agent: string | null;
  tokens: Readonly<Record<string, string>>;
}

export interface HerdrAgentInfo {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  name: string | null;
  agent: string | null;
}

export interface HerdrWorkspaceCreated {
  workspace: HerdrWorkspaceInfo;
  tabId: string;
  rootPane: HerdrPaneInfo;
}

export interface HerdrWindowClient {
  createWorkspace(
    input: { cwd: string; label: string; env: Readonly<Record<string, string>> },
    signal?: AbortSignal,
  ): Promise<HerdrWorkspaceCreated>;
  getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<HerdrWorkspaceInfo>;
  getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPaneInfo>;
  reportWorkspaceMetadata(workspaceId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
  reportPaneMetadata(paneId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
  startAgent(
    input: { paneId: string; name: string; args: readonly string[]; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<HerdrAgentInfo>;
  closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void>;
}

function parseTokenMap(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new HerdrProviderError("malformed_response", "Herdr returned invalid resource metadata.");
  const tokens: Record<string, string> = {};
  for (const [key, token] of Object.entries(value)) {
    if (!nonEmptyString(token)) throw new HerdrProviderError("malformed_response", "Herdr returned invalid resource metadata.");
    tokens[key] = token;
  }
  return tokens;
}

function parseWorkspace(value: unknown): HerdrWorkspaceInfo {
  if (!isRecord(value) || !nonEmptyString(value.workspace_id) || !nonEmptyString(value.active_tab_id)
    || typeof value.focused !== "boolean") {
    throw new HerdrProviderError("malformed_response", "Herdr returned an invalid workspace record.");
  }
  return {
    workspaceId: value.workspace_id,
    activeTabId: value.active_tab_id,
    focused: value.focused,
    tokens: parseTokenMap(value.tokens),
  };
}

function parsePane(value: unknown): HerdrPaneInfo {
  if (!isRecord(value) || !nonEmptyString(value.workspace_id) || !nonEmptyString(value.tab_id)
    || !nonEmptyString(value.pane_id) || !nonEmptyString(value.terminal_id)
    || typeof value.focused !== "boolean"
    || !(typeof value.agent === "string" || value.agent === null || value.agent === undefined)) {
    throw new HerdrProviderError("malformed_response", "Herdr returned an invalid pane record.");
  }
  return {
    workspaceId: value.workspace_id,
    tabId: value.tab_id,
    paneId: value.pane_id,
    terminalId: value.terminal_id,
    focused: value.focused,
    agent: value.agent ?? null,
    tokens: parseTokenMap(value.tokens),
  };
}

function parseAgent(value: unknown): HerdrAgentInfo {
  if (!isRecord(value) || !nonEmptyString(value.workspace_id) || !nonEmptyString(value.tab_id)
    || !nonEmptyString(value.pane_id) || !nonEmptyString(value.terminal_id)
    || !(typeof value.name === "string" || value.name === null || value.name === undefined)
    || !(typeof value.agent === "string" || value.agent === null || value.agent === undefined)) {
    throw new HerdrProviderError("malformed_response", "Herdr returned an invalid agent record.");
  }
  return {
    workspaceId: value.workspace_id,
    tabId: value.tab_id,
    paneId: value.pane_id,
    terminalId: value.terminal_id,
    name: value.name ?? null,
    agent: value.agent ?? null,
  };
}

function parseResponseLine(line: Buffer, expectedId: string): JsonRecord {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw new HerdrProviderError("malformed_response", "Herdr returned non-UTF-8 response data.");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new HerdrProviderError("malformed_response", "Herdr returned malformed response JSON.");
  }
  if (!isRecord(value) || value.id !== expectedId) {
    throw new HerdrProviderError("malformed_response", "Herdr returned a response with an invalid request boundary.");
  }
  const hasResult = own(value, "result");
  const hasError = own(value, "error");
  if (hasResult === hasError) {
    throw new HerdrProviderError("malformed_response", "Herdr returned an invalid response envelope.");
  }
  if (hasError) {
    if (!isRecord(value.error) || !nonEmptyString(value.error.code)
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.error.code)
      || !nonEmptyString(value.error.message)) {
      throw new HerdrProviderError("malformed_response", "Herdr returned an invalid error envelope.");
    }
    throw new HerdrApiError(value.error.code);
  }
  if (!isRecord(value.result) || !nonEmptyString(value.result.type)) {
    throw new HerdrProviderError("malformed_response", "Herdr returned an invalid success envelope.");
  }
  return value.result;
}

export class HerdrRequestClient implements HerdrWindowClient {
  readonly #socketPath: string;
  readonly #connect: HerdrSocketFactory;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #idFactory: () => string;

  constructor(socketPath: string, options: HerdrRequestClientOptions = {}) {
    if (!nonEmptyString(socketPath) || /[\0\r\n]/u.test(socketPath)) {
      throw new HerdrProviderError("transport", "A valid local Herdr socket path is required.");
    }
    this.#socketPath = socketPath;
    this.#connect = options.connect ?? ((path) => net.createConnection(path));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_MAX_BYTES;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  request(method: string, params: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    if (signal?.aborted) return Promise.reject(new HerdrProviderError("aborted", "Herdr request aborted."));
    const id = this.#idFactory();
    const encoded = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      let socket: Duplex;
      try {
        socket = this.#connect(this.#socketPath);
      } catch {
        reject(new HerdrProviderError("transport", "Could not connect to the local Herdr socket."));
        return;
      }
      let settled = false;
      let received = Buffer.alloc(0);
      const timer = setTimeout(() => finish(new HerdrProviderError("timeout", "Herdr request timed out.")), this.#timeoutMs);
      const onAbort = () => finish(new HerdrProviderError("aborted", "Herdr request aborted."));
      const onConnect = () => {
        try {
          socket.write(encoded);
        } catch {
          finish(new HerdrProviderError("transport", "Could not write to the local Herdr socket."));
        }
      };
      const onError = () => finish(new HerdrProviderError("transport", "The local Herdr socket failed."));
      const onClose = () => {
        if (!settled) finish(new HerdrProviderError("transport", "The local Herdr socket closed before responding."));
      };
      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (received.length + next.length > this.#maxResponseBytes) {
          finish(new HerdrProviderError("response_too_large", "Herdr response exceeded its byte limit."));
          return;
        }
        received = Buffer.concat([received, next]);
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        const trailing = received.subarray(newline + 1).toString("utf8");
        if (trailing.trim().length > 0) {
          finish(new HerdrProviderError("response_boundary", "Herdr returned more than one response."));
          return;
        }
        try {
          finish(undefined, parseResponseLine(received.subarray(0, newline), id));
        } catch (error) {
          finish(error);
        }
      };
      const finish = (error?: unknown, result?: JsonRecord) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("connect", onConnect);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.destroy();
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolve(result);
        else reject(new HerdrProviderError("malformed_response", "Herdr returned no response."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  async createWorkspace(
    input: { cwd: string; label: string; env: Readonly<Record<string, string>> },
    signal?: AbortSignal,
  ): Promise<HerdrWorkspaceCreated> {
    const result = await this.request("workspace.create", {
      cwd: input.cwd,
      label: input.label,
      env: input.env,
      focus: false,
    }, signal);
    if (result.type !== "workspace_created" || !isRecord(result.tab) || !nonEmptyString(result.tab.tab_id)) {
      throw new HerdrProviderError("malformed_response", "Herdr returned an invalid workspace creation result.");
    }
    return { workspace: parseWorkspace(result.workspace), tabId: result.tab.tab_id, rootPane: parsePane(result.root_pane) };
  }

  async getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<HerdrWorkspaceInfo> {
    const result = await this.request("workspace.get", { workspace_id: workspaceId }, signal);
    if (result.type !== "workspace_info") throw new HerdrProviderError("malformed_response", "Herdr returned the wrong workspace result.");
    return parseWorkspace(result.workspace);
  }

  async getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPaneInfo> {
    const result = await this.request("pane.get", { pane_id: paneId }, signal);
    if (result.type !== "pane_info") throw new HerdrProviderError("malformed_response", "Herdr returned the wrong pane result.");
    return parsePane(result.pane);
  }

  async reportWorkspaceMetadata(workspaceId: string, resourceNonce: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request("workspace.report_metadata", {
      workspace_id: workspaceId,
      source: HERDR_METADATA_SOURCE,
      tokens: { [HERDR_RESOURCE_TOKEN]: resourceNonce },
    }, signal);
    if (result.type !== "ok") throw new HerdrProviderError("malformed_response", "Herdr rejected workspace metadata reporting.");
  }

  async reportPaneMetadata(paneId: string, resourceNonce: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request("pane.report_metadata", {
      pane_id: paneId,
      source: HERDR_METADATA_SOURCE,
      tokens: { [HERDR_RESOURCE_TOKEN]: resourceNonce },
    }, signal);
    if (result.type !== "ok") throw new HerdrProviderError("malformed_response", "Herdr rejected pane metadata reporting.");
  }

  async startAgent(
    input: { paneId: string; name: string; args: readonly string[]; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<HerdrAgentInfo> {
    const result = await this.request("agent.start", {
      pane_id: input.paneId,
      name: input.name,
      kind: "pi",
      args: [...input.args],
      timeout_ms: input.timeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS,
    }, signal);
    const argv = result.argv;
    if (result.type !== "agent_started" || !Array.isArray(argv)
      || argv.some((argument) => typeof argument !== "string")
      || argv.length !== input.args.length + 1
      || argv[0] !== "pi"
      || input.args.some((argument, index) => argv[index + 1] !== argument)) {
      throw new HerdrProviderError("malformed_response", "Herdr returned an invalid agent start result.");
    }
    return parseAgent(result.agent);
  }

  async closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request("workspace.close", { workspace_id: workspaceId }, signal);
    if (result.type !== "ok") throw new HerdrProviderError("malformed_response", "Herdr returned an invalid workspace close result.");
  }
}

export interface HerdrWindowCapture {
  herdrSession: string;
  herdrSocket: string;
  herdrVersion: string;
  herdrProtocol: number;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName: string;
  sessionName: string;
  resourceNonce: string;
}

export interface CreateHerdrWindowInput {
  herdrSession: string;
  cwd: string;
  agentName: string;
  sessionName: string;
  piArgs: readonly string[];
  /** Generation/root fence. Checked before and after every await until the capture is returned. */
  authorize: () => boolean;
  signal?: AbortSignal;
}

export interface HerdrWindowProviderDependencies {
  statusProbe?: (session: string) => Promise<HerdrStatus>;
  clientFactory?: (status: HerdrStatus) => HerdrWindowClient;
  nonceFactory?: () => string;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  busyAttempts?: number;
  busyDelayMs?: number;
}

export interface CreateHerdrWindowResult {
  capture: HerdrWindowCapture;
}

function assertAuthorized(authorize: () => boolean): void {
  if (!authorize()) throw new HerdrProviderError("authority_lost", "Herdr window authority changed during the operation.");
}

function assertPiSessionArgs(args: readonly string[], sessionName: string): void {
  let matchingName = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--name" && args[index + 1] === sessionName) matchingName = true;
  }
  if (!matchingName) {
    throw new HerdrProviderError("verification_failed", "The supplied Pi arguments do not bind the requested session name.");
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function assertWorkspaceExact(workspace: HerdrWorkspaceInfo, capture: HerdrWindowCapture): void {
  if (workspace.workspaceId !== capture.workspaceId
    || workspace.tokens[HERDR_RESOURCE_TOKEN] !== capture.resourceNonce) {
    throw new HerdrProviderError("verification_failed", "Herdr workspace ownership could not be proven.");
  }
}

function assertPaneExact(pane: HerdrPaneInfo, capture: HerdrWindowCapture): void {
  if (pane.workspaceId !== capture.workspaceId
    || pane.tabId !== capture.tabId
    || pane.paneId !== capture.paneId
    || pane.terminalId !== capture.terminalId
    || pane.tokens[HERDR_RESOURCE_TOKEN] !== capture.resourceNonce) {
    throw new HerdrProviderError("verification_failed", "Herdr pane ownership could not be proven.");
  }
}

function assertAgentExact(agent: HerdrAgentInfo, capture: HerdrWindowCapture): void {
  if (agent.workspaceId !== capture.workspaceId
    || agent.tabId !== capture.tabId
    || agent.paneId !== capture.paneId
    || agent.terminalId !== capture.terminalId
    || agent.name !== capture.agentName
    || agent.agent !== "pi") {
    throw new HerdrProviderError("verification_failed", "Herdr agent ownership could not be proven.");
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new HerdrProviderError("aborted", "Herdr request aborted."));
  return new Promise((resolve, reject) => {
    const onComplete = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onComplete, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new HerdrProviderError("aborted", "Herdr request aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sameStatus(status: HerdrStatus, capture: HerdrWindowCapture): boolean {
  return status.session === capture.herdrSession
    && status.socket === capture.herdrSocket
    && status.version === capture.herdrVersion
    && status.protocol === capture.herdrProtocol;
}

export async function createHerdrWindow(
  input: CreateHerdrWindowInput,
  dependencies: HerdrWindowProviderDependencies = {},
): Promise<CreateHerdrWindowResult> {
  assertPiSessionArgs(input.piArgs, input.sessionName);
  assertAuthorized(input.authorize);
  const statusProbe = dependencies.statusProbe ?? ((session) => probeHerdrStatus(session));
  const status = await statusProbe(input.herdrSession);
  assertAuthorized(input.authorize);
  const client = (dependencies.clientFactory ?? ((current) => new HerdrRequestClient(current.socket)))(status);
  const resourceNonce = (dependencies.nonceFactory ?? randomUUID)();
  if (!nonEmptyString(resourceNonce) || resourceNonce.length > 80 || /[\0\r\n]/u.test(resourceNonce)) {
    throw new HerdrProviderError("verification_failed", "The Herdr resource nonce is invalid.");
  }

  let capture: HerdrWindowCapture | undefined;
  try {
    assertAuthorized(input.authorize);
    const created = await client.createWorkspace({
      cwd: input.cwd,
      label: input.agentName,
      env: stringEnvironment(managedWindowSpawnEnv()),
    }, input.signal);
    assertAuthorized(input.authorize);
    if (created.workspace.focused || created.workspace.workspaceId !== created.rootPane.workspaceId
      || created.workspace.activeTabId !== created.tabId || created.tabId !== created.rootPane.tabId) {
      throw new HerdrProviderError("verification_failed", "Herdr did not create the requested unfocused exact workspace.");
    }
    capture = {
      herdrSession: status.session,
      herdrSocket: status.socket,
      herdrVersion: status.version,
      herdrProtocol: status.protocol,
      workspaceId: created.workspace.workspaceId,
      tabId: created.tabId,
      paneId: created.rootPane.paneId,
      terminalId: created.rootPane.terminalId,
      agentName: input.agentName,
      sessionName: input.sessionName,
      resourceNonce,
    };

    await client.reportWorkspaceMetadata(capture.workspaceId, resourceNonce, input.signal);
    assertAuthorized(input.authorize);
    await client.reportPaneMetadata(capture.paneId, resourceNonce, input.signal);
    assertAuthorized(input.authorize);
    const workspace = await client.getWorkspace(capture.workspaceId, input.signal);
    assertAuthorized(input.authorize);
    assertWorkspaceExact(workspace, capture);
    const pane = await client.getPane(capture.paneId, input.signal);
    assertAuthorized(input.authorize);
    assertPaneExact(pane, capture);

    const attempts = dependencies.busyAttempts ?? DEFAULT_BUSY_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        const agent = await client.startAgent({
          paneId: capture.paneId,
          name: capture.agentName,
          args: input.piArgs,
        }, input.signal);
        assertAuthorized(input.authorize);
        assertAgentExact(agent, capture);
        break;
      } catch (error) {
        if (!(error instanceof HerdrApiError) || error.code !== "agent_pane_busy" || attempt >= attempts) throw error;
        assertAuthorized(input.authorize);
        const currentPane = await client.getPane(capture.paneId, input.signal);
        assertAuthorized(input.authorize);
        assertPaneExact(currentPane, capture);
        await (dependencies.wait ?? delay)(dependencies.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS, input.signal);
        assertAuthorized(input.authorize);
        const pinnedPane = await client.getPane(capture.paneId, input.signal);
        assertAuthorized(input.authorize);
        assertPaneExact(pinnedPane, capture);
      }
    }

    const finalWorkspace = await client.getWorkspace(capture.workspaceId, input.signal);
    assertAuthorized(input.authorize);
    assertWorkspaceExact(finalWorkspace, capture);
    const finalPane = await client.getPane(capture.paneId, input.signal);
    assertAuthorized(input.authorize);
    assertPaneExact(finalPane, capture);
    return { capture };
  } catch (error) {
    if (!capture) throw error;
    try {
      // Rollback has its own bounded requests and must still run when the caller signal caused the failure.
      await closeHerdrWindowExact(capture, { authorize: () => true }, dependencies);
    } catch (rollbackError) {
      throw new HerdrRollbackError(capture, { cause: rollbackError });
    }
    throw error;
  }
}

export interface CloseHerdrWindowOptions {
  authorize: () => boolean;
  signal?: AbortSignal;
  onCloseStarted?: () => void;
}

export interface CloseHerdrWindowResult {
  status: "closed" | "already-exited";
  closed: boolean;
}

function isWorkspaceMissing(error: unknown): boolean {
  return error instanceof HerdrApiError && error.code === "workspace_not_found";
}

/** Closes only workspace.close after re-proving the nonce and every captured Herdr ID. */
export async function closeHerdrWindowExact(
  capture: HerdrWindowCapture,
  options: CloseHerdrWindowOptions,
  dependencies: HerdrWindowProviderDependencies = {},
): Promise<CloseHerdrWindowResult> {
  assertAuthorized(options.authorize);
  const statusProbe = dependencies.statusProbe ?? ((session) => probeHerdrStatus(session));
  const status = await statusProbe(capture.herdrSession);
  assertAuthorized(options.authorize);
  if (!sameStatus(status, capture)) {
    throw new HerdrProviderError("verification_failed", "The captured Herdr server identity changed.");
  }
  const client = (dependencies.clientFactory ?? ((current) => new HerdrRequestClient(current.socket)))(status);
  let workspace: HerdrWorkspaceInfo;
  try {
    workspace = await client.getWorkspace(capture.workspaceId, options.signal);
  } catch (error) {
    assertAuthorized(options.authorize);
    if (isWorkspaceMissing(error)) return { status: "already-exited", closed: false };
    throw error;
  }
  assertAuthorized(options.authorize);
  assertWorkspaceExact(workspace, capture);
  const pane = await client.getPane(capture.paneId, options.signal);
  assertAuthorized(options.authorize);
  assertPaneExact(pane, capture);
  assertAuthorized(options.authorize);
  options.onCloseStarted?.();
  try {
    await client.closeWorkspace(capture.workspaceId, options.signal);
  } catch (error) {
    assertAuthorized(options.authorize);
    if (isWorkspaceMissing(error)) return { status: "already-exited", closed: false };
    throw error;
  }
  assertAuthorized(options.authorize);
  return { status: "closed", closed: true };
}
