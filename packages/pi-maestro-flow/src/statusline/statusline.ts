/**
 * Maestro Flow statusline — Pi Extension footer API implementation.
 *
 * Line 1: Mode | Model | Context | Auto-compaction | Tool calls | Dir+Git | Tokens
 * Line 2: Context pressure or active compaction (when present)
 * Line 3: Active Swarm iteration and convergence (when present)
 * Line 4: Session and active Workflow Run (when a canonical snapshot is active)
 *
 * Adapted from maestro2/src/hooks/statusline.ts for the Pi Extension ecosystem.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import {
	deriveWorkflowViewModel,
	type WorkflowSnapshotLike,
	type WorkflowViewModel,
	workflowStatusLabel,
} from "../session/view-model.ts";
import { EFFORT_STATUS_KEY, formatEffortStatus } from "../effort-display.ts";
import {
	ansiFg,
	ANSI_BOLD,
	ANSI_RESET,
	ICONS,
	GIT_ICONS,
	COLORS,
	getCtxLevel,
	getCtxColor,
} from "./constants.ts";
import { renderSparkline } from "./usage-chart.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MaestroState {
	activeToolCalls?: Map<string, { action: string; startedAt: number; correlationId: string }>;
	/** @deprecated Kept until the extension state owner switches to activeToolCalls. */
	activeRuns?: Map<string, { action: string; startedAt: number; correlationId: string }>;
}

interface GitInfo {
	branch: string;
	dirty: boolean;
	ahead: number;
	behind: number;
}

interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface MessageWithUsage {
	role?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface RuntimeState {
	model: string;
	git: GitInfo | null;
	contextPercent: number | null;
	tokens: TokenTotals;
}

type PlanModeStatus = "ACT" | "PLAN" | "READY";

// ---------------------------------------------------------------------------
// Usage sparkline config (api-manager.json `statsFooter` section)
// ---------------------------------------------------------------------------

interface StatsFooterConfig {
	enabled: boolean;
	metric: "tokens" | "cost" | "cache";
	points: number;
}

const DEFAULT_STATS_FOOTER: StatsFooterConfig = { enabled: false, metric: "tokens", points: 12 };

async function loadStatsFooterConfig(): Promise<StatsFooterConfig> {
	const path = join(getAgentDir(), "api-manager.json");
	try {
		const raw = await readFile(path, "utf8");
		const root = JSON.parse(raw) as Record<string, unknown>;
		const section = root.statsFooter;
		if (!section || typeof section !== "object") return { ...DEFAULT_STATS_FOOTER };
		const s = section as Record<string, unknown>;
		return {
			enabled: s.enabled === true,
			metric: s.metric === "cost" || s.metric === "cache" ? s.metric : "tokens",
			points: typeof s.points === "number" && s.points >= 4 && s.points <= 64 ? Math.floor(s.points) : 12,
		};
	} catch {
		return { ...DEFAULT_STATS_FOOTER };
	}
}

/**
 * Persist an assistant message's usage to the JSONL store. The provider-layer
 * `usage-history` module is imported lazily so the statusline stays decoupled
 * from provider config code; failures are best-effort.
 */
async function recordAssistantUsage(message: MessageWithUsage, sessionId: string, cwd: string): Promise<void> {
	try {
		const { recordUsage } = await import("../providers/usage-history.ts");
		// MessageWithUsage carries the usage fields; cast to the AssistantMessage
		// shape recordUsage expects (it reads model/provider/timestamp/cost too).
		await recordUsage(message as never, sessionId, cwd);
	} catch {
		// Best-effort: never break the turn.
	}
}

/**
 * Fire-and-forget incremental backfill of usage history from Pi session files.
 * Runs once per session start; the cache makes subsequent runs cheap. Failures
 * are swallowed so the agent turn never blocks on history seeding.
 */
async function backfillSessionsBestEffort(): Promise<void> {
	try {
		const { backfillFromSessions } = await import("../providers/usage-history.ts");
		await backfillFromSessions();
	} catch {
		// Best-effort: history seeding must never break the session.
	}
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000) + "k";
}

