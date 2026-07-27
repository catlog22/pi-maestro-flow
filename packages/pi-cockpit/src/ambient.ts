// Ambient surfaces: the streaming working line, the terminal tab title, and the
// footer status slot.
//
// Cockpit already knows the in-progress task, the live agent roster and the
// background jobs, but it only ever painted them into its own widgets. Meanwhile
// the host's streaming loader said "Working…", the tab title said nothing, and a
// config error scrolled away as a one-shot toast. These are pure composers for
// those three surfaces — they add information without costing a single row.

import type { AgentRow, BashBgJob, TodoItem } from "./types.ts";

export interface AmbientState {
	todos: readonly TodoItem[];
	agents: readonly AgentRow[];
	jobs: readonly BashBgJob[];
	running: boolean;
	cwd?: string;
	activeTool?: string;
}

function liveAgents(agents: readonly AgentRow[]): AgentRow[] {
	return agents.filter((a) => a.status === "running" || a.status === "retrying");
}

function failedAgents(agents: readonly AgentRow[]): AgentRow[] {
	return agents.filter((a) => a.status === "failed");
}

function failedJobs(jobs: readonly BashBgJob[]): BashBgJob[] {
	return jobs.filter((job) => job.status === "failed" || (job.exitCode !== null && job.exitCode !== 0));
}

/**
 * The streaming loader line.
 *
 * Keep the host's default "Working" label, elapsed time and interrupt hint.
 * Only replace the label while a foreground tool is actively executing.
 */
export function workingMessage(state: AmbientState): string | undefined {
	if (state.activeTool) return state.activeTool;
	if (state.running) return "working";
	return undefined;
}

/**
 * The terminal tab title.
 *
 * A developer with several tabs open cannot otherwise tell which run finished and
 * which one needs them. Failure outranks progress, because that is the state that
 * actually requires a human.
 */
export function titleFor(state: AmbientState, marks: { ok: string; fail: string }): string {
	const base = state.cwd ? `pi · ${state.cwd}` : "pi";
	const broken = failedAgents(state.agents).length + failedJobs(state.jobs).length;
	if (broken > 0) return `${marks.fail} ${base} · ${broken} failed`;
	if (state.running) {
		const live = liveAgents(state.agents).length;
		return live > 0 ? `${base} · ${live} agents` : `${base} · working`;
	}
	const jobs = state.jobs.filter((job) => job.status === "running").length;
	if (jobs > 0) return `${base} · ${jobs} bg`;
	return base;
}

/**
 * The footer status slot.
 *
 * Reserved for conditions that must persist rather than scroll away — a config
 * that failed to load is the motivating case, since the session then silently
 * runs on defaults.
 */
export function statusText(problem: string | undefined, mark: string): string | undefined {
	return problem ? `${mark} cockpit: ${problem}` : undefined;
}
