import type { Component, TUI } from "@earendil-works/pi-tui";
import { readStableReference } from "./stable-reference.ts";

export const EDITOR_BOTTOM_WIDGET_KEY = "cockpit-editor-bottom-anchor";
export const COCKPIT_EDITOR_BOTTOM_MARKER = Symbol.for("pi-cockpit.editor-bottom-render");

const EDITOR_BOTTOM_SENTINEL = "\u2063\u2064\u2063\u2064\u2063";

type RenderFunction = TUI["render"];

interface RenderMarker {
	owner: object;
	original: RenderFunction;
}

export interface EditorBottomController {
	attach(tui: TUI): void;
	show(): void;
	hide(): void;
	isEnabled(): boolean;
	requestRender(): void;
	dispose(): void;
}

export interface EditorBottomControllerOptions {
	onError?(error: unknown): void;
}

export function createEditorBottomSentinel(): Component {
	return {
		render: () => [EDITOR_BOTTOM_SENTINEL],
		invalidate(): void {},
	};
}

export function createEditorBottomController(
	options: EditorBottomControllerOptions = {},
): EditorBottomController {
	const owner = {};
	let tui: TUI | undefined;
	let originalRender: RenderFunction | undefined;
	let wrappedRender: RenderFunction | undefined;
	let enabled = false;
	let disposed = false;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Layout failure reporting must not break Pi's renderer.
		}
	};

	const requestRender = (): void => {
		try {
			tui?.requestRender();
		} catch {
			// The TUI may already be shutting down.
		}
	};

	const attach = (nextTui: TUI): void => {
		if (disposed) return;
		if (tui === nextTui) return;
		if (tui) throw new Error("Cockpit editor-bottom layout is already attached to another TUI");
		const previousRender = readStableReference(() => nextTui.render);
		if (!previousRender) return;
		const existing = (previousRender as RenderFunction & Record<symbol, RenderMarker | undefined>)[COCKPIT_EDITOR_BOTTOM_MARKER];
		if (existing?.owner === owner) return;
		if (existing) throw new Error("Cockpit editor-bottom layout is already attached to this TUI");

		tui = nextTui;
		originalRender = previousRender;
		wrappedRender = function (this: TUI, width: number): string[] {
			const rendered = previousRender.call(nextTui, width);
			const markerIndex = rendered.findIndex((line) => line.includes(EDITOR_BOTTOM_SENTINEL));
			if (markerIndex < 0) return rendered;
			const withoutMarker = [...rendered.slice(0, markerIndex), ...rendered.slice(markerIndex + 1)];
			if (!enabled) return withoutMarker;
			try {
				const terminalRows = Math.max(1, Math.trunc(nextTui.terminal.rows));
				const padding = Math.max(0, terminalRows - withoutMarker.length);
				if (padding === 0) return withoutMarker;
				return [
					...withoutMarker.slice(0, markerIndex),
					...Array.from({ length: padding }, () => ""),
					...withoutMarker.slice(markerIndex),
				];
			} catch (error) {
				enabled = false;
				reportError(error);
				return withoutMarker;
			}
		};
		Object.defineProperty(wrappedRender, COCKPIT_EDITOR_BOTTOM_MARKER, {
			value: { owner, original: previousRender } satisfies RenderMarker,
			configurable: false,
			enumerable: false,
			writable: false,
		});
		nextTui.render = wrappedRender;
		requestRender();
	};

	return {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			requestRender();
		},
		hide() {
			if (!enabled) return;
			enabled = false;
			requestRender();
		},
		isEnabled: () => enabled,
		requestRender,
		dispose() {
			if (disposed) return;
			disposed = true;
			enabled = false;
			if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
			requestRender();
			tui = undefined;
			originalRender = undefined;
			wrappedRender = undefined;
		},
	};
}
