import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

/**
 * BrowserBridgeServer — the pi side of the optional Chrome extension bridge.
 *
 * The bridge can execute page JavaScript and raw CDP, so binding to localhost is
 * not an authorization boundary. The server creates an owner-only config file
 * containing a random token and requires that token in the first WebSocket
 * frame. No extension message is processed before authentication succeeds.
 *
 * The extension keeps the command protocol unchanged after authentication.
 * The actual port is also written to a legacy discovery file, but that file is
 * never installation or connectivity evidence. New installs copy both port and
 * token from the owner-only config file and use browser status for live state.
 */

const DEFAULT_PORT = 19222;
const BRIDGE_DIRECTORY = process.env.PI_BROWSER_BRIDGE_DIR?.trim() || path.join(os.homedir(), ".pi");
const ANCHOR_ENV = "PI_BROWSER_BRIDGE_PORT";
const AUTH_TIMEOUT_MS = 5_000;
const PAIRING_TTL_MS = 120_000;
const CANCEL_ACK_TIMEOUT_MS = 1_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

type BridgeStatus = "disconnected" | "connecting" | "connected";
type TabsMethod = "query" | "switch" | "create" | "get" | "update" | "close";

type BridgeCommandTerminalStatus =
  | "result"
  | "error"
  | "cancelled"
  | "disconnected"
  | "replaced"
  | "shutdown"
  | "send_failed";

interface BridgeCommandTerminal {
  status: BridgeCommandTerminalStatus;
  result?: BridgeResult;
  error?: Error;
}

interface BridgeCancelAck {
  stopped: boolean;
}

interface TrackedBridgeCommand {
  id: string;
  connection: BridgeConnectionIdentity;
  response: Promise<BridgeResult>;
  terminal: Promise<BridgeCommandTerminal>;
  cancel: () => Promise<BridgeCancelAck>;
}

interface PendingCancellation {
  promise: Promise<BridgeCancelAck>;
  resolve: (value: BridgeCancelAck) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TrackedCommandRecord {
  id: string;
  cmd: string;
  socket: WebSocket;
  connection: BridgeConnectionIdentity;
  responseSettled: boolean;
  responseResolve: (value: BridgeResult) => void;
  responseReject: (error: Error) => void;
  responseTimer: NodeJS.Timeout | null;
  terminalResolve: (value: BridgeCommandTerminal) => void;
  cancellation: PendingCancellation | null;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  results?: unknown[];
  error?: string;
  newTabs?: Array<{ id?: number; url?: string; title?: string }>;
}

interface AuthMessage {
  type: "auth";
  token: string;
}
interface PairingRequestMessage {
  type: "pairing_request";
  origin?: string;
  installationId?: string;
}
interface ExtReadyMessage {
  type: "ext_ready" | "tabs_update";
  tabs?: Array<{ id: number; url: string; title?: string }>;
}
interface ResultMessage {
  type: "result" | "error";
  id: string;
  data?: unknown;
  results?: unknown[];
  error?: string;
  newTabs?: Array<{ id?: number; url?: string; title?: string }>;
}
interface AckMessage {
  type: "ack";
  id: string;
}
interface CancelAckMessage {
  type: "cancel_ack";
  id: string;
  stopped: boolean;
}
interface PingMessage {
  type: "ping";
}
type IncomingMessage = ExtReadyMessage | ResultMessage | AckMessage | CancelAckMessage | PingMessage;

interface BridgeTab {
  id: number;
  url: string;
  title?: string;
}

interface StoredBridgeConfig {
  version: 1;
  port: number;
  token: string;
  installationId?: string;
}

interface BridgeConfig extends StoredBridgeConfig {
  installationId: string;
}

interface BridgeConnectionIdentity {
  installationId: string;
  generation: number;
}

interface AuthenticatedConnection extends BridgeConnectionIdentity {
  socket: WebSocket;
}

interface SocketSession {
  generation: number;
  authenticated: boolean;
  firstFrameSeen: boolean;
  pairingRequestId: string | null;
}

interface PairingRequest {
  requestId: string;
  code: string;
  expiresAt: number;
  socket: WebSocket;
  generation: number;
  origin?: string;
  installationId?: string;
  approving: boolean;
  timer: NodeJS.Timeout;
}

interface PairingRequestInfo {
  requestId: string;
  code: string;
  expiresAt: number;
  generation: number;
  origin?: string;
  installationId?: string;
}

interface BridgePersistencePaths {
  configFile: string;
  portFile: string;
}

interface BrowserBridgeServerOptions {
  directory?: string;
  anchorPort?: number;
  pairingTtlMs?: number;
  cancelAckTimeoutMs?: number;
  persistConfig?: (config: BridgeConfig, paths: BridgePersistencePaths, signal: AbortSignal) => Promise<void>;
}

interface ProvisionalStartAttempt {
  generation: number;
  controller: AbortController;
  server: WebSocketServer | null;
  closePromise: Promise<void> | null;
}

class BrowserBridgeServer {
  #server: WebSocketServer | null = null;
  #connection: AuthenticatedConnection | null = null;
  #connections = new Set<WebSocket>();
  #socketSessions = new Map<WebSocket, SocketSession>();
  #authenticationTimers = new Map<WebSocket, NodeJS.Timeout>();
  #pairingRequests = new Map<string, PairingRequest>();
  #port: number | null = null;
  #token: string | null = null;
  #installationId: string | null = null;
  #status: BridgeStatus = "disconnected";
  #pending = new Map<string, TrackedCommandRecord>();
  #connectionWaiters = new Set<ConnectionWaiter>();
  #tabs: BridgeTab[] = [];
  #startPromise: Promise<void> | null = null;
  #startAttempt: ProvisionalStartAttempt | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #defaultTabId: number | null = null;
  #serverGeneration = 0;
  #connectionGeneration = 0;
  #socketGeneration = 0;
  readonly #directory: string;
  readonly #configFile: string;
  readonly #portFile: string;
  readonly #verifiedInstallFile: string;
  readonly #anchorPort: number;
  readonly #pairingTtlMs: number;
  readonly #cancelAckTimeoutMs: number;
  readonly #persistConfig: (config: BridgeConfig, paths: BridgePersistencePaths, signal: AbortSignal) => Promise<void>;

