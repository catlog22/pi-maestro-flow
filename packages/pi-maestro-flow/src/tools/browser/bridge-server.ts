import { renameSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

/**
 * BrowserBridgeServer — the pi side of the optional Chrome extension bridge.
 *
 * The bridge can execute page JavaScript and raw CDP, so binding to localhost is
 * not an authorization boundary. The server creates an owner-only config file
 * containing a random token and requires that token in the first WebSocket
 * frame. No extension message is processed before authentication succeeds.
 *
 * New extensions scan only the bounded 19222..19231 range, require a marked
 * Browser Bridge pairing challenge, and receive credentials only after explicit
 * requestId+code approval. The owner-only config and manual port/token fields
 * remain as a legacy path; neither localhost nor an open port grants authority.
 */

const DEFAULT_PORT = 19222;
const DISCOVERY_PORT_COUNT = 10;
const BRIDGE_PROTOCOL = "pi-browser-bridge/v1";
const HMAC_AUTH_PROTOCOL = "challenge-hmac-sha256-v1";
const LEGACY_AUTH_PROTOCOL = "first-frame-token-v1";
const BRIDGE_DIRECTORY = process.env.PI_BROWSER_BRIDGE_DIR?.trim() || path.join(os.homedir(), ".pi");
const AUTH_TIMEOUT_MS = 5_000;
const AUTH_CHALLENGE_TTL_MS = 5_000;
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
interface AuthProbeMessage {
  type: "auth_probe";
  protocol: typeof HMAC_AUTH_PROTOCOL;
  clientNonce: string;
}
interface AuthProofMessage {
  type: "auth_proof";
  protocol: typeof HMAC_AUTH_PROTOCOL;
  clientNonce: string;
  serverNonce: string;
  installationId: string;
  port: number;
  generation: number;
  proof: string;
}
interface AuthChallenge {
  clientNonce: string;
  serverNonce: string;
  installationId: string;
  port: number;
  generation: number;
  expiresAt: number;
  consumed: boolean;
}
interface PairingRequestMessage {
  type: "pairing_request";
  protocol: string;
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
  authChallenge: AuthChallenge | null;
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

interface PairingApproval {
  requestId: string;
  port: number;
  installationId: string;
}

interface BridgePersistencePaths {
  configFile: string;
  portFile: string;
}

interface VerifiedInstallMarker {
  version: 1;
  protocol: typeof LEGACY_AUTH_PROTOCOL | typeof HMAC_AUTH_PROTOCOL;
  port: number;
  installationId: string;
  verifiedAt: string;
}

interface VerifiedMarkerWriteContext {
  path: string;
  signal: AbortSignal;
  assertOwner: () => void;
}

type VerifiedMarkerWriter = (marker: VerifiedInstallMarker, context: VerifiedMarkerWriteContext) => Promise<void>;

interface AuthCommit {
  serverGeneration: number;
  socketGeneration: number;
  socket: WebSocket;
  server: WebSocketServer;
  installationId: string;
  controller: AbortController;
  promise: Promise<boolean>;
}

interface BrowserBridgeServerOptions {
  directory?: string;
  anchorPort?: number;
  pairingTtlMs?: number;
  authChallengeTtlMs?: number;
  cancelAckTimeoutMs?: number;
  persistConfig?: (config: BridgeConfig, paths: BridgePersistencePaths, signal: AbortSignal) => Promise<void>;
  writeVerifiedMarker?: VerifiedMarkerWriter;
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
  #authCommits = new Set<AuthCommit>();
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
  readonly #lastPort: number;
  readonly #pairingTtlMs: number;
  readonly #authChallengeTtlMs: number;
  readonly #cancelAckTimeoutMs: number;
  readonly #persistConfig: (config: BridgeConfig, paths: BridgePersistencePaths, signal: AbortSignal) => Promise<void>;
  readonly #writeVerifiedMarker: VerifiedMarkerWriter;

  constructor(options: BrowserBridgeServerOptions = {}) {
    this.#directory = options.directory?.trim() || BRIDGE_DIRECTORY;
    this.#configFile = path.join(this.#directory, "browser-bridge.json");
    this.#portFile = path.join(this.#directory, "browser-bridge.port");
    this.#verifiedInstallFile = path.join(this.#directory, "browser-bridge.verified");
    const anchorPort = options.anchorPort ?? DEFAULT_PORT;
    if (!Number.isInteger(anchorPort) || anchorPort < 1 || anchorPort > 65_535 - DISCOVERY_PORT_COUNT + 1) {
      throw new Error(`browser-bridge discovery range must start between 1 and ${65_535 - DISCOVERY_PORT_COUNT + 1}`);
    }
    this.#anchorPort = anchorPort;
    this.#lastPort = anchorPort + DISCOVERY_PORT_COUNT - 1;
    this.#pairingTtlMs = positiveDuration(options.pairingTtlMs, PAIRING_TTL_MS, "pairing TTL");
    this.#authChallengeTtlMs = positiveDuration(options.authChallengeTtlMs, AUTH_CHALLENGE_TTL_MS, "authentication challenge TTL");
    this.#cancelAckTimeoutMs = positiveDuration(options.cancelAckTimeoutMs, CANCEL_ACK_TIMEOUT_MS, "cancel acknowledgement timeout");
    this.#persistConfig = options.persistConfig ?? persistBridgeConfig;
    this.#writeVerifiedMarker = options.writeVerifiedMarker ?? persistVerifiedMarker;
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

  /** Approve exactly one live request and deliver credentials to that inert socket. */
  async approvePairing(requestId: string, code: string): Promise<PairingApproval> {
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

    // Pairing delivers credentials only. It never proves possession and never
    // writes the verified marker or grants command authority on this socket.
    request.approving = true;
    const currentSession = this.#socketSessions.get(request.socket);
    if (
      currentSession !== session
      || currentSession.generation !== request.generation
      || currentSession.authenticated
      || this.#pairingRequests.get(requestId) !== request
      || request.expiresAt <= Date.now()
      || !this.#token
      || !this.#port
      || !this.#installationId
    ) {
      this.#expirePairingRequest(request, "pairing request revoked during approval");
      throw new Error("browser-bridge pairing request was revoked during approval");
    }

    const approval = {
      requestId,
      port: this.#port,
      installationId: this.#installationId,
    } satisfies PairingApproval;
    try {
      await sendWebSocketFrame(request.socket, {
        type: "pairing_approved",
        protocol: BRIDGE_PROTOCOL,
        ...approval,
        generation: request.generation,
        expiresAt: request.expiresAt,
        token: this.#token,
      });
    } catch (error) {
      this.#expirePairingRequest(request, "pairing credential delivery failed");
      throw new Error(`browser-bridge could not publish pairing approval: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      this.#pairingRequests.get(requestId) !== request
      || this.#socketSessions.get(request.socket) !== session
      || session.generation !== request.generation
      || request.expiresAt <= Date.now()
      || request.socket.readyState !== WebSocket.OPEN
    ) {
      this.#expirePairingRequest(request, "pairing request revoked during credential delivery");
      throw new Error("browser-bridge pairing request was revoked during credential delivery");
    }
    this.#removePairingRequest(request);
    const reconnectTimer = setTimeout(() => {
      if (request.socket.readyState === WebSocket.OPEN) {
        try { request.socket.close(1000, "reconnect with approved credentials"); } catch { request.socket.terminate(); }
      }
    }, 2_000);
    reconnectTimer.unref();
    this.#authenticationTimers.set(request.socket, reconnectTimer);
    return approval;
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
    throw new Error("browser-bridge: no authenticated tab connected. Open the extension, then use browser status and browser pair for first-time setup.");
  }

  /** Lazily start within the bounded discovery range (idempotent and abortable). */
  async start(signal?: AbortSignal): Promise<void> {
    throwIfSignalAborted(signal);
    if (this.#shutdownPromise) {
      if (signal) await abortableStartBoundary(this.#shutdownPromise, signal);
      else await this.#shutdownPromise;
    }
    let createdAttempt = false;
    if (!this.#startPromise) {
      createdAttempt = true;
      const startAttempt: ProvisionalStartAttempt = {
        generation: ++this.#serverGeneration,
        controller: new AbortController(),
        server: null,
        closePromise: null,
      };
      const abortFromCaller = () => startAttempt.controller.abort(
        signal?.reason instanceof Error ? signal.reason : new Error("browser-bridge startup aborted"),
      );
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      const promise = this.#start(startAttempt);
      this.#startAttempt = startAttempt;
      this.#startPromise = promise;
      void promise.then(
        () => {
          signal?.removeEventListener("abort", abortFromCaller);
          if (this.#startAttempt === startAttempt) this.#startAttempt = null;
        },
        () => {
          signal?.removeEventListener("abort", abortFromCaller);
          if (this.#startAttempt === startAttempt) this.#startAttempt = null;
          if (this.#startPromise === promise) this.#startPromise = null;
        },
      );
    }
    return signal && !createdAttempt ? abortableStartBoundary(this.#startPromise, signal) : this.#startPromise;
  }

  async #start(attempt: ProvisionalStartAttempt): Promise<void> {
    const { generation, controller } = attempt;
    await ensurePrivateDirectory(this.#directory);
    this.#assertStartGeneration(generation);
    throwIfSignalAborted(controller.signal);
    const existingConfig = await readBridgeConfig(this.#configFile);
    this.#assertStartGeneration(generation);
    throwIfSignalAborted(controller.signal);
    const token = existingConfig?.token ?? randomBytes(32).toString("base64url");
    const installationId = existingConfig?.installationId ?? randomUUID();

    try {
      const { server, port } = await this.#bindBounded(attempt);
      this.#assertStartGeneration(generation);
      throwIfSignalAborted(controller.signal);
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

  async #bindBounded(attempt: ProvisionalStartAttempt): Promise<{ server: WebSocketServer; port: number }> {
    for (let port = this.#anchorPort; port <= this.#lastPort; port += 1) {
      throwIfSignalAborted(attempt.controller.signal);
      const server = new WebSocketServer({
        port,
        host: "127.0.0.1",
        maxPayload: MAX_PAYLOAD_BYTES,
      });
      attempt.server = server;
      server.on("connection", (socket) => this.#handleConnection(socket));
      try {
        await abortableStartBoundary(waitForListening(server), attempt.controller.signal);
        return { server, port };
      } catch (error) {
        await closeServer(server).catch(() => {});
        if (attempt.server === server) attempt.server = null;
        throwIfSignalAborted(attempt.controller.signal);
        if (fileErrorCode(error) === "EADDRINUSE") continue;
        throw error;
      }
    }
    throw new Error(`browser-bridge: no available port in fixed discovery range ${this.#anchorPort}..${this.#lastPort}`);
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
          `browser-bridge: no authenticated extension connected within ${timeoutMs}ms. Open the extension and approve its pending request with browser status/browser pair; legacy manual port/token configuration remains available.`,
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
      authChallenge: null,
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
        if (isBinary) {
          this.#rejectUnauthenticated(socket, "authentication requires text frames");
          return;
        }
        const parsed = parseJsonRecord(text);
        if (!session.firstFrameSeen) {
          session.firstFrameSeen = true;
          const pairingRequest = decodePairingRequest(parsed);
          if (pairingRequest) {
            this.#registerPairingRequest(socket, session, pairingRequest);
            return;
          }
          const legacyAuth = decodeLegacyAuth(parsed);
          if (legacyAuth) {
            if (!this.#token || !tokensEqual(legacyAuth.token, this.#token)) {
              this.#rejectUnauthenticated(socket, "invalid browser bridge token");
              return;
            }
            this.#completeAuthentication(socket, session, LEGACY_AUTH_PROTOCOL);
            return;
          }
          const probe = decodeAuthProbe(parsed);
          if (probe) {
            this.#issueAuthChallenge(socket, session, probe);
            return;
          }
          this.#rejectUnauthenticated(socket, "invalid browser bridge authentication frame");
          return;
        }
        if (session.pairingRequestId) {
          this.#rejectUnauthenticated(socket, "pairing socket has no command authority");
          return;
        }
        const challenge = session.authChallenge;
        const proof = decodeAuthProof(parsed);
        if (!challenge || !proof || !this.#verifyAuthProof(session, challenge, proof)) {
          this.#rejectUnauthenticated(socket, "invalid browser bridge authentication proof");
          return;
        }
        challenge.consumed = true;
        session.authChallenge = null;
        this.#completeAuthentication(socket, session, HMAC_AUTH_PROTOCOL);
        return;
      }
      this.#handleMessage(socket, text);
    });

    socket.on("close", () => {
      for (const commit of this.#authCommits) {
        if (commit.socket === socket) commit.controller.abort(new Error("browser-bridge authentication socket closed"));
      }
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
    if (message.protocol !== BRIDGE_PROTOCOL) {
      this.#rejectUnauthenticated(socket, "unrecognized browser bridge discovery protocol");
      return;
    }
    const origin = optionalProposalField(message.origin, "origin", 2_048);
    const installationId = optionalProposalField(message.installationId, "installationId", 256);
    if (origin instanceof Error || installationId instanceof Error) {
      this.#rejectUnauthenticated(socket, (origin instanceof Error ? origin : installationId as Error).message);
      return;
    }
    // A newer generation from the same extension installation replaces the old
    // code. Approving a stale/replaced code therefore always fails closed.
    if (installationId || origin) {
      for (const existing of [...this.#pairingRequests.values()]) {
        if (
          (installationId && existing.installationId === installationId)
          || (!installationId && origin && !existing.installationId && existing.origin === origin)
        ) this.#expirePairingRequest(existing, "pairing request replaced by newer generation");
      }
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
      socket.send(JSON.stringify({
        type: "pairing_challenge",
        protocol: BRIDGE_PROTOCOL,
        requestId,
        code,
        expiresAt,
        generation: session.generation,
      }));
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

  #issueAuthChallenge(socket: WebSocket, session: SocketSession, probe: AuthProbeMessage): void {
    const installationId = this.#installationId;
    const port = this.#port;
    if (!this.#server || !this.#token || !installationId || !port || !this.#connections.has(socket)) {
      this.#rejectUnauthenticated(socket, "browser bridge authentication generation is unavailable");
      return;
    }
    const challenge: AuthChallenge = {
      clientNonce: probe.clientNonce,
      serverNonce: randomBytes(16).toString("base64url"),
      installationId,
      port,
      generation: session.generation,
      expiresAt: Date.now() + this.#authChallengeTtlMs,
      consumed: false,
    };
    session.authChallenge = challenge;
    try {
      socket.send(JSON.stringify({
        type: "auth_challenge",
        protocol: HMAC_AUTH_PROTOCOL,
        ...challenge,
        consumed: undefined,
      }));
    } catch {
      session.authChallenge = null;
      socket.terminate();
    }
  }

  #verifyAuthProof(session: SocketSession, challenge: AuthChallenge, proof: AuthProofMessage): boolean {
    if (
      challenge.consumed
      || challenge.expiresAt <= Date.now()
      || session.generation !== challenge.generation
      || proof.clientNonce !== challenge.clientNonce
      || proof.serverNonce !== challenge.serverNonce
      || proof.installationId !== challenge.installationId
      || proof.port !== challenge.port
      || proof.generation !== challenge.generation
      || this.#installationId !== challenge.installationId
      || this.#port !== challenge.port
      || !this.#token
    ) return false;
    const expected = createHmac("sha256", this.#token)
      .update(authTranscript(challenge))
      .digest("base64url");
    return tokensEqual(proof.proof, expected);
  }

  #completeAuthentication(
    socket: WebSocket,
    session: SocketSession,
    protocol: typeof LEGACY_AUTH_PROTOCOL | typeof HMAC_AUTH_PROTOCOL,
  ): void {
    void this.#acceptAuthenticatedSocket(socket, session, protocol).then((accepted) => {
      const current = this.#socketSessions.get(socket);
      if (!accepted || current !== session || current.generation !== session.generation || socket.readyState !== WebSocket.OPEN) return;
      session.authenticated = true;
      try {
        socket.send(JSON.stringify({
          type: "auth_ok",
          protocol: BRIDGE_PROTOCOL,
          authProtocol: protocol,
          port: this.#port,
          installationId: this.#installationId,
        }));
      } catch {
        session.authenticated = false;
        socket.terminate();
        return;
      }
      for (const waiter of [...this.#connectionWaiters]) waiter.resolve();
    }, () => this.#rejectUnauthenticated(socket, "authentication persistence failed", 1011));
  }

  #assertAuthCommitOwner(commit: AuthCommit): void {
    throwIfSignalAborted(commit.controller.signal);
    const session = this.#socketSessions.get(commit.socket);
    if (
      this.#serverGeneration !== commit.serverGeneration
      || this.#server !== commit.server
      || this.#installationId !== commit.installationId
      || !session
      || session.generation !== commit.socketGeneration
      || !this.#connections.has(commit.socket)
      || commit.socket.readyState !== WebSocket.OPEN
    ) throw new Error("browser-bridge authentication commit generation was revoked");
  }

  #startAuthCommit(
    socket: WebSocket,
    session: SocketSession,
    protocol: typeof LEGACY_AUTH_PROTOCOL | typeof HMAC_AUTH_PROTOCOL,
  ): AuthCommit {
    const server = this.#server;
    const installationId = this.#installationId;
    const port = this.#port;
    if (!server || !installationId || !port) throw new Error("browser-bridge authentication generation is unavailable");
    for (const existing of this.#authCommits) {
      if (existing.socketGeneration < session.generation) {
        existing.controller.abort(new Error("browser-bridge authentication commit replaced by newer socket generation"));
      }
    }
    const commit = {
      serverGeneration: this.#serverGeneration,
      socketGeneration: session.generation,
      socket,
      server,
      installationId,
      controller: new AbortController(),
      promise: Promise.resolve(false),
    } satisfies AuthCommit;
    const marker = {
      version: 1,
      protocol,
      port,
      installationId,
      verifiedAt: new Date().toISOString(),
    } satisfies VerifiedInstallMarker;
    commit.promise = (async () => {
      this.#assertAuthCommitOwner(commit);
      await this.#writeVerifiedMarker(marker, {
        path: this.#verifiedInstallFile,
        signal: commit.controller.signal,
        assertOwner: () => this.#assertAuthCommitOwner(commit),
      });
      this.#assertAuthCommitOwner(commit);
      return true;
    })();
    this.#authCommits.add(commit);
    void commit.promise.finally(() => this.#authCommits.delete(commit)).catch(() => undefined);
    return commit;
  }

  async #acceptAuthenticatedSocket(
    socket: WebSocket,
    session: SocketSession,
    protocol: typeof LEGACY_AUTH_PROTOCOL | typeof HMAC_AUTH_PROTOCOL,
  ): Promise<boolean> {
    let commit: AuthCommit;
    try {
      commit = this.#startAuthCommit(socket, session, protocol);
      if (!await commit.promise) return false;
      this.#assertAuthCommitOwner(commit);
    } catch {
      this.#rejectUnauthenticated(socket, "could not persist verified install marker", 1011);
      return false;
    }
    const installationId = commit.installationId;
    const previous = this.#connection;
    if (previous && previous.socket !== socket) {
      this.#terminateCommandsForConnection(previous, "replaced", new Error("browser-bridge connection replaced"));
      try { previous.socket.close(1000, "replaced by authenticated connection"); } catch { previous.socket.terminate(); }
    }
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
        if (typeof acknowledgement.id !== "string" || typeof acknowledgement.stopped !== "boolean") break;
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
        if (typeof result.id !== "string") break;
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
    for (const commit of this.#authCommits) commit.controller.abort(error);
    this.#socketSessions.clear();
    for (const socket of this.#connections) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    this.#connections.clear();
    await Promise.allSettled([...this.#authCommits].map((commit) => commit.promise));
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
    for (const commit of this.#authCommits) commit.controller.abort(error);
    this.#socketSessions.clear();
    for (const socket of this.#connections) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    this.#connections.clear();

    // Marker commits own the server/token/installation identity until every
    // publication-capable continuation has observed cancellation and settled.
    await Promise.allSettled([...this.#authCommits].map((commit) => commit.promise));
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
      throw new Error("browser-bridge: authenticated extension not connected. Open the extension and approve its pending request with browser status/browser pair.");
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
    cancellation.timer.unref();
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

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function decodeLegacyAuth(value: Record<string, unknown> | null): AuthMessage | null {
  if (!value || !hasOnlyKeys(value, ["type", "token"])) return null;
  return value.type === "auth" && typeof value.token === "string" ? { type: "auth", token: value.token } : null;
}

function decodePairingRequest(value: Record<string, unknown> | null): PairingRequestMessage | null {
  if (!value || !hasOnlyKeys(value, ["type", "protocol"], ["origin", "installationId"])) return null;
  if (value.type !== "pairing_request" || typeof value.protocol !== "string") return null;
  return {
    type: "pairing_request",
    protocol: value.protocol,
    ...(value.origin !== undefined ? { origin: value.origin as string } : {}),
    ...(value.installationId !== undefined ? { installationId: value.installationId as string } : {}),
  };
}

function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22,86}$/.test(value);
}

function decodeAuthProbe(value: Record<string, unknown> | null): AuthProbeMessage | null {
  if (!value || !hasOnlyKeys(value, ["type", "protocol", "clientNonce"])) return null;
  if (value.type !== "auth_probe" || value.protocol !== HMAC_AUTH_PROTOCOL || !isNonce(value.clientNonce)) return null;
  return { type: "auth_probe", protocol: HMAC_AUTH_PROTOCOL, clientNonce: value.clientNonce };
}

function decodeAuthProof(value: Record<string, unknown> | null): AuthProofMessage | null {
  if (!value || !hasOnlyKeys(value, ["type", "protocol", "clientNonce", "serverNonce", "installationId", "port", "generation", "proof"])) return null;
  if (
    value.type !== "auth_proof"
    || value.protocol !== HMAC_AUTH_PROTOCOL
    || !isNonce(value.clientNonce)
    || !isNonce(value.serverNonce)
    || !isInstallationId(value.installationId)
    || !isValidPort(value.port)
    || !Number.isSafeInteger(value.generation)
    || Number(value.generation) <= 0
    || typeof value.proof !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.proof)
  ) return null;
  return {
    type: "auth_proof",
    protocol: HMAC_AUTH_PROTOCOL,
    clientNonce: value.clientNonce,
    serverNonce: value.serverNonce,
    installationId: value.installationId,
    port: value.port,
    generation: value.generation as number,
    proof: value.proof,
  };
}

function authTranscript(value: Pick<AuthChallenge, "clientNonce" | "serverNonce" | "installationId" | "port" | "generation">): string {
  return JSON.stringify([
    HMAC_AUTH_PROTOCOL,
    value.clientNonce,
    value.serverNonce,
    value.installationId,
    value.port,
    value.generation,
  ]);
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function parseProductionAnchorPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new Error("PI_BROWSER_BRIDGE_PORT must be a decimal integer");
  const port = Number(value);
  const maximum = 65_535 - DISCOVERY_PORT_COUNT + 1;
  if (!Number.isSafeInteger(port) || port < 1 || port > maximum) {
    throw new Error(`PI_BROWSER_BRIDGE_PORT must be between 1 and ${maximum}`);
  }
  return port;
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

async function persistVerifiedMarker(marker: VerifiedInstallMarker, context: VerifiedMarkerWriteContext): Promise<void> {
  await writePrivateFile(
    context.path,
    `${JSON.stringify(marker, null, 2)}\n`,
    context.signal,
    context.assertOwner,
  );
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

async function writePrivateFile(
  filePath: string,
  content: string,
  signal?: AbortSignal,
  beforePublish?: () => void,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  try {
    const details = await fs.lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`browser-bridge: refusing unsafe file path ${filePath}`);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let published = false;
  try {
    throwIfSignalAborted(signal);
    handle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(content, signal ? { encoding: "utf8", signal } : "utf8");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfSignalAborted(signal);
    beforePublish?.();
    // No await is permitted between the final owner check and publication:
    // a revoked generation must never resume later and replace the marker.
    // renameSync uses the platform's atomic replace primitive; failure is
    // fail-closed and never removes the canonical target first.
    renameSync(temporaryPath, filePath);
    published = true;
  } finally {
    if (!published) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
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

function sendWebSocketFrame(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      socket.send(JSON.stringify(value), (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
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

/** Process-wide singleton (mirrors the single authenticated extension connection). */
export const browserBridge = new BrowserBridgeServer({
  anchorPort: parseProductionAnchorPort(process.env.PI_BROWSER_BRIDGE_PORT),
});
export {
  BRIDGE_PROTOCOL,
  BrowserBridgeServer,
  DEFAULT_PORT,
  DISCOVERY_PORT_COUNT,
  HMAC_AUTH_PROTOCOL,
  authTranscript,
  parseProductionAnchorPort,
};
export type {
  BridgeCancelAck,
  BridgeCommandTerminal,
  BridgeCommandTerminalStatus,
  BridgeConnectionIdentity,
  BridgeResult,
  BridgeStatus,
  BridgeTab,
  BrowserBridgeServerOptions,
  PairingApproval,
  PairingRequestInfo,
  TabsMethod,
  TrackedBridgeCommand,
  VerifiedInstallMarker,
  VerifiedMarkerWriteContext,
  VerifiedMarkerWriter,
};
