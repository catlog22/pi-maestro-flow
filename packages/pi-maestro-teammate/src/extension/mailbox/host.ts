/**
 * Host wiring for the durable mailbox — default-on integration into the extension host.
 *
 * Controlled by environment variable:
 *   PI_TEAMMATE_MAILBOX=authoritative (default) — mailbox is the delivery authority
 *   PI_TEAMMATE_MAILBOX=shadow      — enqueue+validate to v2, still deliver direct
 *   PI_TEAMMATE_MAILBOX=disabled    — v1 direct stdin path, mailbox inert
 *
 * When authoritative (default), follow_up messages route through the durable
 * mailbox; steer/abort keep the legacy direct path. Disk errors are surfaced,
 * never silently falling back to direct stdin.
 */

import type { MailboxDispatchDisposition } from "./consumer.ts";
import { MailboxService } from "./service.ts";
import { MailboxRollout, type RolloutMode } from "./rollout.ts";
import type { MailboxAuthority } from "./router.ts";
import type { MessageProvenanceV1, TeammateState } from "../../shared/types.ts";
import { canProxySendTo, LIVE_AGENT_STATUSES } from "../teammate-core.ts";
import type { RpcMessageMode } from "../../runs/execution.ts";

// --- Env Parsing ---

export function mailboxModeFromEnv(env: NodeJS.ProcessEnv = process.env): RolloutMode {
  const raw = (env.PI_TEAMMATE_MAILBOX ?? "authoritative").toLowerCase();
  if (raw === "shadow" || raw === "authoritative" || raw === "disabled") return raw;
  console.warn(`[pi-maestro-teammate] unknown PI_TEAMMATE_MAILBOX="${raw}", falling back to authoritative`);
  return "authoritative";
}

export const MAILBOX_ENV_VAR = "PI_TEAMMATE_MAILBOX";

// --- Authority Adapter ---

export interface MailboxHostContext {
  state: TeammateState;
  /** Root dispatch correlation id used as implicit team id. */
  rootCorrelationId?: string;
  /** Owner id for this host instance. */
  ownerId: string;
}

/**
 * Builds a MailboxAuthority from the live TeammateState.
 * Revalidates route via canProxySendTo, generation via state.sessionGeneration,
 * and lease via the recipient agent's current SessionLease epoch/nonce.
 */
export function createMailboxAuthority(context: MailboxHostContext): MailboxAuthority {
  return {
    canRoute(senderId, recipientCorrelationId, mode) {
      // senderId "caller" means the root tool itself (user-driven).
      const requesterCid = senderId === "caller" ? undefined : senderId;
      const rpcMode: RpcMessageMode = mode === "steer" ? "steer" : mode === "abort" ? "abort" : "follow_up";
      return canProxySendTo(context.state, requesterCid, recipientCorrelationId, rpcMode);
    },
    currentGeneration() {
      return context.state.sessionGeneration ?? 0;
    },
    currentLeaseEpoch(recipientCorrelationId) {
      // Bind to the recipient's real SessionLease: when a lease advances
      // (handoff advances epoch + nonce), envelopes stamped with the old
      // lease fail revalidation and are dead-lettered. Agents without a lease
      // fall back to epoch 1 (no binding) so the queue stays usable.
      const agent = recipientCorrelationId ? context.state.activeRuns.get(recipientCorrelationId) : undefined;
      return agent?.lease?.epoch ?? 1;
    },
    currentLeaseNonce(recipientCorrelationId) {
      const agent = recipientCorrelationId ? context.state.activeRuns.get(recipientCorrelationId) : undefined;
      return agent?.lease?.nonce ?? context.ownerId;
    },
    isFenced(recipientCorrelationId) {
      const agent = context.state.activeRuns.get(recipientCorrelationId);
      if (!agent) return false;
      // Fenced when the child lease is no longer writable by the child (parking/handoff).
      if (agent.lease !== undefined && agent.lease.state !== "active") return true;
      // Spawn/restart wiring window: a live (non-sleeping) agent whose stdin
      // is not writable yet. Hold the message until the pipe is wired instead
      // of dead-lettering a transient state. Sleeping agents are excluded —
      // their injection path performs the wake/cold-restart itself.
      return LIVE_AGENT_STATUSES.has(agent.status)
        && agent.status !== "sleeping"
        && !agent.stdin?.writable;
    },
    isStaleUnauthorized(recipientCorrelationId) {
      const agent = context.state.activeRuns.get(recipientCorrelationId);
      if (!agent) return false;
      // Only a settled agent is permanently unreachable. A transient
      // unwritable stdin on a live agent is reported as fenced (hold) above,
      // so in-flight messages survive restarts instead of dead-lettering.
      return !LIVE_AGENT_STATUSES.has(agent.status);
    },
    managesRecipient(recipientCorrelationId) {
      return context.state.activeRuns.has(recipientCorrelationId);
    },
  };
}

