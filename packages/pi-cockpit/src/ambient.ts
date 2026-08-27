// Ambient surfaces: the streaming working line, the terminal tab title, and the
// footer status slot.
//
// Cockpit already knows the in-progress task, the live agent roster and the
// background jobs, but it only ever painted them into its own widgets. Meanwhile
// the host's streaming loader said "Working…", the tab title said nothing, and a
// config error scrolled away as a one-shot toast. These are pure composers for
// those three surfaces — they add information without costing a single row.

import type { AgentRow, BashBgJob, TodoItem } from "./types.ts";
import { formatThinkingDuration } from "./thinking-timer.ts";
import { tuiT } from "./tui-i18n.ts";

export interface AmbientState {
	todos: readonly TodoItem[];
	agents: readonly AgentRow[];
	jobs: readonly BashBgJob[];
	running: boolean;
	cwd?: string;
	activeTool?: string;
	workingStartedAt?: number;
	hideLiveDuration?: boolean;
	/** Separator glyph between label and elapsed time (e.g. " · "). */
	separator?: string;
	/** Session summary — the session_info name, else a short session id. */
	session?: string;
	/** Active model short id. */
	model?: string;
	/** Active thinking level (omitted while off). */
	thinking?: string;
	/** Git branch name, or "detached". */
	gitBranch?: string;
	/** Maestro workflow status (run status when a run is active). */
	maestro?: string;
	/** Maestro knowledge evolution summary (consumed/pending/review). */
	maestroKnowledge?: string;
	/**
	 * Leading title glyph: spinner frames while a turn runs, a static marker
	 * when idle (Claude Code's `✳` / braille frames). Failure keeps its own
	 * mark and ignores this. Absent when the caller opts out.
	 */
	frame?: string;
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
 * The streaming working line.
 *
 * Cockpit hides the host indicator and renders the active state with a live
 * elapsed value, matching the compact folded-thinking label.
 */
export function workingMessage(state: AmbientState, now = Date.now()): string | undefined {
	const label = state.activeTool ?? (state.running ? tuiT("ambient.working") : undefined);
	if (!label) return undefined;
	const sep = state.separator ?? " ";
	const text = (state.hideLiveDuration || state.workingStartedAt === undefined)
		? label
		: `${label}${sep}${formatThinkingDuration(now - state.workingStartedAt)}`;
	return `\x1b[3m${text}\x1b[23m`;
}

/** Composition options for titleFor. */
export interface TitleOptions {
	/** Hard cap on the composed title. The middle is ellided, keeping head + state tail. */
	maxLength?: number;
}

/**
 * The terminal tab title.
 *
 * A developer with several tabs open cannot otherwise tell which run finished and
 * which one needs them. Failure outranks progress, because that is the state that
 * actually requires a human. The session summary (when present) sits right after
 * "pi"; model / thinking / git / maestro tags follow the working state. Fields
 * are only appended when present, so callers decide what to expose per config.
 */
export function titleFor(
	state: AmbientState,
	marks: { ok: string; fail: string },
	sep = " - ",
	opts?: TitleOptions,
): string {
	const head = ["pi"];
	if (state.session) head.push(state.session);
	if (state.cwd) head.push(state.cwd);
	const base = head.join(sep);
	const broken = failedAgents(state.agents).length + failedJobs(state.jobs).length;
	const prefix = state.frame ? `${state.frame} ` : "";
	let title: string;
	if (broken > 0) {
		title = `${marks.fail} ${base}${sep}${tuiT("ambient.failed", { count: broken })}`;
	} else if (state.running) {
		const live = liveAgents(state.agents).length;
		title = live > 0
			? `${prefix}${base}${sep}${tuiT("ambient.agents", { count: live })}`
			: `${prefix}${base}${sep}${tuiT("ambient.working")}`;
	} else {
		const jobs = state.jobs.filter((job) => job.status === "running").length;
		title = jobs > 0 ? `${prefix}${base}${sep}${jobs} bg` : `${prefix}${base}`;
	}
	const tags: string[] = [];
	if (state.model) tags.push(`m:${state.model}`);
	if (state.thinking) tags.push(`t:${state.thinking}`);
	if (state.gitBranch) tags.push(`git:${state.gitBranch}`);
	if (state.maestro) tags.push(`wf:${state.maestro}`);
	if (state.maestroKnowledge) tags.push(`k:${state.maestroKnowledge}`);
	if (tags.length > 0) title = `${title}${sep}${tags.join(sep)}`;
	if (opts?.maxLength !== undefined && title.length > opts.maxLength) {
		const cap = opts.maxLength;
		const headLen = Math.max(8, Math.floor(cap * 0.4));
		const tailLen = Math.max(8, Math.floor(cap * 0.5));
		title = `${title.slice(0, headLen)}…${title.slice(-tailLen)}`;
	}
	return title;
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

/**
 * Some host UI setters invalidate the whole TUI even when the value did not
 * change. Cache the last ambient values so the 250ms Cockpit tick only mutates
 * host surfaces when there is a real text change.
 */
export class AmbientSurfaceCache {
	private workingMessageKnown = false;
	private workingMessage: string | undefined;
	private titleKnown = false;
	private title: string | undefined;
	private readonly statuses = new Map<string, string | undefined>();

	reset(): void {
		this.workingMessageKnown = false;
		this.workingMessage = undefined;
		this.titleKnown = false;
		this.title = undefined;
		this.statuses.clear();
	}

	setWorkingMessage(setter: (message: string | undefined) => void, message: string | undefined): boolean {
		if (this.workingMessageKnown && this.workingMessage === message) return false;
		this.workingMessageKnown = true;
		this.workingMessage = message;
		setter(message);
		return true;
	}

	setTitle(setter: (title: string) => void, title: string): boolean {
		if (this.titleKnown && this.title === title) return false;
		this.titleKnown = true;
		this.title = title;
		setter(title);
		return true;
	}

	setStatus(
		key: string,
		setter: (key: string, text: string | undefined) => void,
		text: string | undefined,
	): boolean {
		if (this.statuses.has(key) && this.statuses.get(key) === text) return false;
		this.statuses.set(key, text);
		setter(key, text);
		return true;
	}
}
