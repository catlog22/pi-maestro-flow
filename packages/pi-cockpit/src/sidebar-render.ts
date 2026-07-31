import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { resolveGlyphs, type IconGlyphs } from "./icons.ts";
import type { MaestroUiStateSnapshotV1 } from "./public/v1/events.ts";
import { formatAgentMetric, formatDuration } from "./render.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";

export interface SidebarRenderInput {
	maestro: MaestroUiStateSnapshotV1 | undefined;
	todos: readonly TodoItem[];
	agents: readonly AgentRow[];
	jobs: readonly BashBgJob[];
	config: Pick<CockpitConfig, "sidebar" | "icons">;
	width: number;
	height: number;
	theme: Theme;
	now: number;
	resizing?: boolean;
}

interface SidebarSection {
	title: "Workflow" | "Goal" | "Tasks" | "Agents" | "Jobs" | "Swarm";
	rows: string[];
}

function clean(value: string | undefined): string {
	return value === undefined ? "" : sanitizeExtensionStatusText(value);
}

function finiteCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function statusVisual(status: string, glyphs: IconGlyphs): { glyph: string; color: ThemeColor } {
	const normalized = clean(status).toLowerCase();
	if (/fail|error|blocked/.test(normalized)) return { glyph: glyphs.cross, color: "error" };
	if (/complete|completed|done|success|passed|ready/.test(normalized)) {
		return { glyph: glyphs.check, color: "success" };
	}
	if (/running|working|active|progress|retry|stopping/.test(normalized)) {
		return { glyph: glyphs.dotRunning, color: normalized.includes("retry") ? "warning" : "accent" };
	}
	if (/pause|sleep|waiting/.test(normalized)) return { glyph: glyphs.dotIdle, color: "warning" };
	return { glyph: glyphs.pending, color: "dim" };
}

function paintedStatus(status: string, theme: Theme, glyphs: IconGlyphs): string {
	const safeStatus = clean(status) || "unknown";
	const visual = statusVisual(safeStatus, glyphs);
	return `${theme.fg(visual.color, visual.glyph)} ${safeStatus}`;
}

function compactCounts(values: ReadonlyArray<{ status: string }>): string {
	const active = values.filter((item) => /running|retry|stopping|progress|active/i.test(item.status)).length;
	const failed = values.filter((item) => /fail|error|blocked/i.test(item.status)).length;
	const done = values.filter((item) => /complete|completed|done|success/i.test(item.status)).length;
	return [
		`${values.length} total`,
		active > 0 ? `${active} active` : "",
		failed > 0 ? `${failed} failed` : "",
		done > 0 ? `${done} done` : "",
	].filter(Boolean).join(" · ");
}

function workflowRows(
	maestro: MaestroUiStateSnapshotV1 | undefined,
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	const workflow = maestro?.workflow;
	if (!workflow) return [];
	const session = `${clean(workflow.session.label) || clean(workflow.session.id)} · ${paintedStatus(workflow.session.status, theme, glyphs)}`;
	const chain = workflow.chain;
	const gates = workflow.gates;
	const progress = `${finiteCount(chain.completed)}/${finiteCount(chain.total)} done`
		+ (chain.running > 0 ? ` · ${finiteCount(chain.running)} running` : "")
		+ (chain.pending > 0 ? ` · ${finiteCount(chain.pending)} pending` : "");
	const gateText = `${finiteCount(gates.passed)}/${finiteCount(gates.total)} gates`
		+ ((gates.failed ?? 0) > 0 ? ` · ${finiteCount(gates.failed ?? 0)} failed` : "");
	if (compact) {
		const run = workflow.run
			? `${paintedStatus(workflow.run.status, theme, glyphs)} · ${clean(workflow.run.command)}`
			: progress;
		return [session, run];
	}
	const rows = [session];
	if (workflow.run) rows.push(`${paintedStatus(workflow.run.status, theme, glyphs)} · ${clean(workflow.run.command)}`);
	rows.push(theme.fg("muted", progress), theme.fg((gates.failed ?? 0) > 0 ? "error" : "muted", gateText));
	if (workflow.next) rows.push(`${theme.fg("dim", "Next")} ${clean(workflow.next)}`);
	return rows;
}

