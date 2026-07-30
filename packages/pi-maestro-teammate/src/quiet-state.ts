// Quiet-mode mirror for pi-maestro-teammate tool rendering.
//
// Cockpit owns the quiet-mode config and broadcasts it on the
// cockpit:ui-ownership event (payload.quiet). The extension's ownership
// listener mirrors it here via setQuietMode(); render.ts consults
// isQuietMode() so the teammate tool stream collapses to single-line
// summaries together with every other quiet-aware tool.
//
// This is a fan-out mirror of the same event that pi-maestro-flow mirrors in
// its own quiet-state.ts. Teammate does not import that module (cross-package
// import would create a cycle), so the two packages stay in sync through the
// shared cockpit event rather than a shared implementation. The flag carries no
// logic, so mirroring it twice cannot drift the way a duplicated normalization
// routine would. Defaults to off when cockpit is absent.

let quietMode = false;

export function setQuietMode(value: boolean): void {
	quietMode = value;
}

export function isQuietMode(): boolean {
	return quietMode;
}
