import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { statusText, titleFor, workingMessage, type AmbientState } from "./ambient.ts";
import { BashBgStore } from "./bash-bg-store.ts";
import { BashBgOverlay } from "./bash-bg-overlay.ts";
import { TodoStore } from "./todo-store.ts";
import { makeTodoWidget, makeAgentWidget, terminalRows } from "./stack-widget.ts";
import { activeThemeName, ThemePicker } from "./theme-picker.ts";
import { formatDuration } from "./render.ts";
import { ActivityTimer, getUsageTotals, invalidateUsageCache, renderFooter, type PaintTheme, type WidthUtils } from "./footer.ts";
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
const WIDTH_POLL_INTERVAL_MS = 250;

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
	const activityTimer = new ActivityTimer();
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
			let observedWidth = tui.terminal.columns;
			const widthTimer = setInterval(() => {
				const nextWidth = tui.terminal.columns;
				if (!Number.isFinite(nextWidth) || nextWidth <= 0 || nextWidth === observedWidth) return;
				observedWidth = nextWidth;
				tui.invalidate();
				tui.requestRender(true);
			}, WIDTH_POLL_INTERVAL_MS);
			widthTimer.unref?.();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const component = {
				render(width: number): string[] {
					if (Number.isFinite(width) && width > 0) observedWidth = width;
					const cu = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					const extensionStatuses = collectExtensionStatuses(footerData.getExtensionStatuses());
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
						elapsed: formatDuration(activityTimer.elapsed()),
						// The Agents header one line above already states the roster and
						// the failure count. Repeating it here spent a footer segment to
						// say nothing new, and the two could disagree mid-update.
						workflowStatus: extensionStatuses.find((status) => status.key === WORKFLOW_STATUS_KEY)?.text,
						extensionStatuses: extensionStatuses.filter((status) => status.key !== WORKFLOW_STATUS_KEY),
						glyphs: resolveGlyphs(config.icons.mode),
						theme,
						utils: FOOTER_UTILS,
					});
				},
				invalidate(): void {},
				dispose(): void {
					clearInterval(widthTimer);
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
		activityTimer.reset();
		ensureConfigExists();
		config = loadConfig((m, l) => {
			try {
				ctx.ui.notify(m, l);
			} catch {
				// notify unavailable
			}
		});
		invalidateUsageCache();
		// The theme is deliberately NOT re-applied here. ctx.ui.setTheme writes
		// through to pi's own settings, so pi already restores the user's choice on
		// its own. Replaying cockpit's copy would overwrite whatever the user set
		// through /settings since — including an automatic "light/dark" pair, which
		// cockpit cannot represent and would silently flatten to a single theme.
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
		activityTimer.reset();
		invalidateUsageCache();
		agents.clear();
		bashBg.clear();
	});

	pi.on("before_agent_start", (event) => {
		if (event.prompt.trim() !== "" || (event.images?.length ?? 0) > 0) {
			activityTimer.restart();
		}
	});
	pi.on("agent_start", () => {
		running = true;
		startTick();
		req();
	});
	pi.on("agent_end", () => {
		running = false;
		activityTimer.stop();
		syncTick();
		req();
	});

	// --- redraw triggers for the footer's live data ---
	pi.on("message_start", (event) => {
		const role = event.message.role;
		if (role === "user" || role === "assistant") activityTimer.start();
	});
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
				getTerminalRows: () => terminalRows(tui),
			}), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
		});
	};

	// --- /theme: pi ships no command for this; themes live under /settings ---
	const makeThemePicker = (
		ctx: ExtensionContext,
		tui: TUI,
		theme: Theme,
		close: () => void,
	): ThemePicker => {
		const active = activeThemeName(theme);
		return new ThemePicker({
			themes: ctx.ui.getAllThemes().map((t) => t.name),
			// Cockpit's own record is only a fallback: pi's live theme is the truth,
			// and /settings can have changed it since cockpit last wrote anything.
			initial: active ?? config.theme,
			// Resolve a real instance by name. Passing `theme` straight through would
			// store the Proxy into the very slot the Proxy reads from, and the next
			// colour lookup would recurse until the stack blew.
			original: active ? ctx.ui.getTheme(active) : undefined,
			loadTheme: (name) => ctx.ui.getTheme(name),
			// Instance form: applies in memory without writing through to pi's
			// settings, so scrolling the whole list costs the user nothing.
			previewTheme: (instance) => { ctx.ui.setTheme(instance); },
			// Name form: the one call that persists.
			commitTheme: (name) => {
				const applied = ctx.ui.setTheme(name);
				if (applied.success) {
					config = { ...config, theme: name };
					saveConfig(config);
				}
				return applied;
			},
			close,
			requestRender: () => tui.requestRender(),
			getTerminalRows: () => terminalRows(tui),
			theme,
			glyphs: resolveGlyphs(config.icons.mode),
		});
	};

	const openThemePicker = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) =>
			makeThemePicker(ctx, tui, theme, () => done(undefined)), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "60%", maxHeight: "90%" },
		});
	};

	// pi has no /theme command — the built-in picker is a submenu of /settings.
	// This is the shortcut, not a replacement: /settings still owns the automatic
	// light/dark pairing, which a flat list of names cannot express.
	pi.registerCommand("theme", {
		description: "Switch theme — /theme picks with live preview, /theme <name> applies directly",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const ctx = lastCtx;
			if (!ctx || !ctx.hasUI) return null;
			const matches = ctx.ui.getAllThemes()
				.map((t) => t.name)
				.filter((name) => name.toLowerCase().includes(query));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const name = args.trim();
			if (name === "") {
				await openThemePicker(ctx);
				return;
			}
			const applied = ctx.ui.setTheme(name);
			if (!applied.success) {
				ctx.ui.notify(`theme "${name}" unavailable — ${applied.error ?? "not found"}`, "warning");
				return;
			}
			config = { ...config, theme: name };
			saveConfig(config);
			ctx.ui.notify(`theme: ${name}`, "info");
		},
	});

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
			await openSettings(ctx);
		},
	});

	const openSettings = async (ctx: ExtensionCommandContext): Promise<void> =>
		ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let settingsCursor = 0;
			let saveState: SaveState = { kind: "idle" };
			// The theme row expands in place rather than closing the panel and opening
			// a second overlay: pi's `theme` is a live Proxy, so both surfaces repaint
			// in the previewed colours, and Esc lands back on the row it was invoked
			// from instead of on a panel that looks freshly opened.
			let sub: ThemePicker | undefined;
			const closeSub = (): void => {
				sub?.dispose();
				sub = undefined;
				tui.requestRender();
			};
			const apply = (key: string): void => {
				const wasEnabled = config.enabled;
				if (key === "theme") {
					// Delegate: the picker previews live and reverts on Esc, neither of
					// which a blind one-key cycle through the name list can do.
					sub = makeThemePicker(ctx, tui, theme, closeSub);
					tui.requestRender();
					return;
				}
				config = applyRow(config, key);
				saveState = { kind: "saving" };
				const result = saveConfig(config);
				// The panel now reports what actually happened instead of showing
				// an optimistic value for a write that may never have landed.
				saveState = result.ok
					? { kind: "saved" }
					: { kind: "failed", message: result.error ?? "unknown error" };
				if (wasEnabled !== config.enabled) {
					if (config.enabled) applyUi(ctx);
					else uninstallUi(ctx);
				}
				publishUiOwnership();
				req();
			};
			const ui = {
				render(width: number): string[] {
					// The sub-view takes the whole card. It carries its own title and
					// key hints, so stacking the panel's chrome above it would spend two
					// rows saying nothing the picker does not already say.
					if (sub) return sub.render(width);
					const paint: PaintTheme = theme;
					const rows = buildRows(config);
					settingsCursor = Math.max(0, Math.min(settingsCursor, rows.length - 1));
					const w = Math.min(width, 52);
					const labelWidth = Math.max(...rows.map((r) => visibleWidth(r.label)));
					const lines = [
						paint.fg("text", "pi-cockpit"),
						paint.fg("borderMuted", "─".repeat(w)),
					];
					rows.forEach((row, index) => {
						const selected = index === settingsCursor;
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
						// Scoped to cockpit's own rows: the theme is applied through pi,
						// which persists it regardless of whether this file was written.
						lines.push(paint.fg("dim", "cockpit rows apply for this session only"));
					}
					// The theme row opens /theme; /settings additionally pairs a light
					// and a dark theme, which neither of cockpit's surfaces can express.
					lines.push(paint.fg("dim", "theme is stored by pi · /settings pairs light+dark"));
					lines.push(paint.fg("dim", "↑↓ move · Enter change · letter jumps · Esc close"));
					return lines.map((line) => truncateToWidth(line, width, "…"));
				},
				invalidate(): void {},
				handleInput(data: string): void {
					// While expanded the sub-view owns every key, Esc included — that is
					// what makes Esc step back to the panel instead of dismissing both.
					if (sub) {
						sub.handleInput(data);
						tui.requestRender();
						return;
					}
					const rows = buildRows(config);
					if (matchesKey(data, Key.escape)) {
						done(undefined);
						return;
					}
					if (data === "\x1b[A" || data === "\x1b[B") {
						const delta = data === "\x1b[A" ? -1 : 1;
						settingsCursor = (settingsCursor + delta + rows.length) % rows.length;
					} else if (data === "\r" || data === "\n" || data === " ") {
						apply(rows[settingsCursor].key);
					} else {
						const key = rowKeyForAccel(rows, data);
						if (!key) return;
						settingsCursor = rows.findIndex((row) => row.key === key);
						apply(key);
					}
					tui.requestRender();
				},
				dispose(): void {
					// Closing the panel while expanded must not strand a previewed theme
					// with no way back, so route through the picker's own cancel path.
					sub?.handleInput("\x1b");
					sub?.dispose();
				},
			};
			return ui;
		}, { overlay: true });
}
