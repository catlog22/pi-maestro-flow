import type { TUI } from "@earendil-works/pi-tui";

interface OverlayStackEntry {
	hidden?: boolean;
	options?: {
		nonCapturing?: boolean;
		visible?: (width: number, height: number) => boolean;
	};
}

/**
 * True while a capturing (focus-owning) modal overlay is visible.
 *
 * Plain `hasOverlay()` cannot be used for this: the cockpit dock sidebar is
 * itself a non-capturing overlay, so hasOverlay() stays true in normal dock
 * mode and would wrongly suppress ambient empty-composer behaviours (←/→
 * agent cycling, Shift+↑/↓ roster scrolling) — and, conversely, ambient
 * listeners must yield to real modals like /todo or the ask wizard. Only a
 * visible overlay that captures focus actually owns the keyboard.
 */
export function capturingOverlayVisible(tui: TUI | undefined): boolean {
	if (!tui) return false;
	if (typeof tui.hasOverlay !== "function") return false; // mocked TUI without overlay support
	if (!tui.hasOverlay()) return false;
	// Read the overlay stack directly: the TUI exposes no public API to tell
	// capturing from non-capturing overlays. The stack entries carry the
	// nonCapturing/visible options the same showOverlay used to build them.
	const stack = (tui as unknown as { overlayStack?: readonly OverlayStackEntry[] }).overlayStack;
	if (!stack) return true; // unknown internals: defer to any visible overlay
	return stack.some((entry) => {
		if (entry.hidden) return false;
		const options = entry.options;
		if (options?.visible && !options.visible(tui.terminal.columns, tui.terminal.rows)) return false;
		return options?.nonCapturing !== true;
	});
}
