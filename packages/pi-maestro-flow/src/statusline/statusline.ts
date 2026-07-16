/**
 * Maestro Flow statusline — Pi Extension footer API implementation.
 *
 * Line 1: Mode | Model | Context | Tool calls | Dir+Git | Tokens
 * Line 2: Context pressure or active compaction (when present)
 * Line 3: Session and active Workflow Run (when a canonical snapshot is active)
 *
 * Adapted from maestro2/src/hooks/statusline.ts for the Pi Extension ecosystem.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	deriveWorkflowViewModel,
	type WorkflowSnapshotLike,
	type WorkflowViewModel,
	workflowStatusLabel,
} from "../session/view-model.ts";
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
}

interface MessageWithUsage {
	role?: string;
	usage?: { input?: number; output?: number };
}

interface RuntimeState {
	model: string;
	git: GitInfo | null;
	contextPercent: number | null;
	tokens: TokenTotals;
	turnCount: number;
	isAgentRunning: boolean;
}

type PlanModeStatus = "ACT" | "PLAN" | "READY";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000) + "k";
}

function buildContextBar(usedPct: number, compact = false): string {
	const filled = Math.floor(usedPct / 10);
	const bar = "█".repeat(filled) + "░".repeat(10 - filled);
	const level = getCtxLevel(usedPct);
	const color = getCtxColor(level);
	const value = compact ? `${ICONS.ctx} ${usedPct}%` : `${ICONS.ctx} ${bar} ${usedPct}%`;
	return `${ansiFg(color)}${value}${ANSI_RESET}`;
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
	if (planMode === "PLAN" || planMode === "READY") return "plan";
	const normalized = value?.replace(/^APPROVAL\s+/i, "").trim();
	if (/^(?:YOLO|bypassPermissions)$/i.test(normalized ?? "")) return "YOLO";
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
	const approvalLabel = width >= 80 ? `APPROVAL ${approval}` : width >= 48 ? approval : approvalInitial(approval);
	const separator = width >= 80
		? `${ansiFg(COLORS.separator)} · ${ANSI_RESET}`
		: `${ansiFg(COLORS.separator)}/${ANSI_RESET}`;
	return `${colored("phase", modeLabel)}${separator}${renderApprovalMode(approval, approvalLabel)}`;
}

function renderContextPressure(value: string | undefined, width: number): string {
	if (!value) return "";
	const normalized = value.replace(/^CTX\s+/i, "").trim();
	const match = /^(NUDGE|AUTO-PRUNE|CRITICAL|COMPACT)\s+(\d+)\/(\d+)(?:\s+-(\d+))?$/i.exec(normalized);
	if (!match) return "";
	const band = match[1].toUpperCase();
	const pruned = match[4] ? ` -${match[4]}` : "";
	const text = width >= 80
		? `CTX ${band} ${match[2]}/${match[3]}${pruned}`
		: width >= 48
			? `CTX ${band === "AUTO-PRUNE" ? "PRUNE" : band}${pruned}`
			: band === "AUTO-PRUNE" ? `CTX PRUNE${pruned}` : `CTX ${band}${pruned}`;
	const color = band === "CRITICAL" || band === "COMPACT" ? COLORS.ctxCrit : band === "AUTO-PRUNE" ? COLORS.ctxAlert : COLORS.ctxWarn;
	return `${ansiFg(color)}${text}${ANSI_RESET}`;
}

function renderPressureLine(value: string | undefined, width: number): string {
	return truncateToWidth(renderContextPressure(value, width), Math.max(1, width), "…");
}

const SEP = `${ansiFg(COLORS.separator)} · ${ANSI_RESET}`;

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
): string {
	const safeWidth = Math.max(1, width);
	const modeText = renderPlanModeStatus(modeStatus, approvalStatus, safeWidth);
	const modelText = colored("model", `${ICONS.model} ${shortenModel(rs.model)}`);
	const toolCallText = activeToolCalls > 0
		? colored("runs", `${ICONS.runs} ${activeToolCalls} call${activeToolCalls > 1 ? "s" : ""}`)
		: "";
	let dirText = colored("dir", `${ICONS.dir} ${basename(dir)}`);
	if (rs.git) dirText += `  ${formatGit(rs.git)}`;
	let tokenText = "";
	if (rs.tokens.input > 0 || rs.tokens.output > 0) {
		const value = `↑${formatTokens(rs.tokens.input)} ↓${formatTokens(rs.tokens.output)} ${ICONS.tokens}${formatTokens(rs.tokens.input + rs.tokens.output)}`;
		tokenText = colored("tokens", value);
	}
	let contextFull = "";
	let contextCompact = "";
	if (rs.contextPercent != null) {
		const usedPct = Math.max(0, Math.min(100, Math.round(rs.contextPercent)));
		contextFull = buildContextBar(usedPct);
		contextCompact = buildContextBar(usedPct, true);
	}

	const parts = safeWidth >= 80
		? [modeText, modelText, contextFull, toolCallText, dirText, tokenText]
		: safeWidth >= 48
			? [modeText, modelText, contextCompact, dirText]
			: [modeText, contextCompact, modelText];
	return truncateToWidth(parts.filter(Boolean).join(SEP), safeWidth, "…");
}

export function renderWorkflowStatusline(view: WorkflowViewModel, width: number): string {
	const safeWidth = Math.max(1, width);
	const action = view.recoveryAction ?? view.nextAction;
	if (safeWidth < 20) {
		return truncateToWidth(action ? `» ${action}` : workflowStatusLabel(view.status), safeWidth, "…");
	}

	const run = view.activeRun;
	const runText = run
		? `${run.sequence != null ? String(run.sequence).padStart(3, "0") : run.id}/${run.command}`
		: "no active run";
	const status = run ? workflowStatusLabel(run.status, run.attempt) : workflowStatusLabel(view.status);
	const chain = `✓${view.chain.completed} ▶${view.chain.running} ○${view.chain.pending}`;
	const session = `⚑ ${view.sessionLabel}`;
	const recovery = action ? `» ${action}` : "";

	let parts: string[];
	if (safeWidth < 48) {
		parts = [recovery, status, runText, chain];
	} else if (safeWidth < 80) {
		parts = [recovery, session, status, runText, chain];
	} else {
		const gates = view.gates ? `gate ${view.gates.passed}/${view.gates.total}` : "";
		const budget = view.goal?.tokensUsed != null && view.goal.tokenBudget != null
			? `goal ${formatTokens(view.goal.tokensUsed)}/${formatTokens(view.goal.tokenBudget)}`
			: "";
		parts = [recovery, session, status, runText, chain, gates, budget];
	}
	return truncateToWidth(parts.filter(Boolean).join(SEP), safeWidth, "…");
}

// ---------------------------------------------------------------------------
// Install — registers footer + event handlers
// ---------------------------------------------------------------------------

const GIT_REFRESH_INTERVAL = 30_000;
const GIT_DEBOUNCE_MS = 500;
export function installStatusline(
	pi: ExtensionAPI,
	getMaestroState: () => MaestroState,
	getWorkflowSnapshot: () => WorkflowSnapshotLike | null | undefined = () => null,
): void {
	const rs: RuntimeState = {
		model: "Claude",
		git: null,
		contextPercent: null,
		tokens: { input: 0, output: 0 },
		turnCount: 0,
		isAgentRunning: false,
	};

	let cwd = "";
	let invalidateFn: (() => void) | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let sessionGeneration = 0;
	let footerGeneration = 0;

	function invalidate(): void {
		invalidateFn?.();
	}

	function addTokenUsage(message: MessageWithUsage | undefined): void {
		if (message?.role !== "assistant") return;
		rs.tokens.input += message.usage?.input ?? 0;
		rs.tokens.output += message.usage?.output ?? 0;
	}

	function rebuildTokenUsage(ctx: ExtensionContext): void {
		const totals: TokenTotals = { input: 0, output: 0 };
		try {
			for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
				if (entry.type !== "message") continue;
				const message = entry.message as MessageWithUsage | undefined;
				if (message?.role !== "assistant") continue;
				totals.input += message.usage?.input ?? 0;
				totals.output += message.usage?.output ?? 0;
			}
		} catch {
			// Token tracking is best-effort.
		}
		rs.tokens = totals;
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
			rs.git = git;
			invalidate();
		}, GIT_DEBOUNCE_MS);
	}

	// --- Footer registration ---
	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const generation = ++footerGeneration;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			disposed = false;
			// Connect invalidate → requestRender
			invalidateFn = () => tui.requestRender();

			// Subscribe to branch changes for git refresh
			const unsubBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh(generation);
			});

			return {
				dispose() {
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
					const state = getMaestroState();
					const activeToolCalls = (state.activeToolCalls ?? state.activeRuns)?.size ?? 0;
					const lines: string[] = [];

					const modeStatus = footerData.getExtensionStatuses().get("mode");
					const approvalStatus = footerData.getExtensionStatuses().get("approval-mode");
					const pressureStatus = footerData.getExtensionStatuses().get("maestro-auto-compact");
					lines.push(renderLine1(rs, activeToolCalls, cwd, width, modeStatus, approvalStatus));

					const pressureLine = renderPressureLine(pressureStatus, width);
					if (pressureLine) lines.push(pressureLine);

					const workflow = deriveWorkflowViewModel(getWorkflowSnapshot());
					if (workflow) lines.push(renderWorkflowStatusline(workflow, width));

					return lines;
				},
			};
		});
	}

	// --- Event handlers ---

	pi.on("session_start", (_event, ctx) => {
		// Clear any leaked timers from prior session
		if (gitTimer) { clearInterval(gitTimer); gitTimer = null; }
		if (gitDebounceTimer) { clearTimeout(gitDebounceTimer); gitDebounceTimer = null; }

		const generation = ++sessionGeneration;
		const sessionCwd = ctx.cwd;
		cwd = sessionCwd;
		disposed = false;

		if (ctx.model?.id) rs.model = ctx.model.id;

		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) rs.contextPercent = usage.percent;

		// Session resume/switch may start with an existing branch.
		rebuildTokenUsage(ctx);

		// Footer must install synchronously — before any await
		installFooter(ctx);

		// Fire-and-forget async git refresh
		refreshGit(pi, sessionCwd).then((git) => {
			if (disposed || generation !== sessionGeneration || sessionCwd !== cwd) return;
			rs.git = git;
			invalidate();
		});

		// Periodic git refresh
		gitTimer = setInterval(() => {
			if (disposed) return;
			refreshGit(pi, sessionCwd).then((git) => {
				if (disposed || generation !== sessionGeneration || sessionCwd !== cwd) return;
				rs.git = git;
				invalidate();
			});
		}, GIT_REFRESH_INTERVAL);

	});

	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		footerGeneration += 1;
		disposed = true;
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
		rs.isAgentRunning = true;
		invalidate();
	});

	pi.on("agent_end", () => {
		rs.isAgentRunning = false;
		scheduleGitRefresh();
		invalidate();
	});

	pi.on("turn_start", () => {
		rs.turnCount++;
		invalidate();
	});

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		invalidate();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		// Debounced git refresh after tool completes (may have edited files)
		scheduleGitRefresh();
		invalidate();
	});

	// Each finalized assistant message is counted once. Full branch scans are
	// reserved for lifecycle boundaries above, avoiding quadratic session work.
	pi.on("message_end", (event, ctx) => {
		addTokenUsage(event.message as MessageWithUsage | undefined);

		const usage = ctx.getContextUsage?.();
		if (usage?.percent != null) {
			rs.contextPercent = usage.percent;
		}
		invalidate();
	});
}
