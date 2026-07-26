import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { BashBgStore } from "./bash-bg-store.ts";
import { BashBgOverlay } from "./bash-bg-overlay.ts";
import { TodoStore } from "./todo-store.ts";
import { makeTodoWidget, makeAgentWidget } from "./stack-widget.ts";
import { formatDuration } from "./render.ts";
import { getUsageTotals, invalidateUsageCache, renderFooter, type PaintTheme, type WidthUtils } from "./footer.ts";
import { collectExtensionStatuses } from "./extension-status.ts";
import { resolveGlyphs } from "./icons.ts";
import { ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
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

	const req = (): void => {
		try {
			capturedTui?.requestRender();
		} catch {
			// tui may be gone between sessions
		}
	};
	const startTick = (): void => {
		if (tick) return;
		tick = setInterval(() => {
			if (running || bashBg.hasActive()) req();
		}, 250);
		tick.unref?.();
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
				})(tui, theme);
			},
			{ placement: "belowEditor" },
		);
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
		req();
	});
	pi.events.on(BASH_BG_UPDATE_EVENT, (payload) => {
		if (!bashBg.applySnapshot(payload)) return;
		if (bashBg.hasActive()) startTick();
		else if (!running) stopTick();
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
		if (!bashBg.hasActive()) stopTick();
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
				let view: CockpitConfig = { ...config };
				const commit = (): void => {
					const wasEnabled = config.enabled;
					config = view;
					saveConfig(config);
					if (wasEnabled !== config.enabled) {
						if (config.enabled) applyUi(ctx);
						else uninstallUi(ctx);
					}
					publishUiOwnership();
					req();
				};
				const cycle = (m: "list" | "compact"): "list" | "compact" => (m === "list" ? "compact" : "list");
				const ui = {
					render(width: number): string[] {
						const paint: PaintTheme = theme;
						const row = (k: string, v: string): string =>
							`  ${paint.fg("muted", k.padEnd(13))} ${paint.fg("accent", v)}`;
						const w = Math.min(width, 44);
						return [
							paint.fg("text", "pi-cockpit"),
							paint.fg("dim", "─".repeat(w)),
							row("enabled", view.enabled ? "on" : "off"),
							row("agents", view.agentsMode),
							row("todo", view.todoMode),
							row("todo expand", view.todoExpanded ? "yes" : "no"),
							row("hide native", view.hideNativeAgents ? "yes" : "no"),
							"",
							paint.fg("dim", "e enabled · a agents · t todo · x expand · n hide-native · Esc close"),
						];
					},
					invalidate(): void {},
					handleInput(data: string): void {
						if (data === "e") view = { ...view, enabled: !view.enabled };
						else if (data === "a") view = { ...view, agentsMode: cycle(view.agentsMode) };
						else if (data === "t") view = { ...view, todoMode: cycle(view.todoMode) };
						else if (data === "x") view = { ...view, todoExpanded: !view.todoExpanded };
						else if (data === "n") view = { ...view, hideNativeAgents: !view.hideNativeAgents };
						else if (matchesKey(data, Key.escape)) {
							commit();
							done(undefined);
							return;
						} else {
							return;
						}
						commit();
						tui.requestRender();
					},
					dispose(): void {},
				};
				return ui;
			}, { overlay: true });
		},
	});
}
