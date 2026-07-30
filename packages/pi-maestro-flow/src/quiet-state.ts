// Shared quiet-mode flag for pi-maestro-flow's tool rendering.
//
// Cockpit owns the quiet-mode config and broadcasts it on the cockpit:ui-ownership
// event; the extension's listener mirrors it here via setQuietMode(). Every
// flow-owned tool renderer consults isQuietMode() so the whole tool surface
// switches together, and there is a single source of truth across extension/,
// mcp/ and tools/. Defaults to off when cockpit is absent.

let quietMode = false;

export function setQuietMode(value: boolean): void {
	quietMode = value;
}

export function isQuietMode(): boolean {
	return quietMode;
}