function cacheSegment(tokens: TokenTotals): string {
	const cacheTotal = tokens.cacheRead + tokens.cacheWrite;
	if (cacheTotal <= 0) return "";
	const denom = tokens.input + cacheTotal;
	const hitRate = denom > 0 ? Math.round((tokens.cacheRead / denom) * 100) : 0;
	return ` ⚡${hitRate}%`;
}

function buildContextBar(usedPct: number, compact = false): string {
	const size = compact ? 5 : 10;
	const filled = Math.floor((usedPct / 100) * size);
	const bar = "█".repeat(filled) + "░".repeat(size - filled);
	const level = getCtxLevel(usedPct);
	const color = getCtxColor(level);
	const value = `${ICONS.ctx} ${bar} ${usedPct}%`;
	return `${ansiFg(color)}${value}${ANSI_RESET}`;
}

/**
 * Footer sparkline segment for recent per-turn usage. Returns "" when the
 * feature is disabled or there is no data yet. The segment trails the token
 * totals and is dropped before them under the narrow-width degradation rules
 * (review-standards-004): it never displaces Context/input/output/cache groups.
 */
function renderUsageSparklineSegment(
	series: readonly number[],
	config: StatsFooterConfig,
	width: number,
): string {
	if (!config.enabled || series.length < 2 || width < 100) return "";
	const sparkWidth = Math.min(config.points, Math.max(4, Math.floor((width - 80) / 4)));
	if (sparkWidth < 4) return "";
	const color = COLORS.tokens;
	return ` ${renderSparkline(series, { width: sparkWidth, color })}`;
}

function formatGit(git: GitInfo): string {
	const parts: string[] = [];
	if (git.dirty) parts.push(GIT_ICONS.dirty);
	if (git.ahead > 0) parts.push(`${GIT_ICONS.ahead}${git.ahead}`);
	if (git.behind > 0) parts.push(`${GIT_ICONS.behind}${git.behind}`);
	const suffix = parts.length > 0 ? ` ${parts.join("")}` : "";
	return `${ansiFg(COLORS.git)}${ICONS.git} ${git.branch}${suffix}${ANSI_RESET}`;
}

function colored(key: keyof typeof COLORS, text: string): string {
	return `${ansiFg(COLORS[key])}${text}${ANSI_RESET}`;
}

function normalizePlanModeStatus(value: string | undefined): PlanModeStatus {
	const normalized = value?.trim().toUpperCase();
	if (normalized === "PLAN") return "PLAN";
	if (normalized === "READY" || normalized === "PLAN READY") return "READY";
	return "ACT";
}

function normalizeApprovalMode(value: string | undefined, planMode: PlanModeStatus): string {
	const normalized = value?.replace(/^APPROVAL\s+/i, "").trim();
	// YOLO is safety-relevant and inherits into Plan mode; it wins over the plan indicator.
	if (/^(?:YOLO|bypassPermissions)$/i.test(normalized ?? "")) return "YOLO";
	if (planMode === "PLAN" || planMode === "READY") return "plan";
	return normalized && normalized !== "plan" ? normalized : "default";
}

function approvalInitial(mode: string): string {
	return mode === "acceptEdits" ? "E"
		: mode === "dontAsk" ? "N"
			: mode === "YOLO" || mode === "bypassPermissions" ? "Y"
				: mode === "plan" ? "P" : "D";
}

function approvalColor(mode: string): keyof typeof COLORS {
	return mode === "YOLO" ? "danger"
		: mode === "dontAsk" ? "ctxWarn"
			: mode === "acceptEdits" ? "ctxOk" : "phase";
}

function renderApprovalMode(mode: string, text: string): string {
	const emphasis = mode === "YOLO" ? ANSI_BOLD : "";
	return `${ansiFg(COLORS[approvalColor(mode)])}${emphasis}${text}${ANSI_RESET}`;
}

