import type { ObservationDetail, ObservationSnapshot, ObservationTarget } from "../public/v1/observation.ts";
import { type WorkspaceMainSessionProgressEvent, type WorkspaceOwnerSnapshot } from "./workspace-peers.ts";
export interface WorkspaceSessionObservationItem {
    cursor: number;
    kind: WorkspaceMainSessionProgressEvent["kind"];
    at: number;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    status?: "running" | "completed" | "failed";
    phase?: "agent_start" | "turn_start" | "turn_end" | "agent_end" | "agent_settled";
    /** Raw agent_settled is a lifecycle fact, not business-work completion. */
    provisional?: boolean;
}
export declare function workspaceSessionObservationSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number, cursor?: string): ObservationSnapshot;
