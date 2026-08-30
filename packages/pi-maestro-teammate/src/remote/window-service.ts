import { createHash } from "node:crypto";
import {
  WORKSPACE_MAIN_SESSION_MARKER,
  createWorkspacePeerIdentity,
  discoverWorkspacePeers,
  enqueueWorkspacePeerCommand,
  consumeWorkspacePeerCommands,
  readWorkspacePeerResponseForOwner,
  workspaceProtocolCommandId,
  type WorkspaceOwnerSnapshot,
  type WorkspacePeerCommand,
  type WorkspacePeerCommandResponse,
  type WorkspacePeerIdentity,
  type WorkspaceResolvedTarget,
} from "../sessions/workspace-peer-core.ts";
import type { RemoteWorkerIdentity, ResolvedRemoteWorkspace } from "./types.ts";
import type { RuntimeEventDraftV2 } from "../runtime-v2/contracts.ts";
import {
  SESSION_MESSAGE_ACCEPTED_EVENT_V2,
  SESSION_MESSAGE_INJECTED_EVENT_V2,
  SESSION_MESSAGE_REPLIED_EVENT_V2,
  SESSION_WINDOW_ADVERTISED_EVENT_V2,
  SESSION_WINDOW_HEARTBEAT_EVENT_V2,
  SESSION_WINDOW_WITHDRAWN_EVENT_V2,
  createSessionDomainEventDraftV2,
  type SessionDomainEventTypeV2,
  type SessionMessageDomainPayloadV2,
  type SessionRouteCaptureV2,
  type SessionWindowDomainPayloadV2,
} from "../runtime-v2/session-domain.ts";
import {
  REMOTE_WINDOW_TRANSPORT_VERSION,
  normalizeRemoteWindowCapture,
  remoteWindowCaptureMatches,
  type RemoteWindowCapability,
  type RemoteWindowCapture,
  type RemoteWindowListParams,
  type RemoteWindowListResult,
  type RemoteWindowMessageNotification,
  type RemoteWindowNotification,
  type RemoteWindowObserveParams,
  type RemoteWindowObserveResult,
  type RemoteWindowReceipt,
  type RemoteWindowReceiptParams,
  type RemoteWindowReceiptResult,
  type RemoteWindowSendParams,
  type RemoteWindowSendResult,
} from "./window-protocol.ts";

const RELAY_VERSION = 1;
const DEFAULT_RELAY_TTL_MS = 10 * 60_000;
const MAX_RELAY_TTL_MS = 10 * 60_000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_RELAYS = 256;
const MAX_INBOUND_MESSAGES = 512;

interface RelayBinding {
  key: string;
  monitorOwnerNonce: string;
  workspace: ResolvedRemoteWorkspace;
  identity: WorkspacePeerIdentity;
  capture: RemoteWindowCapture;
  messageId: string;
  commandId: string;
  requestedMode: "steer" | "follow_up";
  createdAt: number;
  expiresAt: number;
  retainUntil: number;
  lastStatus: RemoteWindowReceipt["status"];
}

interface InboundRelayMessage {
  monitorOwnerNonce: string;
  notification: RemoteWindowMessageNotification;
  expiresAt: number;
}

interface AdvertisedWindow {
  capture: RemoteWindowCapture;
  status: "running" | "sleeping";
  agentCount: number;
  sessionId?: string;
  sessionName?: string;
  publishedAt: number;
}

export interface RemoteWindowServiceOptions {
  workspaces: readonly ResolvedRemoteWorkspace[];
  identity: RemoteWorkerIdentity;
  notify: (monitorOwnerNonce: string, notification: RemoteWindowNotification) => void;
  onDomainEvent?: (event: RuntimeEventDraftV2) => void;
  now?: () => number;
  maxRelays?: number;
}

function stableProtocolId(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex").slice(0, 32);
}

