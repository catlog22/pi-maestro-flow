import { type WorkspaceMainSessionProgress, type WorkspaceOwnerSnapshot } from "./workspace-peers.ts";
import type { ObservationDetail, ObservationReadOptions, ObservationSnapshot, ObservationTarget } from "../public/v1/observation.ts";
export interface WorkspacePeerTurn {
    /** 1-based turn index across the published event ring (0 = preamble). */
    index: number;
    startedAt: number;
    /** First assistant text line in the turn, or a lifecycle label. */
    preview: string;
    assistantChars: number;
    toolCallCount: number;
    toolResultCount: number;
    /** Rendered detail lines for this turn (assistant, tool, lifecycle rows). */
    rows: string[];
}
/**
 * Group the peer's published main-session progress events into turns. Every
 * `turn_start` lifecycle event opens a new turn; events before the first
 * `turn_start` (and after `agent_start`) form a preamble turn (index 0) so no
 * published content is hidden. Mirrors the local teammate view=turns
 * semantics but operates on the bounded cross-process ring.
 */
export declare function groupWorkspacePeerTurns(progress: WorkspaceMainSessionProgress | undefined): WorkspacePeerTurn[];
/**
 * Workspace peer `view="turns"` snapshot. Groups `owner.mainProgress.events`
 * into turns (by `turn_start` boundaries) and exposes assistant text, tool
 * calls, and tool results with `turn=<n>` expansion. Falls back to the
 * run-list view when the peer published no session progress.
 */
export declare function workspaceTurnsSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number, options: ObservationReadOptions): ObservationSnapshot;
