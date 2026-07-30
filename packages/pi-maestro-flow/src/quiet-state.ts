// Shared quiet-mode state for pi-maestro-flow's tool rendering.
//
// Cockpit owns the config and broadcasts it on cockpit:ui-ownership. Flow
// mirrors both the enable flag and lifecycle glyph set so every flow-owned tool
// uses the same Quiet presentation without importing Cockpit internals.

export type QuietSymbolMode = "check" | "dot";
export type QuietStatus = "running" | "success" | "failure";

let quietMode = false;
let quietSymbols: QuietSymbolMode = "check";

export function setQuietMode(value: boolean, symbols?: unknown): void {
	quietMode = value;
	if (symbols === "check" || symbols === "dot") quietSymbols = symbols;
}

export function isQuietMode(): boolean {
	return quietMode;
}

export function getQuietSymbols(): QuietSymbolMode {
	return quietSymbols;
}

export function quietStatusMark(status: QuietStatus): string {
	if (quietSymbols === "dot") {
		if (status === "running") return "○";
		if (status === "success") return "●";
		return "!";
	}
	if (status === "running") return "…";
	if (status === "success") return "✓";
	return "✕";
}