function ownerTarget(owner: WorkspaceOwnerSnapshot): WorkspaceResolvedTarget {
  return {
    scope: "remote",
    ownerId: owner.ownerId,
    ownerNonce: owner.ownerNonce,
    state: "active",
    agent: {
      correlationId: WORKSPACE_MAIN_SESSION_MARKER,
      agent: "window",
      status: "running",
      startedAt: owner.publishedAt,
      lastActivityAt: owner.publishedAt,
    },
  };
}

function capabilitiesFor(owner: WorkspaceOwnerSnapshot): readonly RemoteWindowCapability[] {
  const capabilities: RemoteWindowCapability[] = ["observe", "steer", "follow_up", "receipt"];
  if (owner.relay?.versions.includes(RELAY_VERSION) && owner.relay.capabilities.includes("reply")) {
    capabilities.push("reply");
  }
  return Object.freeze(capabilities);
}

function listingStatus(owner: WorkspaceOwnerSnapshot): "running" | "sleeping" {
  return owner.agents.some((agent) => agent.status === "running") || (owner.backgroundJobs?.length ?? 0) > 0
    ? "running"
    : "sleeping";
}

function responseReceiptStatus(response: WorkspacePeerCommandResponse | undefined): RemoteWindowReceipt["status"] {
  if (!response) return "queued";
  if (response.status === "expired") return "expired";
  if (response.status !== "accepted") return "rejected";
  return response.deliveryStage ?? "queued";
}

export class RemoteWindowService {
  readonly #workspaces: Map<string, ResolvedRemoteWorkspace>;
  readonly #identity: RemoteWorkerIdentity;
  readonly #notify: RemoteWindowServiceOptions["notify"];
  readonly #onDomainEvent: RemoteWindowServiceOptions["onDomainEvent"];
  readonly #now: () => number;
  readonly #maxRelays: number;
  readonly #relays = new Map<string, RelayBinding>();
  readonly #inbound = new Map<string, InboundRelayMessage>();
  readonly #advertised = new Map<string, AdvertisedWindow>();
  #closed = false;

