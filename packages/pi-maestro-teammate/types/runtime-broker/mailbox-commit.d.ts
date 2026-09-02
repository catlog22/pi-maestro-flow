import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from "./client.ts";
import { type RuntimeBrokerCommitResult } from "./contracts.ts";
import type { MailboxEnvelope } from "../extension/mailbox/types.ts";
export interface RuntimeBrokerMailboxCommitterOptions {
    stateDirectory: string;
    holderId: string;
    clientOptions?: Omit<RuntimeBrokerClientOptions, "stateDirectory">;
    clientFactory?: () => Promise<RuntimeBrokerClient>;
}
export declare function runtimeBrokerMailboxStreamId(messageId: string): string;
/** Persists the authoritative mailbox effect before the compatibility consumer publishes it. */
export declare class RuntimeBrokerMailboxCommitter {
    #private;
    constructor(options: RuntimeBrokerMailboxCommitterOptions);
    /** Start the client connection and expose completion for callers that must gate dispatch on readiness. */
    prewarm(): Promise<void>;
    commit(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult>;
    commitIfReady(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult | undefined>;
    close(): Promise<void>;
}
