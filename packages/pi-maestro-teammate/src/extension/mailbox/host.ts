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

import { MailboxService } from "./service.ts";
import { MailboxRollout, type RolloutMode } from "./rollout.ts";
import type { MailboxAuthority } from "./router.ts";
import type { TeammateState } from "../../shared/types.ts";
import { canProxySendTo } from "../teammate-core.ts";
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
 * and lease via the recipient agent's current lease token.
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
    currentLeaseEpoch() {
      return 1;
    },
    currentLeaseNonce() {
      return context.ownerId;
    },
    isFenced(recipientCorrelationId) {
      const agent = context.state.activeRuns.get(recipientCorrelationId);
      if (!agent) return false;
      // Fenced when the child lease is no longer writable by the child (parking/handoff).
      return agent.lease !== undefined && agent.lease.state !== "active";
    },
    isStaleUnauthorized(recipientCorrelationId) {
      const agent = context.state.activeRuns.get(recipientCorrelationId);
      if (!agent) return false;
      return !agent.stdin?.writable && agent.status !== "sleeping";
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
  inject: (envelope: { recipientCorrelationId: string; payload: string; mode: string }) => Promise<void>;
  mode?: RolloutMode;
  pollMs?: number;
  now?: () => number;
}

export class MailboxHost {
  readonly service: MailboxService;
  readonly rollout: MailboxRollout;
  readonly mode: RolloutMode;

  constructor(options: MailboxHostOptions) {
    const mode = options.mode ?? mailboxModeFromEnv();
    this.mode = mode;

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
      onDispatch: async (envelope) => {
        await options.inject({
          recipientCorrelationId: envelope.recipientCorrelationId,
          payload: envelope.payload,
          mode: envelope.mode,
        });
      },
      pollMs: options.pollMs,
      now: options.now,
    });

    this.rollout = new MailboxRollout({
      service: this.service,
      config: { mode, advertiseV2: mode === "shadow" || mode === "authoritative" },
      directDeliver: options.inject,
      now: options.now,
    });

    // Start consumer only in authoritative mode.
    if (mode === "authoritative") {
      void this.service.start().then(() => this.rollout.setMode("authoritative"));
    } else if (mode === "shadow") {
      void this.service.start();
    }
  }

  async stop(): Promise<void> {
    await this.service.stop();
  }
}
