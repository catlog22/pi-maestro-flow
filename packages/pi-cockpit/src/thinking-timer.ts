// Live elapsed-time labels for folded thinking rows.
//
// Pi renders one static label ("thoughts") per hidden thinking run. This
// module upgrades that label while the fold itself stays pi's: while the model
// is thinking, the row shows a spinner and the running elapsed time; when the
// run ends, the row settles to the actual duration ("thoughts · 8.4s").
//
// Label targeting: pi's ctx.ui.setHiddenThinkingLabel is global — it rewrites
// every assistant message component. A final duration belongs to one message,
// so it is written per component instance instead: the streaming component
// stays mounted in the chat container after message_end (pi only clears its
// reference), so a duck-typed walk — the same pattern thinking-fold.ts uses
// for actionHandlers — can address exactly the row that just finished
// thinking. When the walk finds nothing (non-TUI mode, pi refactor), the
// global label API is the degraded fallback: the animation still runs, and
// the final duration lingers briefly before the base label returns.

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { ANIMATION_PERIOD_MS, spinFrame, type IconGlyphs } from "./icons.ts";

/**
 * Duck-typed AssistantMessageComponent: the two public setters pi gives it.
 * No other component in pi's chat tree exposes this pair.
 */
export interface ThinkingLabelTarget {
	setHiddenThinkingLabel(label: string): void;
	setHideThinkingBlock(hide: boolean): void;
}

function isThinkingLabelTarget(node: object): node is ThinkingLabelTarget {
	const candidate = node as Partial<ThinkingLabelTarget>;
	return (
		typeof candidate.setHiddenThinkingLabel === "function"
		&& typeof candidate.setHideThinkingBlock === "function"
	);
}

/**
 * Collect label targets in document order. The newest assistant message is
 * always the last target: pi appends the streaming component to the chat
 * container on message_start, and later siblings (tool executions, the next
 * message) are not targets.
 */
export function findThinkingLabelTargets(tui: TUI): ThinkingLabelTarget[] {
	const targets: ThinkingLabelTarget[] = [];
	const seen = new Set<unknown>();
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null || seen.has(node)) return;
		seen.add(node);
		if (isThinkingLabelTarget(node)) targets.push(node);
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) walk(child);
		}
	};
	walk(tui);
	return targets;
}

export function formatThinkingDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export interface ThinkingTimerOptions {
	getTui: () => TUI | undefined;
	/** Instance label writes do not schedule a paint; the owner must. */
	requestRender: () => void;
	/** Label folded rows currently show; undefined means pi's own default. */
	getBaseLabel: () => string | undefined;
	getGlyphs: () => IconGlyphs;
	/** Effective hideThinkingBlock — labels only render while thinking is folded. */
	isThinkingHidden: () => boolean;
	isEnabled: () => boolean;
	/** Global label fallback for when no component instance is reachable. */
	setGlobalLabel: (label: string | undefined) => void;
	now?: () => number;
	/** How long the fallback final label lingers before the base returns. */
	settleMs?: number;
}

const DEFAULT_SETTLE_MS = 5_000;

export class ThinkingFoldTimer {
	readonly #options: ThinkingTimerOptions;
	#startedAt: number | undefined;
	#ticker: ReturnType<typeof setInterval> | undefined;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	// Invalidates pending settle restores across stop/reset boundaries so a
	// late timer can never rewrite a label a newer run already owns.
	#generation = 0;

	constructor(options: ThinkingTimerOptions) {
		this.#options = options;
	}

	onAssistantMessageEvent(event: AssistantMessageEvent | undefined): void {
		if (!event) return;
		if (!this.#options.isEnabled()) {
			this.stop();
			return;
		}
		if (event.type === "thinking_start") this.#begin();
		else if (event.type === "thinking_end") this.#finish();
	}

	/**
	 * Settle an interrupted run: message_end fires for aborted and failed
	 * messages too (agent_end only removes the row afterwards), so the
	 * duration written here is still accurate and lands on a mounted row.
	 */
	onAssistantMessageEnd(): void {
		if (this.#startedAt !== undefined) this.#finish();
	}

	/** One animation frame. The internal interval drives it; tests call it directly. */
	tick(): void {
		if (this.#startedAt === undefined) return;
		const now = this.#now();
		const glyphs = this.#options.getGlyphs();
		const label = `${spinFrame(glyphs, now)} thinking ${formatThinkingDuration(now - (this.#startedAt ?? now))}`;
		this.#paint(label);
	}

	/** The agent stopped: drop the run without settling a duration. */
	stop(): void {
		this.#generation++;
		this.#clearTimers();
		this.#startedAt = undefined;
	}

	/** Session boundary: forget the run; pi rebuilds the chat from entries. */
	reset(): void {
		this.#generation++;
		this.#clearTimers();
		this.#startedAt = undefined;
	}

	#begin(): void {
		// The gate is per-run: when thinking is unfolded the label row is not
		// rendered, so there is nothing to animate and no duration to keep.
		if (!this.#options.isThinkingHidden()) return;
		this.#startedAt = this.#now();
		if (!this.#ticker) {
			this.#ticker = setInterval(() => this.tick(), ANIMATION_PERIOD_MS);
			this.#ticker.unref?.();
		}
		// Paint immediately so the row flips to the live label with the first
		// frame instead of waiting a quarter second.
		this.tick();
	}

	#finish(): void {
		const startedAt = this.#startedAt;
		if (startedAt === undefined) return;
		this.#clearTimers();
		this.#startedAt = undefined;
		const duration = formatThinkingDuration(this.#now() - startedAt);
		const base = this.#options.getBaseLabel() ?? "thoughts";
		this.#paint(`${base}${this.#options.getGlyphs().separator}${duration}`, true);
	}

	#paint(label: string, settle = false): void {
		const tui = this.#options.getTui();
		const targets = tui ? findThinkingLabelTargets(tui) : [];
		const target = targets.at(-1);
		if (target) {
			try {
				target.setHiddenThinkingLabel(label);
				this.#options.requestRender();
			} catch {
				// component may be mid-teardown; the global path recovers
				this.#paintGlobal(label, settle);
			}
			return;
		}
		this.#paintGlobal(label, settle);
	}

	#paintGlobal(label: string, settle: boolean): void {
		try {
			this.#options.setGlobalLabel(label);
		} catch {
			// no UI surface at all — nothing to paint
		}
		if (!settle) return;
		// The global label is shared by every folded row, so the final
		// duration cannot stay: give it a moment to be read, then hand the
		// label back to whatever the owner currently wants.
		this.#generation++;
		const generation = this.#generation;
		if (this.#settleTimer) clearTimeout(this.#settleTimer);
		this.#settleTimer = setTimeout(() => {
			this.#settleTimer = undefined;
			if (generation !== this.#generation) return;
			try {
				this.#options.setGlobalLabel(this.#options.getBaseLabel());
			} catch {
				// best-effort restore
			}
		}, this.#options.settleMs ?? DEFAULT_SETTLE_MS);
		this.#settleTimer.unref?.();
	}

	#clearTimers(): void {
		if (this.#ticker) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
		if (this.#settleTimer) {
			clearTimeout(this.#settleTimer);
			this.#settleTimer = undefined;
		}
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}
}
