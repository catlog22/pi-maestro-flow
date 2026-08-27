/** Dependency-free canonical session discovery and message routing primitives. */

import {
  normalizeMessageProvenanceV1,
  unknownMessageProvenanceV1,
  type MessageProvenanceV1,
} from "../shared/types.ts";

export const SESSION_ENDPOINT_VERSION = 1 as const;
export const SESSION_ENDPOINT_ID_PREFIX = "pi-session/v1" as const;
export const SESSION_HOST_REGISTRY_KEY = Symbol.for("pi-maestro-teammate.session-host-registry.v1");
/** Process-global workspace-peer directory refresh hook; used by sibling packages (e.g. Flow schedule admission) to pull fresh peer state before concluding a target is unreachable. */
export const SESSION_HOST_DIRECTORY_REFRESH_KEY = Symbol.for("pi-maestro-teammate.session-host-directory-refresh.v1");
export const SESSION_SURFACE_ENV_VAR = "PI_TEAMMATE_SESSION_SURFACE" as const;
export const SESSION_HOST_REGISTRY_EVENT = "teammate:sessions" as const;
export const WINDOW_THREAD_EVENT = "teammate:window-thread" as const;
export const WINDOW_THREAD_ENTRY_TYPE = "teammate-window-thread" as const;
export const DEFAULT_WINDOW_THREAD_LIMIT = 512;

export type SessionSurfaceMode = "legacy" | "shadow" | "unified";
export type SessionViewMode = "agents" | "windows";
export type SessionWindowModeAction = "enter" | "exit";
export type SessionEndpointKind = "root" | "agent";
export type SessionEndpointScope = "local" | "workspace-peer";
export type SessionEndpointTransport = "local-root" | "local-agent-mailbox" | "workspace-peer-v1" | "child-ipc";
export type SessionEndpointStatus = "running" | "sleeping" | "settled";
export type SessionMessageMode = "steer" | "follow_up" | "interrupt" | "abort";
export type SessionMessageSource = "user" | "monitor" | "system";
export type SessionMessageKind = "message" | "coordination" | "request" | "status" | "supervision";
export type SessionDeliveryStage = "queued" | "injected";

/** Model-originated status is coordination; only trusted host telemetry stays context-only. */
export function normalizeSessionMessageKind(
  kind: SessionMessageKind | undefined,
  trustedStatus = false,
): SessionMessageKind | undefined {
  return kind === "status" && !trustedStatus ? "coordination" : kind;
}

/** Status messages update context but never start a model turn by themselves. */
export function sessionMessageTriggersTurn(kind: SessionMessageKind | undefined): boolean {
  return kind !== "status";
}

export type SessionEndpointCapability = "inspect" | "message" | "steer" | "follow_up" | "interrupt" | "abort" | "wake"
  | "monitor-workspace-aggregation"
  | "flow-schedule-todo-binding" | "flow-schedule-todo-projection" | "flow-schedule-todo-mutation" | "flow-schedule-report";

export interface SessionEndpointIdentity {
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  correlationId?: string;
}

export interface SessionEndpoint extends SessionEndpointIdentity {
  version: typeof SESSION_ENDPOINT_VERSION;
  id: string;
  kind: SessionEndpointKind;
  scope: SessionEndpointScope;
  transport: SessionEndpointTransport;
  status: SessionEndpointStatus;
  capabilities: readonly SessionEndpointCapability[];
  /** Deterministic position in the canonical endpoint ordering. */
  ordinal: number;
  /** Hash of semantic content; heartbeat-only timestamps are not projected. */
  contentRevision: string;
  sessionId?: string;
  /** Projection producer and monotonic incarnation for local isolation. */
  sourceId?: string;
  generation?: number;
  sessionName?: string;
  name?: string;
  agent?: string;
  phase?: string;
  parentCorrelationId?: string;
  summary?: string;
  contextPressure?: number;
  agentCount?: number;
}

export interface SessionAgentProjection extends SessionEndpointIdentity {
  correlationId: string;
  status: SessionEndpointStatus;
  name?: string;
  agent?: string;
  phase?: string;
  parentCorrelationId?: string;
  summary?: string;
  wakeable?: boolean;
}

export interface SessionOwnerProjection extends Omit<SessionEndpointIdentity, "correlationId"> {
  scope: SessionEndpointScope;
  status: "running" | "sleeping";
  /** Optional caller-side proxy transport; root hosts use the scope defaults. */
  transport?: SessionEndpointTransport;
  sessionId?: string;
  /** Projection producer and monotonic incarnation for local isolation. */
  sourceId?: string;
  generation?: number;
  sessionName?: string;
  contextPressure?: number;
  /** Extra root-endpoint capabilities this owner advertises (e.g. flow-schedule-todo-binding). */
  extraCapabilities?: readonly SessionEndpointCapability[];
  agents: readonly SessionAgentProjection[];
}

export type SessionSelectorKind =
  | "endpoint-id"
  | "local-root"
  | "owner-root"
  | "owner-agent"
  | "session-name"
  | "window-owner-prefix"
  | "name"
  | "name-id-prefix"
  | "correlation-id"
  | "correlation-prefix";

export type SessionResolutionCode = "resolved" | "invalid" | "not_found" | "ambiguous" | "not_routable";

export interface SessionResolution {
  code: SessionResolutionCode;
  selector: string;
  selectorKind?: SessionSelectorKind;
  endpoint?: SessionEndpoint;
  candidates: readonly SessionEndpoint[];
  message?: string;
}

export interface SessionResolveOptions {
  includeSettled?: boolean;
  localFirst?: boolean;
  /** Pin delivery to this correlation id instead of re-resolving the selector. */
  targetCorrelationId?: string;
}

export function parseSessionSurfaceMode(value: unknown): SessionSurfaceMode {
  return value === "shadow" || value === "unified" || value === "legacy" ? value : "legacy";
}

export function sessionSurfaceModeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionSurfaceMode {
  const raw = env[SESSION_SURFACE_ENV_VAR]?.trim().toLowerCase();
  return parseSessionSurfaceMode(raw);
}

function encodeIdSegment(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
}

export function sessionRootEndpointId(identity: Omit<SessionEndpointIdentity, "correlationId">): string {
  return `${SESSION_ENDPOINT_ID_PREFIX}/${encodeIdSegment(identity.workspaceId)}/${encodeIdSegment(identity.ownerId)}/${encodeIdSegment(identity.ownerNonce)}/root`;
}