function renderPlanModeStatus(
	value: string | undefined,
	approvalValue: string | undefined,
	width: number,
): string {
	const mode = normalizePlanModeStatus(value);
	const approval = normalizeApprovalMode(approvalValue, mode);
	const modeLabel = width >= 80
		? mode === "ACT" ? "[A] ACT" : mode === "PLAN" ? "[P] PLAN" : "[P] READY"
		: width >= 48 ? mode : mode === "ACT" ? "A" : mode === "PLAN" ? "P" : "R";
	const approvalLabel = approval === "YOLO"
		? approval
		: width >= 80 ? `APPROVAL ${approval}` : width >= 48 ? approval : approvalInitial(approval);
	const separator = width >= 80
		? `${ansiFg(COLORS.separator)} · ${ANSI_RESET}`
		: `${ansiFg(COLORS.separator)}/${ANSI_RESET}`;
	return `${colored("phase", modeLabel)}${separator}${renderApprovalMode(approval, approvalLabel)}`;
}

function renderAutoCompactionMode(value: string | undefined, width: number): string {
	if (!value) return "";
	const normalized = value.trim().toUpperCase();
	if (normalized !== "AUTO ON" && normalized !== "AUTO OFF") return "";
	const disabled = normalized === "AUTO OFF";
	const text = disabled
		? width >= 80 ? "AUTO-COMPACT OFF" : "AUTO OFF"
		: width >= 80 ? "AUTO-COMPACT ON" : width >= 48 ? "AUTO ON" : "AUTO";
	return colored(disabled ? "ctxWarn" : "ctxOk", text);
}

/**
 * Compact self-evolve marker for the cockpit statusline.
 *
 * Reads the `self-evolve` extension status (`EVOL ● s·d·p` / `EVOL off`):
 *   - disabled → muted `EV○`
 *   - enabled, no signals yet → `EV●`
 *   - enabled, with counters → `EV● s·d·p`
 * Returns "" when the extension never set a status (not loaded).
 */
export function renderEvolMarker(value: string | undefined): string {
	if (!value) return "";
	const counts = /^EVOL ● (\d+·\d+·\d+)/.exec(value)?.[1];
	if (counts) return colored("evol", `EV● ${counts}`);
	if (value === "EVOL off") return colored("separator", `EV○`);
	return colored("evol", `EV●`);
}

/**
 * Knowledge-pending marker: surfaces candidates awaiting manual resolve.
 *
 * Reads the `maestro-knowledge-pending` extension status (`N review · M pending`
 * or `M pending`): review_required shows in danger color (needs resolve), plain
 * pending in phase color. Returns "" when nothing is pending.
 */
export function renderKnowledgePendingMarker(value: string | undefined): string {
	if (!value) return "";
	const review = /^(\d+) review/.exec(value)?.[1];
	const pending = /· (\d+) pending$/.exec(value)?.[1] ?? /^(\d+) pending$/.exec(value)?.[1];
	if (review) {
		const total = pending ? `${review}·${pending}` : review;
		return colored("danger", `KNOW ${total}`);
	}
	if (pending) return colored("phase", `KNOW ${pending}`);
	return colored("phase", `KNOW ?`);
}

function renderContextPressure(value: string | undefined, width: number): string {
	if (!value) return "";
	const normalized = value.replace(/^CTX\s+/i, "").trim();
	// Pruned count carries an optional /<amount> suffix (e.g. -3/-4.2k); trailing
	// reasons (prunable:42% cache:88% …) are captured whole and appended where they fit.
	const match = /^(NUDGE|AUTO-PRUNE|CRITICAL|COMPACT)\s+(\d+)\/(\d+)(?:\s+-(\d+)(?:\/(\S+))?)?(?:\s+(.+))?$/i.exec(normalized);
	if (!match) return "";
	const band = match[1].toUpperCase();
	const pruned = match[4] ? ` -${match[4]}${match[5] ? `/${match[5]}` : ""}` : "";
	// Hard-compaction statuses lead their reason tail with the triggering owner
	// (mid-turn/output-limit/plan-handoff). Split it out so the line stays
	// owner-distinguishing even at narrow widths; any other reason tail is left
	// untouched so legacy statuses render exactly as before.
	const tail = match[6]?.trim() ?? "";
	const ownerMatch = /^(mid-turn|output-limit|plan-handoff|native)\b\s*(.*)$/i.exec(tail);
	const ownerLabel = ownerMatch ? ` ${ownerMatch[1].toLowerCase()}` : "";
	const rest = ownerMatch ? ownerMatch[2].trim() : tail;
	const reasons = rest ? ` ${rest}` : "";
	const text = width >= 80
		? `CTX ${band} ${match[2]}/${match[3]}${pruned}${ownerLabel}${reasons}`
		: width >= 48
			? `CTX ${band === "AUTO-PRUNE" ? "PRUNE" : band}${pruned}${ownerLabel}${reasons}`
			: band === "AUTO-PRUNE" ? `CTX PRUNE${pruned}${ownerLabel}` : `CTX ${band}${pruned}${ownerLabel}`;
	const color = band === "CRITICAL" || band === "COMPACT" ? COLORS.ctxCrit : band === "AUTO-PRUNE" ? COLORS.ctxAlert : COLORS.ctxWarn;
	return `${ansiFg(color)}${text}${ANSI_RESET}`;
}

