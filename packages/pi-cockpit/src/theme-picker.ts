// The /theme picker.
//
// pi has no /theme command — themes live behind /settings → Theme. That built-in
// submenu is good (live preview, cancel restores, automatic light/dark pairing),
// so this exists to give the same quality one keystroke away, not to replace it.
//
// The whole design turns on one asymmetry in the host API:
//
//   setTheme("nord")        -> setThemeName    -> ALSO writes settings (persists)
//   setTheme(themeInstance) -> setThemeInstance -> in-memory only (does NOT persist)
//
// So previewing by *instance* is free: the user's stored setting is untouched no
// matter how many themes they scroll past, and cancelling restores the instance
// that was live when the picker opened. Only Enter commits, and only Enter takes
// the string path that writes through to pi's settings.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, visibleStart, type PrioritizedSegment, type WidthUtils } from "./layout.ts";
import { overlayListRows } from "./viewport.ts";

const UTILS: WidthUtils = { measure: visibleWidth, clip: truncateToWidth };

// Border, title, separator, two footer hints.
const CARD_CHROME_ROWS = 6;

export interface ThemePickerParams {
	/** Theme names the host knows about, in host order. */
	themes: readonly string[];
	/** Cockpit's last known choice; used only to place the cursor sensibly. */
	initial: string;
	/** The Theme that was live when the picker opened — the cancel target. */
	original: Theme;
	loadTheme: (name: string) => Theme | undefined;
	/** In-memory apply. Must not persist. */
	previewTheme: (theme: Theme) => void;
	/** Persisting apply by name. */
	commitTheme: (name: string) => { success: boolean; error?: string };
	close: () => void;
	requestRender: () => void;
	getTerminalRows: () => number | undefined;
	theme: Theme;
	glyphs: IconGlyphs;
}

/** Cursor position for a name that may be absent from the list. */
export function initialIndex(themes: readonly string[], initial: string): number {
	const found = themes.indexOf(initial);
	return found === -1 ? 0 : found;
}

export class ThemePicker implements Component {
	private selected: number;
	private previewed = false;
	private error: string | undefined;

	/**
	 * Display names, stripped of control characters.
	 *
	 * Theme names come from theme files on disk, so they are third-party text
	 * reaching a box-drawn card. A newline in one would break the card open, and
	 * no width assertion would notice — a newline measures zero columns.
	 * `params.themes` stays authoritative for the value handed back to the host.
	 */
	private readonly labels: readonly string[];

	constructor(private readonly params: ThemePickerParams) {
		this.labels = params.themes.map((name) => sanitizeExtensionStatusText(name));
		this.selected = initialIndex(params.themes, params.initial);
		// Show the highlighted theme immediately, so the picker opens already
		// demonstrating what it does rather than waiting for a keypress.
		this.preview();
	}

	invalidate(): void {}
	dispose(): void {}

	private preview(): void {
		const name = this.params.themes[this.selected];
		if (!name) return;
		const instance = this.params.loadTheme(name);
		if (!instance) {
			this.error = `${this.labels[this.selected]} could not be loaded`;
			return;
		}
		this.error = undefined;
		this.previewed = true;
		this.params.previewTheme(instance);
	}

	private cancel(): void {
		// Restore by instance: nothing was persisted, so pi's stored setting — a
		// single name or an automatic "light/dark" pair — is exactly as it was.
		if (this.previewed) this.params.previewTheme(this.params.original);
		this.params.close();
	}

	private commit(): void {
		const name = this.params.themes[this.selected];
		if (!name) {
			this.cancel();
			return;
		}
		const result = this.params.commitTheme(name);
		if (!result.success) {
			this.error = sanitizeExtensionStatusText(
				result.error ?? `could not apply ${this.labels[this.selected]}`,
			);
			this.params.requestRender();
			return;
		}
		this.params.close();
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.cancel();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.commit();
			return;
		}
		const count = this.params.themes.length;
		if (count === 0) return;
		// Arrows only. Plain letters stay inert here, per the terminal rule that
		// reserves them until an explicit filter mode is entered; `/theme <name>`
		// already covers the "I know what I want" path.
		if (data === "\x1b[A") this.move(-1);
		else if (data === "\x1b[B") this.move(1);
		else if (data === "\x1b[5~") this.move(-this.pageSize());
		else if (data === "\x1b[6~") this.move(this.pageSize());
		else if (data === "\x1b[H") this.jump(0);
		else if (data === "\x1b[F") this.jump(count - 1);
	}

	private move(delta: number): void {
		const count = this.params.themes.length;
		this.selected = (this.selected + delta % count + count) % count;
		this.preview();
		this.params.requestRender();
	}

	private jump(index: number): void {
		this.selected = index;
		this.preview();
		this.params.requestRender();
	}

	private pageSize(): number {
		return overlayListRows(this.params.getTerminalRows(), CARD_CHROME_ROWS);
	}

	render(width: number): string[] {
		const { theme: t, glyphs: g, themes } = this.params;
		const w = Math.max(1, Math.min(width, 60));
		const lines = [
			t.fg("text", "theme"),
			t.fg("borderMuted", "─".repeat(w)),
		];

		if (themes.length === 0) {
			lines.push(t.fg("muted", "no themes registered"));
		} else {
			const page = this.pageSize();
			const start = visibleStart(this.selected, themes.length, page);
			for (let index = start; index < Math.min(themes.length, start + page); index++) {
				const active = index === this.selected;
				const marker = active ? t.fg("accent", g.selectMarker) : " ";
				const name = t.fg(active ? "text" : "muted", this.labels[index]);
				lines.push(truncateToWidth(`${marker} ${name}`, w, "…"));
			}
			const hiddenAbove = start;
			const hiddenBelow = Math.max(0, themes.length - (start + page));
			if (hiddenAbove || hiddenBelow) {
				lines.push(t.fg("dim", `  ${g.upDown} ${this.selected + 1}/${themes.length}`));
			}
		}

		if (this.error) lines.push(t.fg("error", `${g.cross} ${this.error}`));

		// Enter is the only key that touches the stored setting, so the footer says
		// which key persists rather than leaving the user to find out.
		const hints: PrioritizedSegment[] = [
			{ text: t.fg("dim", `${g.upDown} preview`), priority: 90, clippable: false },
			{ text: t.fg("dim", "Enter save"), priority: 100, clippable: false },
			{ text: t.fg("dim", "Esc revert"), priority: 95, clippable: false },
		];
		lines.push(fitLineByPriority(hints, w, UTILS, t.fg("dim", " · "), g.ellipsis));
		lines.push(truncateToWidth(
			t.fg("dim", "/settings pairs a light and a dark theme"),
			w,
			"…",
		));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}
}
