import type { ObservationDetail, ObservationSnapshot, ObservationTarget } from "../public/v1/observation.ts";
import { type WorkspaceMainSessionProgressEvent, type WorkspaceOwnerSnapshot, type WorkspaceTodoSnapshot } from "./workspace-peers.ts";
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
export interface WorkspaceTodoObservationItem {
    id: string;
    subject: string;
    status: WorkspaceTodoSnapshot["status"];
    assigneeLabel?: string;
    dispatchId?: string;
    scheduleId?: string;
    stepId?: string;
    bindingActive?: boolean;
    updatedAt: number;
}
/**
 * Render the worker root-session Todo projection (owner.todos) for observe view="todos".
 * Each todo is projected as a structured item (already-validated by validateWorkspaceOwnerSnapshot)
 * and re-sanitized at this render boundary as defense-in-depth against CR/LF/ESC terminal injection (P1-7).
 */
export declare function workspaceTodosObservationSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number): ObservationSnapshot;