export function sessionAgentEndpointId(identity: SessionEndpointIdentity & { correlationId: string }): string {
  return `${SESSION_ENDPOINT_ID_PREFIX}/${encodeIdSegment(identity.workspaceId)}/${encodeIdSegment(identity.ownerId)}/${encodeIdSegment(identity.ownerNonce)}/agent/${encodeIdSegment(identity.correlationId)}`;
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "", "en");
}

function endpointOrder(left: Omit<SessionEndpoint, "ordinal" | "contentRevision">, right: Omit<SessionEndpoint, "ordinal" | "contentRevision">): number {
  if (left.scope !== right.scope) return left.scope === "local" ? -1 : 1;
  return compareText(left.workspaceId, right.workspaceId)
    || compareText(left.ownerId, right.ownerId)
    || compareText(left.ownerNonce, right.ownerNonce)
    || (left.kind === right.kind ? 0 : left.kind === "root" ? -1 : 1)
    || compareText(left.correlationId, right.correlationId);
}

function semanticEndpoint(endpoint: Omit<SessionEndpoint, "ordinal" | "contentRevision">): unknown {
  return {
    version: endpoint.version,
    id: endpoint.id,
    kind: endpoint.kind,
    scope: endpoint.scope,
    transport: endpoint.transport,
    workspaceId: endpoint.workspaceId,
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    correlationId: endpoint.correlationId,
    status: endpoint.status,
    capabilities: endpoint.capabilities,
    sessionId: endpoint.sessionId,
    sourceId: endpoint.sourceId,
    generation: endpoint.generation,
    sessionName: endpoint.sessionName,
    name: endpoint.name,
    agent: endpoint.agent,
    phase: endpoint.phase,
    parentCorrelationId: endpoint.parentCorrelationId,
    summary: endpoint.summary,
    contextPressure: endpoint.contextPressure,
    agentCount: endpoint.agentCount,
  };
}

