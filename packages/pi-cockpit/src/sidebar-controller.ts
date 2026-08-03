import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { MaestroUiStateSnapshotV1 } from "./public/v1/events.ts";
import { renderSidebar, renderSidebarError } from "./sidebar-render.ts";
import {
	createSplitPaneController,
	DEFAULT_SIDEBAR_WIDTH,
	type SplitPaneController,
} from "./split-pane.ts";
import type { AgentRow, BashBgJob, CockpitConfig, TodoItem } from "./types.ts";

export interface SidebarComponentOptions {
	getMaestroSnapshot(): MaestroUiStateSnapshotV1 | undefined;
	getTodos(): readonly TodoItem[];
	getAgents(): readonly AgentRow[];
	getJobs(): readonly BashBgJob[];
	getConfig(): CockpitConfig;
	getHeight(): number;
	isResizing(): boolean;
	/** Browse-window offset (content rows skipped) while the sidebar has keyboard focus. */
	getScrollStart(): number;
	theme: Theme;
	onRenderError?(error: unknown): void;
	now?(): number;
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	const reportRenderError = (error: unknown): void => {
		try {
			options.onRenderError?.(error);
		} catch {
			// Error reporting must never escape Component.render().
		}
	};
	return {
		render(width: number): string[] {
			let height = 1;
			let resizing = false;
			try {
				const measured = options.getHeight();
				height = Number.isFinite(measured) && measured > 0 ? Math.trunc(measured) : 1;
				resizing = options.isResizing();
				return renderSidebar({
					maestro: options.getMaestroSnapshot(),
					todos: options.getTodos(),
					agents: options.getAgents(),
					jobs: options.getJobs(),
					config: options.getConfig(),
					width,
					height,
					theme: options.theme,
					now: options.now?.() ?? Date.now(),
					resizing,
					scrollStart: options.getScrollStart(),
				});
			} catch (error) {
				reportRenderError(error);
				try {
					return renderSidebarError(error, width, height, options.theme, resizing, options.getConfig().icons.mode);
				} catch {
					return [truncateToWidth("Cockpit sidebar unavailable", Math.max(1, width), "")];
				}
			}
		},
		invalidate(): void {},
	};
}

