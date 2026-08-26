import { type ActorAddressV2, type RuntimeEventDraftV2 } from "./contracts.ts";
import type { RemoteRunEvent } from "../remote/types.ts";
export interface RuntimeAdapterContextV2 {
    streamId: string;
    actor: ActorAddressV2;
    occurredAt?: number;
}
export type PiRuntimeSignalV2 = {
    type: "tool_execution_start";
    toolCallId: string;
    toolName: string;
} | {
    type: "tool_execution_end" | "tool_end";
    toolCallId: string;
    toolName: string;
    isError?: boolean;
} | {
    type: "result_published";
    publicationId: string;
    hasStructuredOutput?: boolean;
} | {
    type: "agent_settled";
    outcome: "completed" | "failed" | "cancelled" | "lost";
    error?: string;
} | {
    type: "process_reclaimed";
    processId: string;
    exitCode: number | null;
    signal: string | null;
} | {
    type: "turn_end" | "close";
};
export type AcpRuntimeSignalV2 = {
    type: "tool_start";
    toolCallId: string;
    toolName: string;
} | {
    type: "tool_end";
    toolCallId: string;
    toolName: string;
    isError?: boolean;
} | {
    type: "result_published";
    publicationId: string;
    hasStructuredOutput?: boolean;
} | {
    type: "run_settled";
    outcome: "completed" | "failed" | "cancelled" | "lost";
    error?: string;
} | {
    type: "process_reclaimed";
    processId: string;
    exitCode: number | null;
    signal: string | null;
} | {
    type: "turn_end" | "close";
};
export declare function adaptPiRuntimeSignalV2(signal: PiRuntimeSignalV2, context: RuntimeAdapterContextV2): RuntimeEventDraftV2[];
export declare function adaptAcpRuntimeSignalV2(signal: AcpRuntimeSignalV2, context: RuntimeAdapterContextV2): RuntimeEventDraftV2[];
/** Adapts only explicit durable remote events; transport close is never a success signal. */
export declare function adaptRemoteRunEventV2(event: RemoteRunEvent, protocol: "pi-rpc" | "acp", context: Omit<RuntimeAdapterContextV2, "occurredAt">): RuntimeEventDraftV2[];
