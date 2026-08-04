/**
 * Single isolation point for "is the autocomplete popup active" knowledge.
 *
 * Pi 0.83 exposes `isShowingAutocomplete()` as a public method on the Editor
 * class (not on the EditorComponent contract). CockpitClaudeEditor extends
 * CustomEditor, so it can call it directly — no reflection is needed. Keeping
 * the knowledge here means a future Pi that renames or removes the method
 * fails at compile time in one place, and the double-Escape feature fails open
 * (never clears) instead of mis-detecting.
 */
export interface AutocompleteProbeResult {
	/** true: autocomplete is open; an Escape must cancel it, not arm double-Escape. */
	active: boolean;
	/** true: the probe could not read autocomplete state, so double-Escape must not clear. */
	unknown: boolean;
}

export function readAutocompleteState(editor: { isShowingAutocomplete?(): boolean }): AutocompleteProbeResult {
	if (typeof editor.isShowingAutocomplete !== "function") return { active: false, unknown: true };
	try {
		return { active: editor.isShowingAutocomplete(), unknown: false };
	} catch {
		// A broken probe must never clear user input: fail open to native behaviour.
		return { active: false, unknown: true };
	}
}
