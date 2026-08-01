import type { TUI } from "@earendil-works/pi-tui";

const VIEWPORT_STABILITY_MARKER = Symbol.for("pi-cockpit.viewport-stability");

type ApplyLineResets = (lines: string[]) => string[];

interface ViewportTuiInternals {
	applyLineResets?: ApplyLineResets;
	previousLines?: string[];
	previousViewportTop?: number;
	previousHeight?: number;
	terminal?: { rows: number };
}

interface ViewportStabilityMarker {
	original: ApplyLineResets;
	retain(): () => void;
}

export interface ViewportStabilityPatch {
	active: boolean;
	detach(): void;
}

function once(action: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		action();
	};
}

function markerOf(fn: ApplyLineResets): ViewportStabilityMarker | undefined {
	return (fn as ApplyLineResets & Record<symbol, ViewportStabilityMarker | undefined>)[VIEWPORT_STABILITY_MARKER];
}

function isKittyImageLine(line: string | undefined): boolean {
	return typeof line === "string" && line.includes("\x1b_G");
}

/**
 * Mirrors pi-tui's viewport-safe diff behavior until the host ships it.
 *
 * pi-tui 0.82/0.83 clears the screen and scrollback whenever the first changed
 * line is above the visible viewport. For stable-height content, those lines
 * cannot be updated in terminal scrollback and should only advance the diff
 * baseline. Visible changes are then rendered normally from viewportTop.
 */
export function attachViewportStability(tui: TUI): ViewportStabilityPatch {
	const internals = tui as unknown as ViewportTuiInternals;
	const original = internals.applyLineResets;
	if (typeof original !== "function") return { active: false, detach() {} };
	const existing = markerOf(original);
	if (existing) return { active: true, detach: existing.retain() };

	const wrapped: ApplyLineResets = function (this: ViewportTuiInternals, lines: string[]): string[] {
		const nextLines = original.call(this, lines);
		const previousLines = this.previousLines;
		const viewportTop = this.previousViewportTop;
		const previousHeight = this.previousHeight;
		const currentHeight = this.terminal?.rows;
		if (
			Array.isArray(previousLines)
			&& Array.isArray(nextLines)
			&& previousLines.length === nextLines.length
			&& typeof viewportTop === "number"
			&& Number.isFinite(viewportTop)
			&& viewportTop > 0
			&& typeof previousHeight === "number"
			&& Number.isFinite(previousHeight)
			&& previousHeight === currentHeight
		) {
			const hiddenEnd = Math.min(previousLines.length, Math.trunc(viewportTop));
			const hiddenHasKittyImage = previousLines.slice(0, hiddenEnd).some(isKittyImageLine)
				|| nextLines.slice(0, hiddenEnd).some(isKittyImageLine);
			if (!hiddenHasKittyImage) {
				for (let index = 0; index < hiddenEnd; index++) previousLines[index] = nextLines[index];
			}
		}
		return nextLines;
	};
	let references = 1;
	const release = (): void => {
		references -= 1;
		if (references === 0 && internals.applyLineResets === wrapped) internals.applyLineResets = original;
	};
	const retain = (): (() => void) => {
		references += 1;
		return once(release);
	};
	Object.defineProperty(wrapped, VIEWPORT_STABILITY_MARKER, {
		value: { original, retain } satisfies ViewportStabilityMarker,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	internals.applyLineResets = wrapped;

	return { active: true, detach: once(release) };
}