  constructor(options: BrowserBridgeServerOptions = {}) {
    this.#directory = options.directory?.trim() || BRIDGE_DIRECTORY;
    this.#configFile = path.join(this.#directory, "browser-bridge.json");
    this.#portFile = path.join(this.#directory, "browser-bridge.port");
    this.#verifiedInstallFile = path.join(this.#directory, "browser-bridge.verified");
    const envPort = Number(process.env[ANCHOR_ENV]);
    const configuredPort = Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
    this.#anchorPort = options.anchorPort ?? configuredPort;
    this.#pairingTtlMs = positiveDuration(options.pairingTtlMs, PAIRING_TTL_MS, "pairing TTL");
    this.#cancelAckTimeoutMs = positiveDuration(options.cancelAckTimeoutMs, CANCEL_ACK_TIMEOUT_MS, "cancel acknowledgement timeout");
    this.#persistConfig = options.persistConfig ?? persistBridgeConfig;
  }

  /** Current authenticated connection state. */
  status(): BridgeStatus {
    return this.#status;
  }

  /** The bound loopback port, or null while the server is stopped. */
  listeningPort(): number | null {
    return this.#port;
  }

  /** A bridge extension completed the token handshake and is reachable. */
  isConnected(): boolean {
    return this.#status === "connected" && this.#connection !== null && this.#connection.socket.readyState === WebSocket.OPEN;
  }

