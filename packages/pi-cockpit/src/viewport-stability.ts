import { Container, type TUI } from "@earendil-works/pi-tui";
import { readStableReference } from "./stable-reference.ts";

const VIEWPORT_STABILITY_MARKER = Symbol.for("pi-cockpit.viewport-stability");

type ApplyLineResets = (lines: string[]) => string[];

interface ComponentLayout {
	width: number;
	children: Array<{ component: LayoutComponent; height: number }>;
}

interface LayoutComponent {
	render?: (width: number) => string[];
	children?: LayoutComponent[];
	mouseLayout?: ComponentLayout;
}

interface HiddenComponent {
	component: LayoutComponent;
	start: number;
	end: number;
}

interface ViewportTuiInternals extends LayoutComponent {
	applyLineResets?: ApplyLineResets;
	previousLines?: string[];
	previousViewportTop?: number;
	previousHeight?: number;
	previousWidth?: number;
	terminal?: { columns: number; rows: number };
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
	/** Machine-readable reason when the host shape rejected the patch. */
	reason?: string;
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

// Container records these heights during the actual render. Never render a
// component twice or infer row identity from its changing text.
function measuredComponents(
	root: LayoutComponent,
	lineCount: number,
	width: number,
): HiddenComponent[] | undefined {
	if (root.render !== Container.prototype.render) return undefined;
	const result: HiddenComponent[] = [];
	const seen = new Set<LayoutComponent>();
	const walk = (node: LayoutComponent, start: number, height: number): boolean => {
		if (height === 0) return true;
		if (seen.has(node)) return false;
		seen.add(node);
		const layout = node.mouseLayout;
		if (node.render === Container.prototype.render && Array.isArray(node.children)) {
			if (!layout || layout.width !== width || layout.children.length !== node.children.length) return false;
			let total = 0;
			for (let index = 0; index < layout.children.length; index += 1) {
				const child = layout.children[index]!;
				if (child.component !== node.children[index] || !Number.isSafeInteger(child.height) || child.height < 0) return false;
				total += child.height;
			}
			if (total !== height) return false;
			let offset = start;
			for (const child of layout.children) {
				if (!walk(child.component, offset, child.height)) return false;
				offset += child.height;
			}
			return true;
		}
		result.push({ component: node, start, end: start + height });
		return true;
	};
	return Array.isArray(root.children) && walk(root, 0, lineCount) ? result : undefined;
}

function sameHiddenComponents(previous: readonly HiddenComponent[], next: readonly HiddenComponent[]): boolean {
	return previous.length === next.length && previous.every((span, index) => {
		const other = next[index]!;
		return span.component === other.component && span.start === other.start && span.end === other.end;
	});
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
 * Preserves fully hidden components only while their instances and measured
 * positions stay unchanged. Boundary-spanning components, missing layout
 * evidence, structural changes, resize and images retain the native path.
 */
export function attachViewportStability(tui: TUI): ViewportStabilityPatch {
	try {
		// Native fullscreen has an application-owned fixed viewport. Its inherited
		// applyLineResets method is not part of that renderer's diff path, so patching
		// it would report a false-positive attachment on the shared TUI base class.
		if (tui.mode === "fullscreen") return { active: false, reason: "fullscreen-mode", detach() {} };
		const internals = tui as unknown as ViewportTuiInternals;
		const slot = resolveApplyLineResetsSlot(internals);
		if (!slot) return { active: false, reason: "no-slot", detach() {} };
		const { original } = slot;
		const existing = markerOf(original);
		if (existing) return { active: true, detach: existing.retain() };

		let dispatches = 0;
		const frames = new WeakMap<ViewportTuiInternals, { baseline: string[]; spans: HiddenComponent[] }>();
		const wrapped: ApplyLineResets = function (this: ViewportTuiInternals, lines: string[]): string[] {
			dispatches += 1;
			const nextLines = original.call(this, lines);
			const previousLines = this.previousLines;
			const viewportTop = this.previousViewportTop;
			const hiddenEnd = typeof viewportTop === "number" && Number.isFinite(viewportTop)
				? Math.max(0, Math.min(nextLines.length, Math.trunc(viewportTop)))
				: 0;
			const spans = measuredComponents(this, nextLines.length, this.terminal?.columns ?? 0);
			const previousFrame = frames.get(this);
			if (
				Array.isArray(previousLines)
					&& previousLines.length === nextLines.length
					&& typeof viewportTop === "number"
					&& Number.isFinite(viewportTop)
					&& viewportTop > 0
					&& this.previousHeight === this.terminal?.rows
					&& this.previousWidth === this.terminal?.columns
					&& spans && previousFrame?.baseline === previousLines
					&& sameHiddenComponents(previousFrame.spans, spans)
			) {
				let hiddenHasKittyImage = false;
				for (let index = 0; index < hiddenEnd; index += 1) {
					if (isKittyImageLine(previousLines[index]) || isKittyImageLine(nextLines[index])) {
						hiddenHasKittyImage = true;
						break;
					}
				}
				if (!hiddenHasKittyImage) {
					for (const span of spans) {
						if (span.end > hiddenEnd) break;
						for (let index = span.start; index < span.end; index += 1) nextLines[index] = previousLines[index]!;
					}
				}
			}
			if (spans) {
				// The native no-change path keeps the old array rather than adopting
				// nextLines. Track the exact baseline it will retain in either case.
				const unchanged = previousLines?.length === nextLines.length
					&& nextLines.every((line, index) => line === previousLines[index]);
				frames.set(this, { baseline: unchanged ? previousLines! : nextLines, spans });
			} else frames.delete(this);
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
			return { active: false, reason: installed ? "dispatch-probe" : "install-failed", detach() {} };
		}

		return { active: true, detach: once(release) };
	} catch {
		return { active: false, reason: "attach-error", detach() {} };
	}
}
