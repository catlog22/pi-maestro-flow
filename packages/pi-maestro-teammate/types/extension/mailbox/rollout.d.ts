/**
 * Shadow-write rollout controller for the durable mailbox.
 *
 * Modes:
 * - "disabled": v1 direct path only; no v2 admission or consumption.
 * - "shadow": v2 enqueue + validate but NEVER consume/inject. Files written for parity audit.
 * - "authoritative": (default) v2 is the delivery authority. Consumer dispatches from mailbox.
 *
 * Rollback: switch to "disabled" → new messages use v1 direct path; v2 files preserved for drain.
 * Disk error: surfaced as error, NEVER silent fallback to direct stdin.
 */
import { MailboxService } from "./service.ts";
import type { MailboxCapability } from "./service.ts";
import type { MailboxEnqueueResult } from "./types.ts";
export type RolloutMode = "disabled" | "shadow" | "authoritative";
export interface RolloutConfig {
    /** Current rollout mode. */
    mode: RolloutMode;
    /** Whether to advertise v2 capability to peers. */
    advertiseV2: boolean;
}
export interface MailboxRolloutOptions {
    service: MailboxService;
    config?: Partial<RolloutConfig>;
    /** Fallback delivery function for v1 direct path. */
    directDeliver: (envelope: {
        messageId?: string;
        senderId: string;
        recipientCorrelationId: string;
        payload: string;
        mode: string;
        capabilities?: readonly string[];
        kind: "lifecycle" | "result" | "steer" | "follow_up" | "interrupt" | "task" | "control";
    }) => Promise<void>;
    now?: () => number;
}
export declare class MailboxRollout {
    #private;
    constructor(options: MailboxRolloutOptions);
    get mode(): RolloutMode;
    get config(): Readonly<RolloutConfig>;
    /** Switch rollout mode. Preserves v2 files on downgrade. */
    setMode(mode: RolloutMode): Promise<void>;
    /** Get the capability to advertise to peers based on current mode. */
    advertisedCapability(): MailboxCapability;
    /**
     * Route a message through the appropriate delivery path.
     *
     * - disabled: direct delivery only
     * - shadow: enqueue to v2 (validate) + direct delivery (actual)
     * - authoritative: enqueue to v2 only (consumer delivers)
     *
     * Disk errors are ALWAYS surfaced, never silently falling back.
     */
    deliver(request: {
        /** Stable caller-selected UUID for retry/receipt reconciliation. */
        messageId?: string;
        senderId: string;
        recipientId: string;
        recipientCorrelationId: string;
        kind: "lifecycle" | "result" | "steer" | "follow_up" | "interrupt" | "task" | "control";
        mode: "steer" | "follow_up" | "interrupt" | "abort" | "notify";
        /** Route capabilities frozen by v2; forwarded on the direct path when supplied. */
        capabilities?: readonly string[];
        payload: string;
        requestId?: string;
        correlationId?: string;
    }): Promise<{
        path: "v1" | "v2" | "shadow";
        result: MailboxEnqueueResult | {
            ok: true;
            messageId?: string;
            state: "ready";
        };
    }>;
    /**
     * Check if v2 files still need draining (live messages only — applied/dead
     * receipts are garbage-collected and do not block cleanup).
     */
    hasV2Files(): Promise<boolean>;
}
