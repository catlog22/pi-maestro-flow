import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { effectiveAgentStatus, isExpertLeader } from "./agents-store.ts";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { resolveGlyphs, type IconGlyphs } from "./icons.ts";
import type { MaestroUiStateSnapshotV1 } from "./public/v1/events.ts";
import { formatAgentMetric, formatDuration } from "./render.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";

/**
 * Zen stack projection: the borderless MISSION / WORK / ACTORS rows rendered
 * into the aboveEditor widget stack.
 *
 * Design contract (pi-cockpit-zen.html):
 * - Everything is a line: `glyph(2) + subject + who + detail + telemetry + time`.
 * - Silent presence: a section with no content contributes zero rows.
 * - Height budget: each section caps its detail rows; overflow folds into a
 *   dim `… n more` row, never pushing the editor around (viewport discipline).
 * - staticMode freezes live durations so no per-second churn reaches the TUI.
 * - Browse mode (Alt+L): selectable rows carry stable ids; the selected row is
 *   marked, Enter expands it in place (L2) inside a fixed detail budget.
 *
 * Pure projection: no store reads, no I/O, no Date.now() — `now` is an input.
 */
export interface ZenBrowseState {
	selectedId?: string;
	expandedId?: string;
}

export interface ZenRenderInput {
	maestro: MaestroUiStateSnapshotV1 | undefined;
	todos: readonly TodoItem[];
	agents: readonly AgentRow[];
	jobs: readonly BashBgJob[];
	config: Pick<CockpitConfig, "icons" | "staticMode" | "todoExpanded">;
	width: number;
	theme: Theme;
	now: number;
	/** Hard cap on total rows; the tail folds into a `… n more` marker. */
	maxRows?: number;
	/** Present while the stack has keyboard focus (Alt+L). */
	browse?: ZenBrowseState;
}

/** Collapsed WORK shows at most this many task rows (in_progress > pending > blocked). */
const COLLAPSED_TASK_ROWS = 3;
/** ACTORS shows at most this many participant rows before folding. */
const MAX_ACTOR_ROWS = 4;
/** Expanded WORK still caps its rows so Alt+T cannot push the editor off-screen. */
const EXPANDED_TASK_ROWS = 15;
/** L2 in-place expansion budget: fixed window so Enter cannot grow unbounded. */
const EXPANSION_ROWS = 6;

/** A stack row; `id` marks it browsable, `expansion` supplies its L2 lines. */
interface ZenRow {
	text: string;
	id?: string;
	expansion?: () => string[];
}

function clean(value: string | undefined): string {
	return value === undefined ? "" : sanitizeExtensionStatusText(value);
}

function finite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

interface GlyphVisual {
	glyph: string;
	color: ThemeColor;
}

/** Shared status-string → glyph mapping (agents, jobs, workflow, swarm). */
function statusVisual(status: string, glyphs: IconGlyphs): GlyphVisual {
	const normalized = clean(status).toLowerCase();
	if (/fail|error|blocked/.test(normalized)) return { glyph: glyphs.cross, color: "error" };
	if (/stalled/.test(normalized)) return { glyph: "~", color: "error" };
	if (/terminate|cancel|kill/.test(normalized)) return { glyph: glyphs.cross, color: "warning" };
	if (/retry/.test(normalized)) return { glyph: glyphs.dotRunning, color: "warning" };
	if (/complete|completed|done|success|passed|ready/.test(normalized)) {
		return { glyph: glyphs.check, color: "success" };
	}
	if (/running|working|active|progress|stopping|open/.test(normalized)) {
		return { glyph: glyphs.dotRunning, color: "accent" };
	}
	if (/pause/.test(normalized)) return { glyph: "‖", color: "warning" };
	if (/sleep|waiting|idle/.test(normalized)) return { glyph: glyphs.dotIdle, color: "warning" };
	return { glyph: glyphs.pending, color: "dim" };
}

function glyphCell(theme: Theme, visual: GlyphVisual): string {
	return theme.fg(visual.color, visual.glyph);
}

