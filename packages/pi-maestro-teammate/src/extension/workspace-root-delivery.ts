import { randomUUID } from "node:crypto";
import { type WindowThreadEntry, type WindowThreadStore } from "../sessions/session-core.ts";
import {
  WORKSPACE_MAIN_SESSION_MARKER,
  finalizeWorkspacePeerResponse,
  readWorkspacePeerResponse,
  readWorkspacePeerResponseForOwner,
  type WorkspacePeerIdentity,
  type WorkspacePeerCommand,
  type WorkspacePeerCommandResponse,
} from "../sessions/workspace-peer-core.ts";

export interface WorkspaceRootDeliveryAuthority {
  /** Exact root session + workspace publisher generation, not elapsed time. */
  key: string;
  sessionId: string | null;
  identity: WorkspacePeerIdentity;
}

export function workspaceRootMessageMode(entry: WindowThreadEntry): "steer" | "follow_up" {
  return (entry.effectiveMode ?? entry.mode) === "steer" ? "steer" : "follow_up";
}

/** One host queue admission, actual custom-message consumption, and durable receipts. */
export class WorkspaceRootDelivery {
  #accepted = new Map<string, { authority: WorkspaceRootDeliveryAuthority; token: string; consumed: boolean; localOwnerNonce?: string; mode?: "steer" | "follow_up" }>();
  #reconciling?: Promise<void>;
  #hostSession?: string;
  #finalized = new Map<string, "injected" | "replied">();
  constructor(private readonly dependencies: {
    thread: () => WindowThreadStore | undefined;
    authority: () => WorkspaceRootDeliveryAuthority | undefined;
    onError: (error: unknown) => void;
    sessionEntries?: () => readonly unknown[];
    readResponse?: typeof readWorkspacePeerResponse;
    readFinalizedResponse?: typeof readWorkspacePeerResponseForOwner;
    finalize?: typeof finalizeWorkspacePeerResponse;
  }) {}

  /** A real workspace/session replacement loses the host queue; a generation/reload alone does not. */
  bindSession(workspaceId: string, sessionId: string | null): void {
    const session = `${workspaceId}:${sessionId ?? ""}`;
    if (this.#hostSession !== undefined && this.#hostSession !== session) {
      this.#accepted.clear();
      this.#finalized.clear();
    }
    this.#hostSession = session;
  }