/** Stable 64-bit FNV-1a; suitable for change detection, not security. */
export function sessionContentRevision(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function agentCapabilities(owner: SessionOwnerProjection, agent: SessionAgentProjection): readonly SessionEndpointCapability[] {
  const capabilities: SessionEndpointCapability[] = ["inspect"];
  if (agent.status !== "settled") {
    capabilities.push("message", "steer", "follow_up");
    if (owner.scope === "local") capabilities.push("interrupt", "abort");
    if (agent.wakeable || agent.status === "sleeping") capabilities.push("wake");
  }
  return Object.freeze(capabilities);
}

export function projectSessionEndpoints(owners: readonly SessionOwnerProjection[]): readonly SessionEndpoint[] {
  const projected: Array<Omit<SessionEndpoint, "ordinal" | "contentRevision">> = [];
  for (const owner of owners) {
    const identity = {
      workspaceId: owner.workspaceId,
      ownerId: owner.ownerId,
      ownerNonce: owner.ownerNonce,
    };
    projected.push({
      version: SESSION_ENDPOINT_VERSION,
      id: sessionRootEndpointId(identity),
      kind: "root",
      scope: owner.scope,
      transport: owner.transport ?? (owner.scope === "local" ? "local-root" : "workspace-peer-v1"),
      ...identity,
      status: owner.status,
      capabilities: Object.freeze(
        owner.extraCapabilities && owner.extraCapabilities.length > 0
          ? ["inspect", "message", "steer", "follow_up", ...owner.extraCapabilities]
          : ["inspect", "message", "steer", "follow_up"],
      ),
      ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
      ...(owner.sourceId ? { sourceId: owner.sourceId } : {}),
      ...(owner.generation === undefined ? {} : { generation: owner.generation }),
      ...(owner.sessionName ? { sessionName: owner.sessionName } : {}),
      ...(owner.contextPressure === undefined ? {} : { contextPressure: owner.contextPressure }),
      agentCount: owner.agents.filter((agent) => agent.status !== "settled").length,
    });
    for (const agent of owner.agents) {
      projected.push({
        version: SESSION_ENDPOINT_VERSION,
        id: sessionAgentEndpointId(agent),
        kind: "agent",
        scope: owner.scope,
        transport: owner.transport ?? (owner.scope === "local" ? "local-agent-mailbox" : "workspace-peer-v1"),
        workspaceId: owner.workspaceId,
        ownerId: owner.ownerId,
        ownerNonce: owner.ownerNonce,
        correlationId: agent.correlationId,
        status: agent.status,
        capabilities: agentCapabilities(owner, agent),
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
        ...(owner.sourceId ? { sourceId: owner.sourceId } : {}),
        ...(owner.generation === undefined ? {} : { generation: owner.generation }),
        ...(owner.sessionName ? { sessionName: owner.sessionName } : {}),
        ...(agent.name ? { name: agent.name } : {}),
        ...(agent.agent ? { agent: agent.agent } : {}),
        ...(agent.phase ? { phase: agent.phase } : {}),
        ...(agent.parentCorrelationId ? { parentCorrelationId: agent.parentCorrelationId } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
      });
    }
  }
  projected.sort(endpointOrder);
  return Object.freeze(projected.map((endpoint, ordinal) => Object.freeze({
    ...endpoint,
    ordinal,
    contentRevision: sessionContentRevision(semanticEndpoint(endpoint)),
  })));
}

function resolved(selector: string, selectorKind: SessionSelectorKind, candidates: SessionEndpoint[]): SessionResolution {
  if (candidates.length === 1) return { code: "resolved", selector, selectorKind, endpoint: candidates[0], candidates };
  if (candidates.length > 1) return { code: "ambiguous", selector, selectorKind, candidates, message: `Session selector ${JSON.stringify(selector)} is ambiguous.` };
  return { code: "not_found", selector, selectorKind, candidates: [], message: `Session selector ${JSON.stringify(selector)} was not found.` };
}

export class EndpointDirectory {
  #endpoints: readonly SessionEndpoint[] = Object.freeze([]);
  #byId = new Map<string, SessionEndpoint>();
  #contentRevision = sessionContentRevision([]);
  #subscribers = new Set<(snapshot: SessionEndpointSnapshot) => void>();

  constructor(endpoints: readonly SessionEndpoint[] = []) {
    this.replace(endpoints);
  }

  replace(endpoints: readonly SessionEndpoint[]): void {
    const ordered = [...endpoints].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"));
    const byId = new Map<string, SessionEndpoint>();
    for (const endpoint of ordered) {
      if (byId.has(endpoint.id)) throw new Error(`Duplicate session endpoint id: ${endpoint.id}`);
      byId.set(endpoint.id, endpoint);
    }
    const next = Object.freeze(ordered);
    const contentRevision = sessionContentRevision(next.map((endpoint) => [endpoint.id, endpoint.contentRevision]));
    if (contentRevision === this.#contentRevision) return;
    this.#endpoints = next;
    this.#byId = byId;
    this.#contentRevision = contentRevision;
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber(snapshot);
  }

  list(): readonly SessionEndpoint[] { return this.#endpoints; }
  get(id: string): SessionEndpoint | undefined { return this.#byId.get(id); }
  get contentRevision(): string { return this.#contentRevision; }
  snapshot(): SessionEndpointSnapshot {
    return Object.freeze({ contentRevision: this.#contentRevision, endpoints: this.#endpoints });
  }
  subscribe(subscriber: (snapshot: SessionEndpointSnapshot) => void, options: { emitCurrent?: boolean } = {}): () => void {
    this.#subscribers.add(subscriber);
    if (options.emitCurrent !== false) subscriber(this.snapshot());
    return () => this.#subscribers.delete(subscriber);
  }

  resolve(rawSelector: string, options: SessionResolveOptions = {}): SessionResolution {
    const selector = rawSelector.trim();
    if (!selector || selector.length > 512 || /[\u0000-\u001f\u007f]/.test(selector)) {
      return { code: "invalid", selector: rawSelector, candidates: [], message: "Session selector must be a non-empty bounded identifier." };
    }
    const endpoints = this.#endpoints.filter((endpoint) => options.includeSettled !== false || endpoint.status !== "settled");
    if (options.targetCorrelationId) {
      const pinned = endpoints.filter((endpoint) => endpoint.correlationId === options.targetCorrelationId);
      if (pinned.length === 1) return resolved(selector, "correlation-id", pinned);
      if (pinned.length > 1) {
        return { code: "ambiguous", selector, selectorKind: "correlation-id", candidates: pinned, message: `Multiple endpoints match correlation id ${JSON.stringify(options.targetCorrelationId)}.` };
      }
    }
    const exact = this.#byId.get(selector);
    if (exact && (options.includeSettled !== false || exact.status !== "settled")) return resolved(selector, "endpoint-id", [exact]);

    const requested = selector.startsWith("@") ? selector.slice(1) : selector;
    const agents = endpoints.filter((endpoint) => endpoint.kind === "agent");
    const localAgents = agents.filter((endpoint) => endpoint.scope === "local");
    const marker = requested.lastIndexOf("#");

    // root/@root is reserved for the dispatching root session. An agent named
    // root remains reachable through its decorated name#id or correlation id.
    if (requested === "root") {
      const localRoots = endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.scope === "local");
      if (localRoots.length > 0) return resolved(selector, "local-root", localRoots);
    }

    // The established teammate-send contract gives other local agent names or
    // ids precedence when they resemble owner/window selectors.
    if (options.localFirst !== false) {
      const localNames = localAgents.filter((endpoint) => endpoint.name === requested);
      if (localNames.length > 0) return resolved(selector, "name", localNames);
      if (marker > 0 && marker < requested.length - 1) {
        const name = requested.slice(0, marker);
        const prefix = requested.slice(marker + 1);
        const localDecorated = localAgents.filter((endpoint) =>
          (endpoint.name ?? endpoint.agent) === name && endpoint.correlationId?.startsWith(prefix)
        );
        if (localDecorated.length > 0) return resolved(selector, "name-id-prefix", localDecorated);
      }
      const localIds = localAgents.filter((endpoint) => endpoint.correlationId === requested);
      if (localIds.length > 0) return resolved(selector, "correlation-id", localIds);
      const localPrefixes = localAgents.filter((endpoint) => endpoint.correlationId?.startsWith(requested));
      if (localPrefixes.length > 0) return resolved(selector, "correlation-prefix", localPrefixes);
    }

    const ownerAgent = /^owner:([a-f0-9]{32}):(.+)$/.exec(requested);
    if (ownerAgent) return resolved(selector, "owner-agent", endpoints.filter((endpoint) => endpoint.kind === "agent" && endpoint.ownerId === ownerAgent[1] && endpoint.correlationId === ownerAgent[2]));
    const ownerRoot = /^owner:([a-f0-9]{32})$/.exec(requested);
    if (ownerRoot) return resolved(selector, "owner-root", endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.ownerId === ownerRoot[1]));
    if (requested.startsWith("window:")) {
      const prefix = requested.slice("window:".length);
      return resolved(selector, "window-owner-prefix", endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.ownerId.startsWith(prefix)));
    }
    const sessionNames = endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.sessionName === requested);
    if (sessionNames.length > 0) return resolved(selector, "session-name", sessionNames);

    const globalAgents = options.localFirst === false ? agents : agents.filter((endpoint) => endpoint.scope !== "local");
    const exactIds = globalAgents.filter((endpoint) => endpoint.correlationId === requested);
    if (exactIds.length > 0) return resolved(selector, "correlation-id", exactIds);
    if (marker > 0 && marker < requested.length - 1) {
      const name = requested.slice(0, marker);
      const prefix = requested.slice(marker + 1);
      return resolved(selector, "name-id-prefix", globalAgents.filter((endpoint) => endpoint.name === name && endpoint.correlationId?.startsWith(prefix)));
    }
    const exactNames = globalAgents.filter((endpoint) => endpoint.name === requested);
    if (exactNames.length > 0) {
      const active = exactNames.filter((endpoint) => endpoint.status !== "settled");
      return resolved(selector, "name", active.length > 0 ? active : exactNames);
    }
    return resolved(selector, "correlation-prefix", globalAgents.filter((endpoint) => endpoint.correlationId?.startsWith(requested)));
  }
}

export interface SessionMessageRequest {
  selector: string;
  message: string;
  mode: SessionMessageMode;
  messageId?: string;
  source?: SessionMessageSource;
  messageKind?: SessionMessageKind;
  /** Structured host attribution; absent on legacy callers. */
  provenance?: MessageProvenanceV1;
  /** Authorizes context-only status semantics; never serialized or model-controlled. */
  trustedStatus?: boolean;
  traceId?: string;
  replyTo?: string;
  /** Request one bounded terminal status reply from a root workspace worker. */
  terminalResultRequested?: true;
  fromSessionName?: string;
  /** Pin delivery target; avoids TOCTOU when the selector is rebound between check and route. */
  targetCorrelationId?: string;
  /** Sender correlation id for local agent envelope formatting and inbox attribution. */
  senderCorrelationId?: string;
  /** In-process authority fence checked immediately before external publication; never serialized. */
  authorize?: () => boolean;
  signal?: AbortSignal;
}

export interface SessionEndpointSnapshot {
  contentRevision: string;
  endpoints: readonly SessionEndpoint[];
}

export type WindowThreadDirection = "outgoing" | "incoming";
export type WindowThreadStatus = "pending" | "queued" | "injected" | "accepted" | "rejected" | "timeout";

export interface WindowThreadEntry {
  version: typeof SESSION_ENDPOINT_VERSION;
  messageId: string;
  workspaceId: string;
  peerOwnerId: string;
  peerOwnerNonce: string;
  direction: WindowThreadDirection;
  source: SessionMessageSource;
  messageKind?: SessionMessageKind;
  /** Structured host attribution; absent on legacy journal entries. */
  provenance?: MessageProvenanceV1;
  traceId?: string;
  replyTo?: string;
  /** Opt-in terminal-result contract; absent on legacy journal entries. */
  terminalResultRequested?: true;
  fromSessionName?: string;
  /** Receiving Pi session; prevents inherited fork entries from replaying into the child. */
  targetSessionId?: string;
  targetCorrelationId?: string;
  mode: Exclude<SessionMessageMode, "abort">;
  effectiveMode?: Exclude<SessionMessageMode, "abort">;
  body: string;
  status: WindowThreadStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
  contentRevision: string;
}

export interface WindowThreadSnapshot {
  contentRevision: string;
  entries: readonly WindowThreadEntry[];
}

export type WindowThreadEntryInput = Omit<WindowThreadEntry, "version" | "revision" | "contentRevision">;

/** Only injected/legacy-accepted entries prove model consumption; queued entries remain recoverable. */
export function windowThreadReplayReceipt(
  entry: WindowThreadEntry | undefined,
): { status: "accepted" | "rejected"; message: string } | undefined {
  if (!entry || entry.status === "pending" || entry.status === "queued") return undefined;
  return entry.status === "injected" || entry.status === "accepted"
    ? { status: "accepted", message: "workspace command was already consumed" }
    : { status: "rejected", message: "workspace command was already rejected" };
}

export interface WindowThreadStoreOptions {
  limit?: number;
  persist?: (entry: WindowThreadEntry) => void;
}

function threadKey(entry: Pick<WindowThreadEntry, "direction" | "messageId">): string {
  return `${entry.direction}:${entry.messageId}`;
}

function semanticThreadEntry(entry: Omit<WindowThreadEntry, "contentRevision">): unknown {
  return {
    version: entry.version,
    messageId: entry.messageId,
    workspaceId: entry.workspaceId,
    peerOwnerId: entry.peerOwnerId,
    peerOwnerNonce: entry.peerOwnerNonce,
    direction: entry.direction,
    source: entry.source,
    ...(entry.messageKind === undefined ? {} : { messageKind: entry.messageKind }),
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
    ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
    ...(entry.terminalResultRequested === undefined ? {} : { terminalResultRequested: entry.terminalResultRequested }),
    ...(entry.fromSessionName === undefined ? {} : { fromSessionName: entry.fromSessionName }),
    ...(entry.targetSessionId === undefined ? {} : { targetSessionId: entry.targetSessionId }),
    ...(entry.targetCorrelationId === undefined ? {} : { targetCorrelationId: entry.targetCorrelationId }),
    mode: entry.mode,
    ...(entry.effectiveMode === undefined ? {} : { effectiveMode: entry.effectiveMode }),
    body: entry.body,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
  };
}

function validThreadEntry(value: unknown): WindowThreadEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const normalizedProvenance = entry.provenance === undefined
    ? undefined
    : normalizeMessageProvenanceV1(entry.provenance);
  const replyOwnerMatch = typeof entry.replyTo === "string"
    ? /^owner:([a-f0-9]{32})$/.exec(entry.replyTo)
    : undefined;
  const provenanceOwnerId = normalizedProvenance?.confidence === "verified"
    && "ownerId" in normalizedProvenance.sender
    ? normalizedProvenance.sender.ownerId
    : undefined;
  if (entry.version !== SESSION_ENDPOINT_VERSION
    || typeof entry.messageId !== "string" || entry.messageId.length === 0 || entry.messageId.length > 128
    || typeof entry.workspaceId !== "string" || entry.workspaceId.length === 0 || entry.workspaceId.length > 128
    || typeof entry.peerOwnerId !== "string" || entry.peerOwnerId.length === 0 || entry.peerOwnerId.length > 128
    || typeof entry.peerOwnerNonce !== "string" || entry.peerOwnerNonce.length === 0 || entry.peerOwnerNonce.length > 128
    || (entry.direction !== "outgoing" && entry.direction !== "incoming")
    || (entry.source !== "user" && entry.source !== "monitor" && entry.source !== "system")
    || (entry.messageKind !== undefined
      && entry.messageKind !== "message"
      && entry.messageKind !== "coordination"
      && entry.messageKind !== "request"
      && entry.messageKind !== "status"
      && entry.messageKind !== "supervision")
    || (entry.traceId !== undefined && (typeof entry.traceId !== "string" || entry.traceId.length === 0 || entry.traceId.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.traceId)))
    || (entry.replyTo !== undefined && (typeof entry.replyTo !== "string" || entry.replyTo.length === 0 || entry.replyTo.length > 192 || /[\u0000-\u001f\u007f]/.test(entry.replyTo)))
    || (entry.terminalResultRequested !== undefined && entry.terminalResultRequested !== true)
    || (entry.terminalResultRequested === true
      && (!/^[a-f0-9]{32}$/.test(String(entry.messageId))
        || entry.messageKind !== "request"
        || entry.targetCorrelationId !== "window-main-session"
        || !replyOwnerMatch
        || (entry.direction === "incoming"
          ? replyOwnerMatch[1] !== entry.peerOwnerId
          : provenanceOwnerId !== replyOwnerMatch[1])))
    || (entry.fromSessionName !== undefined && (typeof entry.fromSessionName !== "string" || entry.fromSessionName.length === 0 || entry.fromSessionName.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.fromSessionName)))
    || (entry.targetSessionId !== undefined && (typeof entry.targetSessionId !== "string" || entry.targetSessionId.length === 0 || entry.targetSessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.targetSessionId)))
    || (entry.targetCorrelationId !== undefined && (typeof entry.targetCorrelationId !== "string" || entry.targetCorrelationId.length === 0 || entry.targetCorrelationId.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.targetCorrelationId)))
    || (entry.mode !== "steer" && entry.mode !== "follow_up")
    || (entry.effectiveMode !== undefined && entry.effectiveMode !== "steer" && entry.effectiveMode !== "follow_up")
    || typeof entry.body !== "string"
    || !["pending", "queued", "injected", "accepted", "rejected", "timeout"].includes(String(entry.status))
    || typeof entry.createdAt !== "number" || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
    || typeof entry.updatedAt !== "number" || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < entry.createdAt
    || typeof entry.revision !== "number" || !Number.isSafeInteger(entry.revision) || entry.revision < 1) return undefined;
  const provenance = normalizedProvenance === undefined
    ? undefined
    : normalizedProvenance.confidence === "verified"
      && normalizedProvenance.messageId === entry.messageId
      && normalizedProvenance.messageKind === (entry.messageKind ?? "message")
      && normalizedProvenance.deliveryMode === entry.mode
      ? normalizedProvenance
      : unknownMessageProvenanceV1({
          from: normalizedProvenance.confidence === "unknown" ? normalizedProvenance.legacyLabel : undefined,
          messageId: entry.messageId,
          messageKind: entry.messageKind ?? "message",
          deliveryMode: entry.mode,
        });
  const base = {
    version: SESSION_ENDPOINT_VERSION,
    messageId: entry.messageId,
    workspaceId: entry.workspaceId,
    peerOwnerId: entry.peerOwnerId,
    peerOwnerNonce: entry.peerOwnerNonce,
    direction: entry.direction,
    source: entry.source,
    ...(entry.messageKind === undefined ? {} : { messageKind: entry.messageKind as SessionMessageKind }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(entry.traceId === undefined ? {} : { traceId: entry.traceId as string }),
    ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo as string }),
    ...(entry.terminalResultRequested === undefined ? {} : { terminalResultRequested: true as const }),
    ...(entry.fromSessionName === undefined ? {} : { fromSessionName: entry.fromSessionName as string }),
    ...(entry.targetSessionId === undefined ? {} : { targetSessionId: entry.targetSessionId as string }),
    ...(entry.targetCorrelationId === undefined ? {} : { targetCorrelationId: entry.targetCorrelationId as string }),
    mode: entry.mode,
    ...(entry.effectiveMode === undefined ? {} : { effectiveMode: entry.effectiveMode as Exclude<SessionMessageMode, "abort"> }),
    body: entry.body,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
  } as Omit<WindowThreadEntry, "contentRevision">;
  const contentRevision = sessionContentRevision(semanticThreadEntry(base));
  if (entry.contentRevision !== undefined && entry.contentRevision !== contentRevision) return undefined;
  return Object.freeze({ ...base, contentRevision });
}