  /** Capture the authenticated installation/generation identity for generation-owned work. */
  connectionIdentity(): BridgeConnectionIdentity | null {
    if (!this.isConnected() || !this.#connection) return null;
    return {
      installationId: this.#connection.installationId,
      generation: this.#connection.generation,
    };
  }

  /** Short-lived pairing proposals. Sockets remain command-inert until approved. */
  pairingRequests(): PairingRequestInfo[] {
    const now = Date.now();
    return [...this.#pairingRequests.values()]
      .filter((request) => request.expiresAt > now)
      .map(({ requestId, code, expiresAt, generation, origin, installationId }) => ({
        requestId,
        code,
        expiresAt,
        generation,
        ...(origin ? { origin } : {}),
        ...(installationId ? { installationId } : {}),
      }));
  }

  /** Promote exactly one live pairing request after code verification. */
  async approvePairing(requestId: string, code: string): Promise<BridgeConnectionIdentity> {
    const request = this.#pairingRequests.get(requestId);
    if (!request || request.expiresAt <= Date.now()) {
      if (request) this.#expirePairingRequest(request, "pairing request expired");
      throw new Error("browser-bridge pairing request is missing or expired");
    }
    if (!pairingCodesEqual(code, request.code)) throw new Error("browser-bridge pairing code does not match");
    if (request.approving) throw new Error("browser-bridge pairing request approval is already in progress");
    const session = this.#socketSessions.get(request.socket);
    if (
      !session
      || session.generation !== request.generation
      || session.pairingRequestId !== request.requestId
      || request.socket.readyState !== WebSocket.OPEN
    ) {
      this.#removePairingRequest(request);
      throw new Error("browser-bridge pairing request socket generation is no longer live");
    }

    // Verified-marker persistence is the approval commit boundary. The awaited
    // operation revalidates server/socket generation before command authority is
    // published or credentials are returned to the extension.
    request.approving = true;
    let accepted: boolean;
    try {
      accepted = await this.#acceptAuthenticatedSocket(request.socket, "pairing-v1");
    } catch (error) {
      this.#expirePairingRequest(request, "pairing approval failed");
      throw error;
    }
    const currentSession = this.#socketSessions.get(request.socket);
    if (
      !accepted
      || currentSession !== session
      || currentSession.generation !== request.generation
      || this.#pairingRequests.get(requestId) !== request
      || request.expiresAt <= Date.now()
      || this.#connection?.socket !== request.socket
      || !this.#token
    ) {
      this.#expirePairingRequest(request, "pairing request revoked during approval");
      throw new Error("browser-bridge pairing request was revoked during approval");
    }

    currentSession.authenticated = true;
    this.#removePairingRequest(request);
    try {
      request.socket.send(JSON.stringify({
        type: "pairing_approved",
        requestId,
        token: this.#token,
      }));
    } catch (error) {
      request.socket.terminate();
      throw new Error(`browser-bridge could not publish pairing approval: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const waiter of [...this.#connectionWaiters]) waiter.resolve();
    const identity = this.connectionIdentity();
    if (!identity) throw new Error("browser-bridge pairing approval lost its connection generation");
    return identity;
  }

  /** Reject one pending pairing proposal without affecting authenticated work. */
  rejectPairing(requestId: string): boolean {
    const request = this.#pairingRequests.get(requestId);
    if (!request) return false;
    this.#expirePairingRequest(request, "pairing request rejected");
    return true;
  }

  /** Fail closed unless identity still names the currently authenticated transport. */
  assertConnection(identity: BridgeConnectionIdentity): void {
    const current = this.#connection;
    if (
      !this.isConnected()
      || !current
      || current.installationId !== identity.installationId
      || current.generation !== identity.generation
    ) {
      const actual = current && current.socket.readyState === WebSocket.OPEN
        ? `${current.installationId}/${current.generation}`
        : "disconnected";
      throw new Error(
        `browser-bridge connection generation mismatch: expected ${identity.installationId}/${identity.generation}, current ${actual}`,
      );
    }
  }

  /** Tabs the authenticated bridge last reported (across all browser windows). */
  tabs(): BridgeTab[] {
    return this.#tabs.map((tab) => ({ ...tab }));
  }

  /** The default tab id to target when none is specified (first reported). */
  defaultTabId(): number | null {
    return this.#defaultTabId ?? this.#tabs[0]?.id ?? null;
  }

  /** Resolve a tab id: explicit, or the default, or the first match of a url substring/target. */
  resolveTabId(tabId?: number, target?: string): number {
    if (typeof tabId === "number") return tabId;
    if (target) {
      const needle = target.toLowerCase();
      const match = this.#tabs.find((tab) => tab.url.toLowerCase().includes(needle) || (tab.title ?? "").toLowerCase().includes(needle));
      if (match) return match.id;
    }
    const fallback = this.defaultTabId();
    if (fallback !== null) return fallback;
    throw new Error("browser-bridge: no authenticated tab connected. Configure the extension with the port and token from ~/.pi/browser-bridge.json.");
  }

  /** Lazily start the loopback WebSocket server (idempotent and restartable after shutdown). */
  async start(): Promise<void> {
    if (this.#shutdownPromise) await this.#shutdownPromise;
    if (!this.#startPromise) {
      const startAttempt: ProvisionalStartAttempt = {
        generation: ++this.#serverGeneration,
        controller: new AbortController(),
        server: null,
        closePromise: null,
      };
      const promise = this.#start(startAttempt);
      this.#startAttempt = startAttempt;
      this.#startPromise = promise;
      void promise.then(
        () => {
          if (this.#startAttempt === startAttempt) this.#startAttempt = null;
        },
        () => {
          if (this.#startAttempt === startAttempt) this.#startAttempt = null;
          if (this.#startPromise === promise) this.#startPromise = null;
        },
      );
    }
    return this.#startPromise;
  }

  async #start(attempt: ProvisionalStartAttempt): Promise<void> {
    const { generation, controller } = attempt;
    await ensurePrivateDirectory(this.#directory);
    this.#assertStartGeneration(generation);
    const existingConfig = await readBridgeConfig(this.#configFile);
    this.#assertStartGeneration(generation);
    const token = existingConfig?.token ?? randomBytes(32).toString("base64url");
    const installationId = existingConfig?.installationId ?? randomUUID();
    const port = await findFreePort(this.#anchorPort);
    this.#assertStartGeneration(generation);
    const server = new WebSocketServer({
      port,
      host: "127.0.0.1",
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    attempt.server = server;
    server.on("connection", (socket) => this.#handleConnection(socket));

    try {
      await abortableStartBoundary(waitForListening(server), controller.signal);
      this.#assertStartGeneration(generation);
      const config = { version: 1, port, token, installationId } satisfies BridgeConfig;
      const persistence = this.#persistConfig(
        config,
        { configFile: this.#configFile, portFile: this.#portFile },
        controller.signal,
      );
      // A custom persistence implementation may ignore AbortSignal forever.
      // Race its publication-capable continuation against revocation, while the
      // attached rejection handler fences all late completion from this method.
      await abortableStartBoundary(persistence, controller.signal);
      this.#assertStartGeneration(generation);
      // Publish the live listener and credentials only after both persistence
      // boundaries commit for this exact start generation.
      this.#server = server;
      this.#port = port;
      this.#token = token;
      this.#installationId = installationId;
      this.#status = "disconnected";
      attempt.server = null;
    } catch (error) {
      await this.#cleanupFailedStart(attempt, error);
      throw error;
    }
  }

  #assertStartGeneration(generation: number): void {
    if (this.#serverGeneration !== generation) {
      throw new Error("browser-bridge start generation was revoked");
    }
  }

  /** Wait for a token-verified extension connection, rejecting after timeoutMs. */
  async waitUntilConnected(timeoutMs = 15_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("browser-bridge wait timeout must be greater than zero");
    await this.start();
    if (this.isConnected()) return;
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.#connectionWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.#connectionWaiters.delete(waiter);
          reject(error);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        waiter.reject(new Error(
          `browser-bridge: no authenticated extension connected within ${timeoutMs}ms. Configure both port and token from ${this.#configFile}.`,
        ));
      }, timeoutMs);
      this.#connectionWaiters.add(waiter);
      // Close the race between the check above and registering the waiter.
      if (this.isConnected()) waiter.resolve();
    });
  }

