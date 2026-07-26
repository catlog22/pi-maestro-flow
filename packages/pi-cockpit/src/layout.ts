// Shared line-fitting primitives.
//
// Every cockpit surface renders "a list of segments on one terminal line". The
// footer already degraded segment-by-segment while the widgets blind-clipped the
// whole joined line, which meant the trailing segments (duration, the Alt+J hint,
// the next-task label) were always the first casualties — exactly the tokens the
// non-color-accessibility spec says must survive. This module is the single
// implementation both sides use.

// Width helpers are injected so these stay pure and hermetic in unit tests; the
// real widgets pass pi-tui's visibleWidth / truncateToWidth so east-asian widths
// are correct on a terminal.
export interface WidthUtils {
	measure: (text: string) => number;
	clip: (text: string, width: number, ellipsis: string) => string;
}

export interface PrioritizedSegment {
	text: string;
	/** Higher survives longer. The lowest-priority segment is sacrificed first. */
	priority: number;
	/**
	 * When false the segment is dropped outright rather than ellipsized, so a
	 * segment can never degrade into a bare "…" that occupies space and says
	 * nothing. Defaults to true.
	 */
	clippable?: boolean;
	/**
	 * Narrowest width at which this segment still carries meaning. Below it the
	 * segment is dropped instead of clipped. Segments that carry a glyph prefix
	 * need this: clipping "{icon} ~/work/project" to two columns leaves the icon
	 * and an ellipsis — decoration with the content eaten out of it.
	 */
	minWidth?: number;
}

/**
 * Drop and clip segments by ascending priority until the joined line fits.
 *
 * A segment is only ellipsized when the remaining room still leaves visible
 * characters beyond the ellipsis itself; otherwise it is dropped, because a
 * lone "…" costs a column and carries no information.
 */
export function fitSegmentsByPriority(
	segs: readonly PrioritizedSegment[],
	maxW: number,
	measure: WidthUtils["measure"],
	clip: WidthUtils["clip"],
	ellipsis = "...",
	separatorWidth = 1,
): string[] {
	const ellipsisW = measure(ellipsis);
	const items = segs.map((s) => ({
		text: s.text,
		priority: s.priority,
		clippable: s.clippable !== false,
		minWidth: Math.max(s.minWidth ?? 0, ellipsisW + 1),
		w: measure(s.text),
	}));
	const totalW = (): number => {
		const active = items.filter((it) => it.text !== "");
		return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1) * separatorWidth;
	};
	while (totalW() > maxW) {
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			if (items[i].text !== "" && (target === -1 || items[i].priority < items[target].priority)) {
				target = i;
			}
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i].text !== "");
		const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1) * separatorWidth;
		const avail = maxW - otherW - (others.length > 0 ? separatorWidth : 0);
		// Ellipsizing down to decoration-plus-ellipsis wastes columns and says
		// nothing, so a segment must clear its minWidth to survive the clip.
		const drop = (): void => {
			items[target].text = "";
			items[target].w = 0;
		};
		if (!items[target].clippable || avail < items[target].minWidth) {
			drop();
		} else if (avail < items[target].w) {
			const clipped = clip(items[target].text, avail, ellipsis);
			const clippedW = measure(clipped);
			if (clippedW < items[target].minWidth) drop();
			else {
				items[target].text = clipped;
				items[target].w = clippedW;
			}
		} else {
			break;
		}
	}
	return items.filter((it) => it.text !== "").map((it) => it.text);
}

/**
 * Join prioritized segments into a single line that fits `width`.
 *
 * The common case at every call site: build segments, fit them, join with the
 * separator. Returns "" when nothing survives.
 */
export function fitLineByPriority(
	segs: readonly PrioritizedSegment[],
	width: number,
	utils: WidthUtils,
	separator: string,
	ellipsis: string,
): string {
	if (width <= 0) return "";
	const fitted = fitSegmentsByPriority(
		segs,
		width,
		utils.measure,
		utils.clip,
		ellipsis,
		utils.measure(separator),
	);
	return fitted.join(separator);
}

/**
 * First visible index of a scrolling window that keeps `selected` centred where
 * it can, and flush against either end where it cannot.
 */
export function visibleStart(selected: number, length: number, size: number): number {
	return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, length - size)));
}
