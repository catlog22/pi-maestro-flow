// The title-generation model picker.
//
// Enter on the "title gen model" row opens this in place of the settings
// panel: a one-key selection over the /api-manager providers instead of
// transcribing a "provider/model" ref. "(rule-based)" is the offline fallback
// (stored as ""), and a trailing "custom ref…" entry drops into the free-text
// editor for a ref that is not on the list yet.
//
// Unlike the theme picker there is nothing to preview — a model ref has no
// reversible live effect — so Enter commits directly and Esc cancels; the
// stored setting is only ever touched by commit().

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, visibleStart, type PrioritizedSegment, type WidthUtils } from "./layout.ts";
import { overlayListRows } from "./viewport.ts";

const UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

// Border, title, separator, footer hints.
const CARD_CHROME_ROWS = 6;

export type ModelPickerEntry =
	| { kind: "model"; ref: string; label: string }
	| { kind: "custom"; label: string };

export interface ModelPickerParams {
	entries: readonly ModelPickerEntry[];
	/** Current generationModel ref, parked on when it is on the list. */
	initial: string;
	/** Persisting apply by ref; "" restores the offline rule-based extractor. */
	commit: (ref: string) => void;
	/** "custom ref…" chosen: close the picker and open the free-text editor. */
	requestCustom: () => void;
	close: () => void;
	requestRender: () => void;
	getTerminalRows: () => number | undefined;
	theme: Theme;
	glyphs: IconGlyphs;
}

/** Cursor position for a ref that may be absent from the list. */
export function initialModelIndex(entries: readonly ModelPickerEntry[], initial: string): number {
	const found = entries.findIndex((entry) => entry.kind === "model" && entry.ref === initial);
	return found === -1 ? 0 : found;
}

export class ModelPicker implements Component {
	private selected: number;
	/**
	 * Display labels, stripped of control characters.
	 *
	 * Refs come from models.json, i.e. third-party text reaching a box-drawn
	 * card; a newline would break the card open. `params.entries` stays
	 * authoritative for the value handed back on commit.
	 */
	private readonly labels: readonly string[];

	constructor(private readonly params: ModelPickerParams) {
		this.labels = params.entries.map((entry) => sanitizeExtensionStatusText(entry.label));
		this.selected = initialModelIndex(params.entries, params.initial);
	}

	invalidate(): void {}
	dispose(): void {}

	private commitEntry(index: number): void {
		const entry = this.params.entries[index];
		if (!entry) return;
		if (entry.kind === "custom") this.params.requestCustom();
		else this.params.commit(entry.ref);
		this.params.close();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.params.close();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.commitEntry(this.selected);
			return;
		}
		const count = this.params.entries.length;
		if (count === 0) return;
		if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-this.pageSize());
		else if (matchesKey(data, Key.pageDown)) this.move(this.pageSize());
		else if (matchesKey(data, Key.home)) this.jump(0);
		else if (matchesKey(data, Key.end)) this.jump(count - 1);
	}

	private move(delta: number): void {
		const count = this.params.entries.length;
		this.selected = (this.selected + delta % count + count) % count;
		this.params.requestRender();
	}

	private jump(index: number): void {
		this.selected = index;
		this.params.requestRender();
	}

	private pageSize(): number {
		return overlayListRows(this.params.getTerminalRows(), CARD_CHROME_ROWS);
	}

	render(width: number): string[] {
		const { theme: t, glyphs: g, entries } = this.params;
		const w = Math.max(1, Math.min(width, 60));
		const lines = [
			t.fg("text", "title model"),
			t.fg("borderMuted", "─".repeat(w)),
		];

		if (entries.length === 0) {
			lines.push(t.fg("muted", "no models registered"));
		} else {
			const page = this.pageSize();
			const start = visibleStart(this.selected, entries.length, page);
			for (let index = start; index < Math.min(entries.length, start + page); index++) {
				const active = index === this.selected;
				const marker = active ? t.fg("accent", g.selectMarker) : " ";
				const name = t.fg(active ? "text" : "muted", this.labels[index]);
				lines.push(truncateToWidth(`${marker} ${name}`, w, "…"));
			}
			const hiddenAbove = start;
			const hiddenBelow = Math.max(0, entries.length - (start + page));
			if (hiddenAbove || hiddenBelow) {
				lines.push(t.fg("dim", `  ${g.upDown} ${this.selected + 1}/${entries.length}`));
			}
		}

		// The refs come from /api-manager's registry, and the empty ref is the
		// offline extractor — both worth saying once rather than guessing.
		const hints: PrioritizedSegment[] = [
			{ text: t.fg("dim", `${g.upDown} move`), priority: 90, clippable: false },
			{ text: t.fg("dim", "Enter save"), priority: 100, clippable: false },
			{ text: t.fg("dim", "Esc cancel"), priority: 95, clippable: false },
		];
		lines.push(fitLineByPriority(hints, w, UTILS, t.fg("dim", " · "), g.ellipsis));
		lines.push(truncateToWidth(t.fg("dim", "models come from /api-manager"), w, "…"));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}
}
