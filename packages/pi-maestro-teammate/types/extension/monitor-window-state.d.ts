import type { MonitorWorkRefV1, MonitorWindowCompletionEvidenceV1, MonitorWindowFacetTargetV1, MonitorWindowFacetV1, MonitorWindowStateV1 } from "../public/v1/monitor-window-state.ts";
import type { SessionEndpoint, WindowThreadEntry } from "../sessions/session-core.ts";
import type { WorkspaceOwnerSnapshot } from "../sessions/workspace-peer-core.ts";
/** Minimal adapter over the root extension's managed-window record. */
export interface MonitorManagedWindowMetadataV1 {
    name: string;
    sessionName: string;
    objective?: string;
    presentation?: "interactive" | "headless";
    management?: "monitor" | "delegation";
    pid?: number;
    startedAt?: number;
    launchError?: string;
}
export interface MonitorManagedWindowEvidenceV1 {
    target: MonitorWindowFacetTargetV1;
    metadata: MonitorManagedWindowMetadataV1;
}
/** A journal entry plus the exact endpoint/work incarnation captured before reading it. */
export interface MonitorWindowThreadEvidenceV1 {
    target: Required<MonitorWindowFacetTargetV1>;
    entry: WindowThreadEntry;
}
export interface MonitorWindowReductionItemV1 {
    endpoint: SessionEndpoint;
    /** Current owner snapshot. A non-exact snapshot is treated as stale evidence. */
    owner?: WorkspaceOwnerSnapshot;
    managed?: MonitorManagedWindowEvidenceV1;
    workRef?: MonitorWorkRefV1;
    delivery?: readonly MonitorWindowThreadEvidenceV1[];
    completion?: readonly MonitorWindowCompletionEvidenceV1[];
    facets?: readonly MonitorWindowFacetV1[];
}
export interface MonitorWindowReductionInputV1 {
    /** Caller-supplied observation time; the reducer never reads the clock. */
    observedAt: number;
    windows: readonly MonitorWindowReductionItemV1[];
}
/**
 * Pure reduction of exact endpoint, owner, journal, completion, and optional
 * facet evidence into the public MonitorWindowStateV1 read model.
 */
export declare function reduceMonitorWindowStateV1(input: MonitorWindowReductionInputV1): MonitorWindowStateV1;
/** Canonical semantic hash shared by the state reducer and query cursors. */
export declare function hashMonitorWindowSemanticV1(value: unknown): string;
