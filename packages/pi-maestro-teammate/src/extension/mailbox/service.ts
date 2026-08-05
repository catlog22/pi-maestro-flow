/**
 * MailboxService: unified entry point for the durable mailbox system.
 * Ties together file-store, router, consumer, and GC into a single service
 * that root, proxy, and workspace agents share.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { MailboxConsumer } from "./consumer.ts";
import { MailboxFileStore, createMailboxPaths, ensureMailboxDirectories } from "./file-store.ts";
import { MailboxGC, QuotaAdmission } from "./gc.ts";
import { type MailboxAuthority, type MailboxEnqueueRequest, MailboxRouter } from "./router.ts";
import {
  type MailboxEnvelope,
  type MailboxEnqueueResult,
  type MailboxMessageKind,
  type MailboxDeliveryMode,
  type MailboxPaths,
  SAFE_ID_PATTERN,
} from "./types.ts";

// --- Capability ---

export type MailboxCapability = "v1" | "v2";

export const MAILBOX_CAPABILITY_HEADER = "x-mailbox-capability";

/** Negotiate mailbox capability between two peers. */
export function negotiateCapability(local: MailboxCapability, remote: MailboxCapability | undefined): MailboxCapability {
  // Both must support v2 for v2 to be used; otherwise fall back to v1.
  if (local === "v2" && remote === "v2") return "v2";
  return "v1";
}

// --- Service Options ---

export interface MailboxServiceOptions {
  /** Root directory for mailbox storage. */
  rootDir: string;
  /** Authority provider for route/lease validation. */
  authority: MailboxAuthority;
  /** Recipient correlation ID this service instance serves. */
  recipientCorrelationId: string;
  /** Workspace ID. */
  workspaceId: string;
  /** Team ID. */
  teamId: string;
  /** Owner ID of this service instance. */
  ownerId: string;
  /** Callback invoked when a message is ready for injection into the child. */
  onDispatch: (envelope: MailboxEnvelope) => Promise<void>;
  /** Poll interval for the consumer. */
  pollMs?: number;
  now?: () => number;
}

// --- Service ---

export class MailboxService extends EventEmitter {
  readonly paths: MailboxPaths;
  readonly store: MailboxFileStore;
  readonly router: MailboxRouter;
  readonly consumer: MailboxConsumer;
  readonly gc: MailboxGC;
  readonly quota: QuotaAdmission;
  readonly capability: MailboxCapability = "v2";

  readonly #workspaceId: string;
  readonly #teamId: string;
  readonly #ownerId: string;
  readonly #recipientCorrelationId: string;

  #started = false;
  #stopped = true;
  #startPromise: Promise<void> | undefined;

  constructor(options: MailboxServiceOptions) {
    super();
    // Path-safety: the workspaceId is joined into the on-disk tree, so reject
    // anything that could traverse or escape the mailbox root ("../", separators).
    if (!SAFE_ID_PATTERN.test(options.workspaceId)) {
      throw new Error(`invalid workspaceId "${options.workspaceId}": must match ${SAFE_ID_PATTERN}`);
    }
    // Per-workspace isolation: every workspace gets its own directory tree
    // under rootDir/workspaces/<workspaceId>. Messages from different
    // workspaces never share state directories or claim locks.
    this.paths = createMailboxPaths(join(options.rootDir, "workspaces", options.workspaceId));
    this.store = new MailboxFileStore({ paths: this.paths, now: options.now });
    this.quota = new QuotaAdmission({ store: this.store });
    this.router = new MailboxRouter({
      store: this.store,
      authority: options.authority,
      quota: this.quota,
      workspaceId: options.workspaceId,
      now: options.now,
    });
    this.consumer = new MailboxConsumer({
      store: this.store,
      router: this.router,
      recipientCorrelationId: options.recipientCorrelationId,
      workspaceId: options.workspaceId,
      onDispatch: options.onDispatch,
      pollMs: options.pollMs,
      now: options.now,
    });
    this.gc = new MailboxGC({ store: this.store, now: options.now });

    this.#workspaceId = options.workspaceId;
    this.#teamId = options.teamId;
    this.#ownerId = options.ownerId;
    this.#recipientCorrelationId = options.recipientCorrelationId;

    // Forward consumer events (use "dispatch-error" to avoid Node's special "error" semantics)
    this.consumer.on("dispatch", (event) => this.emit("dispatch", event));
    this.consumer.on("ack", (event) => this.emit("ack", event));
    this.consumer.on("error", (event) => this.emit("dispatch-error", event));
  }

