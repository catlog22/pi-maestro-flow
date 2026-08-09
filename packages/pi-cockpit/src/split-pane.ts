/**
 * Split-pane behavior is derived from pi-atelier's MIT-licensed split pane.
 * Copyright (c) 2026 Michael. Adapted for pi-cockpit.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { ambientKeysShouldYield } from "./capturing-overlay.ts";
import { attachViewportStability, type ViewportStabilityPatch } from "./viewport-stability.ts";
import { acquireMouseReporting, flushMouseReportingWrites, type MouseReportingLease } from "./mouse-reporting.ts";
import { readStableReference } from "./stable-reference.ts";
import { tuiT } from "./tui-i18n.ts";

const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
// Legacy X10 mouse: ESC [ M + 3 bytes (button+32, x+32, y+32). Some terminals fall
// back to it when SGR (1006) is not active; wheel still uses 64/65 in the button byte.
const X10_MOUSE = /^\u001b\[M(.{3})$/s;

export const DEFAULT_SIDEBAR_WIDTH = 40;
export const MIN_SIDEBAR_WIDTH = 32;
export const MAX_SIDEBAR_WIDTH = 56;
export const MIN_MAIN_WIDTH = 72;
export const MIN_SPLIT_TERMINAL_WIDTH = MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH;
export const COCKPIT_SPLIT_PANE_MARKER = Symbol.for("pi-cockpit.split-pane-render");
/** TUI-instance ownership, robust against the render chain being wrapped by another renderer. */
const COCKPIT_SPLIT_PANE_OWNER = Symbol.for("pi-cockpit.split-pane-tui-owner");
type TuiWithOwner = TUI & Record<symbol, unknown>;

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(SGR_MOUSE);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

/** Parse the legacy X10 mouse encoding into the same SgrMouseEvent shape. */
export function parseX10MouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(X10_MOUSE);
	if (!match) return undefined;
	const raw = match[1].charCodeAt(0) - 32;
	const x = match[1].charCodeAt(1) - 32;
	const y = match[1].charCodeAt(2) - 32;
	if (x < 1 || y < 1 || raw < 0) return undefined;
	const release = (raw & 3) === 3;
	// Normalise the release bits (X10 uses 3) away so downstream routing sees the
	// same button value as an SGR release (0) and satisfies (button & 31) === 0.
	const button = release ? raw & ~3 : raw;
	return { button, x, y, release, motion: (raw & 32) !== 0 };
}

type RenderFunction = TUI["render"];
type InputResult = { consume?: boolean; data?: string } | undefined;

interface RenderMarker {
	owner: object;
	original: RenderFunction;
}

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => InputResult): () => void;
	onResizeChange?(resizing: boolean): void;
	onResizeCommit?(width: number): void;
	onVisibilityChange?(visible: boolean): void;
	onEffectiveWidthChange?(width: number): void;
	onWarning?(message: string): void;
	/** Tests may inject a scheduler; production uses queueMicrotask. */
	schedule?(callback: () => void): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(): void;
	hide(): void;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	getEffectiveSidebarWidth(terminalWidth?: number): number;
	isEnabled(): boolean;
	isVisibleAtWidth(terminalWidth: number): boolean;
	beginResize(): boolean;
	finishResize(): void;
	cancelResize(): void;
	isResizing(): boolean;
	overlayOptions(): OverlayOptions;
	requestRender(): void;
	dispose(): void;
}

function finiteInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function renderMarker(render: RenderFunction): RenderMarker | undefined {
	return (render as RenderFunction & Record<symbol, RenderMarker | undefined>)[COCKPIT_SPLIT_PANE_MARKER];
}

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	const minimumSidebar = Math.max(
		1,
		finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH),
	);
	const maximumSidebar = Math.max(
		minimumSidebar,
		finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
	);
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
	let sidebarWidth = clamp(
		finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
		minimumSidebar,
		maximumSidebar,
	);
	const owner = {};
	let tui: TUI | undefined;
	let originalRender: RenderFunction | undefined;
	let wrappedRender: RenderFunction | undefined;
	let viewportStability: ViewportStabilityPatch | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let dragButton: number | undefined;
	let mouseLease: MouseReportingLease | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let mouseReportingEnabled = false;
	let lastPublishedVisible: boolean | undefined;
	let lastPublishedWidth: number | undefined;
	let pendingVisible = false;
	let pendingWidth = 0;
	let dockNotificationScheduled = false;
	let dragRenderScheduled = false;
	let controller: SplitPaneController;

	const safely = (action: () => unknown): void => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Cleanup and callbacks are best effort; the renderer must remain usable.
		}
	};

	const schedule = options.schedule ?? queueMicrotask;
	const publishDockState = (width: number): void => {
		pendingWidth = width;
		pendingVisible = width > 0;
		if (dockNotificationScheduled) return;
		dockNotificationScheduled = true;
		schedule(() => {
			dockNotificationScheduled = false;
			if (disposed) return;
			const width = pendingWidth;
			const visible = pendingVisible;
			const widthChanged = lastPublishedWidth !== width;
			const visibilityChanged = lastPublishedVisible !== visible;
			lastPublishedWidth = width;
			lastPublishedVisible = visible;
			if (visibilityChanged) safely(() => options.onVisibilityChange?.(visible));
			if (widthChanged) safely(() => options.onEffectiveWidthChange?.(width));
		});
	};

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && Number.isFinite(terminalWidth) && terminalWidth >= minimumMain + minimumSidebar;

	const effectiveSidebarWidth = (terminalWidth: number): number => {
		if (!visibleAt(terminalWidth)) return 0;
		return clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain));
	};

	const overlayLayout: OverlayOptions = {
		anchor: "top-right",
		width: sidebarWidth,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth) => visibleAt(terminalWidth),
	};

	const syncOverlayWidth = (terminalWidth = tui?.terminal.columns): number => {
		const effectiveWidth = terminalWidth === undefined ? 0 : effectiveSidebarWidth(terminalWidth);
		overlayLayout.width = effectiveWidth > 0 ? effectiveWidth : sidebarWidth;
		return effectiveWidth;
	};

	const requestRender = (): void => {
		safely(() => tui?.requestRender());
	};
	const requestDragRender = (): void => {
		if (dragRenderScheduled) return;
		dragRenderScheduled = true;
		schedule(() => {
			dragRenderScheduled = false;
			if (disposed) return;
			requestRender();
		});
	};

	const sidebarNudge = (tui: TUI | undefined, delta: number): void => {
		// Keyboard wins over an in-flight mouse drag: end the drag so the next
		// motion cannot overwrite the keyboard result (SP-3).
		dragging = false;
		dragButton = undefined;
		// Clamp to the current effective maximum, not the global one, so a narrow
		// terminal cannot store a width its visible overlay can never show (SP-4).
		const columns = tui?.terminal.columns;
		const effectiveMax = columns !== undefined && Number.isFinite(columns)
			? Math.min(maximumSidebar, columns - minimumMain)
			: maximumSidebar;
		controller.setSidebarWidth(clamp(sidebarWidth + delta, minimumSidebar, Math.max(minimumSidebar, effectiveMax)));
	};

	const stopResize = (restore: boolean, commit: boolean): void => {
		const wasResizing = resizing;
		if (!wasResizing && !mouseReportingEnabled && !unsubscribeInput) return;
		if (restore) sidebarWidth = resizeStartWidth;
		const effectiveWidth = syncOverlayWidth();
		const lease = mouseLease;
		const unsubscribe = unsubscribeInput;
		dragging = false;
		resizing = false;
		mouseReportingEnabled = false;
		unsubscribeInput = undefined;
		if (lease) {
			lease.release();
			mouseLease = undefined;
		}
		if (unsubscribe) safely(unsubscribe);
		if (wasResizing) safely(() => options.onResizeChange?.(false));
		if (commit && wasResizing) safely(() => options.onResizeCommit?.(sidebarWidth));
		publishDockState(effectiveWidth);
		requestRender();
	};

	const reconcileResizeWidth = (terminalWidth: number): void => {
		if (!resizing) return;
		if (!visibleAt(terminalWidth)) {
			stopResize(true, false);
			return;
		}
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const attach = (nextTui: TUI): void => {
		if (disposed) return;
		if (tui === nextTui) return;
		if (tui) throw new Error("Cockpit split pane is already attached to another TUI");
		const previousRender = readStableReference(() => nextTui.render);
		if (!previousRender) return;
		const existing = renderMarker(previousRender);
		if (existing?.owner === owner) return;
		if (existing) throw new Error("Cockpit split pane is already attached to this TUI");
		// Instance-level guard: when another renderer (e.g. editor-bottom) wraps
		// our render wrapper, the marker symbol is no longer the outermost and a
		// second split controller would otherwise attach again (SP-5).
		const instanceOwner = (nextTui as TuiWithOwner)[COCKPIT_SPLIT_PANE_OWNER];
		if (instanceOwner !== undefined && instanceOwner !== owner) {
			throw new Error("Cockpit split pane is already attached to this TUI");
		}
		(nextTui as TuiWithOwner)[COCKPIT_SPLIT_PANE_OWNER] = owner;

		tui = nextTui;
		viewportStability = attachViewportStability(nextTui);
		originalRender = previousRender;
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			reconcileResizeWidth(terminalWidth);
			const reserved = effectiveSidebarWidth(terminalWidth);
			syncOverlayWidth(terminalWidth);
			publishDockState(reserved);
			try {
				return previousRender.call(nextTui, terminalWidth - reserved);
			} catch (error) {
				stopResize(true, false);
				enabled = false;
				publishDockState(0);
				safely(() => options.onError?.(error));
				return previousRender.call(nextTui, terminalWidth);
			}
		};
		Object.defineProperty(wrappedRender, COCKPIT_SPLIT_PANE_MARKER, {
			value: { owner, original: previousRender } satisfies RenderMarker,
			configurable: false,
			enumerable: false,
			writable: false,
		});
		nextTui.render = wrappedRender;
		requestRender();
	};

	const handleResizeInput = (data: string): InputResult => {
		// A capturing modal overlay owns the keyboard (and mouse) while up; the
		// resize hook must not swallow its keys.
		if (ambientKeysShouldYield(tui)) return undefined;
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				// Only the button that started the drag may commit it; any other
				// release must not submit a width the user never chose (SP-2).
				if (dragging && dragButton === mouse.button) stopResize(false, true);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
				const columns = tui?.terminal.columns ?? 0;
				const dividerX = columns - effectiveSidebarWidth(columns) + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) {
					dragging = true;
					dragButton = mouse.button;
				}
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				// Only motion of the initiating button keeps the drag alive (SGR sets
				// the 32 motion bit on top of the button value, so compare low bits).
				if (dragButton === undefined || (mouse.button & 31) !== dragButton) return { consume: true };
				const proposed = tui.terminal.columns - mouse.x + 1;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
				const nextWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
				if (nextWidth === sidebarWidth) return { consume: true };
				sidebarWidth = nextWidth;
				const effectiveWidth = syncOverlayWidth();
				publishDockState(effectiveWidth);
				requestDragRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "shift+left")) {
			sidebarNudge(tui, 4);
			return { consume: true };
		}
		if (matchesKey(data, "shift+right")) {
			sidebarNudge(tui, -4);
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			sidebarNudge(tui, 1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			sidebarNudge(tui, -1);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			stopResize(false, true);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			stopResize(true, false);
			return { consume: true };
		}
		return undefined;
	};

	controller = {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			const effectiveWidth = syncOverlayWidth();
			if (tui) publishDockState(effectiveWidth);
			requestRender();
		},
		hide() {
			stopResize(true, false);
			if (!enabled) return;
			enabled = false;
			syncOverlayWidth();
			publishDockState(0);
			requestRender();
		},
		setSidebarWidth(width) {
			const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
			if (next === sidebarWidth) return;
			sidebarWidth = next;
			const effectiveWidth = syncOverlayWidth();
			if (tui) publishDockState(effectiveWidth);
			requestRender();
		},
		getSidebarWidth: () => sidebarWidth,
		getEffectiveSidebarWidth(terminalWidth = tui?.terminal.columns ?? 0) {
			return effectiveSidebarWidth(terminalWidth);
		},
		beginResize() {
			if (resizing) return true;
			if (!tui || !enabled) {
				safely(() => options.onWarning?.(tuiT("notice.sidebarNotReady")));
				return false;
			}
			if (!visibleAt(tui.terminal.columns)) {
				safely(() => options.onWarning?.(tuiT("notice.sidebarTooNarrow")));
				return false;
			}
			if (!options.subscribeInput) {
				safely(() => options.onWarning?.("Terminal input is unavailable for sidebar resizing"));
				return false;
			}
			sidebarWidth = effectiveSidebarWidth(tui.terminal.columns);
			syncOverlayWidth();
			resizeStartWidth = sidebarWidth;
			dragging = false;
			resizing = true;
			try {
				unsubscribeInput = options.subscribeInput(handleResizeInput);
				mouseReportingEnabled = true;
				mouseLease = acquireMouseReporting(tui, "button");
				options.onResizeChange?.(true);
				requestRender();
				return true;
			} catch (error) {
				stopResize(true, false);
				safely(() => options.onError?.(error));
				return false;
			}
		},
		finishResize: () => stopResize(false, true),
		cancelResize: () => stopResize(true, false),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		isVisibleAtWidth: visibleAt,
		overlayOptions: () => overlayLayout,
		requestRender,
		dispose() {
			if (disposed) return;
			stopResize(true, false);
			disposed = true;
			enabled = false;
			if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
			if (tui) {
				const instanceOwner = (tui as TuiWithOwner)[COCKPIT_SPLIT_PANE_OWNER];
				if (instanceOwner === owner) delete (tui as TuiWithOwner)[COCKPIT_SPLIT_PANE_OWNER];
			}
			viewportStability?.detach();
			viewportStability = undefined;
			if (tui) flushMouseReportingWrites(tui);
			requestRender();
			tui = undefined;
			originalRender = undefined;
			wrappedRender = undefined;
		},
	};
	return controller;
}