  #handleConnection(socket: WebSocket): void {
    this.#connections.add(socket);
    const session: SocketSession = {
      generation: ++this.#socketGeneration,
      authenticated: false,
      firstFrameSeen: false,
      pairingRequestId: null,
    };
    this.#socketSessions.set(socket, session);
    // An accepted socket is not visible live state until canonical persistence
    // publishes this listener generation.
    if (this.#server && !this.isConnected()) this.#status = "connecting";

    const authenticationTimer = setTimeout(() => {
      if (!session.authenticated && !session.pairingRequestId) this.#rejectUnauthenticated(socket, "authentication timeout");
    }, AUTH_TIMEOUT_MS);
    this.#authenticationTimers.set(socket, authenticationTimer);

    socket.on("message", (raw, isBinary) => {
      const text = raw.toString();
      if (!session.authenticated) {
        if (session.firstFrameSeen || isBinary) {
          this.#rejectUnauthenticated(socket, session.pairingRequestId
            ? "pairing socket has no command authority before approval"
            : "authentication must be the first text frame");
          return;
        }
        session.firstFrameSeen = true;
        let message: AuthMessage | PairingRequestMessage | null = null;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (parsed?.type === "auth" && typeof parsed.token === "string") message = parsed as unknown as AuthMessage;
          else if (parsed?.type === "pairing_request") message = parsed as unknown as PairingRequestMessage;
        } catch {
          // Rejected below without exposing parser details to an unauthenticated peer.
        }
        if (message?.type === "pairing_request") {
          this.#registerPairingRequest(socket, session, message);
          return;
        }
        if (!message || message.type !== "auth" || !this.#token || !tokensEqual(message.token, this.#token)) {
          this.#rejectUnauthenticated(socket, "invalid browser bridge token");
          return;
        }
        // The extension waits for auth_ok before sending ext_ready, so no later
        // frame can race through while the verified marker is being persisted.
        void this.#acceptAuthenticatedSocket(socket, "first-frame-token-v1").then((accepted) => {
          const current = this.#socketSessions.get(socket);
          if (current !== session || current.generation !== session.generation) return;
          // Flip the per-socket gate before auth_ok can cause the extension to
          // send ext_ready in the next event-loop turn.
          session.authenticated = accepted;
          if (!accepted) return;
          try {
            socket.send(JSON.stringify({ type: "auth_ok" }));
          } catch {
            session.authenticated = false;
            socket.terminate();
            return;
          }
          for (const waiter of [...this.#connectionWaiters]) waiter.resolve();
        }).catch(() => this.#rejectUnauthenticated(socket, "authentication persistence failed", 1011));
        return;
      }
      this.#handleMessage(socket, text);
    });

