// Cross-extension event names broadcast by pi-maestro-teammate.
// Hard-coded strings (stable contract; see pi-maestro-teammate/src/shared/types.ts:184-186)
// so this package needs no import path into the teammate package.
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

export type AgentStatus = "pending" | "running" | "retrying" | "sleeping" | "done" | "failed";

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
	lastActivityAt: number;
	toolCount?: number;
	tokens?: number;
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

export type IconMode = "auto" | "nerd" | "ascii";

export interface CockpitConfig {
	enabled: boolean;
	agentsMode: ViewMode;
	todoMode: ViewMode;
	todoExpanded: boolean;
	hideNativeAgents: boolean;
	icons: { mode: IconMode };
	/**
	 * Theme to apply at session start. Empty means "leave whatever pi is using",
	 * so cockpit never overrides a theme the user picked elsewhere.
	 */
	theme: string;
}

export const DEFAULT_CONFIG: CockpitConfig = {
	enabled: true,
	agentsMode: "list",
	todoMode: "list",
	todoExpanded: false,
	hideNativeAgents: true,
	icons: { mode: "auto" },
	theme: "",
};
