// Cross-extension event names from pi-maestro-teammate's versioned public
// contract. They remain literal here so Cockpit can still load standalone when
// the optional teammate peer is absent; payload types are imported from /v1.
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export const TEAMMATE_VIEWING_EVENT = "teammate:viewing";
export const TEAMMATE_OPEN_AGENT_EVENT = "teammate:open-agent";
// Cockpit → teammate: interrupt (打断) or steer (引导) one agent by correlationId.
// Payload: { correlationId, action: "interrupt" | "steer", message? }.
export const TEAMMATE_AGENT_COMMAND_EVENT = "teammate:agent-command";
export const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
export const BASH_BG_UPDATE_EVENT = "bash-bg:update";
export const BASH_BG_QUERY_EVENT = "bash-bg:query";
// Unified supervision telemetry from the shared layer (pi-maestro-teammate/v1/supervision).
export const SUPERVISION_EVENT = "supervision:event";
export const WORKFLOW_STATUS_KEY = "maestro-workflow";

// Widget keys owned by pi-cockpit. Native Flow/teammate widgets yield through
// COCKPIT_UI_OWNERSHIP_EVENT instead of being cleared across extension boundaries.
export const STACK_WIDGET_KEY = "cockpit-stack";
export const AGENT_WIDGET_KEY = "cockpit-agents";

// todo tool name registered by pi-maestro-flow (src/extension/index.ts:594).
export const TODO_TOOL_NAME = "todo";

// Role name the teammate extension gives the workflow Leader when a dispatch
// runs in expert mode (pi-maestro-teammate EXPERT_MODE_LEADER_NAME). The name
// travels in every started/message/progress event, so the projection can mark
// the Leader row without a new event field; tests pin both literals so a
// rename cannot drift silently.
export const EXPERT_LEADER_NAME = "expert-leader";
// appendEntry customType the todo tool persists after every mutation (tools/todo.ts:145).
export const TODO_STATE_ENTRY_TYPE = "todo-state";

export type AgentStatus = "pending" | "running" | "retrying" | "sleeping" | "done" | "failed" | "terminated";

export interface AgentLastOutcome {
	status: "completed" | "failed" | "terminated";
	message?: string;
	settledAt: number;
}

export interface AgentRow {
	correlationId: string;
	parentCorrelationId?: string;
	agent: string;
	name: string | undefined;
	role: string;
	task: string;
	status: AgentStatus;
	phase?: string;
	lastOutcome?: AgentLastOutcome;
	tail: string;
	startedAt: number;
	/** Start of the current wake/run cycle; unlike startedAt this resets on every started upsert. */
	turnStartedAt?: number;
	/** Terminal wall-clock used to freeze elapsed time for completed/failed rows. */
	finishedAt?: number;
	lastActivityAt: number;
	/** When the agent published its final result while lifecycle is still confirming (running). */
	resultReadyAt?: number;
	/** True when this agent is the one currently shown in the teammate viewing view. */
	viewing?: boolean;
	toolCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Latest provider/runtime diagnostic from the authoritative progress snapshot. */
	error?: string;
	/** Current tool name while running, from the progress snapshot's recent tools. */
	activeTool?: string;
	/** Redacted one-line argument summary of the current tool call. */
	activeToolArgs?: string;
	requestedModel?: string;
	resolvedModel?: string;
	attemptedModels?: string[];
	taskStatus?: string;
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
export type CurrencyMode = "usd" | "cny";

/**
 * Legacy quiet-tool palette values retained while existing cockpit.json files
 * migrate. Tool names now use theme-owned lifecycle colors instead.
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

/**
 * Terminal tab title surface. Fed from the same AmbientState snapshots as the
 * widgets, so the title can never disagree with them. By default the title is
 * deliberately short — session summary + working state — because a wall of
 * tags in the tab strip is unreadable; every extra dimension is opt-in.
 */
export interface TitleConfig {
	/** Master switch for the terminal tab title surface. */
	enabled: boolean;
	/** Include the session summary (or short id) right after "pi". */
	showSession: boolean;
	/** Include the working directory after the session. Off by default. */
	showCwd: boolean;
	/** Include the active model tag (e.g. `m:gpt-5.6-sol`). Off by default. */
	showModel: boolean;
	/** Include the thinking level tag, skipped while off (e.g. `t:high`). Off by default. */
	showThinking: boolean;
	/** Include the git branch tag (e.g. `git:main`, `git:detached`). Off by default. */
	showGit: boolean;
	/** Include the Maestro workflow status tag (e.g. `wf:running`). Off by default. */
	showMaestro: boolean;
	/**
	 * Model used to generate the session title after the first turn, as
	 * "provider/model" (e.g. "maestro-qwen/qwen3.8-max"). Resolved
	 * through pi's ModelRegistry — the same providers /api-manager manages.
	 * Empty (default) falls back to the offline rule-based suggestTitle().
	 */
	generationModel?: string;
	/** Hard cap on the composed title; the middle is ellided to keep head + state tail. */
	maxLength: number;
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
	/** Legacy persisted value; tool-name colors are derived from lifecycle state. */
	toolPalette: ToolPaletteMode;
	agentsMode: ViewMode;
	todoMode: ViewMode;
	todoExpanded: boolean;
	hideNativeAgents: boolean;
	/** Experimental: keep the editor/footer block at the terminal bottom while the conversation is short. */
	pinEditorBottom: boolean;
	/**
	 * Claude Code-style double bare-Escape clears a non-empty input draft.
	 * The first Escape keeps its native meaning; only a second Escape within
	 * the window, with a non-empty focused draft, is consumed. Empty-draft
	 * double-Escape stays pi's rewind/tree action. Requires /reload to take
	 * effect (installs a Cockpit custom editor at session start).
	 */
	doubleEscapeClearInput: boolean;
	/**
	 * Claude Code-style fullscreen input: alternate screen with the editor
	 * fixed at the bottom and an application-owned scrolling transcript, so
	 * the editor no longer scrolls away on manual scrollback. Terminal-native
	 * scrollback/search is replaced by transcript scrolling. Requires /reload
	 * to take effect (installs a Cockpit custom editor at session start).
	 */
	fullscreenInput: boolean;
	/**
	 * Copy transcript text to the clipboard when a drag selection is released.
	 * Effective only while fullscreenInput is active; ignored otherwise.
	 */
	copyOnSelect: boolean;
	/** Footer cost currency: USD or CNY (CNY converts the USD estimate by currencyRate). */
	currency: CurrencyMode;
	/** CNY per 1 USD; only used while currency is "cny". */
	currencyRate: number;
	icons: { mode: IconMode };
	sidebar: SidebarConfig;
	/** Terminal tab title surface (session summary + working state + optional tags). */
	title: TitleConfig;
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
	pinEditorBottom: false,
	doubleEscapeClearInput: false,
	fullscreenInput: false,
	copyOnSelect: false,
	currency: "usd",
	currencyRate: 7.2,
	icons: { mode: "auto" },
	sidebar: { mode: "off", width: 40, density: "comfortable" },
	title: {
		enabled: true,
		showSession: true,
		showCwd: false,
		showModel: false,
		showThinking: false,
		showGit: false,
		showMaestro: false,
		generationModel: "",
		maxLength: 80,
	},
	theme: "",
};