// --- Host Mailbox ---

export interface MailboxHostOptions {
  /** Root directory for mailbox storage. */
  rootDir: string;
  state: TeammateState;
  rootCorrelationId?: string;
  ownerId: string;
  workspaceId: string;
  teamId: string;
  /** Convert a mailbox envelope back into an actual stdin injection. */
  inject: (envelope: {
    messageId?: string;
    senderId: string;
    recipientCorrelationId: string;
    payload: string;
    provenance?: MessageProvenanceV1;
    mode: string;
    kind: "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
  }) => Promise<MailboxDispatchDisposition | void>;
  mode?: RolloutMode;
  pollMs?: number;
  /** GC sweep interval (default 10 minutes). */
  gcIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_GC_INTERVAL_MS = 10 * 60_000;

export class MailboxHost {
  readonly service: MailboxService;
  readonly rollout: MailboxRollout;
  /** Live mode — proxies the rollout controller so runtime setMode stays the single source of truth. */
  get mode(): RolloutMode {
    return this.rollout.mode;
  }
  readonly #startPromise: Promise<void>;
  #gcTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MailboxHostOptions) {
    const mode = options.mode ?? mailboxModeFromEnv();

    const authority = createMailboxAuthority({
      state: options.state,
      rootCorrelationId: options.rootCorrelationId,
      ownerId: options.ownerId,
    });

    this.service = new MailboxService({
      rootDir: options.rootDir,
      authority,
      // Root host serves every agent — the consumer matches all recipients.
      recipientCorrelationId: "*",
      workspaceId: options.workspaceId,
      teamId: options.teamId,
      ownerId: options.ownerId,
      onDispatch: async (envelope) => options.inject({
        messageId: envelope.messageId,
        senderId: envelope.senderId,
        recipientCorrelationId: envelope.recipientCorrelationId,
        payload: envelope.payload,
        ...(envelope.provenance === undefined ? {} : { provenance: envelope.provenance }),
        mode: envelope.mode,
        kind: envelope.kind,
      }),
      pollMs: options.pollMs,
      now: options.now,
    });

    this.rollout = new MailboxRollout({
      service: this.service,
      config: { mode, advertiseV2: mode === "shadow" || mode === "authoritative" },
      directDeliver: async (envelope) => {
        await options.inject(envelope);
      },
      now: options.now,
    });

    // Authoritative: init dirs + start consumer. Shadow: init dirs only — the
    // shadow contract is "enqueue + validate but NEVER consume/inject". The
    // start promise is retained so stop() can barrier on it; a late start
    // continuation can never republish a consumer after stop (ISS-20260803-003).
    this.#startPromise = this.service.start(mode === "authoritative");
    void this.#startPromise.catch((error) => {
      // Surface — never silently fall back to direct stdin.
      console.error(`[pi-maestro-teammate] mailbox startup failed:`, error);
    });

    // Periodic GC keeps applied/dead/expired receipts from accumulating.
    this.#gcTimer = setInterval(() => {
      void this.service.runGC().catch((error) => {
        console.error(`[pi-maestro-teammate] mailbox GC failed:`, error);
      });
    }, options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS);
    this.#gcTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#gcTimer) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = undefined;
    }
    // Barrier on the in-flight start before stopping the consumer.
    await this.#startPromise.catch(() => undefined);
    await this.service.stop();
  }
}
