import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsStore, type CompletePayload, type MessagePayload, type StartedPayload } from "./agents-store.ts";
import { TodoStore } from "./todo-store.ts";
import { makeStackWidget } from "./stack-widget.ts";
import { getUsageTotals, renderFooter, type PaintTheme, type WidthUtils } from "./footer.ts";
import { ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import {
	DEFAULT_CONFIG,
	NATIVE_AGENTS_WIDGET_KEY,
	STACK_WIDGET_KEY,
	TEAMMATE_COMPLETE_EVENT,
	TEAMMATE_MESSAGE_EVENT,
	TEAMMATE_STARTED_EVENT,
	TODO_TOOL_NAME,
	type CockpitConfig,
} from "./types.ts";

const FOOTER_UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `0:${String(s).padStart(2, "0")}`;
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI): void {
	const agents = new AgentsStore();
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
			if (running) req();
		}, 250);
		tick.unref?.();
	};
	const stopTick = (): void => {
		if (tick) {
			clearInterval(tick);
			tick = undefined;
		}
	};

	const uninstallUi = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(STACK_WIDGET_KEY, undefined);
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
				return makeStackWidget({
					getAgents: () => agents.snapshot(),
					getTodos: () => todos.snapshot(),
					getConfig: () => config,
					isRunning: () => running,
				})(tui, theme);
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setFooter((tui, theme, footerData) => {
			capturedTui = tui;
			const component = {
				render(width: number): string[] {
					const cu = ctx.getContextUsage();
					const branch = footerData.getGitBranch();
					return renderFooter({
						width,
						model: ctx.model?.id ?? "no-model",
						provider: ctx.model?.provider,
						ctxPct: cu?.percent ?? 0,
						ctxTokens: cu?.tokens ?? 0,
						ctxWindow: cu?.contextWindow ?? ctx.model?.contextWindow ?? 0,
						totals: getUsageTotals(ctx.sessionManager.getEntries()),
						git: branch ?? undefined,
						elapsed: fmtElapsed(Date.now() - sessionStart),
						ascii: false,
						theme,
						utils: FOOTER_UTILS,
					});
				},
				invalidate(): void {},
				dispose(): void {},
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
		todos.hydrateFromEntries(ctx.sessionManager.getEntries());
		applyUi(ctx);
		if (config.hideNativeAgents) {
			try {
				ctx.ui.setWidget(NATIVE_AGENTS_WIDGET_KEY, undefined);
			} catch {
				// native widget absent on bare pi
			}
		}
		req();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (lastCtx) uninstallUi(lastCtx);
		lastCtx = undefined;
		running = false;
		agents.clear();
	});

	pi.on("agent_start", () => {
		running = true;
		startTick();
		req();
	});
	pi.on("agent_end", () => {
		running = false;
		stopTick();
		req();
	});

	// --- redraw triggers for the footer's live data ---
	pi.on("message_end", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});
	pi.on("model_select", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});
	pi.on("session_compact", (_e, ctx) => {
		if (isTuiContext(ctx)) req();
	});

	// --- /cockpit: toggle list/compact + enabled + hide-native ---
	pi.registerCommand("cockpit", {
		description: "Open pi-cockpit settings (list/compact modes, enabled, hide native agents)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
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
					if (config.hideNativeAgents) {
						try {
							ctx.ui.setWidget(NATIVE_AGENTS_WIDGET_KEY, undefined);
						} catch {
							// ignore
						}
					}
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
							row("hide native", view.hideNativeAgents ? "yes" : "no"),
							"",
							paint.fg("dim", "e enabled · a agents · t todo · n hide-native · Esc close"),
						];
					},
					invalidate(): void {},
					handleInput(data: string): void {
						if (data === "e") view = { ...view, enabled: !view.enabled };
						else if (data === "a") view = { ...view, agentsMode: cycle(view.agentsMode) };
						else if (data === "t") view = { ...view, todoMode: cycle(view.todoMode) };
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
