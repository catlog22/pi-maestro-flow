// Vertical budgeting.
//
// Every row cockpit paints is a row of conversation the user cannot read. The
// widgets used to carry fixed caps (8 todo rows, 6 agent rows, plus headers and
// the background strip) chosen for a comfortable window. On a 24-row terminal
// that is most of the screen: the panels win and the actual answer is pushed off
// the top. Width was already adaptive; height was not.

// Share of the terminal a single cockpit panel may claim. Two panels plus the
// footer then land near a third of the screen, which is the ceiling at which this
// still reads as a status strip rather than as the application.
export const CHROME_SHARE = 0.15;
/** Below this a panel cannot say anything useful, so it stops shrinking. */
export const MIN_PANEL_ROWS = 3;
/** Above this extra rows stop earning their place, however tall the terminal is. */
export const MAX_PANEL_ROWS = 10;

/**
 * Rows one panel may use, or undefined when the terminal height is unknown — in
 * which case callers keep their previous fixed caps rather than guessing.
 */
export function panelRows(terminalRows: number | undefined): number | undefined {
	if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) return undefined;
	return Math.max(MIN_PANEL_ROWS, Math.min(MAX_PANEL_ROWS, Math.floor(terminalRows * CHROME_SHARE)));
}

/**
 * Split `total` items into what fits and what is hidden.
 *
 * The "N more" marker is paid for out of the budget rather than added on top of
 * it, because a panel that overflows its budget by exactly one row is the bug
 * this module exists to prevent.
 */
export function fitRows(total: number, budget: number): { visible: number; hidden: number } {
	if (budget <= 0) return { visible: 0, hidden: total };
	if (total <= budget) return { visible: total, hidden: 0 };
	const visible = Math.max(0, budget - 1);
	return { visible, hidden: total - visible };
}
