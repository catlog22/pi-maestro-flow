import type { AgentStatus } from "../shared/types.ts";
import { RuntimeBrokerClient } from "../runtime-broker/client.ts";
import { type RuntimeAgentReadEntityV2, type RuntimeReadModelSnapshotV2 } from "./read-model.ts";
export interface RuntimeReadModelBrokerBridgeOptions {
    cwd: string;
    sourceId: string;
    mode?: "sqlite";
    client?: RuntimeBrokerClient;
}
/**
 * V1 lifecycle events are admitted through this bridge, but only the broker
 * journal is authoritative for V2 reads. Cockpit and Observe never own its
 * lease or reconciliation lifecycle.
 */
export declare class RuntimeReadModelBrokerBridge {
    #private;
    readonly workspaceId: string;
    readonly sourceStreamId: string;
    private constructor();
    static connect(options: RuntimeReadModelBrokerBridgeOptions): Promise<RuntimeReadModelBrokerBridge>;
    get generation(): number;
    publish(agents: readonly RuntimeAgentReadEntityV2[], options?: {
        reset?: boolean;
    }): Promise<RuntimeReadModelSnapshotV2>;
    snapshot(): Promise<RuntimeReadModelSnapshotV2>;
    close(): Promise<void>;
}
export declare function runtimeAgentStatusFromBrokerOutcome(outcome: "completed" | "failed" | "cancelled" | "lost"): AgentStatus;
