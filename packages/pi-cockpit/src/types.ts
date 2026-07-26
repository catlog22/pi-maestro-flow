// Cross-extension event names broadcast by pi-maestro-teammate.
// Hard-coded strings (stable contract; see pi-maestro-teammate/src/shared/types.ts:184-186)
// so this package needs no import path into the teammate package.
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";

// The widget key we own. The teammate extension owns "teammate-agents" (belowEditor);
// we use a distinct key above the editor so the two can coexist.
export const STACK_WIDGET_KEY = "cockpit-stack";
export const NATIVE_AGENTS_WIDGET_KEY = "teammate-agents";

// todo tool name registered by pi-maestro-flow (src/extension/index.ts:594).
export const TODO_TOOL_NAME = "todo";
// appendEntry customType the todo tool persists after every mutation (tools/todo.ts:145).
export const TODO_STATE_ENTRY_TYPE = "todo-state";

export type AgentStatus = "running" | "done" | "failed";

export interface AgentRow {
	correlationId: string;
	agent: string;
	name: string | undefined;
	role: string;
	task: string;
	status: AgentStatus;
	tail: string;
	startedAt: number;
}

export type TodoState = "pending" | "in_progress" | "completed" | "blocked";

export interface TodoItem {
	id: string;
	subject: string;
	status: TodoState;
}

export type ViewMode = "list" | "compact";

export interface CockpitConfig {
	enabled: boolean;
	agentsMode: ViewMode;
	todoMode: ViewMode;
	hideNativeAgents: boolean;
}

export const DEFAULT_CONFIG: CockpitConfig = {
	enabled: true,
	agentsMode: "list",
	todoMode: "list",
	hideNativeAgents: false,
};