/** `glyph subject — detail · telemetry` with dim tail segments. */
function zenLine(
	theme: Theme,
	glyphs: IconGlyphs,
	visual: GlyphVisual,
	subject: string,
	parts: { who?: string; detail?: string; telemetry?: string; time?: string },
): string {
	let line = `${glyphCell(theme, visual)} ${subject}`;
	if (parts.who) line += ` ${theme.fg("accent", parts.who)}`;
	if (parts.detail) line += theme.fg("muted", `${glyphs.separator}${parts.detail}`);
	if (parts.telemetry) line += theme.fg("dim", `${glyphs.separator}${parts.telemetry}`);
	if (parts.time) line += theme.fg("dim", `${glyphs.separator}${parts.time}`);
	return line;
}

/** Live durations are frozen under staticMode (viewport discipline: no per-second churn). */
function elapsed(
	startedAt: number,
	finishedAt: number | undefined,
	now: number,
	hideLive: boolean,
): string {
	const live = finishedAt === undefined;
	if (live && hideLive) return "";
	return formatDuration((finishedAt ?? now) - startedAt);
}

/** One dim, indented L2 detail line: `    label  value`. */
function detailLine(theme: Theme, label: string, value: string): string {
	return theme.fg("dim", `    ${label}  `) + theme.fg("muted", value);
}

function detailLines(theme: Theme, pairs: Array<[string, string]>): string[] {
	return pairs
		.filter(([, value]) => value !== "")
		.slice(0, EXPANSION_ROWS)
		.map(([label, value]) => detailLine(theme, label, value));
}

// ── MISSION ──────────────────────────────────────────────────────────────

function missionRows(input: ZenRenderInput, glyphs: IconGlyphs): ZenRow[] {
	const { maestro, theme } = input;
	const workflow = maestro?.workflow;
	const goal = maestro === undefined || maestro.goals.length === 0
		? undefined
		: maestro.goals.find((candidate) => candidate.id === maestro.currentGoalId)
			?? maestro.goals.find((candidate) => /running|active|progress|pause/i.test(candidate.status))
			?? maestro.goals[0];
	if (!workflow && !goal) return [];

	const rows: ZenRow[] = [];
	const objective = workflow
		? clean(workflow.session.label) || clean(workflow.session.id)
		: clean(goal?.objective) || clean(goal?.id);
	const status = workflow ? workflow.session.status : goal?.status ?? "";
	rows.push({
		id: "mission",
		text: zenLine(theme, glyphs, statusVisual(status, glyphs), theme.bold(objective), {
			detail: tuiStatus(clean(status) || "unknown"),
		}),
		expansion: () => detailLines(theme, [
			[tuiT("zen.detail.session"), workflow ? `${clean(workflow.session.id)}` : clean(goal?.id ?? "")],
			[tuiT("zen.detail.status"), tuiStatus(clean(status) || "unknown")],
			[tuiT("zen.detail.gates"), workflow
				? tuiT("sidebar.gates", { passed: finite(workflow.gates.passed), total: finite(workflow.gates.total) })
				: ""],
			[tuiT("zen.detail.tokens"), goal
				? (goal.tokenBudget === undefined
					? formatAgentMetric(finite(goal.tokensUsed))
					: `${formatAgentMetric(finite(goal.tokensUsed))}/${formatAgentMetric(finite(goal.tokenBudget))}`)
				: ""],
			[tuiT("zen.detail.time"), goal ? formatDuration(finite(goal.timeUsedSeconds) * 1_000) : ""],
			[tuiT("sidebar.next"), workflow?.next ? clean(workflow.next) : ""],
		]),
	});

	const meta: string[] = [];
	if (workflow) {
		const gates = workflow.gates;
		const failed = finite(gates.failed);
		const gateText = tuiT("sidebar.gates", { passed: finite(gates.passed), total: finite(gates.total) });
		meta.push(failed > 0
			? theme.fg("error", `${gateText}${glyphs.separator}${tuiT("common.failed", { count: failed })}`)
			: gateText);
	}
	if (goal) {
		meta.push(goal.tokenBudget === undefined
			? tuiT("sidebar.tokens", { count: formatAgentMetric(finite(goal.tokensUsed)) })
			: tuiT("sidebar.tokensBudget", {
				used: formatAgentMetric(finite(goal.tokensUsed)),
				budget: formatAgentMetric(finite(goal.tokenBudget)),
			}));
		meta.push(tuiT("sidebar.iteration", { current: finite(goal.iteration) }));
	}
	if (workflow?.next) meta.push(`${tuiT("sidebar.next")} ${clean(workflow.next)}`);
	if (meta.length > 0) rows.push({ text: theme.fg("muted", `  ${meta.join(glyphs.separator)}`) });

	// The gold pause line: the one place the accent color asks for a human.
	if (goal?.pauseReason) {
		rows.push({ text: `${theme.fg("warning", "‖")} ${theme.fg("warning", clean(goal.pauseReason))}` });
	}
	return rows;
}

