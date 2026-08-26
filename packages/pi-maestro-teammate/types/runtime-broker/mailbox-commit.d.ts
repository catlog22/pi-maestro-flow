import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from "./client.ts";
import type { RuntimeBrokerCommitResult } from "./contracts.ts";
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
    commit(envelope: MailboxEnvelope): Promise<RuntimeBrokerCommitResult>;
    close(): Promise<void>;
}
