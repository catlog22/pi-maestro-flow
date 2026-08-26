import type { AgentStatus } from "../shared/types.ts";
import { RuntimeBrokerClient } from "../runtime-broker/client.ts";
import { type RuntimeAgentReadEntityV2, type RuntimeReadModelOwnershipV2, type RuntimeReadModelSnapshotV2 } from "./read-model.ts";
export interface RuntimeReadModelBrokerBridgeOptions {
    cwd: string;
    sourceId: string;
    /** Pi session projected by this source; defaults to sourceId for compatibility. */
    sessionId?: string;
    /** Monotonic session/source incarnation; defaults to 1 for compatibility. */
    sessionGeneration?: number;
    mode?: "sqlite";
    client?: RuntimeBrokerClient;
    readScope?: "workspace" | "source";
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
    readonly projection: RuntimeReadModelOwnershipV2;
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