  #current(authority: WorkspaceRootDeliveryAuthority): boolean {
    return this.dependencies.authority()?.key === authority.key;
  }
  #eligible(entry: WindowThreadEntry, authority: WorkspaceRootDeliveryAuthority): boolean {
    return entry.workspaceId === authority.identity.workspaceId
      && (entry.targetSessionId === undefined || entry.targetSessionId === authority.sessionId);
  }
  #key(entry: WindowThreadEntry): string {
    return `${entry.workspaceId}:${entry.targetSessionId ?? ""}:${entry.messageId}`;
  }

  wasAccepted(entry: WindowThreadEntry): boolean { return this.#accepted.has(this.#key(entry)); }

  /** Caller decides whether this is a new command or an actual recovery. No age-based redrive. */
  enqueue(entry: WindowThreadEntry, send: (token: string, mode: "steer" | "follow_up") => boolean): boolean {
    const authority = this.dependencies.authority();
    if (!authority || !this.#eligible(entry, authority)) return false;
    const key = this.#key(entry);
    // Session/reload hooks do not prove that the host lost its accepted queue.
    if (this.#accepted.has(key)) return true;
    const acceptance = { authority, token: randomUUID(), consumed: false, localOwnerNonce: entry.localOwnerNonce };
    this.#accepted.set(key, acceptance); // before send: idle custom messages can consume synchronously
    let delivered = false;
    try { delivered = send(acceptance.token, workspaceRootMessageMode(entry)); }
    finally { if (!delivered && !acceptance.consumed) this.#accepted.delete(key); }
    if (delivered && this.#current(authority)) {
      try { this.dependencies.thread()?.transition(entry.messageId, "incoming", "queued", Date.now(), entry.effectiveMode); }
      catch (error) { this.dependencies.onError(error); }
    }
    return delivered;
  }

  /** Missing response after a crash: authorize only exact, already accepted root work. */
  recoveryReceipt(command: WorkspacePeerCommand): { effectiveAction: "steer" | "follow_up"; deliveryStage: "queued" | "injected" | "replied" } | undefined {
    const authority = this.dependencies.authority();
    const entry = this.dependencies.thread()?.get(command.commandId, "incoming");
    if (!authority || !entry || !this.#eligible(entry, authority)
      || entry.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
      || entry.workspaceId !== command.workspaceId || entry.peerOwnerId !== command.fromOwnerId
      || entry.peerOwnerNonce !== command.fromOwnerNonce
      || (entry.localOwnerNonce !== undefined && entry.localOwnerNonce !== command.toOwnerNonce)
      || (entry.receiptStatus !== undefined && entry.receiptStatus !== "accepted")
      || command.toOwnerId !== authority.identity.ownerId || entry.mode !== command.action
      || entry.body !== command.message || entry.createdAt !== command.createdAt
      || (entry.status !== "queued" && entry.status !== "injected" && entry.status !== "replied"
        && !(entry.status === "pending" && this.wasAccepted(entry)))) return undefined;
    // This is the exact original processing command, not a new owner incarnation.
    this.dependencies.thread()?.migrateLocalOwnerNonce(entry.messageId, "incoming", command.toOwnerNonce);
    return { deliveryStage: entry.status === "pending" ? "queued" : entry.status, effectiveAction: workspaceRootMessageMode(entry) };
  }

  consume(message: { role: string; customType?: string; details?: unknown }): void {
    if (message.role !== "custom" || message.customType !== "teammate-message"
      || !message.details || typeof message.details !== "object") return;
    const details = message.details as Record<string, unknown>;
    if (details.source !== "workspace-peer" || typeof details.messageId !== "string") return;
    const thread = this.dependencies.thread();
    const entry = thread?.get(details.messageId, "incoming");
    if (!entry) return;
    const acceptance = this.#accepted.get(this.#key(entry));
    if (!acceptance || !this.#current(acceptance.authority)
      || details.deliveryToken !== acceptance.token
      || details.fromOwnerId !== entry.peerOwnerId || details.fromOwnerNonce !== entry.peerOwnerNonce
      || details.localOwnerNonce !== acceptance.localOwnerNonce
      || (acceptance.localOwnerNonce !== undefined && acceptance.localOwnerNonce !== entry.localOwnerNonce)
      || !this.#eligible(entry, acceptance.authority)) return;
    acceptance.consumed = true;
    acceptance.mode = details.mode === "steer" || details.mode === "follow_up" ? details.mode : undefined;
    // Actual consumption is distinct from queue acceptance. A failed journal write
    // is retried by reconcile; the host's persisted custom message also recovers it.
    try { thread?.reconcileInjected(entry.messageId, Date.now(), acceptance.mode); }
    catch (error) { this.dependencies.onError(error); }
    void this.reconcile();
  }

  #consumedReceipt(entry: WindowThreadEntry, authority: WorkspaceRootDeliveryAuthority): WorkspacePeerCommandResponse {
    return { version: 1, kind: "response", workspaceId: entry.workspaceId, commandId: entry.messageId,
      fromOwnerId: authority.identity.ownerId, fromOwnerNonce: entry.localOwnerNonce!,
      toOwnerId: entry.peerOwnerId, toOwnerNonce: entry.peerOwnerNonce, targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER,
      status: "accepted", deliveryStage: entry.status as "injected" | "replied", effectiveAction: workspaceRootMessageMode(entry),
      ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
      respondedAt: entry.updatedAt, expiresAt: entry.updatedAt + 24 * 60 * 60_000 };
  }

  reconcile(): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    const work = this.#reconcile().catch(this.dependencies.onError).finally(() => {
      if (this.#reconciling === work) this.#reconciling = undefined;
    });
    this.#reconciling = work;
    return work;
  }
  async #reconcile(): Promise<void> {
    const authority = this.dependencies.authority();
    const thread = this.dependencies.thread();
    if (!authority || !thread) return;
    if (thread.list().some((entry) => entry.direction === "incoming"
      && (entry.status === "pending" || entry.status === "queued") && this.#eligible(entry, authority))) {
      thread.reconcilePersistedMessages(this.dependencies.sessionEntries?.() ?? [],
      (entry) => {
        const acceptance = this.#accepted.get(this.#key(entry));
        return this.#current(authority) && this.#eligible(entry, authority)
          && (!acceptance || this.#current(acceptance.authority))
          && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER;
      });
    }
    for (const entry of thread.list()) {
      if (!this.#current(authority)) return;
      if (!this.#eligible(entry, authority)) continue;
      try {
        if (entry.direction === "incoming" && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER) {
          // Receipt evidence migrates legacy bindings and records accepted provenance
          // before retention loss. Never substitute this publisher's current nonce.
          if (entry.localOwnerNonce === undefined || entry.receiptStatus === undefined) {
            const response = await (this.dependencies.readFinalizedResponse ?? readWorkspacePeerResponseForOwner)(
              authority.identity, entry.peerOwnerId, entry.messageId);
            if (!this.#current(authority)) return;
            if (response) thread.reconcileReceiptBinding(entry.messageId, "incoming", response, authority.identity.ownerId);
          }
          const acceptance = this.#accepted.get(this.#key(entry));
          if (acceptance && this.#current(acceptance.authority)) {
            if (acceptance.consumed) thread.reconcileInjected(entry.messageId, Date.now(), acceptance.mode);
            else if (entry.status === "pending") thread.transition(entry.messageId, "incoming", "queued", Date.now(), entry.effectiveMode);
          }
          const durable = thread.get(entry.messageId, "incoming");
          if (!durable || durable.localOwnerNonce === undefined
            || (durable.receiptStatus !== undefined && durable.receiptStatus !== "accepted")
            || (durable.status !== "injected" && durable.status !== "replied")) continue;
          const stage = durable.status;
          const receiptKey = `${authority.key}:${this.#key(durable)}:${durable.localOwnerNonce ?? ""}`;
          const finalized = this.#finalized.get(receiptKey);
          if (finalized === "replied" || finalized === stage) continue;
          // Missing initial response and IO failure remain retryable, while a
          // verified durable receipt needs no endless rewrite/read loop.
          const advanced = await (this.dependencies.finalize ?? finalizeWorkspacePeerResponse)(
            authority.identity, durable.peerOwnerId, durable.messageId,
            stage, {
              receiptOwnerNonce: durable.localOwnerNonce,
              senderOwnerNonce: durable.peerOwnerNonce,
              // Missing receipts are recoverable only with durable accepted evidence
              // AND actual consumption; queued markers alone cannot resurrect one.
              recoveryReceipt: durable.receiptStatus === "accepted" ? this.#consumedReceipt(durable, authority) : undefined,
              beforeCommit: () => { if (!this.#current(authority)) throw new Error("Workspace delivery authority changed."); },
            },
          );
          if (!this.#current(authority)) return;
          if (advanced) this.#finalized.set(receiptKey, stage);
          else {
            const response = await (this.dependencies.readFinalizedResponse ?? readWorkspacePeerResponseForOwner)(
              authority.identity, durable.peerOwnerId, durable.messageId);
            if (!this.#current(authority)) return;
            if (response) thread.reconcileReceiptBinding(durable.messageId, "incoming", response, authority.identity.ownerId);
            if (response?.status === "accepted" && response.workspaceId === durable.workspaceId
              && response.fromOwnerId === authority.identity.ownerId
              && response.fromOwnerNonce === durable.localOwnerNonce
              && response.toOwnerNonce === durable.peerOwnerNonce
              && response.targetCorrelationId === durable.targetCorrelationId
              && (response.deliveryStage === "replied" || response.deliveryStage === stage)) {
              this.#finalized.set(receiptKey, response.deliveryStage);
            }
          }
        } else if (entry.direction === "outgoing" && ["pending", "queued", "timeout"].includes(entry.status)) {
          const response = await (this.dependencies.readResponse ?? readWorkspacePeerResponse)(authority.identity, entry.messageId);
          if (!this.#current(authority) || !response) continue;
          // Persist the original sender incarnation before applying receipt fences.
          thread.reconcileReceiptBinding(entry.messageId, "outgoing", response, authority.identity.ownerId);
          const bound = thread.get(entry.messageId, "outgoing")!;
          // Read real receipt evidence before considering any observational deadline.
          if (response.commandId !== entry.messageId || response.workspaceId !== entry.workspaceId || response.fromOwnerId !== entry.peerOwnerId
            || response.fromOwnerNonce !== entry.peerOwnerNonce || response.toOwnerId !== authority.identity.ownerId
            || response.toOwnerNonce !== bound.localOwnerNonce
            || response.targetCorrelationId !== entry.targetCorrelationId) continue;
          if (response.status === "accepted") thread.reconcileAcceptedReceipt(entry.messageId, response, authority.identity);
          else if (entry.status === "pending" || entry.status === "queued") {
            const { version: _version, revision: _revision, contentRevision: _contentRevision, ...input } = bound;
            thread.record({ ...input, receiptStatus: response.status,
              status: response.status === "expired" ? "timeout" : "rejected", updatedAt: response.respondedAt });
          }
        }
      } catch (error) { this.dependencies.onError(error); }
    }
  }
}
