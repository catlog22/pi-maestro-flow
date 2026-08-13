import type { TUI } from "@earendil-works/pi-tui";
import { readStableReference } from "./stable-reference.ts";

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

interface ApplyLineResetsSlot {
	original: ApplyLineResets;
	requiresDispatchProbe: boolean;
	current(): ApplyLineResets | undefined;
	replace(value: ApplyLineResets): void;
	restore(): void;
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

function prototypeMethodSlot(target: object): ApplyLineResetsSlot | undefined {
	const seen = new WeakSet<object>();
	let owner = Object.getPrototypeOf(target) as object | null;
	for (let depth = 0; owner && depth < 32; depth += 1) {
		if (seen.has(owner)) return undefined;
		seen.add(owner);
		const descriptor = Object.getOwnPropertyDescriptor(owner, "applyLineResets");
		if (descriptor) {
			if (typeof descriptor.value !== "function" || descriptor.writable !== true) return undefined;
			const original = descriptor.value as ApplyLineResets;
			return {
				original,
				requiresDispatchProbe: true,
				current: () => Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value as ApplyLineResets | undefined,
				replace: (value) => Object.defineProperty(owner, "applyLineResets", { ...descriptor, value }),
				restore: () => Object.defineProperty(owner, "applyLineResets", descriptor),
			};
		}
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return undefined;
}

function instanceMethodSlot(internals: ViewportTuiInternals, stable: ApplyLineResets): ApplyLineResetsSlot {
	const target = internals as object;
	const descriptor = Object.getOwnPropertyDescriptor(target, "applyLineResets");
	return {
		original: stable,
		requiresDispatchProbe: false,
		current: () => internals.applyLineResets,
		replace: (value) => Object.defineProperty(target, "applyLineResets", descriptor
			? { ...descriptor, value }
			: { configurable: true, enumerable: false, writable: true, value }),
		restore: () => {
			if (descriptor) Object.defineProperty(target, "applyLineResets", descriptor);
			else delete internals.applyLineResets;
		},
	};
}

function resolveApplyLineResetsSlot(internals: ViewportTuiInternals): ApplyLineResetsSlot | undefined {
	const stable = readStableReference(() => internals.applyLineResets);
	if (typeof stable === "function") return instanceMethodSlot(internals, stable);
	// pi 0.84 exposes a dynamic TUI Proxy whose method reads intentionally return
	// fresh dispatch closures. Its prototype, however, is the current renderer's
	// real prototype, so patch that stable method slot without wrapping a closure.
	return prototypeMethodSlot(internals);
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
	try {
		const internals = tui as unknown as ViewportTuiInternals;
		const slot = resolveApplyLineResetsSlot(internals);
		if (!slot) return { active: false, detach() {} };
		const { original } = slot;
		const existing = markerOf(original);
		if (existing) return { active: true, detach: existing.retain() };

		let dispatches = 0;
		const wrapped: ApplyLineResets = function (this: ViewportTuiInternals, lines: string[]): string[] {
			dispatches += 1;
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
			if (references === 0 && slot.current() === wrapped) slot.restore();
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
		slot.replace(wrapped);
		const installed = slot.current() === wrapped;
		const dispatched = !slot.requiresDispatchProbe || (() => {
			const before = dispatches;
			internals.applyLineResets?.([]);
			return dispatches === before + 1;
		})();
		if (!installed || !dispatched) {
			if (slot.current() === wrapped) slot.restore();
			return { active: false, detach() {} };
		}

		return { active: true, detach: once(release) };
	} catch {
		return { active: false, detach() {} };
	}
}