// ── WORK ─────────────────────────────────────────────────────────────────

// in_progress > pending > blocked > completed: blocked waits on an external
// dependency, so it must not crowd actionable pending rows out of the stack
// when a long plan accumulates many blocked items.
const TODO_RANK: Record<TodoItem["status"], number> = {
	in_progress: 0,
	pending: 1,
	blocked: 2,
	completed: 3,
};

function todoVisual(status: TodoItem["status"], glyphs: IconGlyphs): GlyphVisual {
	switch (status) {
		case "in_progress": return { glyph: glyphs.dotRunning, color: "accent" };
		case "completed": return { glyph: glyphs.check, color: "success" };
		case "blocked": return { glyph: glyphs.blocked, color: "error" };
		default: return { glyph: glyphs.pending, color: "dim" };
	}
}

function taskRow(item: TodoItem, theme: Theme, glyphs: IconGlyphs): ZenRow {
	const visual = todoVisual(item.status, glyphs);
	const subject = item.status === "completed"
		? theme.fg("dim", theme.strikethrough(clean(item.subject)))
		: item.status === "in_progress"
			? theme.bold(clean(item.subject))
			: clean(item.subject);
	const who = item.assignee ? `@${clean(item.assignee.label)}` : "";
	const detail = item.status === "blocked" && item.blockedBy.length > 0
		? tuiT("zen.blockedBy", { ids: item.blockedBy.join(", ") })
		: "";
	return {
		id: `task:${item.id}`,
		text: zenLine(theme, glyphs, visual, subject, { ...(who ? { who } : {}), ...(detail ? { detail } : {}) }),
		expansion: () => detailLines(theme, [
			[tuiT("zen.detail.status"), tuiStatus(item.status)],
			[tuiT("zen.detail.assignee"), item.assignee ? `@${clean(item.assignee.label)}` : ""],
			[tuiT("zen.detail.createdBy"), item.createdBy ? `@${clean(item.createdBy.label)}` : ""],
			[tuiT("zen.detail.blockedBy"), item.blockedBy.join(", ")],
			[tuiT("zen.detail.skills"), item.skills.map((skill) => clean(skill.name)).join(", ")],
		]),
	};
}

