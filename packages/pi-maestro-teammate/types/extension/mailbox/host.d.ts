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
import type { TeammateState } from "../../shared/types.ts";
export declare function mailboxModeFromEnv(env?: NodeJS.ProcessEnv): RolloutMode;
export declare const MAILBOX_ENV_VAR = "PI_TEAMMATE_MAILBOX";
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
export declare function createMailboxAuthority(context: MailboxHostContext): MailboxAuthority;
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
        mode: string;
        kind: "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
    }) => Promise<MailboxDispatchDisposition | void>;
    mode?: RolloutMode;
    pollMs?: number;
    /** GC sweep interval (default 10 minutes). */
    gcIntervalMs?: number;
    now?: () => number;
}
export declare class MailboxHost {
    #private;
    readonly service: MailboxService;
    readonly rollout: MailboxRollout;
    /** Live mode — proxies the rollout controller so runtime setMode stays the single source of truth. */
    get mode(): RolloutMode;
    constructor(options: MailboxHostOptions);
    stop(): Promise<void>;
}
