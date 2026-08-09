import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { effectiveAgentStatus } from "./agents-store.ts";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { resolveGlyphs, type IconGlyphs, type IconMode } from "./icons.ts";
import { composeByPriority, type PriorityGroup } from "./layout.ts";
import type { MaestroUiStateSnapshotV1 } from "./public/v1/events.ts";
import { formatAgentMetric, formatDuration } from "./render.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";

export interface SidebarRenderInput {
	maestro: MaestroUiStateSnapshotV1 | undefined;
	todos: readonly TodoItem[];
	agents: readonly AgentRow[];
	jobs: readonly BashBgJob[];
	config: Pick<CockpitConfig, "sidebar" | "icons" | "staticMode">;
	width: number;
	height: number;
	theme: Theme;
	now: number;
	resizing?: boolean;
	/** Browse-window offset (content rows skipped) while the sidebar has keyboard focus. */
	scrollStart?: number;
	/** Row id (`Section:i`) currently selected in browse mode; gets a highlight. */
	focusedRowId?: string;
}

type SidebarSectionTitle = "Workflow" | "Goal" | "Tasks" | "Agents" | "Jobs" | "Swarm";

interface SidebarSection {
	title: SidebarSectionTitle;
	rows: string[];
}

/** Sections in render order; row ids are `${title}:${index}` (mirrors group names). */
function buildSections(input: SidebarRenderInput): SidebarSection[] {
	const theme = input.theme;
	const glyphs = resolveGlyphs(input.config.icons.mode);
	const compact = input.width <= 35 || input.config.sidebar.density === "compact";
	const now = Number.isFinite(input.now) ? input.now : 0;
	const hideLiveDuration = input.config.staticMode === true;
	return [
		{ title: "Workflow" as const, rows: workflowRows(input.maestro, compact, theme, glyphs) },
		{ title: "Goal" as const, rows: goalRows(input.maestro, compact, theme, glyphs) },
		{ title: "Tasks" as const, rows: taskRows(input.todos, compact, theme, glyphs) },
		{ title: "Agents" as const, rows: agentRows(input.agents, compact, theme, glyphs, now, hideLiveDuration) },
		{ title: "Jobs" as const, rows: jobRows(input.jobs, compact, theme, glyphs, now, hideLiveDuration) },
		{ title: "Swarm" as const, rows: swarmRows(input.maestro, compact, theme, glyphs) },
	].filter((section) => section.rows.length > 0);
}

/** Nav-row ids in the same order the sidebar renders them (browse-mode keyboard navigation). */
export function enumerateNavRows(input: SidebarRenderInput): string[] {
	return buildSections(input).flatMap((section) =>
		section.rows.map((_, index) => `${section.title}:${index}`),
	);
}

/** Highlight a focused row: `▸` accent prefix on the original text. */
function highlightRow(row: string, theme: Theme, contentWidth: number): string {
	return fit(theme.bold(theme.fg("accent", `▸ ${row}`)), contentWidth);
}

/** Sidebar group extends the shared PriorityGroup with a section association. */
interface SidebarGroup extends PriorityGroup {
	section: SidebarSectionTitle;
}

function clean(value: string | undefined): string {
	return value === undefined ? "" : sanitizeExtensionStatusText(value);
}

function finiteCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function statusVisual(status: string, glyphs: IconGlyphs): { glyph: string; color: ThemeColor } {
	const normalized = clean(status).toLowerCase();
	if (/fail|error|blocked|stalled/.test(normalized)) return { glyph: glyphs.cross, color: "error" };
	if (/terminate|cancel/.test(normalized)) return { glyph: glyphs.cross, color: "warning" };
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
	return `${theme.fg(visual.color, visual.glyph)} ${tuiStatus(safeStatus)}`;
}