function workRows(input: ZenRenderInput, glyphs: IconGlyphs): ZenRow[] {
	const { maestro, todos, theme } = input;
	const workflow = maestro?.workflow;
	if (!workflow && todos.length === 0) return [];

	const rows: ZenRow[] = [];
	if (workflow) {
		const chain = workflow.chain;
		const chainText = `${tuiT("zen.chain")} ${finite(chain.completed)}/${finite(chain.total)}`
			+ (chain.running > 0 ? `${glyphs.separator}${tuiT("common.running", { count: finite(chain.running) })}` : "")
			+ (chain.pending > 0 ? `${glyphs.separator}${tuiT("common.pending", { count: finite(chain.pending) })}` : "");
		const expansion = (): string[] => detailLines(theme, [
			[tuiT("zen.detail.run"), workflow.run ? clean(workflow.run.id) : ""],
			[tuiT("zen.detail.status"), workflow.run ? tuiStatus(clean(workflow.run.status) || "unknown") : ""],
			[tuiT("zen.detail.chain"), `${finite(chain.completed)}/${finite(chain.total)}`
				+ (chain.running > 0 ? `${glyphs.separator}${tuiT("common.running", { count: finite(chain.running) })}` : "")
				+ (chain.pending > 0 ? `${glyphs.separator}${tuiT("common.pending", { count: finite(chain.pending) })}` : "")],
			[tuiT("sidebar.next"), workflow.next ? clean(workflow.next) : ""],
		]);
		if (workflow.run) {
			rows.push({
				id: "run",
				text: zenLine(theme, glyphs, statusVisual(workflow.run.status, glyphs), theme.bold(clean(workflow.run.command)), {
					detail: `${tuiStatus(clean(workflow.run.status) || "unknown")}${glyphs.separator}${chainText}`,
				}),
				expansion,
			});
		} else {
			rows.push({ id: "run", text: theme.fg("muted", `${theme.fg("dim", glyphs.pending)} ${chainText}`), expansion });
		}
	}

	if (todos.length > 0) {
		const ordered = [...todos].sort((a, b) =>
			TODO_RANK[a.status] - TODO_RANK[b.status] || a.id.localeCompare(b.id));
		const active = ordered.filter((item) => item.status !== "completed");
		const done = ordered.filter((item) => item.status === "completed");
		const expanded = input.config.todoExpanded;
		const budget = expanded ? EXPANDED_TASK_ROWS : COLLAPSED_TASK_ROWS;
		const visible = expanded ? ordered.slice(0, budget) : active.slice(0, budget);
		rows.push(...visible.map((item) => taskRow(item, theme, glyphs)));

		const hiddenActive = expanded ? Math.max(0, ordered.length - visible.length) : active.length - visible.length;
		const foldedDone = expanded ? 0 : done.length;
		const folded: string[] = [];
		if (hiddenActive > 0) folded.push(`${glyphs.ellipsis} ${tuiT("common.more", { count: hiddenActive })}`);
		if (foldedDone > 0) folded.push(`${glyphs.check} ${tuiT("common.done", { count: foldedDone })}`);
		if (folded.length > 0) rows.push({ text: theme.fg("dim", `  ${folded.join(glyphs.separator)}`) });
	}
	return rows;
}

// ── ACTORS ───────────────────────────────────────────────────────────────

interface ActorEntry {
	/** Problem rows float first, running second, the rest last. */
	severity: number;
	lastActivityAt: number;
	row: ZenRow;
}

function agentSeverity(status: string): number {
	if (/fail|stalled|error/.test(status)) return 0;
	if (/retry/.test(status)) return 1;
	if (/running|stopping/.test(status)) return 2;
	return 3;
}

function agentEntry(row: AgentRow, input: ZenRenderInput, glyphs: IconGlyphs): ActorEntry {
	const { theme, now } = input;
	const status = effectiveAgentStatus(row, now);
	const label = clean(row.name) || clean(row.role) || clean(row.agent) || "agent";
	const expert = isExpertLeader(row) ? `${theme.fg("accent", "☆")} ` : "";
	// Problem detail wins over routine detail: an error the user must act on
	// may not be squeezed out by a long task label.
	const detail = row.error
		? clean(row.error)
		: clean(row.phase) || (row.activeTool ? clean(row.activeTool) : "") || clean(row.task) || clean(row.tail);
	const telemetry = row.inputTokens !== undefined || row.outputTokens !== undefined
		? `${glyphs.tokensIn}${formatAgentMetric(finite(row.inputTokens))}/${glyphs.tokensOut}${formatAgentMetric(finite(row.outputTokens))}`
		: row.tokens !== undefined ? tuiT("widget.agent.tokens", { count: formatAgentMetric(finite(row.tokens)) }) : "";
	const live = status === "running" || status === "retrying";
	const time = elapsed(row.startedAt, live ? undefined : row.finishedAt ?? row.lastActivityAt, input.now, input.config.staticMode && live);
	return {
		severity: agentSeverity(status),
		lastActivityAt: row.lastActivityAt,
		row: {
			id: `agent:${row.correlationId}`,
			text: zenLine(theme, glyphs, statusVisual(status, glyphs), `${expert}${theme.fg("dim", "agent")} ${theme.bold(label)}`, {
				...(detail ? { detail } : {}),
				...(telemetry ? { telemetry } : {}),
				...(time ? { time } : {}),
			}),
			expansion: () => detailLines(theme, [
				[tuiT("zen.detail.task"), clean(row.task)],
				[tuiT("zen.detail.status"), `${tuiStatus(status)}${row.phase ? `${glyphs.separator}${clean(row.phase)}` : ""}`],
				[tuiT("zen.detail.model"), clean(row.resolvedModel) || clean(row.requestedModel)],
				[tuiT("zen.detail.tokens"), row.inputTokens !== undefined || row.outputTokens !== undefined
					? tuiT("widget.agent.inputOutput", {
						input: formatAgentMetric(finite(row.inputTokens)),
						output: formatAgentMetric(finite(row.outputTokens)),
						separator: glyphs.separator,
					})
					: ""],
				[tuiT("zen.detail.error"), clean(row.error)],
				[tuiT("zen.detail.tail"), clean(row.tail)],
			]),
		},
	};
}

