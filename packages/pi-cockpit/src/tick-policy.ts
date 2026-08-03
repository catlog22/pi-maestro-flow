// Pure scheduling policy for the cockpit animation/redraw loop.
//
// index.ts wires live state (config.staticMode, running, jobs, lingering rows,
// tick presence) into these functions so the static-mode matrix is unit-testable
// without instantiating the extension. Three independent gates exist because the
// surfaces they drive have different stakes:
// - the main 250ms tick must keep running while failed/sleeping rows need
//   expiry (failure retention is correctness, not animation);
// - the spinner frame gate additionally requires the tick to actually exist, so
//   a frozen mid-cycle spinner never claims "busy";
// - the sidebar's own timer also animates while lingering rows are on screen.

export interface TickPolicyState {
	/** Static mode: suppress periodic churn (spinners, elapsed ticks). */
	staticMode: boolean;
	/** A foreground agent turn is in flight. */
	running: boolean;
	/** At least one agent (foreground or background) is still running. */
	agentActive: boolean;
	/** At least one background bash job is active. */
	bashActive: boolean;
	/** Failed or sleeping rows are still counting down to expiry. */
	lingering: boolean;
	/** The main redraw interval currently exists. */
	ticking: boolean;
}

/**
 * Whether the main 250ms redraw loop should run.
 *
 * Dynamic mode: any activity keeps it alive. Static mode: only lingering rows
 * do — they expire through read-driven pruning, so the loop must outlive them;
 * running agents and jobs repaint on their own events instead.
 */
export function shouldRunTick(p: TickPolicyState): boolean {
	if (p.staticMode) return p.lingering;
	return p.running || p.agentActive || p.bashActive || p.lingering;
}

/**
 * Whether spinner glyphs may advance. Static mode freezes every spinner through
 * this one gate; when the loop is not running the frame must not advance either,
 * or a frozen mid-cycle frame would read as a hung UI.
 */
export function shouldAnimateFrames(p: TickPolicyState): boolean {
	return !p.staticMode && p.ticking && (p.running || p.agentActive || p.bashActive);
}

/**
 * Whether the sidebar's own animation timer should run. Unlike the main tick it
 * also animates while lingering rows are visible (they occupy the dock), but the
 * static-mode gate is identical.
 */
export function shouldAnimateSidebar(p: TickPolicyState): boolean {
	return !p.staticMode && (p.running || p.agentActive || p.bashActive || p.lingering);
}