    socket.on("close", () => {
      this.#connections.delete(socket);
      this.#socketSessions.delete(socket);
      this.#clearAuthenticationTimer(socket);
      if (session.pairingRequestId) {
        const pairing = this.#pairingRequests.get(session.pairingRequestId);
        if (pairing?.socket === socket && pairing.generation === session.generation) this.#removePairingRequest(pairing);
      }
      if (this.#connection?.socket === socket) {
        const connection = this.#connection;
        this.#connection = null;
        this.#tabs = [];
        this.#defaultTabId = null;
        this.#status = this.#connections.size > 0 && this.#server ? "connecting" : "disconnected";
        this.#terminateCommandsForConnection(connection, "disconnected", new Error("browser-bridge disconnected"));
      } else if (!this.#connection) {
        this.#status = this.#connections.size > 0 && this.#server ? "connecting" : "disconnected";
      }
    });
    socket.on("error", () => { /* close handler performs cleanup */ });
  }

  #registerPairingRequest(socket: WebSocket, session: SocketSession, message: PairingRequestMessage): void {
    const origin = optionalProposalField(message.origin, "origin", 2_048);
    const installationId = optionalProposalField(message.installationId, "installationId", 256);
    if (origin instanceof Error || installationId instanceof Error) {
      this.#rejectUnauthenticated(socket, (origin instanceof Error ? origin : installationId as Error).message);
      return;
    }
    const requestId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = Date.now() + this.#pairingTtlMs;
    const request: PairingRequest = {
      requestId,
      code,
      expiresAt,
      socket,
      generation: session.generation,
      ...(origin ? { origin } : {}),
      ...(installationId ? { installationId } : {}),
      approving: false,
      timer: setTimeout(() => this.#expirePairingRequest(request, "pairing request expired"), this.#pairingTtlMs),
    };
    request.timer.unref();
    session.pairingRequestId = requestId;
    this.#pairingRequests.set(requestId, request);
    this.#clearAuthenticationTimer(socket);
    try {
      socket.send(JSON.stringify({ type: "pairing_challenge", requestId, code, expiresAt }));
    } catch {
      this.#removePairingRequest(request);
      socket.terminate();
    }
  }

  #removePairingRequest(request: PairingRequest): void {
    if (this.#pairingRequests.get(request.requestId) !== request) return;
    this.#pairingRequests.delete(request.requestId);
    clearTimeout(request.timer);
    const session = this.#socketSessions.get(request.socket);
    if (session?.generation === request.generation && session.pairingRequestId === request.requestId) {
      session.pairingRequestId = null;
    }
  }

  #expirePairingRequest(request: PairingRequest, reason: string): void {
    this.#removePairingRequest(request);
    this.#rejectUnauthenticated(request.socket, reason);
  }

  async #acceptAuthenticatedSocket(socket: WebSocket, protocol: "first-frame-token-v1" | "pairing-v1"): Promise<boolean> {
    const server = this.#server;
    const installationId = this.#installationId;
    if (!server || !installationId || !this.#connections.has(socket) || socket.readyState !== WebSocket.OPEN) return false;
    try {
      await writePrivateFile(this.#verifiedInstallFile, `${JSON.stringify({
        version: 1,
        protocol,
        port: this.#port,
        installationId,
        verifiedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } catch {
      this.#rejectUnauthenticated(socket, "could not persist verified install marker", 1011);
      return false;
    }
    if (
      this.#server !== server
      || this.#installationId !== installationId
      || !this.#connections.has(socket)
      || socket.readyState !== WebSocket.OPEN
    ) return false;

    const previous = this.#connection;
    if (previous && previous.socket !== socket) {
      // Pending calls belong to the previous authenticated transport; never let
      // a replacement extension satisfy their ids.
      this.#terminateCommandsForConnection(previous, "replaced", new Error("browser-bridge connection replaced"));
      try { previous.socket.close(1000, "replaced by authenticated connection"); } catch { previous.socket.terminate(); }
    }
    // A new authenticated transport has not reported its tabs yet. Clear the
    // previous transport's snapshot so status can never label stale tabs live
    // during the auth_ok → ext_ready window.
    this.#tabs = [];
    this.#defaultTabId = null;
    this.#connection = {
      socket,
      installationId,
      generation: ++this.#connectionGeneration,
    };
    this.#clearAuthenticationTimer(socket);
    this.#status = "connected";
    return true;
  }

  #rejectUnauthenticated(socket: WebSocket, reason: string, code = 1008): void {
    this.#clearAuthenticationTimer(socket);
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
    try {
      socket.send(JSON.stringify({ type: "auth_error", error: reason }));
    } catch {
      // The close code remains the authoritative failure signal.
    }
    try {
      socket.close(code, reason.slice(0, 123));
      const forceClose = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }, 250);
      forceClose.unref();
      socket.once("close", () => clearTimeout(forceClose));
    } catch {
      socket.terminate();
    }
  }

  #clearAuthenticationTimer(socket: WebSocket): void {
    const timer = this.#authenticationTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.#authenticationTimers.delete(socket);
  }

  #handleMessage(socket: WebSocket, text: string): void {
    if (socket !== this.#connection?.socket) return;
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(text) as IncomingMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ext_ready":
      case "tabs_update": {
        const tabs = (msg as ExtReadyMessage).tabs ?? [];
        this.#tabs = tabs.filter(isValidBridgeTab).map((tab) => ({ id: tab.id, url: tab.url, ...(tab.title ? { title: tab.title } : {}) }));
        if (this.#defaultTabId === null || !this.#tabs.some((tab) => tab.id === this.#defaultTabId)) {
          this.#defaultTabId = this.#tabs[0]?.id ?? null;
        }
        break;
      }
      case "ack": {
        // Delivery acknowledgement is intentionally not a lifecycle boundary.
        // The caller deadline remains absolute and terminal ownership stays with
        // result/error/cancel(dispatched=false)/transport teardown.
        void (msg as AckMessage).id;
        break;
      }
      case "cancel_ack": {
        const acknowledgement = msg as CancelAckMessage;
        const connection = this.#connection;
        if (!connection) break;
        this.#handleCancelAcknowledgement(acknowledgement, connection);
        break;
      }
      case "ping":
        break;
      case "result":
      case "error": {
        const result = msg as ResultMessage;
        const connection = this.#connection;
        if (!connection) break;
        this.#finish(result.id, {
          ok: result.type === "result",
          data: result.data,
          results: result.results,
          error: result.error,
          newTabs: result.newTabs,
        }, connection);
        break;
      }
    }
  }

  #finish(id: string, result: BridgeResult, connection: AuthenticatedConnection): void {
    const pending = this.#pending.get(id);
    if (!pending || !sameCommandConnection(pending, connection)) return;
    const error = result.ok ? undefined : new Error(result.error ?? "browser-bridge command failed");
    this.#settleTrackedCommand(pending, {
      status: result.ok ? "result" : "error",
      result,
      ...(error ? { error } : {}),
    });
  }

  #handleCancelAcknowledgement(acknowledgement: CancelAckMessage, connection: AuthenticatedConnection): void {
    const pending = this.#pending.get(acknowledgement.id);
    if (!pending || !sameCommandConnection(pending, connection) || !pending.cancellation) return;
    const cancellation = pending.cancellation;
    pending.cancellation = null;
    clearTimeout(cancellation.timer);
    cancellation.resolve({ stopped: acknowledgement.stopped });
    if (acknowledgement.stopped) {
      this.#settleTrackedCommand(pending, {
        status: "cancelled",
        error: new Error("browser-bridge command cancelled before start"),
      });
    }
  }

  #settleTrackedCommand(pending: TrackedCommandRecord, terminal: BridgeCommandTerminal): void {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#pending.delete(pending.id);
    if (pending.responseTimer) clearTimeout(pending.responseTimer);
    pending.responseTimer = null;
    if (pending.cancellation) {
      clearTimeout(pending.cancellation.timer);
      pending.cancellation.resolve({ stopped: false });
      pending.cancellation = null;
    }
    if (!pending.responseSettled) {
      pending.responseSettled = true;
      if (terminal.status === "result" && terminal.result) pending.responseResolve(terminal.result);
      else pending.responseReject(terminal.error ?? new Error(`browser-bridge command ended: ${terminal.status}`));
    }
    pending.terminalResolve(terminal);
  }

  #terminateCommandsForConnection(
    connection: BridgeConnectionIdentity & { socket: WebSocket },
    status: Exclude<BridgeCommandTerminalStatus, "result" | "error" | "cancelled" | "send_failed">,
    error: Error,
  ): void {
    for (const pending of [...this.#pending.values()]) {
      if (!sameCommandConnection(pending, connection)) continue;
      this.#settleTrackedCommand(pending, { status, error });
    }
  }

  #terminateAllCommands(status: "shutdown" | "send_failed", error: Error): void {
    for (const pending of [...this.#pending.values()]) this.#settleTrackedCommand(pending, { status, error });
  }

  async #cleanupFailedStart(attempt: ProvisionalStartAttempt, cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.#connection = null;
    this.#status = "disconnected";
    this.#tabs = [];
    this.#defaultTabId = null;
    this.#terminateAllCommands("send_failed", error);
    for (const waiter of [...this.#connectionWaiters]) waiter.reject(error);
    for (const timer of this.#authenticationTimers.values()) clearTimeout(timer);
    this.#authenticationTimers.clear();
    for (const request of [...this.#pairingRequests.values()]) this.#removePairingRequest(request);
    this.#socketSessions.clear();
    for (const socket of this.#connections) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    this.#connections.clear();
    await this.#closeStartAttempt(attempt);
  }

  #closeStartAttempt(attempt: ProvisionalStartAttempt): Promise<void> {
    if (!attempt.server) return Promise.resolve();
    if (!attempt.closePromise) attempt.closePromise = closeServer(attempt.server);
    return attempt.closePromise;
  }

  /**
   * Revoke the listener generation, close every socket, reject all callers, and
   * wait until publication-capable startup work and the listening handle settle.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    const attempt = this.#shutdown();
    this.#shutdownPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.#shutdownPromise === attempt) this.#shutdownPromise = null;
    }
  }

  async #shutdown(): Promise<void> {
    const starting = this.#startPromise;
    const startAttempt = this.#startAttempt;
    const server = this.#server;
    ++this.#serverGeneration;
    startAttempt?.controller.abort(new Error("browser-bridge startup revoked by shutdown"));
    const error = new Error("browser-bridge shut down");

    // Fence new publication and revoke command authority before releasing both
    // published and provisional listener generations. The abort-facing startup
    // promise then settles even when custom persistence ignores cancellation.
    this.#connection = null;
    this.#status = "disconnected";
    this.#tabs = [];
    this.#defaultTabId = null;
    this.#terminateAllCommands("shutdown", error);
    for (const waiter of [...this.#connectionWaiters]) waiter.reject(error);
    for (const timer of this.#authenticationTimers.values()) clearTimeout(timer);
    this.#authenticationTimers.clear();
    for (const request of [...this.#pairingRequests.values()]) this.#removePairingRequest(request);
    this.#socketSessions.clear();
    for (const socket of this.#connections) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    this.#connections.clear();

    const closing: Promise<void>[] = [];
    if (startAttempt) closing.push(this.#closeStartAttempt(startAttempt));
    if (server) closing.push(closeServer(server));
    await Promise.allSettled(closing);
    if (starting) await starting.catch(() => {});
    this.#server = null;
    this.#port = null;
    this.#token = null;
    this.#installationId = null;
    if (this.#startPromise === starting) this.#startPromise = null;
    if (this.#startAttempt === startAttempt) this.#startAttempt = null;
  }

  /** Backward-compatible test hook; production code should call shutdown(). */
  ["__testDispose"](): Promise<void> {
    return this.shutdown();
  }

  /**
   * Send a command while separating caller response time from resource-terminal
   * ownership. A caller timeout rejects only response; terminal stays pending
   * until the extension or the owning transport reaches a real terminal state.
   */
  async sendTracked(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15_000,
    expectedConnection?: BridgeConnectionIdentity,
  ): Promise<TrackedBridgeCommand> {
    const callerTimeoutMs = positiveDuration(timeoutMs, 15_000, "command timeout");
    await this.start();
    if (expectedConnection) this.assertConnection(expectedConnection);
    const active = this.#connection;
    if (!this.isConnected() || !active) {
      throw new Error(`browser-bridge: authenticated extension not connected. Configure both port and token from ${this.#configFile}.`);
    }
    const connection = {
      installationId: active.installationId,
      generation: active.generation,
    } satisfies BridgeConnectionIdentity;
    const socket = active.socket;
    const id = randomUUID();
    let responseResolve!: (value: BridgeResult) => void;
    let responseReject!: (error: Error) => void;
    const rawResponse = new Promise<BridgeResult>((resolve, reject) => {
      responseResolve = resolve;
      responseReject = reject;
    });
    // Close the result→consumer race: a replacement/disconnect scheduled after
    // the wire result but before the caller continuation must fail the captured
    // generation instead of publishing a stale response.
    const response = rawResponse.then((result) => {
      this.assertConnection(connection);
      return result;
    });
    let terminalResolve!: (value: BridgeCommandTerminal) => void;
    const terminal = new Promise<BridgeCommandTerminal>((resolve) => { terminalResolve = resolve; });
    const pending: TrackedCommandRecord = {
      id,
      cmd,
      socket,
      connection,
      responseSettled: false,
      responseResolve,
      responseReject,
      responseTimer: null,
      terminalResolve,
      cancellation: null,
    };
    pending.responseTimer = setTimeout(() => {
      if (this.#pending.get(id) !== pending || pending.responseSettled) return;
      pending.responseSettled = true;
      pending.responseTimer = null;
      pending.responseReject(new Error(`browser-bridge ${cmd} timed out after ${callerTimeoutMs}ms`));
      // Deliberately retain #pending: terminal ownership outlives its caller.
    }, callerTimeoutMs);
    this.#pending.set(id, pending);

    const handle: TrackedBridgeCommand = {
      id,
      connection,
      response,
      terminal,
      cancel: () => this.#cancelTrackedCommand(pending),
    };
    try {
      socket.send(JSON.stringify({ id, cmd, ...payload }), (error) => {
        if (!error || this.#pending.get(id) !== pending) return;
        this.#settleTrackedCommand(pending, {
          status: "send_failed",
          error: new Error(`browser-bridge send failed: ${error.message}`),
        });
      });
    } catch (error) {
      this.#settleTrackedCommand(pending, {
        status: "send_failed",
        error: new Error(`browser-bridge send failed: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
    return handle;
  }

  async #cancelTrackedCommand(pending: TrackedCommandRecord): Promise<BridgeCancelAck> {
    if (this.#pending.get(pending.id) !== pending) return { stopped: true };
    if (pending.cancellation) return pending.cancellation.promise;
    let resolveCancellation!: (value: BridgeCancelAck) => void;
    let rejectCancellation!: (error: Error) => void;
    const promise = new Promise<BridgeCancelAck>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    const cancellation: PendingCancellation = {
      promise,
      resolve: resolveCancellation,
      reject: rejectCancellation,
      timer: setTimeout(() => {
        if (pending.cancellation !== cancellation) return;
        pending.cancellation = null;
        cancellation.reject(new Error(`browser-bridge cancel acknowledgement timed out after ${this.#cancelAckTimeoutMs}ms`));
      }, this.#cancelAckTimeoutMs),
    };
    pending.cancellation = cancellation;
    try {
      pending.socket.send(JSON.stringify({ type: "cancel", id: pending.id }), (error) => {
        if (!error || pending.cancellation !== cancellation) return;
        clearTimeout(cancellation.timer);
        pending.cancellation = null;
        cancellation.reject(new Error(`browser-bridge cancel send failed: ${error.message}`));
      });
    } catch (error) {
      clearTimeout(cancellation.timer);
      pending.cancellation = null;
      cancellation.reject(new Error(`browser-bridge cancel send failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return promise;
  }

  /** Thin backward-compatible adapter for legacy Promise<BridgeResult> callers. */
  async send(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15_000,
    expectedConnection?: BridgeConnectionIdentity,
  ): Promise<BridgeResult> {
    const handle = await this.sendTracked(cmd, payload, timeoutMs, expectedConnection);
    const result = await handle.response;
    if (expectedConnection) this.assertConnection(expectedConnection);
    return result;
  }

  /** Execute JS in the MAIN world of a tab (CDP fallback handled by the extension). */
  async exec(tabId: number, code: string, timeoutMs?: number, expectedConnection?: BridgeConnectionIdentity): Promise<BridgeResult> {
    return this.send("exec", { tabId, code }, timeoutMs, expectedConnection);
  }

  /** Send a raw CDP command via chrome.debugger on a tab. */
  async cdp(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    expectedConnection?: BridgeConnectionIdentity,
  ): Promise<BridgeResult> {
    return this.send("cdp", { tabId, method, params: params ?? {} }, timeoutMs, expectedConnection);
  }

  /** Read cookies (with partition support) for a tab or url. */
  async cookies(args: { tabId?: number; url?: string }, timeoutMs?: number, expectedConnection?: BridgeConnectionIdentity): Promise<BridgeResult> {
    return this.send("cookies", args, timeoutMs, expectedConnection);
  }

  /** Query/switch/create/get/update/close tabs. Omitting method remains query-compatible. */
  async tabsCmd(
    method?: TabsMethod,
    extra?: Record<string, unknown>,
    timeoutMs?: number,
    expectedConnection?: BridgeConnectionIdentity,
  ): Promise<BridgeResult> {
    return this.send("tabs", { ...(method ? { method } : {}), ...(extra ?? {}) }, timeoutMs, expectedConnection);
  }

  /** Manage other extensions (list/disable/enable). */
  async management(method: string, extId?: string, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("management", { method, ...(extId ? { extId } : {}) }, timeoutMs);
  }

  /** Set a contentSetting (e.g. automaticDownloads allow to bypass the multi-download prompt). */
  async contentSettings(type: string, setting: string, pattern = "<all_urls>", timeoutMs?: number): Promise<BridgeResult> {
    return this.send("contentSettings", { type, setting, pattern }, timeoutMs);
  }

  /** Toggle the CSP-stripping DNR rule. */
  async dnr(method: "enable" | "disable", timeoutMs?: number): Promise<BridgeResult> {
    return this.send("dnr", { method }, timeoutMs);
  }

  /** Batch commands with $N.path references resolved by the extension. */
  async batch(
    commands: Array<Record<string, unknown>>,
    tabId?: number,
    timeoutMs?: number,
    expectedConnection?: BridgeConnectionIdentity,
  ): Promise<BridgeResult> {
    return this.send("batch", { commands, ...(tabId !== undefined ? { tabId } : {}) }, timeoutMs, expectedConnection);
  }
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`browser-bridge ${label} must be greater than zero`);
  return Math.max(1, Math.floor(value));
}

function optionalProposalField(value: unknown, name: string, maxLength: number): string | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return new Error(`browser-bridge pairing ${name} proposal must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    return new Error(`browser-bridge pairing ${name} proposal must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function pairingCodesEqual(received: string, expected: string): boolean {
  return /^\d{6}$/.test(received) && tokensEqual(received, expected);
}

function sameCommandConnection(
  pending: TrackedCommandRecord,
  connection: BridgeConnectionIdentity & { socket: WebSocket },
): boolean {
  return pending.socket === connection.socket
    && pending.connection.installationId === connection.installationId
    && pending.connection.generation === connection.generation;
}

function isValidBridgeTab(value: unknown): value is BridgeTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<BridgeTab>;
  return Number.isInteger(tab.id) && typeof tab.url === "string" && /^https?:/.test(tab.url);
}

function tokensEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

async function readBridgeConfig(configFile: string): Promise<StoredBridgeConfig | null> {
  let details;
  try {
    details = await fs.lstat(configFile);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`browser-bridge: refusing unsafe config path ${configFile}`);
  }
  await fs.chmod(configFile, PRIVATE_FILE_MODE);
  let parsed: Partial<StoredBridgeConfig>;
  try {
    parsed = JSON.parse(await fs.readFile(configFile, "utf8")) as Partial<StoredBridgeConfig>;
  } catch {
    throw new Error(`browser-bridge: malformed config at ${configFile}; remove it and restart to generate a new token`);
  }
  if (parsed.version !== 1 || typeof parsed.token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(parsed.token)) {
    throw new Error(`browser-bridge: invalid token config at ${configFile}; remove it and restart to generate a new token`);
  }
  if (parsed.installationId !== undefined && !isInstallationId(parsed.installationId)) {
    throw new Error(`browser-bridge: invalid installation identity at ${configFile}; remove it and restart to generate a new identity`);
  }
  return {
    version: 1,
    port: Number.isInteger(parsed.port) && Number(parsed.port) > 0 ? Number(parsed.port) : DEFAULT_PORT,
    token: parsed.token,
    ...(parsed.installationId ? { installationId: parsed.installationId } : {}),
  };
}

function isInstallationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function persistBridgeConfig(config: BridgeConfig, paths: BridgePersistencePaths, signal: AbortSignal): Promise<void> {
  // The credential-free legacy port file is not installation authority. Commit
  // it first and the canonical owner-only config last. Abort checks fence each
  // rename boundary so shutdown cannot publish a revoked canonical config.
  throwIfSignalAborted(signal);
  await writePrivateFile(paths.portFile, String(config.port), signal);
  throwIfSignalAborted(signal);
  await writePrivateFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, signal);
  throwIfSignalAborted(signal);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const details = await fs.lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`browser-bridge: refusing unsafe config directory ${directory}`);
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function writePrivateFile(filePath: string, content: string, signal?: AbortSignal): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  try {
    const details = await fs.lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`browser-bridge: refusing unsafe file path ${filePath}`);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    throwIfSignalAborted(signal);
    handle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(content, signal ? { encoding: "utf8", signal } : "utf8");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfSignalAborted(signal);
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      // Windows does not consistently replace an existing destination. The
      // temporary file is already owner-only and remains in the same directory.
      if (!new Set(["EEXIST", "EPERM", "EACCES"]).has(fileErrorCode(error) ?? "")) throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    }
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function abortableStartBoundary<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("browser-bridge startup aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("browser-bridge startup aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("browser-bridge startup aborted");
}

function waitForListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && fileErrorCode(error) !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error) {
      if (fileErrorCode(error) === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

/** Find the first free TCP port at or above start. */
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > 65535) return reject(new Error("no free browser-bridge port found"));
      const tester = net.createServer();
      tester.once("error", () => tryPort(port + 1));
      tester.once("listening", () => {
        tester.once("close", () => resolve(port));
        tester.close();
      });
      tester.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

/** Process-wide singleton (mirrors the single authenticated extension connection). */
export const browserBridge = new BrowserBridgeServer();
export { BrowserBridgeServer };
export type {
  BridgeCancelAck,
  BridgeCommandTerminal,
  BridgeCommandTerminalStatus,
  BridgeConnectionIdentity,
  BridgeResult,
  BridgeStatus,
  BridgeTab,
  BrowserBridgeServerOptions,
  PairingRequestInfo,
  TabsMethod,
  TrackedBridgeCommand,
};
