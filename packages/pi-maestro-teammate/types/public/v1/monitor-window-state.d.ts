/**
 * Versioned, root-side Monitor window read-model and facet contribution contract.
 *
 * The state is intentionally read-only. Registering a facet provider grants no
 * cross-window write authority and does not register an LLM tool.
 */
export declare const MONITOR_WINDOW_STATE_VERSION: 1;
export declare const MAX_MONITOR_WINDOW_FACETS = 256;
/** Exact root endpoint incarnation. Every item of work evidence is fenced by all four fields. */
export interface MonitorWindowIdentityV1 {
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    endpointId: string;
}
/** Provider-defined work identity. Both fields participate in exact equality. */
export interface MonitorWorkRefV1 {
    kind: string;
    id: string;
}
export interface MonitorWindowFacetTargetV1 {
    identity: MonitorWindowIdentityV1;
    /** Omit only for a facet about the window rather than its current work. */
    workRef?: MonitorWorkRefV1;
}
export type MonitorWindowAttentionSeverityV1 = "info" | "warning" | "error";
export interface MonitorWindowFacetAttentionV1 {
    code: string;
    severity: MonitorWindowAttentionSeverityV1;
    message: string;
    /** Stable provider key. Equal keys for one exact target are displayed once. */
    dedupeKey?: string;
}
export type MonitorWindowJsonValueV1 = null | boolean | number | string | readonly MonitorWindowJsonValueV1[] | {
    readonly [key: string]: MonitorWindowJsonValueV1;
};
/** One bounded, display-only contribution from a root-side package such as Flow. */
export interface MonitorWindowFacetV1 {
    /** Must equal the emitting provider's kind. */
    kind: string;
    target: MonitorWindowFacetTargetV1;
    /** Opaque provider content revision. */
    revision: string;
    data: MonitorWindowJsonValueV1;
    attention?: readonly MonitorWindowFacetAttentionV1[];
}
export interface MonitorWindowFacetReadRequestV1 {
    version: typeof MONITOR_WINDOW_STATE_VERSION;
    /** Exact targets captured by the root Monitor at the start of a read tick. */
    targets: readonly MonitorWindowFacetTargetV1[];
}
export interface MonitorWindowFacetProvider {
    /** Stable process-local provider kind. */
    kind: string;
    /**
     * Read bounded display facets for the captured targets. Providers must not
     * mutate windows or infer authority from a Todo projection.
     */
    read(request: MonitorWindowFacetReadRequestV1): readonly MonitorWindowFacetV1[] | Promise<readonly MonitorWindowFacetV1[]>;
}
/** Register a process-local root facet provider. Stale disposers cannot remove replacements. */
export declare function registerMonitorWindowFacetProvider(provider: MonitorWindowFacetProvider): () => void;
export declare function getMonitorWindowFacetProvider(kind: string): MonitorWindowFacetProvider | undefined;
export declare function listMonitorWindowFacetProviders(): MonitorWindowFacetProvider[];
/**
 * Read every registered provider without allowing one failure or malformed
 * target to poison the root Monitor snapshot. The returned facets remain
 * inputs to the pure reducer; this function itself performs no state reduction.
 */
export declare function readMonitorWindowFacets(request: MonitorWindowFacetReadRequestV1, onError?: (message: string) => void): Promise<MonitorWindowFacetV1[]>;
export type MonitorWindowLifecycleStatusV1 = "running" | "sleeping" | "settled" | "launching" | "failed" | "disconnected" | "unknown";
export interface MonitorWindowLifecycleV1 {
    status: MonitorWindowLifecycleStatusV1;
    source: "endpoint" | "managed-window" | "unknown";
    /** Heartbeat/display timestamp. Deliberately excluded from the state revision. */
    ownerPublishedAt?: number;
    lastSettle?: {
        at: number;
        lastResult?: string;
        source: "lifecycle";
    };
}
export interface MonitorWindowDeliveryV1 {
    publicationStage: "unknown" | "pending" | "accepted" | "rejected" | "timeout";
    consumptionStage: "unknown" | "queued" | "injected" | "replied";
    source: "thread" | "unknown";
    /** True only for injected/replied. Publication acceptance and queueing are not consumption. */
    consumed: boolean;
    messageId?: string;
    updatedAt?: number;
}
export type MonitorWindowCompletionOutcomeV1 = "completed" | "failed" | "cancelled" | "no-result";
export type MonitorWindowCompletionSourceV1 = "canonical-completion" | "exact-report";
/** Exact, owner- and work-fenced evidence that may authoritatively complete work. */
export interface MonitorWindowCompletionEvidenceV1 {
    target: Required<MonitorWindowFacetTargetV1>;
    source: MonitorWindowCompletionSourceV1;
    outcome: MonitorWindowCompletionOutcomeV1;
    /** Opaque producer revision used to distinguish same-status reports. */
    revision: string;
    completedAt: number;
    summary?: string;
}
export interface MonitorWindowCompletionV1 {
    outcome: MonitorWindowCompletionOutcomeV1 | "unknown";
    source: MonitorWindowCompletionSourceV1 | "unknown";
    revision?: string;
    completedAt?: number;
    summary?: string;
}
export interface MonitorWindowTodoDisplayV1 {
    id: string;
    subject: string;
    status: string;
    assigneeLabel?: string;
    dispatchId?: string;
    scheduleId?: string;
    stepId?: string;
    bindingActive?: boolean;
    updatedAt: number;
    /** Todo is an observer projection and never completion authority. */
    authority: "display-only";
    source: "workspace-owner";
}
export type MonitorWindowWorkStatusV1 = "unknown" | "waiting-delivery" | "active" | "delivery-failed" | MonitorWindowCompletionOutcomeV1;
export interface MonitorWindowWorkV1 {
    ref?: MonitorWorkRefV1;
    status: MonitorWindowWorkStatusV1;
    delivery: MonitorWindowDeliveryV1;
    completion: MonitorWindowCompletionV1;
    todos: readonly MonitorWindowTodoDisplayV1[];
}
export interface MonitorWindowAttentionV1 extends MonitorWindowFacetAttentionV1 {
    target: MonitorWindowFacetTargetV1;
    source: "reducer" | "lifecycle" | `facet:${string}`;
    dedupeKey: string;
}
export interface MonitorWindowCardV1 {
    identity: MonitorWindowIdentityV1;
    endpoint: {
        status: string;
        scope: string;
        transport: string;
        contentRevision: string;
    };
    window: {
        name?: string;
        sessionName?: string;
        objective?: string;
        presentation?: "interactive" | "headless";
        management?: "monitor" | "delegation";
        pid?: number;
        startedAt?: number;
        lifecycle: MonitorWindowLifecycleV1;
    };
    work: MonitorWindowWorkV1;
    facets: readonly MonitorWindowFacetV1[];
    attention: readonly MonitorWindowAttentionV1[];
}
export interface MonitorWindowStateV1 {
    version: typeof MONITOR_WINDOW_STATE_VERSION;
    /** Opaque hash of semantic state; heartbeat-only timestamps are excluded. */
    revision: string;
    /** Opaque continuation token for this exact semantic snapshot. */
    cursor: string;
    observedAt: number;
    windows: readonly MonitorWindowCardV1[];
    attention: readonly MonitorWindowAttentionV1[];
}