function renderPressureLine(value: string | undefined, width: number): string {
	return truncateToWidth(renderContextPressure(value, width), Math.max(1, width), "…");
}

const SEP = `${ansiFg(COLORS.separator)} · ${ANSI_RESET}`;

function renderFirstFittingLine(candidates: string[][], width: number): string {
	const lines = candidates.map((parts) => parts.filter(Boolean).join(SEP));
	for (const line of lines) {
		if (visibleWidth(line) <= width) return line;
	}
	return truncateToWidth(lines.at(-1) ?? "", width, "…");
}

// ---------------------------------------------------------------------------
// Git reader (async — cached)
// ---------------------------------------------------------------------------

async function refreshGit(pi: ExtensionAPI, cwd: string): Promise<GitInfo | null> {
	try {
		// Single command: branch + dirty + ahead/behind from porcelain header
		const result = await pi.exec(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "--branch", "-uno"],
			{ cwd, timeout: 3000 },
		);
		if (result.code !== 0) return null;

		const lines = result.stdout.split("\n");
		const headerLine = lines[0] ?? "";
		if (!headerLine.startsWith("## ")) return null;

		// Parse "## branch...origin/branch [ahead N, behind M]" or "## branch"
		const header = headerLine.slice(3);
		const dotIdx = header.indexOf("...");
		const bracketIdx = header.indexOf(" [");
		const branch = dotIdx > 0 ? header.slice(0, dotIdx) : (bracketIdx > 0 ? header.slice(0, bracketIdx) : header.trim());
		if (!branch) return null;

		let ahead = 0;
		let behind = 0;
		if (bracketIdx > 0) {
			const bracketContent = header.slice(bracketIdx);
			const aheadMatch = bracketContent.match(/ahead (\d+)/);
			const behindMatch = bracketContent.match(/behind (\d+)/);
			if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
			if (behindMatch) behind = parseInt(behindMatch[1], 10);
		}

		// Any non-header line = dirty
		const dirty = lines.some((l, i) => i > 0 && l.length > 0);

		return { branch, dirty, ahead, behind };
	} catch {
		return null;
	}
}

function gitInfoEqual(left: GitInfo | null, right: GitInfo | null): boolean {
	return left === right || (
		left !== null
		&& right !== null
		&& left.branch === right.branch
		&& left.dirty === right.dirty
		&& left.ahead === right.ahead
		&& left.behind === right.behind
	);
}

// ---------------------------------------------------------------------------
// Renderer — produces line strings
// ---------------------------------------------------------------------------

function shortenModel(id: string): string {
	return id
		.replace(/^claude-/, "")
		.replace(/-\d{8}$/, "");
}

