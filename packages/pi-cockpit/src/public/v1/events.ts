/** Public v1 event contract shared by Maestro producers and Cockpit consumers. */

export const COCKPIT_MAESTRO_QUERY_EVENT = "cockpit:maestro-query";
export const MAESTRO_UI_SNAPSHOT_EVENT = "maestro:ui-snapshot";
export const MAESTRO_UI_SNAPSHOT_VERSION = 1 as const;

/**
 * Cross-extension input ownership: emitted before any extension opens a
 * capturing overlay, so the Cockpit split-pane resize listener (a global
 * terminal input hook) yields before the overlay grabs focus. Fire-and-forget;
 * producers never await a reply.
 */
export const COCKPIT_PREEMPT_RESIZE_EVENT = "cockpit:preempt-resize";

/**
 * Todo panel toggle. Emitted by pi-maestro-flow's Alt+T handler while Cockpit
 * owns the Todo surface; Cockpit applies `expanded` as a boolean and treats an
 * absent/non-boolean value as a toggle. The payload is optional by design.
 */
export const COCKPIT_TODO_TOGGLE_EVENT = "cockpit:toggle-todo";
export interface CockpitTodoToggleV1 {
	expanded?: unknown;
}

export type MaestroJsonPrimitiveV1 = string | number | boolean | null;
export type MaestroJsonValueV1 = MaestroJsonPrimitiveV1 | MaestroJsonValueV1[] | MaestroJsonObjectV1;
export interface MaestroJsonObjectV1 {
	[key: string]: MaestroJsonValueV1;
}

export interface MaestroWorkflowSessionV1 {
	id: string;
	label: string;
	status: string;
}

export interface MaestroWorkflowRunV1 {
	id: string;
	command: string;
	status: string;
}

export interface MaestroWorkflowChainV1 {
	completed: number;
	running: number;
	pending: number;
	total: number;
}

export interface MaestroWorkflowGatesV1 {
	passed: number;
	total: number;
	failed?: number;
}

export interface MaestroWorkflowV1 {
	session: MaestroWorkflowSessionV1;
	run: MaestroWorkflowRunV1 | null;
	chain: MaestroWorkflowChainV1;
	gates: MaestroWorkflowGatesV1;
	next: string | null;
}

export interface MaestroGoalV1 {
	id: string;
	objective: string;
	status: string;
	pauseReason?: string;
	iteration: number;
	tokensUsed: number;
	tokenBudget?: number;
	timeUsedSeconds: number;
	startedAt: number;
	updatedAt: number;
}

export interface MaestroSwarmWorkerV1 {
	id: string;
	label?: string;
	status: string;
}

export interface MaestroSwarmBestV1 {
	workerId?: string;
	iteration: number;
	score: number;
	summary?: string;
}

export interface MaestroSwarmV1 {
	sessionId: string;
	objective: string;
	status: string;
	iteration: number;
	maxIterations: number;
	workers: MaestroSwarmWorkerV1[];
	best: MaestroSwarmBestV1 | null;
	updatedAt: number;
}

/**
 * The active Maestro projection. String values are deliberately open so adding
 * a producer mode does not require a protocol revision.
 */
export type MaestroModeV1 = string | { kind: string; label?: string };

export interface MaestroQueryV1 {
	version: typeof MAESTRO_UI_SNAPSHOT_VERSION;
}

export interface MaestroUiEnvelopeV1 {
	version: typeof MAESTRO_UI_SNAPSHOT_VERSION;
	/** Opaque lifecycle identity. A new value fences the previous generation. */
	sessionGeneration: string;
	/** Monotonically increasing within one session generation. */
	revision: number;
	/** Epoch milliseconds assigned by the producer. */
	publishedAt: number;
}

export interface MaestroUiStateSnapshotV1 extends MaestroUiEnvelopeV1 {
	cleared?: false;
	workflow: MaestroWorkflowV1 | null;
	goals: MaestroGoalV1[];
	currentGoalId?: string;
	swarm: MaestroSwarmV1 | null;
	mode: MaestroModeV1;
}

/** Ordered tombstone; state fields are intentionally absent. */
export interface MaestroUiClearSnapshotV1 extends MaestroUiEnvelopeV1 {
	cleared: true;
}

export type MaestroUiSnapshotV1 = MaestroUiStateSnapshotV1 | MaestroUiClearSnapshotV1;

export interface CockpitUiOwnershipV1 {
	todo: boolean;
	agents: boolean;
	footer: boolean;
	/** True only while the split-pane dock is effectively visible. */
	sidebar: boolean;
	/** True only while the dock renders Maestro Goal state. */
	goal: boolean;
	todoExpanded: boolean;
	quiet: boolean;
	quietSymbols: "check" | "dot";
	/** Static mode: per-second churn (elapsed ticks, spinners) is suppressed. */
	static: boolean;
}

export interface MaestroEventMapV1 {
	"cockpit:maestro-query": MaestroQueryV1;
	"maestro:ui-snapshot": MaestroUiSnapshotV1;
	"cockpit:ui-ownership": CockpitUiOwnershipV1;
	"cockpit:preempt-resize": undefined;
	"cockpit:toggle-todo": CockpitTodoToggleV1 | undefined;
}