function goalRows(
	maestro: MaestroUiStateSnapshotV1 | undefined,
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	if (!maestro || maestro.goals.length === 0) return [];
	const goal = maestro.goals.find((candidate) => candidate.id === maestro.currentGoalId)
		?? maestro.goals.find((candidate) => /running|active|progress|pause/i.test(candidate.status))
		?? maestro.goals[0];
	const objective = clean(goal.objective) || clean(goal.id);
	const status = `${paintedStatus(goal.status, theme, glyphs)} · iteration ${finiteCount(goal.iteration)}`;
	if (compact) return [objective, status];
	const tokens = goal.tokenBudget === undefined
		? `${formatAgentMetric(goal.tokensUsed)} tokens`
		: `${formatAgentMetric(goal.tokensUsed)}/${formatAgentMetric(goal.tokenBudget)} tokens`;
	const rows = [theme.bold(objective), status, theme.fg("muted", `${tokens} · ${formatDuration(goal.timeUsedSeconds * 1_000)}`)];
	if (goal.pauseReason) rows.push(`${theme.fg("warning", glyphs.dotIdle)} ${clean(goal.pauseReason)}`);
	if (maestro.goals.length > 1) rows.push(theme.fg("dim", `${maestro.goals.length} goals · current ${clean(goal.id)}`));
	return rows;
}

const TODO_RANK: Record<TodoItem["status"], number> = {
	in_progress: 0,
	blocked: 1,
	pending: 2,
	completed: 3,
};

function taskRows(
	items: readonly TodoItem[],
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	if (items.length === 0) return [];
	const done = items.filter((item) => item.status === "completed").length;
	const active = items.filter((item) => item.status === "in_progress").length;
	const blocked = items.filter((item) => item.status === "blocked").length;
	const summary = `${done}/${items.length} done`
		+ (active > 0 ? ` · ${active} active` : "")
		+ (blocked > 0 ? ` · ${blocked} blocked` : "");
	const ordered = [...items].sort((a, b) => TODO_RANK[a.status] - TODO_RANK[b.status] || a.id.localeCompare(b.id));
	const visible = compact ? ordered.slice(0, 1) : ordered;
	return [theme.fg(blocked > 0 ? "warning" : "muted", summary), ...visible.map((item) => {
		const visual = item.status === "in_progress"
			? { glyph: glyphs.dotRunning, color: "accent" as ThemeColor }
			: item.status === "completed"
				? { glyph: glyphs.check, color: "success" as ThemeColor }
				: item.status === "blocked"
					? { glyph: glyphs.blocked, color: "error" as ThemeColor }
					: { glyph: glyphs.pending, color: "dim" as ThemeColor };
		const actor = item.assignee ? ` @${clean(item.assignee.label)}` : "";
		return `${theme.fg(visual.color, visual.glyph)} ${clean(item.subject)}${theme.fg("dim", actor)}`;
	})];
}

function agentRows(
	rows: readonly AgentRow[],
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
	now: number,
): string[] {
	if (rows.length === 0) return [];
	const ordered = [...rows].sort((a, b) => {
		const active = (row: AgentRow) => row.status === "running" || row.status === "retrying" ? 0 : row.status === "failed" ? 1 : 2;
		return active(a) - active(b) || b.lastActivityAt - a.lastActivityAt || a.correlationId.localeCompare(b.correlationId);
	});
	const summary = compactCounts(ordered);
	const visible = compact ? ordered.slice(0, 1) : ordered;
	return [theme.fg("muted", summary), ...visible.map((row) => {
		const label = clean(row.name) || clean(row.role) || clean(row.agent) || "agent";
		const task = clean(row.task);
		const elapsed = formatDuration((row.finishedAt ?? now) - row.startedAt);
		return `${paintedStatus(row.status, theme, glyphs)} · ${theme.fg("syntaxFunction", label)}`
			+ (task ? ` · ${task}` : "")
			+ theme.fg("dim", ` · ${elapsed}`);
	})];
}

function jobRows(
	jobs: readonly BashBgJob[],
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
	now: number,
): string[] {
	if (jobs.length === 0) return [];
	const summary = compactCounts(jobs);
	const visible = compact ? jobs.slice(0, 1) : jobs;
	return [theme.fg("muted", summary), ...visible.map((job) => {
		const command = clean(job.command) || clean(job.id);
		const elapsed = formatDuration((job.finishedAt ?? now) - job.startedAt);
		const exit = job.exitCode === null ? "" : ` · exit ${job.exitCode}`;
		return `${paintedStatus(job.status, theme, glyphs)} · ${command}${theme.fg("dim", ` · ${elapsed}${exit}`)}`;
	})];
}