function renderLine1(
	rs: RuntimeState,
	activeToolCalls: number,
	dir: string,
	width: number,
	modeStatus: string | undefined,
	approvalStatus: string | undefined,
	compactionStatus: string | undefined,
	effortStatus: string | undefined,
	evolStatus: string | undefined,
	knowledgeStatus: string | undefined,
	usageSparkline: string,
): string {
	const safeWidth = Math.max(1, width);
	const modeFull = renderPlanModeStatus(modeStatus, approvalStatus, 80);
	const modeCompact = renderPlanModeStatus(modeStatus, approvalStatus, 48);
	const modeNarrow = renderPlanModeStatus(modeStatus, approvalStatus, 1);
	const autoCompactionFull = renderAutoCompactionMode(compactionStatus, 80);
	const autoCompactionCompact = renderAutoCompactionMode(compactionStatus, 48);
	const evolText = renderEvolMarker(evolStatus);
	const knowledgeText = renderKnowledgePendingMarker(knowledgeStatus);
	const autoCompactionNarrow = renderAutoCompactionMode(compactionStatus, 1);
	const effort = formatEffortStatus(effortStatus);
	const modelText = colored("model", `${ICONS.model} ${shortenModel(rs.model)}${effort ? ` · ${effort}` : ""}`);
	const toolCallText = activeToolCalls > 0
		? colored("runs", `${ICONS.runs} ${activeToolCalls} call${activeToolCalls > 1 ? "s" : ""}`)
		: "";
	const dirText = colored("dir", `${ICONS.dir} ${basename(dir)}`);
	const dirGitText = rs.git ? `${dirText}  ${formatGit(rs.git)}` : dirText;
	let tokenText = "";
	if (rs.tokens.input > 0 || rs.tokens.output > 0 || rs.tokens.cacheRead > 0 || rs.tokens.cacheWrite > 0) {
		const value = `↑${formatTokens(rs.tokens.input)} ↓${formatTokens(rs.tokens.output)} ${ICONS.tokens}${formatTokens(rs.tokens.input + rs.tokens.output)}${cacheSegment(rs.tokens)}`;
		tokenText = colored("tokens", value) + usageSparkline;
	}
	let contextFull = "";
	let contextCompact = "";
	if (rs.contextPercent != null) {
		const usedPct = Math.max(0, Math.min(100, Math.round(rs.contextPercent)));
		contextFull = buildContextBar(usedPct);
		contextCompact = buildContextBar(usedPct, true);
	}

	const candidates = safeWidth >= 80
		? [
			[modeFull, modelText, contextFull, autoCompactionFull, evolText, knowledgeText, toolCallText, dirGitText, tokenText],
			[modeCompact, modelText, contextCompact, autoCompactionCompact, evolText, toolCallText, dirGitText, tokenText],
			[modeCompact, modelText, contextCompact, autoCompactionCompact, evolText, toolCallText, dirGitText],
			[modeCompact, modelText, contextCompact, autoCompactionCompact, toolCallText, dirGitText],
			[modeCompact, modelText, contextCompact, autoCompactionCompact, dirText],
			[modeNarrow, autoCompactionNarrow, contextCompact, modelText],
		]
		: safeWidth >= 48
			? [
				[modeCompact, autoCompactionCompact, modelText, contextCompact, evolText, dirGitText],
				[modeCompact, autoCompactionCompact, modelText, contextCompact, dirGitText],
				[modeCompact, autoCompactionCompact, modelText, contextCompact],
				[modeNarrow, autoCompactionNarrow, contextCompact, modelText],
			]
			: [
				[modeNarrow, autoCompactionNarrow, contextCompact, modelText],
				[modeNarrow, autoCompactionNarrow, contextCompact],
				[modeNarrow, contextCompact],
			];
	return renderFirstFittingLine(candidates, safeWidth);
}

export function renderWorkflowStatusline(view: WorkflowViewModel, width: number): string {
	const safeWidth = Math.max(1, width);
	const run = view.activeRun;
	const runText = run
		? `${run.sequence != null ? String(run.sequence).padStart(3, "0") : run.id}/${run.command}`
		: "no active run";
	const status = run ? workflowStatusLabel(run.status, run.attempt) : workflowStatusLabel(view.status);
	const chain = `✓${view.chain.completed} ▶${view.chain.running} ○${view.chain.pending}`;
	const session = `⚑ ${view.sessionLabel}`;
	const action = view.recoveryAction ?? view.nextAction;
	const recovery = action ? `» ${action}` : "";

	// Session label leads every layout so concurrent sessions stay identifiable
	// even when the line is truncated to a narrow terminal.
	if (safeWidth < 20) {
		return truncateToWidth(session, safeWidth, "…");
	}

	let parts: string[];
	if (safeWidth < 80) {
		parts = [session, recovery, status, runText, chain];
	} else {
		const gates = view.gates ? `gate ${view.gates.passed}/${view.gates.total}` : "";
		const budget = view.goal?.tokensUsed != null && view.goal.tokenBudget != null
			? `goal ${formatTokens(view.goal.tokensUsed)}/${formatTokens(view.goal.tokenBudget)}`
			: "";
		parts = [session, recovery, status, runText, chain, gates, budget];
	}
	return truncateToWidth(parts.filter(Boolean).join(SEP), safeWidth, "…");
}

