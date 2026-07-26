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
	/** Name to park the cursor on — the active theme where the host reveals it. */
	initial: string;
	/**
	 * A **real** Theme instance captured when the picker opened — the cancel target.
	 *
	 * MUST NOT be the host's exported `theme`: that is a Proxy which forwards every
	 * property read to `globalThis[THEME_KEY]`, i.e. to whatever is current. Handing
	 * it back to setThemeInstance stores the proxy inside the slot the proxy reads
	 * from, and the next colour lookup recurses until the stack blows.
	 *
	 * `undefined` when the host would not name its active theme, in which case there
	 * is no safe way to put it back and the picker refuses to preview at all.
	 */
	original: Theme | undefined;
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

/**
 * Name of the theme that is actually live, or undefined if the host won't say.
 *
 * The Theme a component is handed is pi's exported `theme`, which is a Proxy
 * forwarding every read to the current global theme — so reading `.name` off it
 * is a *live* reading, and the closest thing the extension API has to a reader
 * for the current theme. It still does not expose the stored setting, which under
 * Automatic mode is a "light/dark" pair rather than a single name.
 *
 * Being a Proxy is also why the caller must resolve a real instance from this
 * name before using it as a cancel target: handing the Proxy itself back to
 * setThemeInstance stores it in the slot it reads from, and the next colour
 * lookup recurses until the stack blows.
 */
export function activeThemeName(theme: Theme): string | undefined {
	try {
		const name = (theme as { name?: unknown }).name;
		return typeof name === "string" && name !== "" ? name : undefined;
	} catch {
		// The Proxy throws outright when no theme has been initialised.
		return undefined;
	}
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

	/** True when there is no instance to put back, so previewing would be one-way. */
	private get previewBlocked(): boolean {
		return this.params.original === undefined;
	}

	private preview(): void {
		// Never preview what cannot be undone. Without a real original instance the
		// only way back would be the persisting string form, which is the one thing
		// scrolling a list must never do.
		if (this.previewBlocked) return;
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
		const { original } = this.params;
		if (this.previewed && original) this.params.previewTheme(original);
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

		if (this.previewBlocked) {
			lines.push(t.fg("warning", `${g.blocked} pi did not name its active theme — no preview`));
		}
		if (this.error) lines.push(t.fg("error", `${g.cross} ${this.error}`));

		// Enter is the only key that touches the stored setting, so the footer says
		// which key persists rather than leaving the user to find out. When preview
		// is off the wording changes with it — promising a revert we cannot perform
		// would be worse than the missing feature.
		const hints: PrioritizedSegment[] = this.previewBlocked
			? [
				{ text: t.fg("dim", `${g.upDown} move`), priority: 90, clippable: false },
				{ text: t.fg("dim", "Enter apply"), priority: 100, clippable: false },
				{ text: t.fg("dim", "Esc close"), priority: 95, clippable: false },
			]
			: [
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