function sessionEntryData(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  return entry.type === "custom" && entry.customType === WINDOW_THREAD_ENTRY_TYPE ? entry.data : undefined;
}

function persistedTeammateMessage(value: unknown): { messageId: string; effectiveMode?: "steer" | "follow_up" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; details?: unknown };
  if (entry.type !== "custom_message" || entry.customType !== "teammate-message"
    || !entry.details || typeof entry.details !== "object") return undefined;
  const details = entry.details as { messageId?: unknown; mode?: unknown };
  if (typeof details.messageId !== "string" || details.messageId.length === 0 || details.messageId.length > 128) return undefined;
  const effectiveMode = details.mode === "steer" || details.mode === "follow_up" ? details.mode : undefined;
  return { messageId: details.messageId, ...(effectiveMode === undefined ? {} : { effectiveMode }) };
}

/** Bounded local projection of cross-window command history. */
export class WindowThreadStore {
  readonly limit: number;
  #entries: readonly WindowThreadEntry[] = Object.freeze([]);
  #byKey = new Map<string, WindowThreadEntry>();
  #contentRevision = sessionContentRevision([]);
  #subscribers = new Set<(snapshot: WindowThreadSnapshot) => void>();
  #persist: WindowThreadStoreOptions["persist"];

  constructor(options: WindowThreadStoreOptions = {}) {
    this.limit = options.limit ?? DEFAULT_WINDOW_THREAD_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 10_000) {
      throw new Error("Window thread limit must be an integer between 1 and 10000.");
    }
    this.#persist = options.persist;
  }

  get contentRevision(): string { return this.#contentRevision; }
  list(): readonly WindowThreadEntry[] { return this.#entries; }
  get(messageId: string, direction?: WindowThreadDirection): WindowThreadEntry | undefined {
    if (direction) return this.#byKey.get(`${direction}:${messageId}`);
    return this.#byKey.get(`outgoing:${messageId}`) ?? this.#byKey.get(`incoming:${messageId}`);
  }
  transition(
    messageId: string,
    direction: WindowThreadDirection,
    status: WindowThreadStatus,
    updatedAt = Date.now(),
    effectiveMode?: Exclude<SessionMessageMode, "abort">,
  ): WindowThreadEntry | undefined {
    const previous = this.get(messageId, direction);
    if (!previous) return undefined;
    const { version: _version, revision: _revision, contentRevision: _contentRevision, ...input } = previous;
    return this.record({
      ...input,
      status,
      updatedAt,
      ...(effectiveMode === undefined ? {} : { effectiveMode }),
    });
  }
  reconcileInjected(
    messageId: string,
    updatedAt = Date.now(),
    effectiveMode?: Exclude<SessionMessageMode, "abort">,
  ): WindowThreadEntry | undefined {
    const previous = this.get(messageId, "incoming");
    if (!previous || (previous.status !== "pending" && previous.status !== "queued")) return previous;
    const { contentRevision: _contentRevision, ...base } = previous;
    const candidate = validThreadEntry({
      ...base,
      status: "injected",
      updatedAt: Math.max(previous.updatedAt, updatedAt),
      revision: previous.revision + 1,
      ...(effectiveMode === undefined ? {} : { effectiveMode }),
    });
    if (!candidate) throw new Error("Invalid injected window thread entry.");
    this.#apply(candidate, false);
    return candidate;
  }
  snapshot(): WindowThreadSnapshot {
    return Object.freeze({ contentRevision: this.#contentRevision, entries: this.#entries });
  }
  subscribe(subscriber: (snapshot: WindowThreadSnapshot) => void, options: { emitCurrent?: boolean } = {}): () => void {
    this.#subscribers.add(subscriber);
    if (options.emitCurrent !== false) subscriber(this.snapshot());
    return () => this.#subscribers.delete(subscriber);
  }

  record(input: WindowThreadEntryInput): WindowThreadEntry {
    const key = threadKey(input);
    const previous = this.#byKey.get(key);
    const previousTerminal = previous && ["injected", "accepted", "rejected", "timeout"].includes(previous.status);
    if (previousTerminal) return previous;
    if (previous?.status === "queued" && input.status === "pending") return previous;
    if (previous
      && previous.workspaceId === input.workspaceId
      && previous.peerOwnerId === input.peerOwnerId
      && previous.peerOwnerNonce === input.peerOwnerNonce
      && previous.source === input.source
      && previous.messageKind === input.messageKind
      && JSON.stringify(previous.provenance) === JSON.stringify(input.provenance)
      && previous.traceId === input.traceId
      && previous.replyTo === input.replyTo
      && previous.terminalResultRequested === input.terminalResultRequested
      && previous.fromSessionName === input.fromSessionName
      && previous.targetSessionId === input.targetSessionId
      && previous.targetCorrelationId === input.targetCorrelationId
      && previous.mode === input.mode
      && previous.effectiveMode === input.effectiveMode
      && previous.body === input.body
      && previous.status === input.status
      && previous.createdAt === input.createdAt
      && previous.updatedAt === input.updatedAt) return previous;
    const candidate = validThreadEntry({
      version: SESSION_ENDPOINT_VERSION,
      ...input,
      createdAt: previous?.createdAt ?? input.createdAt,
      updatedAt: Math.max(previous?.updatedAt ?? input.createdAt, input.updatedAt),
      revision: previous ? previous.revision + 1 : 1,
    });
    if (!candidate) throw new Error("Invalid window thread entry.");
    this.#apply(candidate, true);
    return candidate;
  }

  rebuild(sessionEntries: readonly unknown[]): WindowThreadSnapshot {
    const byKey = new Map<string, WindowThreadEntry>();
    const persistedMessages = new Map<string, "steer" | "follow_up" | undefined>();
    for (const sessionEntry of sessionEntries) {
      const message = persistedTeammateMessage(sessionEntry);
      if (message) persistedMessages.set(message.messageId, message.effectiveMode);
      const candidate = validThreadEntry(sessionEntryData(sessionEntry));
      if (!candidate) continue;
      const key = threadKey(candidate);
      const previous = byKey.get(key);
      if (!previous || candidate.revision > previous.revision
        || (candidate.revision === previous.revision && candidate.updatedAt > previous.updatedAt)) {
        byKey.set(key, candidate);
      }
    }
    for (const [key, entry] of byKey) {
      if (entry.direction !== "incoming"
        || (entry.status !== "pending" && entry.status !== "queued")
        || !persistedMessages.has(entry.messageId)) continue;
      const { contentRevision: _contentRevision, ...base } = entry;
      const effectiveMode = persistedMessages.get(entry.messageId) ?? entry.effectiveMode;
      const injected = validThreadEntry({
        ...base,
        status: "injected",
        revision: entry.revision + 1,
        ...(effectiveMode === undefined ? {} : { effectiveMode }),
      });
      if (injected) byKey.set(key, injected);
    }
    this.#replace([...byKey.values()]);
    return this.snapshot();
  }

  #apply(entry: WindowThreadEntry, persist: boolean): void {
    if (persist) this.#persist?.(entry);
    const next = this.#entries.filter((candidate) => threadKey(candidate) !== threadKey(entry));
    next.push(entry);
    this.#replace(next);
  }

  #replace(entries: WindowThreadEntry[]): void {
    const ordered = entries
      .sort((left, right) => left.createdAt - right.createdAt || left.updatedAt - right.updatedAt || threadKey(left).localeCompare(threadKey(right), "en"))
      .slice(-this.limit);
    const contentRevision = sessionContentRevision(ordered.map((entry) => [threadKey(entry), entry.contentRevision]));
    if (contentRevision === this.#contentRevision) return;
    this.#entries = Object.freeze(ordered);
    this.#byKey = new Map(ordered.map((entry) => [threadKey(entry), entry]));
    this.#contentRevision = contentRevision;
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber(snapshot);
  }
}

export interface SessionRouteClassification {
  transport: SessionEndpointTransport;
  routable: boolean;
  reason?: string;
}

export interface SessionMessageResult {
  delivered: boolean;
  endpointId?: string;
  transport?: SessionEndpointTransport;
  error?: string;
  receipt?: {
    mode?: string;
    requestedMode?: SessionMessageMode;
    effectiveMode?: SessionMessageMode;
    deliveryStage?: SessionDeliveryStage;
    publicationStage?: "published" | "accepted" | "rejected";
    messageId?: string;
    traceId?: string;
    wasSleeping?: boolean;
    contextDeferred?: boolean;
    terminatedCount?: number;
  };
}

export interface SessionTransportAdapter {
  readonly transport: SessionEndpointTransport;
  classify(endpoint: SessionEndpoint, request: SessionMessageRequest): SessionRouteClassification;
  deliver(endpoint: SessionEndpoint, request: SessionMessageRequest): Promise<SessionMessageResult>;
}

export interface LegacySessionAuthority {
  resolve(request: SessionMessageRequest): SessionResolution;
  classify(request: SessionMessageRequest, resolution: SessionResolution): SessionRouteClassification;
  deliver(request: SessionMessageRequest, resolution: SessionResolution): Promise<SessionMessageResult>;
}

export interface SessionShadowComparison {
  selector: string;
  legacy: { resolution: SessionResolutionCode; endpointId?: string; transport?: SessionEndpointTransport; routable: boolean };
  unified: { resolution: SessionResolutionCode; endpointId?: string; transport?: SessionEndpointTransport; routable: boolean };
  matches: boolean;
}

export interface MessageRouterOptions {
  directory: EndpointDirectory;
  surface?: SessionSurfaceMode;
  adapters?: readonly SessionTransportAdapter[];
  legacy?: LegacySessionAuthority;
  onShadowComparison?: (comparison: SessionShadowComparison) => void;
}

function summary(resolution: SessionResolution, classification: SessionRouteClassification): SessionShadowComparison["legacy"] {
  return {
    resolution: resolution.code,
    ...(resolution.endpoint ? { endpointId: resolution.endpoint.id } : {}),
    transport: classification.transport,
    routable: classification.routable,
  };
}

export class MessageRouter {
  readonly directory: EndpointDirectory;
  #surface: SessionSurfaceMode;
  #legacy: LegacySessionAuthority | undefined;
  #adapters = new Map<SessionEndpointTransport, SessionTransportAdapter>();
  #onShadowComparison: MessageRouterOptions["onShadowComparison"];

  constructor(options: MessageRouterOptions) {
    this.directory = options.directory;
    this.#surface = options.surface ?? "legacy";
    this.#legacy = options.legacy;
    this.#onShadowComparison = options.onShadowComparison;
    for (const adapter of options.adapters ?? []) this.#adapters.set(adapter.transport, adapter);
  }

  get surface(): SessionSurfaceMode { return this.#surface; }
  setSurface(surface: SessionSurfaceMode): void { this.#surface = surface; }

  classify(request: SessionMessageRequest, resolution = this.directory.resolve(request.selector, {
    includeSettled: true,
    targetCorrelationId: request.targetCorrelationId,
  })): SessionRouteClassification {
    if (resolution.code !== "resolved" || !resolution.endpoint) return { transport: "local-agent-mailbox", routable: false, reason: resolution.message ?? resolution.code };
    const adapter = this.#adapters.get(resolution.endpoint.transport);
    return adapter?.classify(resolution.endpoint, request) ?? { transport: resolution.endpoint.transport, routable: false, reason: `No ${resolution.endpoint.transport} adapter is registered.` };
  }

  compare(request: SessionMessageRequest): SessionShadowComparison | undefined {
    if (!this.#legacy) return undefined;
    const legacyResolution = this.#legacy.resolve(request);
    const legacyClassification = this.#legacy.classify(request, legacyResolution);
    const unifiedResolution = this.directory.resolve(request.selector, {
      includeSettled: true,
      targetCorrelationId: request.targetCorrelationId,
    });
    const unifiedClassification = this.classify(request, unifiedResolution);
    const legacy = summary(legacyResolution, legacyClassification);
    const unified = summary(unifiedResolution, unifiedClassification);
    const comparison = {
      selector: request.selector,
      legacy,
      unified,
      matches: legacy.resolution === unified.resolution
        && legacy.endpointId === unified.endpointId
        && legacy.transport === unified.transport
        && legacy.routable === unified.routable,
    };
    this.#onShadowComparison?.(comparison);
    return comparison;
  }

  async route(request: SessionMessageRequest): Promise<SessionMessageResult> {
    if (this.#surface !== "unified") {
      if (!this.#legacy) return { delivered: false, error: "Legacy session delivery authority is unavailable." };
      if (this.#surface === "shadow") this.compare(request);
      const resolution = this.#legacy.resolve(request);
      return this.#legacy.deliver(request, resolution);
    }
    const resolution = this.directory.resolve(request.selector, {
      includeSettled: true,
      targetCorrelationId: request.targetCorrelationId,
    });
    if (resolution.code !== "resolved" || !resolution.endpoint) return { delivered: false, error: resolution.message ?? resolution.code };
    const classification = this.classify(request, resolution);
    if (!classification.routable) return { delivered: false, endpointId: resolution.endpoint.id, transport: classification.transport, error: classification.reason };
    const adapter = this.#adapters.get(classification.transport);
    if (!adapter) return { delivered: false, endpointId: resolution.endpoint.id, transport: classification.transport, error: "Session transport adapter is unavailable." };
    return adapter.deliver(resolution.endpoint, request);
  }
}

export interface SessionHostControls {
  requestWindowMode?: (action: SessionWindowModeAction) => void | Promise<void>;
}

export interface SessionHostRegistryOptions extends Omit<MessageRouterOptions, "directory"> {
  endpoints?: readonly SessionEndpoint[];
  thread?: WindowThreadStore;
  controls?: SessionHostControls;
  /** Canonical host boundary applied to every public send entry point. */
  prepareMessage?: (request: SessionMessageRequest) => SessionMessageRequest;
}

export interface SessionHostSnapshot {
  version: typeof SESSION_ENDPOINT_VERSION;
  contentRevision: string;
  endpointContentRevision: string;
  threadContentRevision: string;
  viewMode: SessionViewMode;
  endpoints: readonly SessionEndpoint[];
  thread: readonly WindowThreadEntry[];
}

export class SessionHostRegistry {
  readonly version = SESSION_ENDPOINT_VERSION;
  readonly directory: EndpointDirectory;
  readonly router: MessageRouter;
  readonly thread: WindowThreadStore;
  #subscribers = new Set<(snapshot: SessionHostSnapshot) => void>();
  #controls: SessionHostControls;
  #prepareMessage: ((request: SessionMessageRequest) => SessionMessageRequest) | undefined;
  #viewMode: SessionViewMode = "agents";

  constructor(options: SessionHostRegistryOptions = {}) {
    this.directory = new EndpointDirectory(options.endpoints);
    this.thread = options.thread ?? new WindowThreadStore();
    this.router = new MessageRouter({ ...options, directory: this.directory });
    this.#controls = options.controls ?? {};
    this.#prepareMessage = options.prepareMessage;
    this.directory.subscribe(() => this.#publish(), { emitCurrent: false });
    this.thread.subscribe(() => this.#publish(), { emitCurrent: false });
  }

  get contentRevision(): string { return this.snapshot().contentRevision; }
  get viewMode(): SessionViewMode { return this.#viewMode; }
  replaceEndpoints(endpoints: readonly SessionEndpoint[]): void { this.directory.replace(endpoints); }
  listEndpoints(): readonly SessionEndpoint[] { return this.directory.list(); }
  resolve(selector: string, options?: SessionResolveOptions): SessionResolution { return this.directory.resolve(selector, options); }
  send(request: SessionMessageRequest): Promise<SessionMessageResult> {
    const prepared = this.#prepareMessage?.(request) ?? request;
    if (prepared.provenance === undefined) return this.router.route(prepared);
    const normalized = normalizeMessageProvenanceV1(prepared.provenance);
    const messageId = prepared.messageId ?? normalized.messageId;
    const messageKind = prepared.messageKind ?? "message";
    const bound = normalized.confidence === "verified"
      && normalized.messageId === messageId
      && normalized.messageKind === messageKind
      && normalized.deliveryMode === prepared.mode;
    const provenance = bound
      ? normalized
      : unknownMessageProvenanceV1({
          from: normalized.confidence === "unknown" ? normalized.legacyLabel : undefined,
          messageId,
          messageKind,
          deliveryMode: prepared.mode,
        });
    return this.router.route({ ...prepared, ...(messageId === undefined ? {} : { messageId }), provenance });
  }
  setControls(controls: SessionHostControls): void { this.#controls = controls; }
  setViewMode(mode: SessionViewMode): void {
    if (mode === this.#viewMode) return;
    this.#viewMode = mode;
    this.#publish();
  }
  async requestWindowMode(action: SessionWindowModeAction): Promise<void> {
    if (this.#controls.requestWindowMode) await this.#controls.requestWindowMode(action);
    else this.setViewMode(action === "enter" ? "windows" : "agents");
  }
  snapshot(): SessionHostSnapshot {
    const endpointContentRevision = this.directory.contentRevision;
    const threadContentRevision = this.thread.contentRevision;
    return Object.freeze({
      version: this.version,
      contentRevision: sessionContentRevision([
        endpointContentRevision,
        threadContentRevision,
        this.#viewMode,
      ]),
      endpointContentRevision,
      threadContentRevision,
      viewMode: this.#viewMode,
      endpoints: this.directory.list(),
      thread: this.thread.list(),
    });
  }
  subscribe(subscriber: (snapshot: SessionHostSnapshot) => void, options: { emitCurrent?: boolean } = {}): () => void {
    this.#subscribers.add(subscriber);
    if (options.emitCurrent !== false) subscriber(this.snapshot());
    return () => this.#subscribers.delete(subscriber);
  }
  #publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber(snapshot);
  }
}

export function getSessionHostRegistry(
  host: typeof globalThis & Record<symbol, unknown> = globalThis as typeof globalThis & Record<symbol, unknown>,
): SessionHostRegistry | undefined {
  const candidate = host[SESSION_HOST_REGISTRY_KEY];
  return candidate instanceof SessionHostRegistry ? candidate : undefined;
}

export function publishSessionHostRegistry(
  registry: SessionHostRegistry | undefined,
  host: typeof globalThis & Record<symbol, unknown> = globalThis as typeof globalThis & Record<symbol, unknown>,
): void {
  host[SESSION_HOST_REGISTRY_KEY] = registry;
}

/** Refreshes workspace-peer discovery and rebuilds the endpoint directory of the published session host registry. */
export type SessionHostDirectoryRefresh = () => Promise<void>;

export function getSessionHostDirectoryRefresh(
  host: typeof globalThis & Record<symbol, unknown> = globalThis as typeof globalThis & Record<symbol, unknown>,
): SessionHostDirectoryRefresh | undefined {
  const candidate = host[SESSION_HOST_DIRECTORY_REFRESH_KEY];
  return typeof candidate === "function" ? candidate as SessionHostDirectoryRefresh : undefined;
}

export function publishSessionHostDirectoryRefresh(
  refresh: SessionHostDirectoryRefresh | undefined,
  host: typeof globalThis & Record<symbol, unknown> = globalThis as typeof globalThis & Record<symbol, unknown>,
): void {
  host[SESSION_HOST_DIRECTORY_REFRESH_KEY] = refresh;
}

export type SessionTransportDelivery = (endpoint: SessionEndpoint, request: SessionMessageRequest) => Promise<SessionMessageResult>;

function callbackAdapter(
  transport: SessionEndpointTransport,
  supports: (endpoint: SessionEndpoint, request: SessionMessageRequest) => string | undefined,
  deliver: SessionTransportDelivery,
): SessionTransportAdapter {
  return {
    transport,
    classify(endpoint, request) {
      const reason = supports(endpoint, request);
      return { transport, routable: reason === undefined, ...(reason ? { reason } : {}) };
    },
    deliver,
  };
}

function capabilityReason(endpoint: SessionEndpoint, request: SessionMessageRequest): string | undefined {
  if (endpoint.status === "settled") return "The session endpoint is settled.";
  if (!endpoint.capabilities.includes(request.mode)) return `The session endpoint does not support ${request.mode}.`;
  return undefined;
}

export function createLocalRootTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter {
  return callbackAdapter("local-root", (endpoint, request) => endpoint.transport === "local-root" ? capabilityReason(endpoint, request) : "Not a local root endpoint.", deliver);
}

export function createLocalAgentMailboxTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter {
  return callbackAdapter("local-agent-mailbox", (endpoint, request) => endpoint.transport === "local-agent-mailbox" ? capabilityReason(endpoint, request) : "Not a local agent mailbox endpoint.", deliver);
}

export function createWorkspacePeerV1TransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter {
  return callbackAdapter("workspace-peer-v1", (endpoint, request) => endpoint.transport === "workspace-peer-v1" ? capabilityReason(endpoint, request) : "Not a workspace peer endpoint.", deliver);
}

/** Child callers proxy every target to the root; the root remains delivery authority. */
export function createChildIpcTransportAdapter(deliver: SessionTransportDelivery): SessionTransportAdapter {
  return callbackAdapter("child-ipc", (endpoint, request) => endpoint.transport === "child-ipc" ? capabilityReason(endpoint, request) : "Not a child IPC endpoint.", deliver);
}
