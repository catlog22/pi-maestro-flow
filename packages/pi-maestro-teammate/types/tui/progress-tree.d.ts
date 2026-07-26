import { type StatusTone } from "../shared/agent-status.ts";
import type { AgentProgressSnapshot } from "../shared/types.ts";
export interface ProgressPalette {
    dim(text: string): string;
    accent(text: string): string;
    running(text: string): string;
    success(text: string): string;
    error(text: string): string;
    bold(text: string): string;
}
export interface ProgressTreeRow {
    taskIndex: number;
    text: string;
}
export declare function progressDurationMs(entry: AgentProgressSnapshot, now?: number): number | undefined;
/** Resolve a semantic tone against the ANSI palette used by progress rows. */
export declare function toneText(palette: ProgressPalette, tone: StatusTone, text: string): string;
export declare function progressIcon(status: AgentProgressSnapshot["status"], palette: ProgressPalette): string;
export declare function progressLabel(entry: AgentProgressSnapshot): string;
export declare function buildProgressTree(progress: AgentProgressSnapshot[], palette: ProgressPalette): ProgressTreeRow[];
export declare function focusTaskIndex(progress: AgentProgressSnapshot[]): number | undefined;
export declare function selectProgressWindow(rows: ProgressTreeRow[], maxRows: number, focusIndex?: number): {
    rows: ProgressTreeRow[];
    start: number;
    total: number;
};
export declare function selectPriorityProgressRows(rows: ProgressTreeRow[], maxRows: number, focusIndex: number | undefined, pinnedIndexes: readonly number[]): {
    rows: ProgressTreeRow[];
    total: number;
    hidden: number;
};