function swarmRows(
	maestro: MaestroUiStateSnapshotV1 | undefined,
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	const swarm = maestro?.swarm;
	if (!swarm) return [];
	const objective = clean(swarm.objective) || clean(swarm.sessionId);
	const iteration = `${paintedStatus(swarm.status, theme, glyphs)} · iteration ${finiteCount(swarm.iteration)}/${finiteCount(swarm.maxIterations)}`;
	const workers = `${swarm.workers.length} workers`
		+ (swarm.workers.length > 0 ? ` · ${compactCounts(swarm.workers)}` : "");
	if (compact) return [objective, iteration];
	const rows = [theme.bold(objective), iteration, theme.fg("muted", workers)];
	if (swarm.best) {
		const summary = clean(swarm.best.summary);
		rows.push(`${theme.fg("success", `${glyphs.check} best ${swarm.best.score}`)}`
			+ (summary ? ` · ${summary}` : ""));
	}
	return rows;
}

function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "");
}

function sectionTitle(title: SidebarSection["title"], theme: Theme, width: number): string {
	return fit(theme.bold(theme.fg("syntaxFunction", title)), width);
}

function allocatedRows(section: SidebarSection, count: number, theme: Theme, glyphs: IconGlyphs, width: number): string[] {
	if (count >= section.rows.length) return section.rows.slice(0, count).map((row) => fit(row, width));
	if (count <= 0) return [];
	const hidden = section.rows.length - count;
	if (count === 1) {
		return [fit(`${section.rows[0]} ${theme.fg("dim", `${glyphs.ellipsis} +${hidden}`)}`, width)];
	}
	return [
		...section.rows.slice(0, count - 1).map((row) => fit(row, width)),
		fit(theme.fg("dim", `${glyphs.ellipsis} ${hidden + 1} more`), width),
	];
}

function layoutSections(
	sections: readonly SidebarSection[],
	height: number,
	theme: Theme,
	glyphs: IconGlyphs,
	contentWidth: number,
): string[] {
	let remaining = Math.max(0, height);
	const allocations = sections.map((section) => ({ section, rows: 0 }));
	const included: typeof allocations = [];
	for (const allocation of allocations) {
		if (remaining < 2) break;
		allocation.rows = 1;
		remaining -= 2;
		included.push(allocation);
	}
	for (const allocation of included) {
		const wanted = Math.max(0, allocation.section.rows.length - allocation.rows);
		const granted = Math.min(wanted, remaining);
		allocation.rows += granted;
		remaining -= granted;
	}
	const output: string[] = [];
	for (const allocation of included) {
		output.push(sectionTitle(allocation.section.title, theme, contentWidth));
		output.push(...allocatedRows(allocation.section, allocation.rows, theme, glyphs, contentWidth));
	}
	return output;
}

function dockRows(rows: readonly string[], width: number, height: number, theme: Theme, resizing: boolean): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const divider = theme.fg(resizing ? "warning" : "borderMuted", "│");
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = fit(rows[index] ?? "", contentWidth);
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return fit(`${divider} ${content}${padding}`, safeWidth);
	});
}

/** Pure projection renderer. It performs no store reads, file access, or CLI work. */
export function renderSidebar(input: SidebarRenderInput): string[] {
	const width = Math.max(0, Math.trunc(input.width));
	const height = Math.max(0, Math.trunc(input.height));
	if (width <= 0 || height <= 0) return [];
	const theme = input.theme;
	const glyphs = resolveGlyphs(input.config.icons.mode);
	const compact = width <= 35 || input.config.sidebar.density === "compact";
	const now = Number.isFinite(input.now) ? input.now : 0;
	const candidates: SidebarSection[] = [
		{ title: "Workflow", rows: workflowRows(input.maestro, compact, theme, glyphs) },
		{ title: "Goal", rows: goalRows(input.maestro, compact, theme, glyphs) },
		{ title: "Tasks", rows: taskRows(input.todos, compact, theme, glyphs) },
		{ title: "Agents", rows: agentRows(input.agents, compact, theme, glyphs, now) },
		{ title: "Jobs", rows: jobRows(input.jobs, compact, theme, glyphs, now) },
		{ title: "Swarm", rows: swarmRows(input.maestro, compact, theme, glyphs) },
	];
	const sections = candidates.filter((section) => section.rows.length > 0);
	const content = layoutSections(sections, height, theme, glyphs, Math.max(0, width - 2));
	return dockRows(content, width, height, theme, input.resizing === true);
}

export function renderSidebarError(
	error: unknown,
	width: number,
	height: number,
	theme: Theme,
	resizing = false,
): string[] {
	const message = clean(error instanceof Error ? error.message : String(error)) || "render failed";
	const rows = [theme.bold(theme.fg("error", "Cockpit sidebar")), theme.fg("error", message)];
	return dockRows(rows, width, height, theme, resizing);
}