  constructor(options: RemoteWindowServiceOptions) {
    this.#workspaces = new Map(options.workspaces.map((workspace) => [workspace.workspaceRef, workspace]));
    this.#identity = options.identity;
    this.#notify = options.notify;
    this.#onDomainEvent = options.onDomainEvent;
    this.#now = options.now ?? Date.now;
    this.#maxRelays = options.maxRelays ?? DEFAULT_MAX_RELAYS;
    if (!Number.isSafeInteger(this.#maxRelays) || this.#maxRelays < 1 || this.#maxRelays > 4_096) {
      throw new Error("Remote window relay limit must be between 1 and 4096");
    }
  }

  async list(params: RemoteWindowListParams): Promise<RemoteWindowListResult> {
    this.#assertOpen();
    const workspace = this.#trustedWorkspace(params.workspaceRef, params.authorityId);
    const identity = this.#discoveryIdentity(workspace);
    const discovery = await discoverWorkspacePeers(identity, { includeSelf: true });
    const windows = discovery.peers
      .filter((owner) => this.#compatibleOwner(owner))
      .map((owner) => {
        const capture = this.#capture(params.monitorOwnerNonce, workspace, owner);
        const listing = Object.freeze({
          capture,
          ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
          ...(owner.sessionName === undefined ? {} : { sessionName: owner.sessionName }),
          status: listingStatus(owner),
          agentCount: owner.agents.length,
          publishedAt: owner.publishedAt,
          cancel: false as const,
        });
        const key = this.#windowKey(capture);
        this.#emitWindowEvent(
          this.#advertised.has(key) ? SESSION_WINDOW_HEARTBEAT_EVENT_V2 : SESSION_WINDOW_ADVERTISED_EVENT_V2,
          listing,
        );
        this.#advertised.set(key, listing);
        return listing;
      });
    const currentKeys = new Set(windows.map((window) => this.#windowKey(window.capture)));
    for (const [key, previous] of this.#advertised) {
      if (previous.capture.workspaceRef !== workspace.workspaceRef || currentKeys.has(key)) continue;
      this.#advertised.delete(key);
      this.#emitWindowEvent(SESSION_WINDOW_WITHDRAWN_EVENT_V2, {
        ...previous,
        status: "unavailable",
        agentCount: 0,
        publishedAt: this.#now(),
      }, "owner-replaced");
      this.#notify(previous.capture.monitorOwnerNonce, {
        type: "window/state",
        capture: previous.capture,
        state: "unavailable",
        observedAt: this.#now(),
        reason: "owner-replaced",
      });
    }
    return Object.freeze({ windows: Object.freeze(windows) });
  }

  async observe(params: RemoteWindowObserveParams): Promise<RemoteWindowObserveResult> {
    this.#assertOpen();
    const { capture, owner } = await this.#currentOwner(params.monitorOwnerNonce, params.capture);
    return Object.freeze({ capture, owner: Object.freeze(owner), observedAt: this.#now() });
  }

  async send(params: RemoteWindowSendParams): Promise<RemoteWindowSendResult> {
    this.#assertOpen();
    const current = await this.#currentOwner(params.monitorOwnerNonce, params.capture);
    if (!current.capture.capabilities.includes(params.mode)) {
      throw new Error(`Remote window does not support ${params.mode}`);
    }
    const key = this.#relayKey(params.monitorOwnerNonce, current.capture, params.messageId);
    const existing = this.#relays.get(key);
    if (existing) {
      if (!remoteWindowCaptureMatches(existing.capture, current.capture)
        || existing.requestedMode !== params.mode) {
        throw new Error("Remote window message id was reused with different parameters");
      }
      return { receipt: await this.#refreshReceipt(existing) };
    }
    await this.#sweep();
    if (this.#relays.size >= this.#maxRelays) {
      const expired = [...this.#relays.entries()].find(([, binding]) => this.#now() >= binding.expiresAt);
      if (expired) this.#relays.delete(expired[0]);
    }
    if (this.#relays.size >= this.#maxRelays) throw new Error("Remote window relay limit reached");
    const relayId = stableProtocolId(
      "remote-window-relay",
      this.#identity.instanceNonce,
      params.monitorOwnerNonce,
      current.capture.workspaceRef,
      params.messageId,
    );
    const relayNonce = stableProtocolId("remote-window-relay-nonce", this.#identity.instanceNonce, relayId);
    const identity = createWorkspacePeerIdentity(current.workspace.cwd, {
      ownerId: relayId,
      ownerNonce: relayNonce,
    });
    const now = this.#now();
    const ttlMs = params.ttlMs ?? DEFAULT_RELAY_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_RELAY_TTL_MS) {
      throw new Error("Remote window message TTL is outside protocol bounds");
    }
    const commandId = workspaceProtocolCommandId(params.messageId);
    if (!commandId) throw new Error("Remote window message id is invalid");
    const binding: RelayBinding = {
      key,
      monitorOwnerNonce: params.monitorOwnerNonce,
      workspace: current.workspace,
      identity,
      capture: current.capture,
      messageId: params.messageId,
      commandId,
      requestedMode: params.mode,
      createdAt: now,
      expiresAt: now + ttlMs,
      retainUntil: now + ttlMs + RECEIPT_RETENTION_MS,
      lastStatus: "queued",
    };
    this.#relays.set(key, binding);
    try {
      await enqueueWorkspacePeerCommand(identity, ownerTarget(current.owner), params.mode, params.message, {
        now,
        ttlMs,
        messageId: params.messageId,
        source: params.source,
        messageKind: params.messageKind,
        traceId: params.messageId,
        ...(current.capture.capabilities.includes("reply") ? { replyTo: `relay:${relayId}` } : {}),
        beforePublish: () => this.#currentOwner(params.monitorOwnerNonce, current.capture).then(() => undefined),
        beforeCommit: () => this.#currentOwner(params.monitorOwnerNonce, current.capture).then(() => undefined),
      });
      this.#emitMessageEvent(SESSION_MESSAGE_ACCEPTED_EVENT_V2, binding);
    } catch (error) {
      this.#relays.delete(key);
      throw error;
    }
    return { receipt: await this.#refreshReceipt(binding) };
  }

  async receipt(params: RemoteWindowReceiptParams): Promise<RemoteWindowReceiptResult> {
    this.#assertOpen();
    if (params.direction === "incoming") {
      const inbound = this.#inbound.get(params.messageId);
      if (!inbound
        || inbound.monitorOwnerNonce !== params.monitorOwnerNonce
        || !remoteWindowCaptureMatches(inbound.notification.capture, params.capture)) {
        return Object.freeze({ acknowledged: false });
      }
      if (params.acknowledge === "injected") this.#inbound.delete(params.messageId);
      return Object.freeze({ acknowledged: params.acknowledge === "injected" });
    }
    const binding = this.#relays.get(this.#relayKey(params.monitorOwnerNonce, params.capture, params.messageId));
    if (!binding || !remoteWindowCaptureMatches(binding.capture, params.capture)) return Object.freeze({});
    await this.#pumpRelay(binding);
    return Object.freeze({ receipt: await this.#refreshReceipt(binding) });
  }

  async tick(): Promise<void> {
    if (this.#closed) return;
    await this.#sweep();
    for (const binding of this.#relays.values()) {
      await this.#pumpRelay(binding).catch(() => undefined);
      await this.#refreshReceipt(binding).catch(() => undefined);
    }
    for (const inbound of this.#inbound.values()) {
      this.#notify(inbound.monitorOwnerNonce, inbound.notification);
    }
  }

  close(): void {
    if (this.#closed) return;
    for (const listing of this.#advertised.values()) {
      this.#emitWindowEvent(SESSION_WINDOW_WITHDRAWN_EVENT_V2, {
        ...listing,
        status: "unavailable",
        agentCount: 0,
        publishedAt: this.#now(),
      }, "monitor-exited");
    }
    this.#closed = true;
    this.#relays.clear();
    this.#inbound.clear();
    this.#advertised.clear();
  }

  #windowKey(capture: RemoteWindowCapture): string {
    return `${capture.workspaceRef}:${capture.gatewayInstanceNonce}:${capture.ownerId}:${capture.ownerNonce}`;
  }

  #domainRoute(capture: RemoteWindowCapture): SessionRouteCaptureV2 {
    return {
      version: 1,
      authority: {
        kind: "ssh",
        authorityId: capture.authorityId,
        instanceNonce: capture.gatewayInstanceNonce,
      },
      actor: {
        version: 2,
        revision: 1,
        workspaceId: capture.workspaceId,
        actorKind: "remote",
        actorId: `${capture.gatewayWorkerId}:${capture.ownerId}`,
        generation: capture.generation,
      },
      transport: "remote-workspace-rpc-v1",
      capabilities: ["inspect", "message", ...capture.capabilities.filter((capability) => capability !== "observe")],
      workspaceRef: capture.workspaceRef,
      target: `ssh-window:${capture.workspaceRef}:${capture.ownerId}`,
      ownerId: capture.ownerId,
      ownerNonce: capture.ownerNonce,
      cancel: false,
    };
  }

  #emitWindowEvent(
    eventType: typeof SESSION_WINDOW_ADVERTISED_EVENT_V2 | typeof SESSION_WINDOW_HEARTBEAT_EVENT_V2 | typeof SESSION_WINDOW_WITHDRAWN_EVENT_V2,
    listing: { capture: RemoteWindowCapture; status: "running" | "sleeping" | "unavailable"; agentCount: number; sessionId?: string; sessionName?: string; publishedAt: number },
    reason?: SessionWindowDomainPayloadV2["reason"],
  ): void {
    if (!this.#onDomainEvent) return;
    const payload: SessionWindowDomainPayloadV2 = {
      version: 1,
      route: this.#domainRoute(listing.capture),
      status: listing.status,
      ...(listing.sessionId === undefined ? {} : { sessionId: listing.sessionId }),
      ...(listing.sessionName === undefined ? {} : { sessionName: listing.sessionName }),
      agentCount: listing.agentCount,
      ...(reason === undefined ? {} : { reason }),
    };
    this.#emit(eventType, this.#windowKey(listing.capture), listing.publishedAt, payload);
  }

  #emitMessageEvent(
    eventType: typeof SESSION_MESSAGE_ACCEPTED_EVENT_V2 | typeof SESSION_MESSAGE_INJECTED_EVENT_V2 | typeof SESSION_MESSAGE_REPLIED_EVENT_V2,
    binding: RelayBinding,
  ): void {
    if (!this.#onDomainEvent) return;
    const payload: SessionMessageDomainPayloadV2 = {
      version: 1,
      route: this.#domainRoute(binding.capture),
      messageId: binding.messageId,
      direction: "outgoing",
      mode: binding.requestedMode,
    };
    this.#emit(eventType, `${binding.messageId}:${eventType}`, this.#now(), payload);
  }

  #emit(
    eventType: SessionDomainEventTypeV2,
    eventId: string,
    occurredAt: number,
    payload: SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2,
  ): void {
    try {
      this.#onDomainEvent?.(createSessionDomainEventDraftV2({
        eventType,
        streamId: `session-window:${payload.route.actor.workspaceId}:${payload.route.ownerId}:${payload.route.actor.generation}`,
        actor: payload.route.actor,
        eventId,
        occurredAt,
        payload,
      }));
    } catch {
      // Runtime V2 is advisory until its independent outbox switch becomes canonical.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Remote window service is closed");
  }

  #trustedWorkspace(workspaceRef: string, authorityId: string): ResolvedRemoteWorkspace {
    const workspace = this.#workspaces.get(workspaceRef);
    if (!workspace) throw new Error(`Unknown configured remote workspace: ${workspaceRef}`);
    if (workspace.host !== authorityId) throw new Error("Remote window authority does not match the trusted workspace");
    return workspace;
  }

  #discoveryIdentity(workspace: ResolvedRemoteWorkspace): WorkspacePeerIdentity {
    return createWorkspacePeerIdentity(workspace.cwd, {
      ownerId: stableProtocolId("remote-window-gateway", this.#identity.instanceNonce, workspace.workspaceRef),
      ownerNonce: stableProtocolId("remote-window-gateway-nonce", this.#identity.instanceNonce, workspace.workspaceRef),
    });
  }

  #compatibleOwner(owner: WorkspaceOwnerSnapshot): boolean {
    return owner.plugin?.id === "pi-maestro-teammate"
      && owner.protocol?.workspacePeerVersion === 1
      && owner.protocol.commandResponseVersion === 1;
  }

  #capture(
    monitorOwnerNonce: string,
    workspace: ResolvedRemoteWorkspace,
    owner: WorkspaceOwnerSnapshot,
  ): RemoteWindowCapture {
    return Object.freeze({
      workspaceRef: workspace.workspaceRef,
      authorityId: workspace.host,
      gatewayWorkerId: this.#identity.workerId,
      gatewayInstanceNonce: this.#identity.instanceNonce,
      monitorOwnerNonce,
      workspaceId: owner.workspaceId,
      ownerId: owner.ownerId,
      ownerNonce: owner.ownerNonce,
      generation: owner.ownerGeneration ?? 1,
      transportVersion: REMOTE_WINDOW_TRANSPORT_VERSION,
      capabilities: capabilitiesFor(owner),
      cancel: false,
    });
  }

  async #currentOwner(
    monitorOwnerNonce: string,
    rawCapture: RemoteWindowCapture,
  ): Promise<{ capture: RemoteWindowCapture; workspace: ResolvedRemoteWorkspace; owner: WorkspaceOwnerSnapshot }> {
    const capture = normalizeRemoteWindowCapture(rawCapture, {
      gatewayWorkerId: this.#identity.workerId,
      gatewayInstanceNonce: this.#identity.instanceNonce,
      monitorOwnerNonce,
    });
    const workspace = this.#trustedWorkspace(capture.workspaceRef, capture.authorityId);
    const discovery = await discoverWorkspacePeers(this.#discoveryIdentity(workspace), { includeSelf: true });
    const owner = discovery.peers.find((candidate) => candidate.ownerId === capture.ownerId);
    if (!owner || !this.#compatibleOwner(owner)
      || owner.workspaceId !== capture.workspaceId
      || owner.ownerNonce !== capture.ownerNonce
      || (owner.ownerGeneration ?? 1) !== capture.generation) {
      throw new Error("Remote window owner capture mismatch");
    }
    return { capture, workspace, owner };
  }

  #relayKey(monitorOwnerNonce: string, capture: RemoteWindowCapture, messageId: string): string {
    return `${monitorOwnerNonce}\0${capture.workspaceRef}\0${capture.ownerId}\0${messageId}`;
  }

  #receipt(binding: RelayBinding, response?: WorkspacePeerCommandResponse): RemoteWindowReceipt {
    const now = this.#now();
    const status = now >= binding.expiresAt ? "expired" : responseReceiptStatus(response);
    return Object.freeze({
      capture: binding.capture,
      messageId: binding.messageId,
      requestedMode: binding.requestedMode,
      ...(response?.effectiveAction === undefined ? {} : { effectiveMode: response.effectiveAction }),
      status,
      updatedAt: response?.respondedAt ?? now,
      expiresAt: binding.expiresAt,
      relayId: binding.identity.ownerId,
      ...(response?.message === undefined ? {} : { detail: response.message }),
    });
  }

  async #refreshReceipt(binding: RelayBinding): Promise<RemoteWindowReceipt> {
    const response = await readWorkspacePeerResponseForOwner(binding.identity, binding.identity.ownerId, binding.commandId);
    const receipt = this.#receipt(binding, response);
    if (receipt.status !== binding.lastStatus) {
      binding.lastStatus = receipt.status;
      if (receipt.status === "injected") this.#emitMessageEvent(SESSION_MESSAGE_INJECTED_EVENT_V2, binding);
      if (receipt.status === "replied") this.#emitMessageEvent(SESSION_MESSAGE_REPLIED_EVENT_V2, binding);
      this.#notify(binding.monitorOwnerNonce, {
        type: "window/state",
        capture: binding.capture,
        state: receipt.status === "expired" || receipt.status === "rejected" ? "unavailable" : "updated",
        observedAt: this.#now(),
        receipt,
        ...(receipt.status === "expired" ? { reason: "expired" as const } : {}),
      });
    }
    return receipt;
  }

  async #pumpRelay(binding: RelayBinding): Promise<void> {
    if (!binding.capture.capabilities.includes("reply") || this.#now() >= binding.expiresAt) return;
    await this.#currentOwner(binding.monitorOwnerNonce, binding.capture);
    await consumeWorkspacePeerCommands(binding.identity, async (command: WorkspacePeerCommand) => {
      const receivedAt = this.#now();
      const notification: RemoteWindowMessageNotification = Object.freeze({
        type: "window/message",
        capture: binding.capture,
        relayId: binding.identity.ownerId,
        messageId: command.commandId,
        inReplyTo: binding.messageId,
        mode: command.action,
        source: command.source ?? "system",
        messageKind: command.messageKind ?? "message",
        message: command.message,
        createdAt: command.createdAt,
        receivedAt,
      });
      if (this.#inbound.size >= MAX_INBOUND_MESSAGES && !this.#inbound.has(command.commandId)) {
        const oldest = this.#inbound.keys().next().value as string | undefined;
        if (oldest) this.#inbound.delete(oldest);
      }
      this.#inbound.set(command.commandId, {
        monitorOwnerNonce: binding.monitorOwnerNonce,
        notification,
        expiresAt: binding.expiresAt,
      });
      this.#notify(binding.monitorOwnerNonce, notification);
      return { status: "accepted", effectiveAction: command.action, deliveryStage: "injected" };
    }, { limit: 32 });
  }

  async #sweep(): Promise<void> {
    const now = this.#now();
    for (const [key, binding] of this.#relays) {
      if (now >= binding.retainUntil) this.#relays.delete(key);
    }
    for (const [messageId, inbound] of this.#inbound) {
      if (now >= inbound.expiresAt) this.#inbound.delete(messageId);
    }
  }
}