export function renderSwarmStatusline(value: string | undefined, width: number): string {
	if (!value?.trim()) return "";
	return truncateToWidth(colored("runs", value.trim()), Math.max(1, width), "…");
}

// ---------------------------------------------------------------------------
// Install — registers footer + event handlers
// ---------------------------------------------------------------------------

const GIT_REFRESH_INTERVAL = 30_000;
const GIT_DEBOUNCE_MS = 500;
const WIDTH_POLL_INTERVAL = 500;
const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";

function widthLayoutBand(width: number): number {
	return width < 20 ? 0 : width < 48 ? 1 : width < 80 ? 2 : 3;
}
export function installStatusline(
	pi: ExtensionAPI,
	getMaestroState: () => MaestroState,
	getWorkflowSnapshot: () => WorkflowSnapshotLike | null | undefined = () => null,
): void {
	const rs: RuntimeState = {
		model: "Claude",
		git: null,
		contextPercent: null,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	// In-memory sparkline buffer (current session only). Avoids reading the
	// JSONL store on every footer render; the stats panel reads the store
	// directly when opened.
	let usageSeries: number[] = [];
	let statsFooterConfig: StatsFooterConfig = { ...DEFAULT_STATS_FOOTER };
	let currentSessionId = "";
	void loadStatsFooterConfig().then((cfg) => {
		statsFooterConfig = cfg;
	});

	let cwd = "";
	let invalidateFn: (() => void) | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let sessionGeneration = 0;
	let footerGeneration = 0;
	let footerCtx: ExtensionContext | undefined;
	let cockpitOwnsFooter = false;

	function invalidate(): void {
		invalidateFn?.();
	}

	function addTokenUsage(message: MessageWithUsage | undefined): void {
		if (message?.role !== "assistant") return;
		rs.tokens.input += message.usage?.input ?? 0;
		rs.tokens.output += message.usage?.output ?? 0;
		rs.tokens.cacheRead += message.usage?.cacheRead ?? 0;
		rs.tokens.cacheWrite += message.usage?.cacheWrite ?? 0;
	}

	function rebuildTokenUsage(ctx: ExtensionContext): void {
		const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		try {
			for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
				if (entry.type !== "message") continue;
				const message = entry.message as MessageWithUsage | undefined;
				if (message?.role !== "assistant") continue;
				totals.input += message.usage?.input ?? 0;
				totals.output += message.usage?.output ?? 0;
				totals.cacheRead += message.usage?.cacheRead ?? 0;
				totals.cacheWrite += message.usage?.cacheWrite ?? 0;
			}
		} catch {
			// Token tracking is best-effort.
		}
		rs.tokens = totals;
	}

	function updateGit(git: GitInfo | null): void {
		if (gitInfoEqual(rs.git, git)) return;
		rs.git = git;
		invalidate();
	}

	function scheduleGitRefresh(generation: number): void {
		if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
		const session = sessionGeneration;
		const refreshCwd = cwd;
		gitDebounceTimer = setTimeout(async () => {
			if (disposed) return;
			const git = await refreshGit(pi, refreshCwd);
			if (
				disposed
				|| generation !== footerGeneration
				|| session !== sessionGeneration
				|| refreshCwd !== cwd
			) return;
			updateGit(git);
		}, GIT_DEBOUNCE_MS);
	}

	// --- Footer registration ---
	function installFooter(ctx: ExtensionContext): void {
		footerCtx = ctx;
		if (!ctx.hasUI || cockpitOwnsFooter) return;
		const generation = ++footerGeneration;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			disposed = false;
			// Connect invalidate → requestRender
			invalidateFn = () => tui.requestRender();
			let observedWidth = tui.terminal.columns;
			let pendingWidth: number | null = null;
			let stableWidthSamples = 0;
			const widthTimer = setInterval(() => {
				if (disposed || generation !== footerGeneration) {
					clearInterval(widthTimer);
					return;
				}
				const nextWidth = tui.terminal.columns;
				if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
				if (nextWidth === observedWidth) {
					pendingWidth = null;
					stableWidthSamples = 0;
					return;
				}
				if (nextWidth !== pendingWidth) {
					pendingWidth = nextWidth;
					stableWidthSamples = 1;
					return;
				}
				stableWidthSamples += 1;
				if (stableWidthSamples < 2) return;

				const previousWidth = observedWidth;
				observedWidth = nextWidth;
				pendingWidth = null;
				stableWidthSamples = 0;
				// Browser-hosted terminals can change columns without a stdout resize event.
				tui.invalidate();
				tui.requestRender(widthLayoutBand(previousWidth) !== widthLayoutBand(nextWidth));
			}, WIDTH_POLL_INTERVAL);

			// Subscribe to branch changes for git refresh
			const unsubBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh(generation);
			});

			return {
				dispose() {
					clearInterval(widthTimer);
					unsubBranch();
					if (generation !== footerGeneration) return;
					disposed = true;
					invalidateFn = null;
					if (gitTimer) clearInterval(gitTimer);
					if (gitDebounceTimer) clearTimeout(gitDebounceTimer);
				},

				invalidate() {
					// Called by Pi when render cache is cleared
				},

				render(width: number): string[] {
					if (Number.isFinite(width) && width > 0) {
						observedWidth = width;
						pendingWidth = null;
						stableWidthSamples = 0;
					}
					const state = getMaestroState();
					const activeToolCalls = (state.activeToolCalls ?? state.activeRuns)?.size ?? 0;
					const lines: string[] = [];

					const modeStatus = footerData.getExtensionStatuses().get("mode");
					const approvalStatus = footerData.getExtensionStatuses().get("approval-mode");
					const compactionModeStatus = footerData.getExtensionStatuses().get("maestro-auto-compact-mode");
					const effortStatus = footerData.getExtensionStatuses().get(EFFORT_STATUS_KEY);
					const pressureStatus = footerData.getExtensionStatuses().get("maestro-auto-compact");
					const swarmStatus = footerData.getExtensionStatuses().get("maestro-swarm");
					const evolStatus = footerData.getExtensionStatuses().get("self-evolve");
					const knowledgeStatus = footerData.getExtensionStatuses().get("maestro-knowledge-pending");
					const usageSparkline = renderUsageSparklineSegment(usageSeries, statsFooterConfig, width);
					lines.push(renderLine1(rs, activeToolCalls, cwd, width, modeStatus, approvalStatus, compactionModeStatus, effortStatus, evolStatus, knowledgeStatus, usageSparkline));

					const pressureLine = renderPressureLine(pressureStatus, width);
					if (pressureLine) lines.push(pressureLine);

					const swarmLine = renderSwarmStatusline(swarmStatus, width);
					if (swarmLine) lines.push(swarmLine);

					const workflow = deriveWorkflowViewModel(getWorkflowSnapshot());
					if (workflow) lines.push(renderWorkflowStatusline(workflow, width));

					return lines;
				},
			};
		});
	}

	// --- Event handlers ---

	pi.events.on(COCKPIT_UI_OWNERSHIP_EVENT, (payload) => {
		if (!payload || typeof payload !== "object") return;
		const ownership = payload as { footer?: unknown };
		const nextOwnership = ownership.footer === true;
		if (nextOwnership === cockpitOwnsFooter) return;
		cockpitOwnsFooter = nextOwnership;
		if (cockpitOwnsFooter) {
			footerGeneration += 1;
			footerCtx?.ui.setFooter(undefined);
			return;
		}
		if (footerCtx) installFooter(footerCtx);
	});

	pi.on("session_start", (_event, ctx) => {
		// Clear any leaked timers from prior session
		if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
		if (gitDebounceTimer) { clearTimeout(gitDebounceTimer); gitDebounceTimer = null; }

		const generation = ++sessionGeneration;
		const sessionCwd = ctx.cwd;
		cwd = sessionCwd;
		disposed = false;

		// Per-session usage sparkline: reset buffer and reload the footer config
		// so a config change made between sessions takes effect immediately.
		currentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		usageSeries = [];
		void loadStatsFooterConfig().then((cfg) => {
			statsFooterConfig = cfg;
		});

		// Incremental backfill from Pi session files (fire-and-forget, off the
		// hot path). Seeds usage-history with full history so the stats panel
		// and footer sparkline have data from before this extension loaded.
		void backfillSessionsBestEffort();

		if (ctx.model?.id) rs.model = ctx.model.id;

		const usage = ctx.getContextUsage?.();
		// A null percent (no usable usage since the last compaction) means the
		// size is genuinely unknown — clear the stale bar instead of showing a
		// pre-compaction value that reads as "compression never happened".
		if (usage) rs.contextPercent = usage.percent ?? null;

		// Session resume/switch may start with an existing branch.
		rebuildTokenUsage(ctx);

		// Footer must install synchronously — before any await
		installFooter(ctx);

		// Fire-and-forget async git refresh
		refreshGit(pi, sessionCwd).then((git) => {
			if (disposed || generation !== sessionGeneration || sessionCwd !== cwd) return;
			updateGit(git);
		});

		// Periodic git refresh
		gitTimer = setInterval(() => {
			if (disposed) return;
			refreshGit(pi, sessionCwd).then((git) => {
				if (disposed || generation !== sessionGeneration || sessionCwd !== cwd) return;
				updateGit(git);
			});
		}, GIT_REFRESH_INTERVAL);

	});

	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		footerGeneration += 1;
		disposed = true;
		footerCtx = undefined;
		invalidateFn = null;
		if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
		if (gitDebounceTimer) { clearTimeout(gitDebounceTimer); gitDebounceTimer = null; }
	});

	pi.on("session_tree", (_event, ctx) => {
		// Tree rewind/branch switch invalidates the incremental token baseline.
		rebuildTokenUsage(ctx);
		// Reinstall footer on session tree change
		installFooter(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.model?.id) {
			rs.model = ctx.model.id;
		}
		invalidate();
	});

	pi.on("agent_start", () => {
		invalidate();
	});

	pi.on("agent_end", () => {
		scheduleGitRefresh(footerGeneration);
		invalidate();
	});

	pi.on("turn_start", () => {
		invalidate();
	});

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage) rs.contextPercent = usage.percent ?? null;
		invalidate();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage) rs.contextPercent = usage.percent ?? null;
		// Debounced git refresh after tool completes (may have edited files)
		scheduleGitRefresh(footerGeneration);
		invalidate();
	});

	// Each finalized assistant message is counted once. Full branch scans are
	// reserved for lifecycle boundaries above, avoiding quadratic session work.
	pi.on("message_end", (event, ctx) => {
		addTokenUsage(event.message as MessageWithUsage | undefined);

		// Resolve sessionId from the live ctx (authoritative) with the cached
		// value as fallback. Relying solely on the session_start cache missed
		// recordings when the cache was empty (e.g. handler order races or
		// non-interactive contexts), leaving usage-history empty.
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;

		// Per-turn sparkline point + persistent history (best-effort).
		const message = event.message as MessageWithUsage | undefined;
		if (message?.role === "assistant") {
			// MessageWithUsage carries input/output/cacheRead/cacheWrite but not
			// cost, so the sparkline shows token count or cache-hit ratio; the
			// full cost breakdown is available in the /api-manager stats panel.
			const input = message.usage?.input ?? 0;
			const cacheRead = message.usage?.cacheRead ?? 0;
			const point = statsFooterConfig.metric === "cache"
				? (input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0)
				: input + (message.usage?.output ?? 0);
			usageSeries.push(point);
			if (usageSeries.length > statsFooterConfig.points * 2) usageSeries = usageSeries.slice(-statsFooterConfig.points * 2);
		}
		// Persist full record (async, best-effort). The full AssistantMessage
		// object (model/provider/timestamp/usage.cost) survives the type
		// narrowing — TS only trims the visible shape, not runtime fields.
		if (message?.role === "assistant" && sessionId) {
			void recordAssistantUsage(message, sessionId, ctx.cwd);
		}

		const usage = ctx.getContextUsage?.();
		if (usage) rs.contextPercent = usage.percent ?? null;
		invalidate();
	});
}