function jobEntry(job: BashBgJob, input: ZenRenderInput, glyphs: IconGlyphs): ActorEntry {
	const { theme } = input;
	const live = job.status === "running" || job.status === "stopping";
	const time = elapsed(job.startedAt, job.finishedAt, input.now, input.config.staticMode && live);
	const exit = job.exitCode === null ? "" : tuiT("sidebar.exit", { code: job.exitCode });
	return {
		severity: job.status === "failed" ? 0 : live ? 2 : 3,
		lastActivityAt: job.updatedAt,
		row: {
			id: `job:${job.id}`,
			text: zenLine(theme, glyphs, statusVisual(job.status, glyphs), `${theme.fg("dim", "job")} ${theme.bold(clean(job.command) || clean(job.id))}`, {
				...(exit ? { detail: exit } : {}),
				...(time ? { time } : {}),
			}),
			expansion: () => {
				const tail = clean(job.outputTail).split("\n").map((line) => line.trim()).filter(Boolean);
				return detailLines(theme, [
					[tuiT("zen.detail.status"), `${tuiStatus(job.status)}${exit ? `${glyphs.separator}${exit}` : ""}`],
					[tuiT("zen.detail.cwd"), clean(job.cwd)],
					[tuiT("zen.detail.pid"), String(job.pid)],
					[tuiT("zen.detail.log"), clean(job.logPath)],
					[tuiT("zen.detail.tail"), tail.slice(-2).join(" ⏎ ")],
				]);
			},
		},
	};
}

function actorsRows(input: ZenRenderInput, glyphs: IconGlyphs): ZenRow[] {
	const { agents, jobs, maestro, theme, now } = input;
	const entries: ActorEntry[] = [
		...agents.map((row) => agentEntry(row, input, glyphs)),
		...jobs.map((job) => jobEntry(job, input, glyphs)),
	];
	const rows: ZenRow[] = [];
	if (entries.length > 0) {
		entries.sort((a, b) => a.severity - b.severity || b.lastActivityAt - a.lastActivityAt);
		const statuses = agents.map((row) => effectiveAgentStatus(row, now) as string).concat(jobs.map((job) => job.status));
		const failed = statuses.filter((status) => /fail|stalled/.test(status)).length;
		const running = statuses.filter((status) => /running|retry|stopping/.test(status)).length;
		if (entries.length > MAX_ACTOR_ROWS) {
			const summary = [
				tuiT("common.total", { count: entries.length }),
				failed > 0 ? theme.fg("error", tuiT("common.failed", { count: failed })) : "",
				running > 0 ? tuiT("common.running", { count: running }) : "",
			].filter(Boolean).join(glyphs.separator);
			rows.push({ text: theme.fg("muted", `  ${summary}`) });
		}
		rows.push(...entries.slice(0, MAX_ACTOR_ROWS).map((entry) => entry.row));
		const hidden = entries.length - Math.min(entries.length, MAX_ACTOR_ROWS);
		if (hidden > 0) rows.push({ text: theme.fg("dim", `  ${glyphs.ellipsis} ${tuiT("common.more", { count: hidden })}`) });
	}

	const swarm = maestro?.swarm;
	if (swarm) {
		rows.push({
			id: "swarm",
			text: zenLine(theme, glyphs, statusVisual(swarm.status, glyphs), `${theme.fg("dim", "swarm")} ${theme.bold(clean(swarm.objective) || clean(swarm.sessionId))}`, {
				detail: `${tuiT("sidebar.iterationTotal", { current: finite(swarm.iteration), total: finite(swarm.maxIterations) })}`
					+ `${glyphs.separator}${tuiT("common.workers", { count: swarm.workers.length })}`
					+ (swarm.best ? `${glyphs.separator}${tuiT("sidebar.best", { score: swarm.best.score })}` : ""),
			}),
			expansion: () => detailLines(theme, [
				[tuiT("zen.detail.status"), tuiStatus(clean(swarm.status) || "unknown")],
				[tuiT("zen.detail.workers"), swarm.workers.slice(0, 3)
					.map((worker) => `${clean(worker.label) || clean(worker.id)} (${tuiStatus(clean(worker.status) || "unknown")})`)
					.join(", ") + (swarm.workers.length > 3 ? ` ${glyphs.ellipsis}` : "")],
				[tuiT("zen.detail.best"), swarm.best
					? `${swarm.best.score}${swarm.best.summary ? `${glyphs.separator}${clean(swarm.best.summary)}` : ""}`
					: ""],
			]),
		});
	}
	return rows;
}