function compactCounts(values: ReadonlyArray<{ status: string }>, sep: string): string {
	const active = values.filter((item) => /running|retry|stopping|progress|active/i.test(item.status)).length;
	const failed = values.filter((item) => /fail|error|blocked/i.test(item.status)).length;
	const stalled = values.filter((item) => /stalled/i.test(item.status)).length;
	const terminated = values.filter((item) => /terminate|cancel/i.test(item.status)).length;
	const done = values.filter((item) => /complete|completed|done|success/i.test(item.status)).length;
	return [
		tuiT("common.total", { count: values.length }),
		active > 0 ? tuiT("common.active", { count: active }) : "",
		failed > 0 ? tuiT("common.failed", { count: failed }) : "",
		stalled > 0 ? tuiT("common.stalled", { count: stalled }) : "",
		terminated > 0 ? tuiT("common.terminated", { count: terminated }) : "",
		done > 0 ? tuiT("common.done", { count: done }) : "",
	].filter(Boolean).join(sep);
}

function workflowRows(
	maestro: MaestroUiStateSnapshotV1 | undefined,
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	const workflow = maestro?.workflow;
	if (!workflow) return [];
	const session = `${clean(workflow.session.label) || clean(workflow.session.id)}${glyphs.separator}${paintedStatus(workflow.session.status, theme, glyphs)}`;
	const chain = workflow.chain;
	const gates = workflow.gates;
	const progress = tuiT("common.done", { count: `${finiteCount(chain.completed)}/${finiteCount(chain.total)}` })
		+ (chain.running > 0 ? `${glyphs.separator}${tuiT("common.running", { count: finiteCount(chain.running) })}` : "")
		+ (chain.pending > 0 ? `${glyphs.separator}${tuiT("common.pending", { count: finiteCount(chain.pending) })}` : "");
	const gateText = tuiT("sidebar.gates", {
		passed: finiteCount(gates.passed),
		total: finiteCount(gates.total),
	}) + ((gates.failed ?? 0) > 0
		? `${glyphs.separator}${tuiT("common.failed", { count: finiteCount(gates.failed ?? 0) })}`
		: "");
	if (compact) {
		const run = workflow.run
			? `${paintedStatus(workflow.run.status, theme, glyphs)}${glyphs.separator}${clean(workflow.run.command)}`
			: progress;
		return [session, run];
	}
	const rows = [session];
	if (workflow.run) rows.push(`${paintedStatus(workflow.run.status, theme, glyphs)}${glyphs.separator}${clean(workflow.run.command)}`);
	rows.push(theme.fg("muted", progress), theme.fg((gates.failed ?? 0) > 0 ? "error" : "muted", gateText));
	if (workflow.next) rows.push(`${theme.fg("dim", tuiT("sidebar.next"))} ${clean(workflow.next)}`);
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
	const status = `${paintedStatus(goal.status, theme, glyphs)}${glyphs.separator}${tuiT("sidebar.iteration", {
		current: finiteCount(goal.iteration),
	})}`;
	if (compact) return [objective, status];
	const tokens = goal.tokenBudget === undefined
		? tuiT("sidebar.tokens", { count: formatAgentMetric(goal.tokensUsed) })
		: tuiT("sidebar.tokensBudget", {
			used: formatAgentMetric(goal.tokensUsed),
			budget: formatAgentMetric(goal.tokenBudget),
		});
	const rows = [theme.bold(objective), status, theme.fg("muted", `${tokens}${glyphs.separator}${formatDuration(goal.timeUsedSeconds * 1_000)}`)];
	if (goal.pauseReason) rows.push(`${theme.fg("warning", glyphs.dotIdle)} ${clean(goal.pauseReason)}`);
	if (maestro.goals.length > 1) {
		rows.push(theme.fg("dim", `${tuiT("common.goals", { count: maestro.goals.length })}${glyphs.separator}${tuiT("sidebar.currentGoal", {
			id: clean(goal.id),
		})}`));
	}
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
	const summary = tuiT("common.done", { count: `${done}/${items.length}` })
		+ (active > 0 ? `${glyphs.separator}${tuiT("common.active", { count: active })}` : "")
		+ (blocked > 0 ? `${glyphs.separator}${tuiT("common.blocked", { count: blocked })}` : "");
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
	hideLiveDuration: boolean,
): string[] {
	if (rows.length === 0) return [];
	const ordered = [...rows].sort((a, b) => {
		const active = (row: AgentRow) => {
			const status = effectiveAgentStatus(row, now);
			return status === "running" || status === "retrying" ? 0 : status === "stalled" || status === "failed" ? 1 : 2;
		};
		return active(a) - active(b) || b.lastActivityAt - a.lastActivityAt || a.correlationId.localeCompare(b.correlationId);
	});
	const summary = compactCounts(ordered.map((row) => ({ status: effectiveAgentStatus(row, now) })), glyphs.separator);
	const visible = compact ? ordered.slice(0, 1) : ordered;
	return [theme.fg("muted", summary), ...visible.map((row) => {
		const displayStatus = effectiveAgentStatus(row, now);
		const label = clean(row.name) || clean(row.role) || clean(row.agent) || "agent";
		const task = clean(row.task);
		const live = displayStatus === "running" || displayStatus === "retrying";
		const elapsed = hideLiveDuration && live ? "" : formatDuration((row.finishedAt ?? now) - row.startedAt);
		const action = row.error
			? tuiT("sidebar.error", { message: clean(row.error) })
			: row.phase
				? clean(row.phase)
				: row.activeTool
					? tuiT("sidebar.tool", { name: clean(row.activeTool) })
					: row.lastOutcome?.status === "failed"
						? row.lastOutcome.message
							? tuiT("sidebar.lastFailedMessage", { message: clean(row.lastOutcome.message) })
							: tuiT("sidebar.lastFailed")
						: clean(row.tail);
		const telemetry = [
			row.dependencies?.length ? tuiT("sidebar.deps", { count: row.dependencies.length }) : "",
			row.toolCount !== undefined ? tuiT("common.tools", { count: row.toolCount }) : "",
			row.inputTokens !== undefined || row.outputTokens !== undefined
				? tuiT("widget.agent.inputOutput", {
					input: formatAgentMetric(row.inputTokens ?? 0),
					separator: "/",
					output: formatAgentMetric(row.outputTokens ?? 0),
				})
				: row.tokens !== undefined ? tuiT("widget.agent.tokens", { count: formatAgentMetric(row.tokens) }) : "",
		].filter(Boolean).join(glyphs.separator);
		let line = `${paintedStatus(displayStatus, theme, glyphs)}${glyphs.separator}${theme.fg("syntaxFunction", label)}`
			// Action before task: on a narrow dock the whole row is truncated, and a
			// long task must not squeeze out the error/phase/tool a user needs to
			// respond to (SB-5).
			+ (action ? `${glyphs.separator}${action}` : "")
			+ (task ? `${glyphs.separator}${task}` : "")
			+ (telemetry ? theme.fg("muted", `${glyphs.separator}${telemetry}`) : "")
			// Viewing marker: this agent is the one shown in teammate's viewing view.
			+ (row.viewing ? theme.fg("dim", `${glyphs.separator}${tuiT("sidebar.viewing")}`) : "");
		if (elapsed !== "") line += theme.fg("dim", `${glyphs.separator}${elapsed}`);
		return line;
	})];
}

