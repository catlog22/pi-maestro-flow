import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { statusText, titleFor, workingMessage, type AmbientState } from "./ambient.ts";
import { BashBgStore } from "./bash-bg-store.ts";
import { BashBgOverlay } from "./bash-bg-overlay.ts";
import { TodoStore } from "./todo-store.ts";
import { makeTodoWidget, makeAgentWidget } from "./stack-widget.ts";
import { formatDuration } from "./render.ts";
import { getUsageTotals, invalidateUsageCache, renderFooter, type PaintTheme, type WidthUtils } from "./footer.ts";
import { collectExtensionStatuses } from "./extension-status.ts";
import { ANIMATION_PERIOD_MS, resolveGlyphs } from "./icons.ts";
import { ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { applyRow, buildRows, rowKeyForAccel, type SaveState } from "./settings-view.ts";
import {
	AGENT_WIDGET_KEY,
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	COCKPIT_TODO_TOGGLE_EVENT,
	COCKPIT_UI_OWNERSHIP_EVENT,
	DEFAULT_CONFIG,
	STACK_WIDGET_KEY,
	TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT,
	TODO_TOOL_NAME,
	WORKFLOW_STATUS_KEY,
	type CockpitConfig,
} from "./types.ts";

const FOOTER_UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };
const BASH_BG_OVERLAY_KEY = "alt+j";
const COCKPIT_STATUS_KEY = "cockpit";

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export default function (pi: ExtensionAPI): void {
	const agents = new AgentsStore();
	const bashBg = new BashBgStore();
	const todos = new TodoStore();
	let config: CockpitConfig = structuredClone(DEFAULT_CONFIG);
	let lastCtx: ExtensionContext | undefined;
	let capturedTui: TUI | undefined;
	let running = false;
	let sessionStart = 0;
	let tick: ReturnType<typeof setInterval> | undefined;
	// Persisted rather than toasted: a config that failed to load silently downgrades
	// the whole session to defaults, so it belongs in a slot that does not scroll away.
	let configProblem: string | undefined;

	// The streaming line, the tab title and the footer status slot are all fed from
	// the same snapshots the widgets read, so they can never disagree with them.
	const refreshAmbient = (): void => {
		const ctx = lastCtx;
		if (!ctx || !isTuiContext(ctx)) return;
		const g = resolveGlyphs(config.icons.mode);
		try {
			if (!config.enabled) {
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.setStatus(COCKPIT_STATUS_KEY, undefined);
				return;
			}
			const state: AmbientState = {
				todos: todos.snapshot(),
				agents: agents.snapshot(),
				jobs: bashBg.snapshot(),
				running,
				cwd: formatCwd(ctx.sessionManager.getCwd()),
			};
			ctx.ui.setWorkingMessage(workingMessage(state));
			ctx.ui.setTitle(titleFor(state, { ok: g.check, fail: g.cross }));
			ctx.ui.setStatus(COCKPIT_STATUS_KEY, statusText(configProblem, g.blocked));
		} catch {
			// ambient surfaces are best-effort; never let them break a render
		}
	};

	const req = (): void => {
		refreshAmbient();
		try {
			capturedTui?.requestRender();
		} catch {
			// tui may be gone between sessions
		}
	};
	// True only while a redraw loop is actually running; widgets use it to avoid
	// painting a frozen spinner frame that reads as a hung UI.
	const isAnimating = (): boolean => tick !== undefined && (running || bashBg.hasActive());
	// A failed agent lingers for a while after it completes, and the loop has to
	// outlive the session that produced it — otherwise the row would sit there
	// until some unrelated event happened to expire it.
	const needsTick = (): boolean => running || bashBg.hasActive() || agents.hasLingering();
	const startTick = (): void => {
		if (tick) return;
		tick = setInterval(() => {
			if (needsTick()) req();
			else syncTick();
		}, ANIMATION_PERIOD_MS);
		tick.unref?.();
	};
	const syncTick = (): void => {
		if (needsTick()) startTick();
		else stopTick();
	};
	const stopTick = (): void => {
		if (tick) {
			clearInterval(tick);
			tick = undefined;
		}
	};
	const publishUiOwnership = (): void => {
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, {
			todo: config.enabled,
			agents: config.enabled && config.hideNativeAgents,
			todoExpanded: config.todoExpanded,
		});
	};
	const setTodoExpanded = (expanded: boolean): void => {
		if (config.todoExpanded === expanded) return;
		config = { ...config, todoExpanded: expanded };
		saveConfig(config);
		publishUiOwnership();
		req();
	};

	const uninstallUi = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(STACK_WIDGET_KEY, undefined);
		ctx.ui.setWidget(AGENT_WIDGET_KEY, undefined);
		ctx.ui.setFooter(undefined);
		try {
			// Leaving these set would strand a title and a status line owned by an
			// extension that is no longer painting anything.
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus(COCKPIT_STATUS_KEY, undefined);
		} catch {
			// ambient surfaces are best-effort
		}
		stopTick();
		capturedTui = undefined;
	};

	const applyUi = (ctx: ExtensionContext): void => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		ctx.ui.setWidget(
			STACK_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				return makeTodoWidget({
					getTodos: () => todos.snapshot(),
					getConfig: () => config,
					isAnimating,
				})(tui, theme);
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setWidget(
			AGENT_WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				return makeAgentWidget({
					getAgents: () => agents.snapshot(),
					getBashBgJobs: () => bashBg.snapshot(),
					getConfig: () => config,
					isRunning: () => running,
					isAnimating,
				})(tui, theme);
			},
			{ placement: "belowEditor" },
		);
		// Re-enabling mid-run reinstalls the widgets but used to leave the ticker
		// stopped, freezing every spinner and elapsed counter until some unrelated
		// event happened to trigger a redraw.
		syncTick();
		ctx.ui.setFooter((tui, theme, footerData) => {
			capturedTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const component = {
				render(width: number): string[] {
					const cu = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					const extensionStatuses = collectExtensionStatuses(footerData.getExtensionStatuses());
					const agentSnap = agents.snapshot();
					const agentFailed = agentSnap.filter((a) => a.status === "failed").length;
					const agentRunning = agentSnap.filter((a) => a.status === "running" || a.status === "retrying").length;
					const agentSummary = agentSnap.length > 0
						? agentFailed > 0
							? `${agentRunning} agents · ${agentFailed} failed`
							: `${agentRunning} agents`
						: undefined;
					return renderFooter({
						width,
						model: ctx.model?.id ?? "no-model",
						provider: ctx.model?.provider,
						thinking: pi.getThinkingLevel(),
						cwd: formatCwd(ctx.sessionManager.getCwd()),
						ctxPct: cu?.percent ?? 0,
						ctxTokens: cu?.tokens ?? 0,
						ctxWindow: cu?.contextWindow ?? ctx.model?.contextWindow ?? 0,
						totals: getUsageTotals(ctx.sessionManager.getEntries()),
						git: branch ?? undefined,
						elapsed: formatDuration(Date.now() - sessionStart),
						agentSummary,
						workflowStatus: extensionStatuses.find((status) => status.key === WORKFLOW_STATUS_KEY)?.text,
						extensionStatuses: extensionStatuses.filter((status) => status.key !== WORKFLOW_STATUS_KEY),
						glyphs: resolveGlyphs(config.icons.mode),
						theme,
						utils: FOOTER_UTILS,
					});
				},
				invalidate(): void {},
				dispose(): void {
					unsubscribeBranch();
				},
			};
			return component;
		});
	};

	// --- teammate lifecycle (custom event bus; subscribed once for the extension lifetime) ---
	pi.events.on(TEAMMATE_STARTED_EVENT, (d) => {
		agents.applyStarted(d as StartedPayload);
		req();
	});
	pi.events.on(TEAMMATE_MESSAGE_EVENT, (d) => {
		agents.applyMessage(d as MessagePayload);
		req();
	});
	pi.events.on(TEAMMATE_COMPLETE_EVENT, (d) => {
		agents.applyComplete(d as CompletePayload);
		// A failure that arrives after the session went idle still needs a loop to
		// expire it, so the tick is re-evaluated rather than assumed to be running.
		syncTick();
		req();
	});
	pi.events.on(BASH_BG_UPDATE_EVENT, (payload) => {
		if (!bashBg.applySnapshot(payload)) return;
		syncTick();
		req();
	});
	pi.events.on(COCKPIT_TODO_TOGGLE_EVENT, (payload) => {
		if (!config.enabled) return;
		const requested = payload && typeof payload === "object"
			? (payload as { expanded?: unknown }).expanded
			: undefined;
		setTodoExpanded(typeof requested === "boolean" ? requested : !config.todoExpanded);
	});

	// --- todo changes: re-hydrate from the durable snapshot the todo tool persists ---
	pi.on("tool_execution_end", (e, ctx) => {
		if (e.toolName === TODO_TOOL_NAME) {
			todos.hydrateFromEntries(ctx.sessionManager.getEntries());
			req();
		}
	});

	// --- session + agent lifecycle ---
	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		sessionStart = Date.now();
		ensureConfigExists();
		config = loadConfig((m, l) => {
			try {
				ctx.ui.notify(m, l);
			} catch {
				// notify unavailable
			}
		});
		invalidateUsageCache();
		// An explicitly chosen theme is restored here; an empty value deliberately
		// leaves whatever theme pi is already using untouched.
		if (config.theme) {
			const applied = ctx.ui.setTheme(config.theme);
			if (!applied.success) {
				try {
					ctx.ui.notify(`pi-cockpit: theme "${config.theme}" unavailable — ${applied.error ?? "not found"}`, "warning");
				} catch {
					// notify unavailable
				}
			}
		}
		todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		applyUi(ctx);
		publishUiOwnership();
		pi.events.emit(BASH_BG_QUERY_EVENT, undefined);
		req();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (lastCtx) uninstallUi(lastCtx);
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, {
			todo: false,
			agents: false,
			todoExpanded: config.todoExpanded,
		});
		lastCtx = undefined;
		running = false;
		invalidateUsageCache();
		agents.clear();
		bashBg.clear();
	});

	pi.on("agent_start", () => {
		running = true;
		startTick();
		req();
	});
	pi.on("agent_end", () => {
		running = false;
		syncTick();
		req();
	});

	// --- redraw triggers for the footer's live data ---
	pi.on("message_end", (_e, ctx) => {
		invalidateUsageCache();
		if (isTuiContext(ctx)) req();
	});
	pi.on("model_select", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});
	pi.on("session_compact", (_e, ctx) => {
		invalidateUsageCache();
		if (isTuiContext(ctx)) req();
	});

	const openBashBgOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) =>
			new BashBgOverlay({
				getJobs: () => bashBg.snapshot(),
				requestRender: () => tui.requestRender(),
				requestRefresh: () => pi.events.emit(BASH_BG_QUERY_EVENT, undefined),
				close: () => done(undefined),
				theme,
				glyphs: resolveGlyphs(config.icons.mode),
				getTerminalRows: () => {
					try {
						const rows = tui.terminal?.rows;
						return typeof rows === "number" && rows > 0 ? rows : undefined;
					} catch {
						return undefined;
					}
				},
			}), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
		});
	};

	pi.registerShortcut(BASH_BG_OVERLAY_KEY, {
		description: "Open background Bash jobs — live status, command, cwd, duration and output tail",
		async handler(ctx) {
			await openBashBgOverlay(ctx);
		},
	});

	// --- /cockpit: toggle list/compact + enabled + hide-native ---
	pi.registerCommand("cockpit", {
		description: "Open pi-cockpit settings; use /cockpit bg for background Bash job details",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const action = args.trim().toLowerCase();
			if (action === "bg" || action === "jobs") {
				await openBashBgOverlay(ctx);
				return;
			}
			if (action === "todo" || action === "todo toggle") {
				setTodoExpanded(!config.todoExpanded);
				ctx.ui.notify(`TODO ${config.todoExpanded ? "expanded" : "collapsed"}`, "info");
				return;
			}
			if (action === "todo expand" || action === "todo collapse") {
				setTodoExpanded(action.endsWith("expand"));
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const themes = ctx.ui.getAllThemes().map((t) => t.name);
				let cursor = 0;
				let saveState: SaveState = { kind: "idle" };
				const apply = (key: string): void => {
					const wasEnabled = config.enabled;
					const previousTheme = config.theme;
					config = applyRow(config, key, themes);
					saveState = { kind: "saving" };
					const result = saveConfig(config);
					// The panel now reports what actually happened instead of showing
					// an optimistic value for a write that may never have landed.
					saveState = result.ok
						? { kind: "saved" }
						: { kind: "failed", message: result.error ?? "unknown error" };
					if (config.theme !== previousTheme && config.theme !== "") {
						const applied = ctx.ui.setTheme(config.theme);
						if (!applied.success) {
							saveState = { kind: "failed", message: applied.error ?? `unknown theme ${config.theme}` };
						}
					}
					if (wasEnabled !== config.enabled) {
						if (config.enabled) applyUi(ctx);
						else uninstallUi(ctx);
					}
					publishUiOwnership();
					req();
				};
				const ui = {
					render(width: number): string[] {
						const paint: PaintTheme = theme;
						const rows = buildRows(config, themes);
						cursor = Math.max(0, Math.min(cursor, rows.length - 1));
						const w = Math.min(width, 52);
						const labelWidth = Math.max(...rows.map((r) => visibleWidth(r.label)));
						const lines = [
							paint.fg("text", "pi-cockpit"),
							paint.fg("borderMuted", "─".repeat(w)),
						];
						rows.forEach((row, index) => {
							const selected = index === cursor;
							const marker = selected ? paint.fg("accent", "›") : " ";
							const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
							const label = paint.fg(selected ? "text" : "muted", row.label) + pad;
							const value = paint.fg("accent", row.value);
							// Showing the next value makes the cycle visible instead of
							// something the user has to discover by pressing and watching.
							const hint = selected ? paint.fg("dim", ` → ${row.next}`) : "";
							lines.push(`${marker} ${paint.fg("dim", row.accel)} ${label}  ${value}${hint}`);
						});
						lines.push("");
						if (saveState.kind === "saved") lines.push(paint.fg("success", "✓ saved"));
						else if (saveState.kind === "saving") lines.push(paint.fg("dim", "· saving…"));
						else if (saveState.kind === "failed") {
							lines.push(paint.fg("error", `✗ save failed — ${saveState.message}`));
							lines.push(paint.fg("dim", "settings apply for this session only"));
						}
						lines.push(paint.fg("dim", "↑↓ move · Enter change · letter jumps · Esc close"));
						return lines.map((line) => truncateToWidth(line, width, "…"));
					},
					invalidate(): void {},
					handleInput(data: string): void {
						const rows = buildRows(config, themes);
						if (matchesKey(data, Key.escape)) {
							done(undefined);
							return;
						}
						if (data === "\x1b[A" || data === "\x1b[B") {
							const delta = data === "\x1b[A" ? -1 : 1;
							cursor = (cursor + delta + rows.length) % rows.length;
						} else if (data === "\r" || data === "\n" || data === " ") {
							apply(rows[cursor].key);
						} else {
							const key = rowKeyForAccel(rows, data);
							if (!key) return;
							cursor = rows.findIndex((row) => row.key === key);
							apply(key);
						}
						tui.requestRender();
					},
					dispose(): void {},
				};
				return ui;
			}, { overlay: true });
		},
	});
}