// ── stack composition ────────────────────────────────────────────────────

function buildRows(input: ZenRenderInput, glyphs: IconGlyphs): ZenRow[] {
	const sections = [
		missionRows(input, glyphs),
		workRows(input, glyphs),
		actorsRows(input, glyphs),
	].filter((rows) => rows.length > 0);
	// Silent presence: sections juxtapose without headers; a single dim rule
	// row would cost height for no information.
	return sections.flat();
}

/** Browsable row ids that remain visible after expansion and height folding. */
export function enumerateZenNavRows(input: ZenRenderInput): string[] {
	if (Math.trunc(input.width) <= 0) return [];
	const glyphs = resolveGlyphs(input.config.icons.mode);
	const built = buildRows(input, glyphs);
	const positions: Array<{ id: string; row: number }> = [];
	let renderedRows = 0;
	for (const row of built) {
		if (row.id !== undefined) positions.push({ id: row.id, row: renderedRows });
		renderedRows += 1;
		if (input.browse?.expandedId === row.id && row.expansion) renderedRows += row.expansion().length;
	}
	const maxRows = input.maxRows !== undefined && Number.isFinite(input.maxRows)
		? Math.max(1, Math.trunc(input.maxRows))
		: undefined;
	const visibleRows = maxRows !== undefined && renderedRows > maxRows ? maxRows - 1 : renderedRows;
	return positions.filter(({ row }) => row < visibleRows).map(({ id }) => id);
}

export function renderZenStack(input: ZenRenderInput): string[] {
	const width = Math.max(0, Math.trunc(input.width));
	if (width <= 0) return [];
	const glyphs = resolveGlyphs(input.config.icons.mode);
	const built = buildRows(input, glyphs);
	if (built.length === 0) return [];

	const browse = input.browse;
	let rows: string[] = [];
	for (const row of built) {
		// Browse mode indents every row by two columns so the selection marker
		// never reflows content when it moves between rows.
		const marker = browse
			? (row.id !== undefined && row.id === browse.selectedId
				? `${input.theme.fg("accent", glyphs.selectMarker)} `
				: "  ")
			: "";
		rows.push(marker + row.text);
		if (browse && row.id !== undefined && row.id === browse.expandedId && row.expansion) {
			rows.push(...row.expansion().map((line) => (browse ? "  " : "") + line));
		}
	}

	const maxRows = input.maxRows !== undefined && Number.isFinite(input.maxRows)
		? Math.max(1, Math.trunc(input.maxRows))
		: undefined;
	if (maxRows !== undefined && rows.length > maxRows) {
		const kept = Math.max(0, maxRows - 1);
		const hidden = rows.length - kept;
		rows = [
			...rows.slice(0, kept),
			input.theme.fg("dim", `  ${glyphs.ellipsis} ${tuiT("common.more", { count: hidden })}`),
		];
	}
	return rows.map((row) => truncateToWidth(row, width, glyphs.ellipsis));
}
