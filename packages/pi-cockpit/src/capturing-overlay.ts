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

interface FocusedComponentLike {
	handleInput?: unknown;
	getText?: unknown;
	getExpandedText?: unknown;
	setText?: unknown;
}

/**
 * True while a non-overlay custom component (e.g. the ask wizard via
 * `ui.custom`) owns input focus. `showExtensionCustom` mounts such components
 * in the editor container and calls `setFocus` on them; the built-in editor is
 * the only other focusable component, and it is distinguishable by its
 * EditorComponent text API (getText/getExpandedText/setText). Ambient
 * empty-composer hooks (←/→ cycling, Shift+↑/↓ scroll) must yield to any
 * component that is actively consuming keys.
 */
export function customComponentCapturesInput(tui: TUI | undefined): boolean {
	if (!tui) return false;
	const focused = (tui as unknown as { focusedComponent?: FocusedComponentLike | null }).focusedComponent;
	if (!focused) return false;
	if (typeof focused.handleInput !== "function") return false;
	// The built-in editor implements the EditorComponent text API.
	if (
		typeof focused.getText === "function"
		|| typeof focused.getExpandedText === "function"
		|| typeof focused.setText === "function"
	) {
		return false;
	}
	return true;
}

/**
 * True when ambient empty-composer keyboard hooks should yield to whatever the
 * user is actually interacting with: a capturing modal overlay, or a custom
 * component mounted in the composer (ui.custom without overlay: true).
 */
export function ambientKeysShouldYield(tui: TUI | undefined): boolean {
	return capturingOverlayVisible(tui) || customComponentCapturesInput(tui);
}
