// Cross-extension event names from pi-maestro-teammate's versioned public
// contract. They remain literal here so Cockpit can still load standalone when
// the optional teammate peer is absent; payload types are imported from /v1.
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
export const COCKPIT_TODO_TOGGLE_EVENT = "cockpit:toggle-todo";
export const BASH_BG_UPDATE_EVENT = "bash-bg:update";
export const BASH_BG_QUERY_EVENT = "bash-bg:query";
export const WORKFLOW_STATUS_KEY = "maestro-workflow";

// Widget keys owned by pi-cockpit. Native Flow/teammate widgets yield through
// COCKPIT_UI_OWNERSHIP_EVENT instead of being cleared across extension boundaries.
export const STACK_WIDGET_KEY = "cockpit-stack";
export const AGENT_WIDGET_KEY = "cockpit-agents";

// todo tool name registered by pi-maestro-flow (src/extension/index.ts:594).
export const TODO_TOOL_NAME = "todo";
// appendEntry customType the todo tool persists after every mutation (tools/todo.ts:145).
export const TODO_STATE_ENTRY_TYPE = "todo-state";

export type AgentStatus = "pending" | "running" | "retrying" | "sleeping" | "done" | "failed" | "terminated";

export interface AgentRow {
	correlationId: string;
	parentCorrelationId?: string;
	agent: string;
	name: string | undefined;
	role: string;
	task: string;
	status: AgentStatus;
	tail: string;
	startedAt: number;
	/** Terminal wall-clock used to freeze elapsed time for completed/failed rows. */
	finishedAt?: number;
	lastActivityAt: number;
	/** When the agent published its final result while lifecycle is still confirming (running). */
	resultReadyAt?: number;
	toolCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Latest provider/runtime diagnostic from the authoritative progress snapshot. */
	error?: string;
	requestedModel?: string;
	resolvedModel?: string;
	attemptedModels?: string[];
	taskStatus?: string;
	activeTool?: string;
	taskIndex?: number;
	dependencies?: number[];
	/** Set only on a failed row that outlived its completion, so it can be pruned. */
	failedAt?: number;
}

export type BashBgStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface BashBgJob {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	status: BashBgStatus;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	exitCode: number | null;
	outputTail: string;
	outputBytes: number;
	logPath: string;
}

export type TodoState = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
	id: string;
	subject: string;
	status: TodoState;
	blockedBy: string[];
	createdBy?: TodoActor;
	assignee?: TodoActor;
	skills: TodoSkill[];
	updatedAt?: number;
}

export interface TodoActor {
	id: string;
	label: string;
}

export interface TodoSkill {
	name: string;
	role?: string;
}

export type ViewMode = "list" | "compact";

export type QuietSymbolMode = "check" | "dot";

/**
 * Colour grouping for compact Quiet tool rows. Each mode re-maps the seven
 * built-in tools onto existing theme slots, so it works across every theme
 * without new colour definitions and is orthogonal to the theme accent.
 * - classic: the original syntax-slot mapping (bash/read/ls share one hue).
 * - family: three operation families — inspect / mutate / execute.
 * - readwrite: cool reads vs warm writes, bash set apart.
 * - search: splits discovery into view (read/ls) vs search (grep/find).
 * - mono: single hue ramped by lightness; colourblind-safe, quietest look.
 */
export type ToolPaletteMode = "classic" | "family" | "readwrite" | "search" | "mono";

export type IconMode = "auto" | "nerd" | "ascii";

export type SidebarMode = "auto" | "on" | "off";

export type SidebarDensity = "comfortable" | "compact";

export interface SidebarConfig {
	mode: SidebarMode;
	width: number;
	density: SidebarDensity;
}

export interface CockpitConfig {
	enabled: boolean;
	/**
	 * Static mode: suppress the 250ms animation/redraw loop and the live pieces it
	 * drives. Spinners freeze to static markers, running agents and background jobs
	 * drop their live elapsed time, and token usage totals refresh at most once per
	 * throttle window instead of on every message. Event-driven state changes
	 * (agent start/message/complete, tool start/end) still repaint immediately;
	 * only the periodic churn is removed. Failed rows still linger their readable
	 * window — that retention is a correctness requirement, not animation.
	 */
	staticMode: boolean;
	/**
	 * Quiet mode: compress built-in tool calls to one-line lifecycle summaries and
	 * fold thinking blocks. The lifecycle glyph set is selected by quietSymbols.
	 * The fold drives pi's native thinking toggle, so pi owns and persists the
	 * visibility; turning quiet off leaves thinking as the user last set it
	 * (Ctrl+T or the panel's thinking row). The footer and the Todo widget render
	 * exactly as they do with quiet mode off; the Agents widget stays expanded
	 * but hides its live streaming tail (the per-message text), keeping
	 * role/task/state/telemetry. Symbol changes apply live. Turning Quiet off
	 * still requires /reload or a new session to restore native tool renderers.
	 */
	quietMode: boolean;
	/** Lifecycle glyph set used by compact Quiet tool rows. */
	quietSymbols: QuietSymbolMode;
	/** Colour grouping applied to compact Quiet tool names. */
	toolPalette: ToolPaletteMode;
	agentsMode: ViewMode;
	todoMode: ViewMode;
	todoExpanded: boolean;
	hideNativeAgents: boolean;
	icons: { mode: IconMode };
	sidebar: SidebarConfig;
	/**
	 * Theme to apply at session start. Empty means "leave whatever pi is using",
	 * so cockpit never overrides a theme the user picked elsewhere.
	 */
	theme: string;
}

export const DEFAULT_CONFIG: CockpitConfig = {
	enabled: true,
	staticMode: false,
	quietMode: false,
	quietSymbols: "check",
	toolPalette: "family",
	agentsMode: "list",
	todoMode: "list",
	todoExpanded: false,
	hideNativeAgents: true,
	icons: { mode: "auto" },
	sidebar: { mode: "off", width: 40, density: "comfortable" },
	theme: "",
};