export interface SidebarController {
	show(): void;
	hide(): void;
	toggle(): void;
	isVisible(): boolean;
	beginResize(): boolean;
	cancelResize(): void;
	isResizing(): boolean;
	/** Enter sidebar keyboard-focus (browse) mode; returns false when there is nothing to navigate. */
	beginFocus(): boolean;
	endFocus(): void;
	isFocused(): boolean;
	getWidth(): number;
	setWidth(width: number): void;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getMaestroSnapshot(): MaestroUiStateSnapshotV1 | undefined;
	getTodos(): readonly TodoItem[];
	getAgents(): readonly AgentRow[];
	getJobs(): readonly BashBgJob[];
	getConfig(): CockpitConfig;
	now?(): number;
	/** Terminal rows used to size the browse window; defaults to 12. */
	getHeight?(): number;
	/** When true the sidebar runs its own periodic redraw (duration ticks, spinners). */
	shouldAnimate?(): boolean;
	/** Interval for the sidebar's own animation timer. Defaults to 1000ms. */
	animationIntervalMs?: number;
	onResizeCommit?(width: number): void | Promise<void>;
	onVisibilityChange?(visible: boolean): void;
	onEffectiveWidthChange?(width: number): void;
	onWarning?(message: string): void;
	onError?(error: unknown): void;
	schedule?(callback: () => void): void;
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	let enabled = false;
	let disposed = false;
	let generation = 0;
	let overlayPending = false;
	let requestOverlayRender: (() => void) | undefined;
	let splitRequestRender: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	// Sidebar keyboard-focus (browse) mode: a global terminal-input hook like
	// resize, entered explicitly via shortcut so it never steals keys by default.
	let focused = false;
	let focusScroll = 0;
	let focusSelectedId: string | undefined;
	let navRows: Array<{ id: string }> = [];
	let unsubscribeFocusInput: (() => void) | undefined;
	const animationIntervalMs = Math.max(1, Math.trunc(options.animationIntervalMs ?? 1_000));
	const schedule = options.schedule ?? queueMicrotask;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Error reporting must not interrupt lifecycle cleanup.
		}
	};

	const safely = (action: () => unknown): boolean => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(reportError);
			}
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	};

	// --- Animation timer (pi-atelier syncAnimation pattern) ---
	const stopAnimation = (): void => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};
	const syncAnimation = (): void => {
		if (!enabled || options.shouldAnimate?.() !== true || !requestOverlayRender) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			safely(() => requestOverlayRender?.());
		}, animationIntervalMs);
		animationTimer.unref?.();
	};

	let initialWidth = DEFAULT_SIDEBAR_WIDTH;
	try {
		initialWidth = options.getConfig().sidebar.width;
	} catch (error) {
		reportError(error);
	}

	const split: SplitPaneController = createSplitPaneController({
		defaultSidebarWidth: initialWidth,
		subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
		onResizeChange: () => {
			safely(() => requestOverlayRender?.());
			safely(() => splitRequestRender?.());
		},
		onResizeCommit: (width) => {
			if (!disposed) safely(() => options.onResizeCommit?.(width));
		},
		onVisibilityChange: (visible) => {
			if (!disposed) safely(() => options.onVisibilityChange?.(visible));
		},
		onEffectiveWidthChange: (width) => {
			if (!disposed) safely(() => options.onEffectiveWidthChange?.(width));
		},
		onWarning: (message) => {
			if (options.onWarning) safely(() => options.onWarning?.(message));
			else safely(() => options.ctx.ui.notify(message, "warning"));
		},
		onError: reportError,
		schedule,
	});

	const clearOverlayCallbacks = (): void => {
		requestOverlayRender = undefined;
		splitRequestRender = undefined;
		overlayHandle = undefined;
	};

	// --- Sidebar browse (focus) mode ---
	const rebuildNav = (): void => {
		try {
			const todoIds = options.getTodos().map((item) => `task:${item.id}`);
			const agentIds = options.getAgents().map((row) => `agent:${row.correlationId}`);
			const jobIds = options.getJobs().map((job) => `job:${job.id}`);
			navRows = [...todoIds, ...agentIds, ...jobIds].map((id) => ({ id }));
		} catch {
			navRows = [];
		}
	};
	const focusVisibleRows = (): number => Math.max(1, Math.trunc((options.getHeight?.() ?? 12) - 4));
	const reconcileFocus = (): void => {
		rebuildNav();
		if (navRows.length === 0) {
			focusScroll = 0;
			return;
		}
		const visible = focusVisibleRows();
		// Stable-id anchor: when a selected entity survives a store reorder, keep
		// its window position; when it disappears, fall back to clamping (SB-3).
		if (focusSelectedId) {
			const index = navRows.findIndex((row) => row.id === focusSelectedId);
			if (index >= 0) {
				if (index < focusScroll) focusScroll = index;
				else if (index >= focusScroll + visible) focusScroll = index - visible + 1;
			} else {
				focusSelectedId = undefined;
			}
		}
		focusScroll = Math.max(0, Math.min(focusScroll, Math.max(0, navRows.length - visible)));
	};
	const moveFocus = (delta: number): void => {
		rebuildNav();
		if (navRows.length === 0) return;
		const current = focusSelectedId ? navRows.findIndex((row) => row.id === focusSelectedId) : -1;
		const next = current < 0 ? 0 : Math.max(0, Math.min(navRows.length - 1, current + delta));
		focusSelectedId = navRows[next]?.id;
		reconcileFocus();
		requestOverlayRender?.();
	};
	const handleFocusInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		if (!focused) return undefined;
		if (matchesKey(data, Key.escape)) {
			endFocus();
			return { consume: true };
		}
		if (matchesKey(data, Key.up) || data === "k") {
			moveFocus(-1);
			return { consume: true };
		}
		if (matchesKey(data, Key.down) || data === "j") {
			moveFocus(1);
			return { consume: true };
		}
		if (matchesKey(data, Key.pageUp)) {
			moveFocus(-focusVisibleRows());
			return { consume: true };
		}
		if (matchesKey(data, Key.pageDown)) {
			moveFocus(focusVisibleRows());
			return { consume: true };
		}
		if (matchesKey(data, Key.home)) {
			focusSelectedId = navRows[0]?.id;
			reconcileFocus();
			requestOverlayRender?.();
			return { consume: true };
		}
		if (matchesKey(data, Key.end)) {
			focusSelectedId = navRows[navRows.length - 1]?.id;
			reconcileFocus();
			requestOverlayRender?.();
			return { consume: true };
		}
		return undefined;
	};
	const beginFocus = (): boolean => {
		if (focused) return true;
		if (!enabled) {
			if (options.onWarning) safely(() => options.onWarning?.("Cockpit sidebar is not visible"));
			else safely(() => options.ctx.ui.notify("Cockpit sidebar is not visible", "warning"));
			return false;
		}
		rebuildNav();
		if (navRows.length === 0) {
			safely(() => options.ctx.ui.notify("Nothing to browse in the Cockpit sidebar", "warning"));
			return false;
		}
		// The browse hook mirrors the resize listener pattern; it must yield to
		// any capturing overlay, so a preempt event cancels it too.
		focused = true;
		try {
			unsubscribeFocusInput = options.ctx.ui.onTerminalInput(handleFocusInput);
		} catch (error) {
			focused = false;
			reportError(error);
			return false;
		}
		requestOverlayRender?.();
		return true;
	};
	const endFocus = (): void => {
		if (!focused && !unsubscribeFocusInput) return;
		focused = false;
		const unsubscribe = unsubscribeFocusInput;
		unsubscribeFocusInput = undefined;
		if (unsubscribe) safely(unsubscribe);
		requestOverlayRender?.();
	};

	const hide = (): void => {
		if (!enabled && !split.isEnabled()) return;
		enabled = false;
		generation += 1;
		stopAnimation();
		safely(split.cancelResize);
		safely(() => overlayHandle?.setHidden(true));
		safely(split.hide);
	};

	const show = (): void => {
		if (disposed || enabled) return;
		if (options.ctx.mode !== "tui") {
			reportError(new Error("Cockpit sidebar requires TUI mode"));
			return;
		}
		enabled = true;
		const currentGeneration = ++generation;
		if (!safely(split.show)) {
			enabled = false;
			generation += 1;
			stopAnimation();
			safely(split.hide);
			return;
		}
		if (overlayHandle) {
			safely(() => overlayHandle?.setHidden(false));
			requestOverlayRender?.();
			syncAnimation();
			return;
		}
		if (overlayPending) return;
		overlayPending = true;
		try {
			const pending = options.ctx.ui.custom<void>(
				(tui, theme, _keybindings, _done) => {
					const attached = safely(() => split.attach(tui));
					if (!attached) {
						enabled = false;
						generation += 1;
						stopAnimation();
						safely(split.hide);
					} else {
						splitRequestRender = () => tui.requestRender();
						requestOverlayRender = () => tui.requestRender();
					}
					return createSidebarComponent({
						getMaestroSnapshot: options.getMaestroSnapshot,
						getTodos: options.getTodos,
						getAgents: options.getAgents,
						getJobs: options.getJobs,
						getConfig: options.getConfig,
						getHeight: () => tui.terminal.rows,
						isResizing: split.isResizing,
						getScrollStart: () => (focused ? focusScroll : 0),
						theme,
						...(options.now ? { now: options.now } : {}),
						onRenderError: (error) => {
							schedule(() => {
								if (!disposed) reportError(error);
							});
						},
					});
				},
				{
					overlay: true,
					overlayOptions: () => split.overlayOptions(),
					onHandle: (handle) => {
						overlayPending = false;
						if (disposed) {
							safely(() => handle.hide());
							return;
						}
						// Cockpit reuses the overlay handle across show/hide cycles
						// (setHidden, not destroy), so a handle delivered after hide()
						// is kept and marked hidden for a later show() to reuse.  The
						// generation guard lives in the pending .finally() instead, where
						// a stale settle must not reset the new cycle's enabled flag.
						overlayHandle = handle;
						if (!enabled) safely(() => handle.setHidden(true));
						else syncAnimation();
					},
				},
			);
			void pending
				.catch((error: unknown) => {
					overlayPending = false;
					reportError(error);
				})
				.finally(() => {
					if (generation !== currentGeneration) return;
					overlayPending = false;
					enabled = false;
					stopAnimation();
				});
		} catch (error) {
			overlayPending = false;
			if (generation === currentGeneration) {
				enabled = false;
				stopAnimation();
				safely(split.hide);
			}
			reportError(error);
		}
	};

	return {
		show,
		hide,
		toggle() {
			if (enabled) hide();
			else show();
		},
		isVisible: () => enabled,
		beginResize: () => {
			// Resize and browse are mutually exclusive modal hooks on the same
			// terminal-input channel; entering one must leave the other.
			endFocus();
			return split.beginResize();
		},
		cancelResize: split.cancelResize,
		isResizing: split.isResizing,
		beginFocus,
		endFocus,
		isFocused: () => focused,
		getWidth: split.getSidebarWidth,
		setWidth: split.setSidebarWidth,
		requestRender() {
			safely(() => requestOverlayRender?.());
			safely(split.requestRender);
			syncAnimation();
		},
		dispose() {
			if (disposed) return;
			hide();
			endFocus();
			disposed = true;
			stopAnimation();
			safely(() => overlayHandle?.hide());
			clearOverlayCallbacks();
			safely(split.dispose);
		},
	};
}
