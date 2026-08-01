import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { statusText, titleFor, workingMessage, type AmbientState } from "./ambient.ts";
import { BashBgStore } from "./bash-bg-store.ts";
import { MaestroStore } from "./maestro-store.ts";
import { createSidebarController, type SidebarController } from "./sidebar-controller.ts";
import { BashBgOverlay } from "./bash-bg-overlay.ts";
import { renderBashBgSummary } from "./bash-bg-widget.ts";
import { registerQuietTools } from "./quiet-tools.ts";
import { ensureThinkingFolded, readHideThinkingBlock } from "./thinking-fold.ts";
import { ThinkingFoldTimer } from "./thinking-timer.ts";
import { TodoStore } from "./todo-store.ts";
import { makeTodoWidget, makeAgentWidget, terminalRows } from "./stack-widget.ts";
import { activeThemeName, ThemePicker } from "./theme-picker.ts";
import { getUsageTotals, invalidateUsageCache, renderFooter, type PaintTheme, type WidthUtils } from "./footer.ts";
import { collectExtensionStatuses } from "./extension-status.ts";
import { ANIMATION_PERIOD_MS, resolveGlyphs, spinFrame } from "./icons.ts";
import { ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { applyRow, buildRows, rowKeyForAccel, type SaveState } from "./settings-view.ts";
import {
	COCKPIT_MAESTRO_QUERY_EVENT,
	MAESTRO_UI_SNAPSHOT_EVENT,
	MAESTRO_UI_SNAPSHOT_VERSION,
	type CockpitUiOwnershipV1,
} from "./public/v1/events.ts";
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
const SIDEBAR_RESIZE_KEY = "ctrl+shift+r";
const COCKPIT_STATUS_KEY = "cockpit";
const WIDTH_POLL_INTERVAL_MS = 250;
// Quiet mode's rename of pi's hidden-thinking label. The live thinking timer
// derives its final "thoughts · 8.4s" labels from the same word.
const QUIET_THINKING_LABEL = "thoughts";

export type CockpitSurfaceState = "dock" | "widgets" | "disabled";

export function resolveCockpitSurfaceState(
	enabled: boolean,
	sidebarMode: CockpitConfig["sidebar"]["mode"],
	dockEffectiveVisible: boolean,
): CockpitSurfaceState {
	if (!enabled) return "disabled";
	return sidebarMode !== "off" && dockEffectiveVisible ? "dock" : "widgets";
}

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
	const maestro = new MaestroStore();
	let config: CockpitConfig = structuredClone(DEFAULT_CONFIG);
	let lastCtx: ExtensionContext | undefined;
	let capturedTui: TUI | undefined;
	let sidebarController: SidebarController | undefined;
	let dockEffectiveVisible = false;
	let surfaceState: CockpitSurfaceState = "disabled";
	let running = false;
	const activeTools = new Map<string, string>();
	let tick: ReturnType<typeof setInterval> | undefined;
	// Persisted rather than toasted: a config that failed to load silently downgrades
	// the whole session to defaults, so it belongs in a slot that does not scroll away.
	let configProblem: string | undefined;
	let quietToolsRegistered = false;

	// Register quiet tools at extension load time, not just in session_start.
	// During /resume, pi renders history BEFORE emitting session_start
	// (rebindCurrentSession({ renderBeforeBind: true })), so tools registered
	// only in session_start miss the initial render pass and every historical
	// tool call gets the verbose default renderer.  registerTool() is valid
	// during extension load (loader.ts: "refresh is only needed post-bind"),
	// and the Extension.tools map is read by _refreshToolRegistry during
	// AgentSession construction — before renderInitialMessages runs.
	ensureConfigExists();
	config = loadConfig();
	if (config.quietMode) {
		registerQuietTools(pi, () => config);
		quietToolsRegistered = true;
	}

	// Live labels for folded thinking rows: a spinner with running elapsed
	// time while the model thinks, then the actual duration once it settles.
	// Pi owns the fold; this only renames the label it already renders.
	const thinkingTimer = new ThinkingFoldTimer({
		getTui: () => capturedTui,
		requestRender: () => {
			try {
				capturedTui?.requestRender();
			} catch {
				// tui may be gone between sessions
			}
		},
		getBaseLabel: () => (config.quietMode ? QUIET_THINKING_LABEL : undefined),
		getGlyphs: () => resolveGlyphs(config.icons.mode),
		isThinkingHidden: () => (lastCtx ? readHideThinkingBlock(lastCtx.cwd) : false),
		isEnabled: () => config.enabled,
		setGlobalLabel: (label) => {
			const ctx = lastCtx;
			if (!ctx || !isTuiContext(ctx)) return;
			try {
				ctx.ui.setHiddenThinkingLabel(label);
			} catch {
				// non-TUI or mid-teardown
			}
		},
	});

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
				activeTool: [...activeTools.values()].at(-1),
			};
			ctx.ui.setWorkingMessage(workingMessage(state));
			ctx.ui.setTitle(titleFor(state, { ok: g.check, fail: g.cross }, g.separator));
			ctx.ui.setStatus(COCKPIT_STATUS_KEY, statusText(configProblem, g.blocked));
		} catch {
			// ambient surfaces are best-effort; never let them break a render
		}
	};

	const req = (): void => {
		refreshAmbient();
		try {
			capturedTui?.requestRender();
			sidebarController?.requestRender();
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
	const emitMaestroQuery = (): void => {
		pi.events.emit(COCKPIT_MAESTRO_QUERY_EVENT, { version: MAESTRO_UI_SNAPSHOT_VERSION });
	};
	const publishUiOwnership = (): void => {
		const ownsDock = surfaceState === "dock";
		const ownership: CockpitUiOwnershipV1 = {
			todo: config.enabled,
			agents: config.enabled && config.hideNativeAgents,
			footer: config.enabled,
			sidebar: ownsDock,
			goal: ownsDock,
			todoExpanded: config.todoExpanded,
			quiet: config.enabled && config.quietMode,
			quietSymbols: config.quietSymbols,
		};
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, ownership);
	};
	const setTodoExpanded = (expanded: boolean): void => {
		if (config.todoExpanded === expanded) return;
		config = { ...config, todoExpanded: expanded };
		saveConfig(config);
		publishUiOwnership();
		req();
	};

	// Quiet mode live toggle: widgets and footer read config on every render so
	// they switch immediately. Tool rendering is a one-way latch (registerTool
	// cannot be undone), so turning ON registers immediately but turning OFF
	// requires /reload to restore the default tool shells.
	const applyQuietMode = (ctx: ExtensionContext, was: boolean, now: boolean): void => {
		// Broadcast so cross-extension surfaces (e.g. pi-maestro-flow's todo tool
		// rendering) can follow quiet mode regardless of which path toggled it.
		publishUiOwnership();
		if (now && !was) {
			if (!quietToolsRegistered) {
				registerQuietTools(pi, () => config);
				quietToolsRegistered = true;
			}
			try {
				ctx.ui.setHiddenThinkingLabel(QUIET_THINKING_LABEL);
			} catch { /* non-TUI */ }
			// The label only renames an already-hidden block; the fold itself
			// rides pi's native toggle, which also persists it. Report what
			// actually happened instead of promising a fold we could not reach.
			const folded = ensureThinkingFolded(capturedTui, ctx.cwd, true);
			ctx.ui.notify(
				folded
					? "quiet mode on — tools compressed, thinking folded"
					: "quiet mode on — tools compressed",
				"info",
			);
		} else if (!now && was) {
			try {
				ctx.ui.setHiddenThinkingLabel(undefined);
			} catch { /* non-TUI */ }
			ctx.ui.notify(
				quietToolsRegistered
					? "quiet mode off — /reload to restore default tool rendering"
					: "quiet mode off",
				"info",
			);
		}
	};

	const clearWidgets = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(STACK_WIDGET_KEY, undefined);
		ctx.ui.setWidget(AGENT_WIDGET_KEY, undefined);
	};

	const installWidgets = (ctx: ExtensionContext): void => {
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
					getConfig: () => config,
					isRunning: () => running,
					isAnimating,
				})(tui, theme);
			},
			{ placement: "belowEditor" },
		);
	};

	const reconcileSurface = (ctx: ExtensionContext): void => {
		const next = resolveCockpitSurfaceState(config.enabled, config.sidebar.mode, dockEffectiveVisible);
		if (next === surfaceState) return;
		if (next === "dock" || next === "disabled") clearWidgets(ctx);
		else installWidgets(ctx);
		surfaceState = next;
		publishUiOwnership();
		req();
	};

	const ensureSidebarController = (ctx: ExtensionContext): SidebarController => {
		if (sidebarController) return sidebarController;
		sidebarController = createSidebarController({
			ctx,
			getMaestroSnapshot: () => maestro.snapshot(),
			getTodos: () => todos.snapshot(),
			getAgents: () => agents.snapshot(),
			getJobs: () => bashBg.snapshot(),
			getConfig: () => config,
			shouldAnimate: () => running || bashBg.hasActive() || agents.hasLingering(),
			onVisibilityChange: (visible) => {
				dockEffectiveVisible = visible;
				const activeCtx = lastCtx;
				if (visible) emitMaestroQuery();
				if (activeCtx && isTuiContext(activeCtx)) reconcileSurface(activeCtx);
			},
			onResizeCommit: (width) => {
				config = { ...config, sidebar: { ...config.sidebar, width } };
				const result = saveConfig(config);
				if (!result.ok) {
					configProblem = `sidebar width save failed: ${result.error ?? "unknown error"}`;
					ctx.ui.notify(`Cockpit sidebar width kept for this session; save failed: ${result.error ?? "unknown error"}`, "warning");
				} else if (configProblem?.startsWith("sidebar width save failed:")) {
					configProblem = undefined;
				}
				req();
			},
			onWarning: (message) => ctx.ui.notify(message, "warning"),
			onError: (error) => {
				ctx.ui.notify(`Cockpit sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			},
		});
		return sidebarController;
	};

	const syncSidebarMode = (ctx: ExtensionContext): void => {
		const controller = ensureSidebarController(ctx);
		if (config.sidebar.mode === "off") {
			dockEffectiveVisible = false;
			controller.hide();
		} else {
			controller.show();
		}
		reconcileSurface(ctx);
	};

	const uninstallUi = (ctx: ExtensionContext): void => {
		dockEffectiveVisible = false;
		sidebarController?.dispose();
		sidebarController = undefined;
		clearWidgets(ctx);
		ctx.ui.setFooter(undefined);
		surfaceState = "disabled";
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
		ctx.ui.setFooter((tui, theme, footerData) => {
			capturedTui = tui;
			let observedWidth = tui.terminal.columns;
			const widthTimer = setInterval(() => {
				try {
					const nextWidth = tui.terminal.columns;
					if (!Number.isFinite(nextWidth) || nextWidth <= 0 || nextWidth === observedWidth) return;
					observedWidth = nextWidth;
					// Deliberately skip tui.invalidate(): upstream pi 0.83.0 has a bug
					// where ToolExecutionComponent.updateDisplay() can push undefined
					// into Container.children (renderer returns undefined for a
					// "working" tool).  Container.invalidate() then does
					// `child.invalidate?.()` on that undefined child → TypeError →
					// uncaughtException in this timer callback → pi process exit.
					// requestRender(true) already clears previousLines and forces a
					// full re-render with the new width, which is all we need here.
					tui.requestRender(true);
				} catch {
					// Last-resort guard: a synchronous exception in this timer
					// callback would become an uncaughtException and kill the pi
					// process.  Swallow it so the session survives; the next tick
					// will retry.
				}
			}, WIDTH_POLL_INTERVAL_MS);
			widthTimer.unref?.();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const component = {
				render(width: number): string[] {
					if (Number.isFinite(width) && width > 0) observedWidth = width;
					const cu = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					const extensionStatuses = collectExtensionStatuses(footerData.getExtensionStatuses());
					const glyphs = resolveGlyphs(config.icons.mode);
					const now = Date.now();
					const bashBgStatus = renderBashBgSummary(
						bashBg.snapshot(),
						width,
						theme,
						FOOTER_UTILS,
						{
							glyphs,
							spin: spinFrame(glyphs, now, isAnimating()),
							now,
						},
					)[0];
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
						bashBgStatus,
						workflowStatus: extensionStatuses.find((status) => status.key === WORKFLOW_STATUS_KEY)?.text,
						extensionStatuses: extensionStatuses.filter((status) => status.key !== WORKFLOW_STATUS_KEY),
						glyphs,
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
		syncSidebarMode(ctx);
		// Re-enabling mid-run must restart live spinner and elapsed updates.
		syncTick();
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
	pi.events.on(MAESTRO_UI_SNAPSHOT_EVENT, (payload) => {
		if (!maestro.applySnapshot(payload)) return;
		req();
	});
	pi.events.on(COCKPIT_TODO_TOGGLE_EVENT, (payload) => {
		if (!config.enabled) return;
		const requested = payload && typeof payload === "object"
			? (payload as { expanded?: unknown }).expanded
			: undefined;
		setTodoExpanded(typeof requested === "boolean" ? requested : !config.todoExpanded);
	});

	// --- foreground tool label + todo changes ---
	pi.on("tool_execution_start", (e) => {
		activeTools.set(e.toolCallId, e.toolName);
		req();
	});
	pi.on("tool_execution_end", (e, ctx) => {
		activeTools.delete(e.toolCallId);
		if (e.toolName === TODO_TOOL_NAME) {
			todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		}
		req();
	});

	// --- session + agent lifecycle ---
	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		configProblem = undefined;
		activeTools.clear();
		thinkingTimer.reset();
		maestro.clear();
		ensureConfigExists();
		config = loadConfig((m, l) => {
			try {
				ctx.ui.notify(m, l);
			} catch {
				// notify unavailable
			}
		});
		invalidateUsageCache();
		// Quiet mode: register compact tool renderers and fold thinking blocks.
		// Tools are normally registered at extension load time (above) so they
		// are available before pi renders resumed history.  This session_start
		// path is a fallback for the rare case where the early config load
		// returned defaults but the persisted config enables quiet mode.
		if (config.quietMode && !quietToolsRegistered) {
			registerQuietTools(pi, () => config);
			quietToolsRegistered = true;
		}
		if (config.quietMode) {
			try {
				ctx.ui.setHiddenThinkingLabel(QUIET_THINKING_LABEL);
			} catch {
				// non-TUI mode
			}
		}
		// The theme is deliberately NOT re-applied here. ctx.ui.setTheme writes
		// through to pi's own settings, so pi already restores the user's choice on
		// its own. Replaying cockpit's copy would overwrite whatever the user set
		// through /settings since — including an automatic "light/dark" pair, which
		// cockpit cannot represent and would silently flatten to a single theme.
		todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		if (config.enabled) {
			publishUiOwnership();
			applyUi(ctx);
		} else {
			applyUi(ctx);
			publishUiOwnership();
		}
		// applyUi captured the TUI synchronously, so the native toggle is
		// reachable already; a no-op when cockpit is disabled or non-TUI.
		if (config.quietMode) ensureThinkingFolded(capturedTui, ctx.cwd, true);
		pi.events.emit(BASH_BG_QUERY_EVENT, undefined);
		emitMaestroQuery();
		req();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (lastCtx) uninstallUi(lastCtx);
		const released: CockpitUiOwnershipV1 = {
			todo: false,
			agents: false,
			footer: false,
			sidebar: false,
			goal: false,
			todoExpanded: config.todoExpanded,
			quiet: false,
			quietSymbols: config.quietSymbols,
		};
		pi.events.emit(COCKPIT_UI_OWNERSHIP_EVENT, released);
		lastCtx = undefined;
		running = false;
		activeTools.clear();
		thinkingTimer.reset();
		invalidateUsageCache();
		agents.clear();
		bashBg.clear();
		maestro.clear();
	});

	pi.on("agent_start", () => {
		running = true;
		startTick();
		req();
	});
	pi.on("agent_end", () => {
		running = false;
		activeTools.clear();
		thinkingTimer.stop();
		syncTick();
		req();
	});

	// --- live labels for folded thinking rows ---
	pi.on("message_update", (e) => {
		thinkingTimer.onAssistantMessageEvent(e.assistantMessageEvent);
	});

	// --- redraw triggers for the footer's live data ---
	pi.on("message_end", (e, ctx) => {
		// Settle an interrupted thinking run: message_end fires for aborted
		// and failed messages too, while the row is still mounted.
		if (e.message.role === "assistant") thinkingTimer.onAssistantMessageEnd();
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

	const setSidebarMode = (
		ctx: ExtensionContext,
		mode: CockpitConfig["sidebar"]["mode"],
	): void => {
		if (config.sidebar.mode === mode) {
			ctx.ui.notify(`Cockpit sidebar: ${mode}`, "info");
			return;
		}
		config = { ...config, sidebar: { ...config.sidebar, mode } };
		const result = saveConfig(config);
		if (!result.ok) {
			ctx.ui.notify(`Cockpit sidebar mode kept for this session; save failed: ${result.error ?? "unknown error"}`, "warning");
		} else if (configProblem?.startsWith("sidebar width save failed:")) {
			configProblem = undefined;
		}
		if (config.enabled && isTuiContext(ctx)) syncSidebarMode(ctx);
		publishUiOwnership();
		req();
	};

	pi.registerShortcut(BASH_BG_OVERLAY_KEY, {
		description: "Open background Bash jobs — live status, command, cwd, duration and output tail",
		async handler(ctx) {
			await openBashBgOverlay(ctx);
		},
	});

	pi.registerShortcut(SIDEBAR_RESIZE_KEY, {
		description: "Resize the Cockpit sidebar",
		handler(ctx) {
			if (!config.enabled) {
				ctx.ui.notify("Cockpit is disabled", "warning");
				return;
			}
			sidebarController?.beginResize();
		},
	});

	// --- /cockpit: settings plus direct surface controls ---
	pi.registerCommand("cockpit", {
		description: "Open pi-cockpit settings; /cockpit sidebar controls the dock, /cockpit bg shows jobs",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const candidates = [
				"quiet", "quiet on", "quiet off", "bg", "jobs", "todo", "todo expand", "todo collapse",
				"sidebar", "sidebar auto", "sidebar on", "sidebar off", "sidebar resize",
			];
			const matches = candidates.filter((c) => c.startsWith(query));
			return matches.length > 0 ? matches.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const action = args.trim().toLowerCase();
			if (action === "bg" || action === "jobs") {
				await openBashBgOverlay(ctx);
				return;
			}
			if (action === "sidebar") {
				ctx.ui.notify(
					`Cockpit sidebar: ${config.sidebar.mode} · ${config.sidebar.width} columns · ${config.sidebar.density}`,
					"info",
				);
				return;
			}
			if (action === "sidebar resize") {
				if (!config.enabled) ctx.ui.notify("Cockpit is disabled", "warning");
				else sidebarController?.beginResize();
				return;
			}
			if (action === "sidebar auto" || action === "sidebar on" || action === "sidebar off") {
				setSidebarMode(ctx, action.slice("sidebar ".length) as CockpitConfig["sidebar"]["mode"]);
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
			if (action === "quiet" || action === "quiet toggle") {
				const was = config.quietMode;
				config = { ...config, quietMode: !was };
				saveConfig(config);
				applyQuietMode(ctx, was, config.quietMode);
				req();
				return;
			}
			if (action === "quiet on" || action === "quiet off") {
				const target = action === "quiet on";
				if (config.quietMode === target) return;
				const was = config.quietMode;
				config = { ...config, quietMode: target };
				saveConfig(config);
				applyQuietMode(ctx, was, target);
				req();
				return;
			}
			await openSettings(ctx);
		},
	});

	const openSettings = async (ctx: ExtensionCommandContext): Promise<void> =>
		ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let settingsCursor = 0;
			let saveState: SaveState = { kind: "idle" };
			let enableAfterClose = false;
			// Mirror of pi's hideThinkingBlock, read when the panel opens. The
			// overlay captures input, so Ctrl+T cannot flip it while this is open
			// and the mirror stays exact until the panel closes.
			let thinkingHidden = readHideThinkingBlock(ctx.cwd);
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
				const wasQuiet = config.quietMode;
				const wasSidebarMode = config.sidebar.mode;
				if (key === "theme") {
					// Delegate: the picker previews live and reverts on Esc, neither of
					// which a blind one-key cycle through the name list can do.
					sub = makeThemePicker(ctx, tui, theme, closeSub);
					tui.requestRender();
					return;
				}
				if (key === "thinkingFold") {
					// Pass-through row: pi owns hideThinkingBlock, so bring it to the
					// wanted state through the native toggle instead of saving config.
					// pi persists the flip synchronously through its settingsManager.
					const target = !thinkingHidden;
					const ok = ensureThinkingFolded(tui, ctx.cwd, target);
					if (ok) thinkingHidden = target;
					saveState = ok
						? { kind: "saved" }
						: { kind: "failed", message: "editor unreachable" };
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
				if (result.ok && configProblem?.startsWith("sidebar width save failed:")) {
					configProblem = undefined;
				}
				if (wasEnabled !== config.enabled) {
					if (config.enabled) {
						// Creating a non-capturing sidebar while this capturing settings
						// overlay is still open would put it on top; settings done() would
						// then close the sidebar. Acquire/install only after settings disposes.
						enableAfterClose = true;
					} else {
						enableAfterClose = false;
						uninstallUi(ctx);
						publishUiOwnership();
					}
				} else {
					if (config.enabled && wasSidebarMode !== config.sidebar.mode) syncSidebarMode(ctx);
					publishUiOwnership();
				}
				if (wasQuiet !== config.quietMode) {
					applyQuietMode(ctx, wasQuiet, config.quietMode);
				}
				req();
			};
			const ui = {
				render(width: number): string[] {
					// The sub-view takes the whole card. It carries its own title and
					// key hints, so stacking the panel's chrome above it would spend two
					// rows saying nothing the picker does not already say.
					if (sub) return sub.render(width);
					const paint: PaintTheme = theme;
					const rows = buildRows(config, { thinkingHidden });
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
					// Thinking fold is pi's setting too (Ctrl+T), mirrored live here.
					lines.push(paint.fg("dim", "theme & thinking are stored by pi"));
					lines.push(paint.fg("dim", "/settings pairs light+dark"));
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
					const rows = buildRows(config, { thinkingHidden });
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
					if (enableAfterClose && config.enabled) {
						queueMicrotask(() => {
							if (lastCtx !== ctx || !config.enabled) return;
							publishUiOwnership();
							applyUi(ctx);
							req();
						});
					}
				},
			};
			return ui;
		}, { overlay: true });
}