  /**
   * Initialize directories and start the consumer.
   * startConsumer=false (shadow mode) initializes directories only — the
   * shadow contract is "enqueue + validate but NEVER consume/inject".
   */
  async start(startConsumer = true): Promise<void> {
    await this.#runStart(async () => {
      if (!startConsumer) return;
      // Crash recovery: replay accepted-without-ack back to ready before polling.
      await this.consumer.replayAcceptedToReady();
      this.consumer.start();
      this.#started = true;
    });
  }

  /** Start just the consumer (rollout upgrade to authoritative). */
  async startConsumer(): Promise<void> {
    await this.#runStart(async () => {
      await this.consumer.replayAcceptedToReady();
      this.consumer.start();
      this.#started = true;
    });
  }

  /** Stop the consumer. */
  async stop(): Promise<void> {
    await this.#stopInternal();
  }

  /** Stop just the consumer (rollout downgrade away from authoritative). */
  async stopConsumer(): Promise<void> {
    await this.#stopInternal();
  }

  /**
   * Generation-free start barrier: a stop() that lands while start() is still
   * initializing flips #stopped so the in-flight continuation bails, and every
   * stop waits for the in-flight start promise before deciding what to stop.
   * A late start continuation can therefore never republish a running consumer
   * after stop returned (ISS-20260803-003).
   */
  async #runStart(body: () => Promise<void>): Promise<void> {
    if (this.#started) return;
    if (this.#startPromise) {
      await this.#startPromise;
      return;
    }
    this.#stopped = false;
    const promise = (async () => {
      await ensureMailboxDirectories(this.paths);
      if (this.#stopped) return;
      await body();
    })();
    this.#startPromise = promise;
    try {
      await promise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async #stopInternal(): Promise<void> {
    this.#stopped = true;
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    if (!this.#started) return;
    await this.consumer.stop();
    this.#started = false;
  }

  /**
   * Enqueue a message for delivery.
   * This is the primary entry point replacing direct stdin delivery.
   */
  async enqueue(request: {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    kind: MailboxMessageKind;
    mode: MailboxDeliveryMode;
    payload: string;
    requestId?: string;
    correlationId?: string;
  }): Promise<MailboxEnqueueResult> {
    return this.router.enqueue({
      workspaceId: this.#workspaceId,
      teamId: this.#teamId,
      ...request,
    });
  }

  /**
   * Acknowledge IPC confirmation that a message was injected.
   * Transitions ACCEPTED → APPLIED.
   */
  async acknowledge(messageId: string): Promise<boolean> {
    return this.consumer.acknowledge(messageId);
  }

  /** Run garbage collection. */
  async runGC(): Promise<{ removed: number; errors: string[] }> {
    return this.gc.run();
  }

  /** Check if there is pending mail for the recipient (blocks eviction). */
  async hasPendingMail(): Promise<boolean> {
    const ready = await this.store.listMessages("ready");
    const claimed = await this.store.listMessages("claimed");
    const accepted = await this.store.listMessages("accepted");
    // Filter to this recipient
    for (const ids of [ready, claimed, accepted]) {
      for (const id of ids) {
        const state = ids === ready ? "ready" : ids === claimed ? "claimed" : "accepted";
        const envelope = await this.store.readEnvelope(state, id);
        if (envelope?.recipientCorrelationId === this.#recipientCorrelationId) return true;
      }
    }
    return false;
  }

  /** Get pending mail count for observability. */
  async pendingCount(): Promise<number> {
    const ready = await this.store.listMessages("ready");
    const claimed = await this.store.listMessages("claimed");
    const accepted = await this.store.listMessages("accepted");
    let count = 0;
    for (const ids of [ready, claimed, accepted]) {
      for (const id of ids) {
        const state = ids === ready ? "ready" : ids === claimed ? "claimed" : "accepted";
        const envelope = await this.store.readEnvelope(state, id);
        if (envelope?.recipientCorrelationId === this.#recipientCorrelationId) count++;
      }
    }
    return count;
  }
}