function jobRows(
	jobs: readonly BashBgJob[],
	compact: boolean,
	theme: Theme,
	glyphs: IconGlyphs,
	now: number,
	hideLiveDuration: boolean,
): string[] {
	if (jobs.length === 0) return [];
	const summary = compactCounts(jobs, glyphs.separator);
	const visible = compact ? jobs.slice(0, 1) : jobs;
	return [theme.fg("muted", summary), ...visible.map((job) => {
		const command = clean(job.command) || clean(job.id);
		const live = job.status === "running" || job.status === "stopping";
		const elapsed = hideLiveDuration && live ? "" : formatDuration((job.finishedAt ?? now) - job.startedAt);
		const exit = job.exitCode === null ? "" : `${glyphs.separator}${tuiT("sidebar.exit", { code: job.exitCode })}`;
		let line = `${paintedStatus(job.status, theme, glyphs)}${glyphs.separator}${command}`;
		if (elapsed !== "" || exit !== "") line += theme.fg("dim", `${glyphs.separator}${elapsed}${exit}`);
		return line;
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
	const iteration = `${paintedStatus(swarm.status, theme, glyphs)}${glyphs.separator}${tuiT("sidebar.iterationTotal", {
		current: finiteCount(swarm.iteration),
		total: finiteCount(swarm.maxIterations),
	})}`;
	const workers = tuiT("common.workers", { count: swarm.workers.length })
		+ (swarm.workers.length > 0 ? `${glyphs.separator}${compactCounts(swarm.workers, glyphs.separator)}` : "");
	if (compact) return [objective, iteration];
	const rows = [theme.bold(objective), iteration, theme.fg("muted", workers)];
	if (swarm.best) {
		const summary = clean(swarm.best.summary);
		rows.push(`${theme.fg("success", `${glyphs.check} ${tuiT("sidebar.best", { score: swarm.best.score })}`)}`
			+ (summary ? `${glyphs.separator}${summary}` : ""));
	}
	return rows;
}

function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "");
}

function sectionTitle(title: SidebarSectionTitle, theme: Theme, width: number): string {
	return fit(theme.bold(theme.fg("syntaxFunction", tuiT(`sidebar.section.${title}`))), width);
}

/**
 * Convert flat sections into priority-annotated groups.
 * Each section header is required; content rows get ascending dropRank
 * so later/less-important rows are dropped first under height pressure.
 */
function sectionsToGroups(sections: readonly SidebarSection[]): SidebarGroup[] {
	const groups: SidebarGroup[] = [];
	// Base priority per section (higher = more important, dropped later).
	const sectionBase: Record<SidebarSectionTitle, number> = {
		Workflow: 60,
		Goal: 50,
		Tasks: 45,
		Agents: 40,
		Jobs: 35,
		Swarm: 30,
	};
	for (const section of sections) {
		if (section.rows.length === 0) continue;
		const base = sectionBase[section.title];
		for (let i = 0; i < section.rows.length; i++) {
			const row = section.rows[i];
			if (row === undefined) continue;
			// Two-tier priority: section summaries (row 0) use the section's base
			// rank (>= 30), ensuring breadth-first composition — all sections show
			// their summary before any section gains detail rows.  Detail rows
			// (i > 0) always rank below the lowest section summary so they are
			// dropped first under height pressure.
			const dropRank = i === 0 ? base : 20 - i;
			groups.push({
				name: `${section.title}:${i}`,
				section: section.title,
				rows: [row],
				required: false,
				dropRank,
			});
		}
	}
	return groups;
}

/** Cost = content rows + one header line per distinct surviving section. */
function sectionAwareCost(groups: readonly PriorityGroup[]): number {
	const sidebarGroups = groups as readonly SidebarGroup[];
	let lines = 0;
	let lastSection: SidebarSectionTitle | undefined;
	for (const group of sidebarGroups) {
		if (group.section !== lastSection) {
			lines += 1; // section header
			lastSection = group.section;
		}
		lines += group.rows.length;
	}
	return lines;
}

/** Render surviving groups with section headers inserted on section boundaries. */
/**
 * Browse-mode renderer: skips the first `scrollStart` content rows and renders
 * the following window (section headers included). One row is reserved for a
 * "▼ N more" hint when content remains below; an "▲" hint marks content above.
 */
function renderScrolled(
	groups: readonly SidebarGroup[],
	scrollStart: number,
	theme: Theme,
	glyphs: IconGlyphs,
	contentWidth: number,
	height: number,
	totalBudget: number,
	focusedRowId?: string,
): string[] {
	const totalContentRows = groups.reduce((sum, g) => sum + g.rows.length, 0);
	const above = Math.min(scrollStart, totalContentRows);
	const hintRows = (above > 0 ? 1 : 0) + (scrollStart + 1 <= totalContentRows ? 1 : 0);
	const budget = Math.max(0, height - hintRows);
	const output: string[] = [];
	let contentIndex = 0;
	for (const group of groups) {
		if (output.length >= budget) break;
		let drewTitle = false;
		for (const row of group.rows) {
			if (output.length >= budget) break;
			const index = contentIndex;
			contentIndex += 1;
			if (index < scrollStart) continue;
			if (!drewTitle) {
				if (output.length >= budget) break;
				output.push(sectionTitle(group.section, theme, contentWidth));
				drewTitle = true;
			}
			output.push(group.name === focusedRowId ? highlightRow(row, theme, contentWidth) : fit(row, contentWidth));
		}
	}
	if (above > 0) output.push(fit(theme.fg("dim", `${glyphs.ellipsis} ${tuiT("common.above", { count: above })}`), contentWidth));
	const below = totalContentRows - contentIndex;
	if (below > 0 && output.length < height) {
		output.push(fit(theme.fg("dim", `${glyphs.ellipsis} ${tuiT("common.more", { count: below })}`), contentWidth));
	}
	return output;
}

function renderGroups(
	groups: readonly SidebarGroup[],
	theme: Theme,
	glyphs: IconGlyphs,
	contentWidth: number,
	height: number,
	totalBudget: number = groups.reduce((sum, g) => sum + 1 + g.rows.length, 0),
	focusedRowId?: string,
): string[] {
	const output: string[] = [];
	let lastSection: SidebarSectionTitle | undefined;
	// Reserve one row for the overflow hint whenever content cannot fit: a full
	// dock must still say how much is hidden (SB-2).
	const hasOverflow = totalBudget > height;
	const budget = hasOverflow ? Math.max(0, height - 1) : height;
	for (const group of groups) {
		if (output.length >= budget) break;
		if (group.section !== lastSection) {
			output.push(sectionTitle(group.section, theme, contentWidth));
			lastSection = group.section;
		}
		for (const row of group.rows) {
			if (output.length >= budget) break;
			output.push(group.name === focusedRowId ? highlightRow(row, theme, contentWidth) : fit(row, contentWidth));
		}
	}
	if (hasOverflow && totalBudget > output.length) {
		const hidden = totalBudget - output.length;
		output.push(fit(theme.fg("dim", `${glyphs.ellipsis} ${tuiT("common.more", { count: hidden })}`), contentWidth));
	}
	return output;
}

function layoutSections(
	sections: readonly SidebarSection[],
	height: number,
	theme: Theme,
	glyphs: IconGlyphs,
	contentWidth: number,
	scrollStart = 0,
	focusedRowId?: string,
): string[] {
	const groups = sectionsToGroups(sections);
	// Pre-composition cost (one section-title row per group plus its rows) is the
	// truthful "what should have been shown" baseline for the hidden counter.
	const totalBudget = groups.reduce((sum, g) => sum + 1 + g.rows.length, 0);
	if (scrollStart > 0) {
		// Browse mode (sidebar keyboard focus): render a window starting at
		// scrollStart content rows so rows the composer would drop are still
		// reachable (SB-1). Section headers re-appear at the window top.
		return renderScrolled(groups, scrollStart, theme, glyphs, contentWidth, height, totalBudget, focusedRowId);
	}
	const composed = composeByPriority(groups, height, sectionAwareCost) as SidebarGroup[];
	return renderGroups(composed, theme, glyphs, contentWidth, height, totalBudget, focusedRowId);
}

function dockRows(rows: readonly string[], width: number, height: number, theme: Theme, resizing: boolean, glyphs: IconGlyphs): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const divider = theme.fg(resizing ? "warning" : "borderMuted", glyphs.box.vertical);
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
	const sections = buildSections(input);
	const content = layoutSections(
		sections,
		height,
		theme,
		glyphs,
		Math.max(0, width - 2),
		Number.isFinite(input.scrollStart) && (input.scrollStart ?? 0) > 0 ? Math.trunc(input.scrollStart ?? 0) : 0,
		input.focusedRowId,
	);
	return dockRows(content, width, height, theme, input.resizing === true, glyphs);
}

export function renderSidebarError(
	error: unknown,
	width: number,
	height: number,
	theme: Theme,
	resizing = false,
	iconMode: IconMode = "ascii",
): string[] {
	const message = clean(error instanceof Error ? error.message : String(error)) || tuiT("sidebar.renderFailed");
	const rows = [theme.bold(theme.fg("error", tuiT("sidebar.title"))), theme.fg("error", message)];
	return dockRows(rows, width, height, theme, resizing, resolveGlyphs(iconMode));
}
