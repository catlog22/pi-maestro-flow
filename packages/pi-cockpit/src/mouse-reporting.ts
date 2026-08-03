import type { TUI } from "@earendil-works/pi-tui";

/**
 * Ref-counted terminal mouse reporting shared by the split-pane resize hook
 * (button/drag mode, 1002) and the settings shell (hover mode, 1003). Both use
 * the SGR 1006 extension, so one surface releasing its mode must not disable
 * 1006 while the other still needs it (CS-4). Writes are best-effort; a failed
 * disable is retried on the next explicit flush (e.g. component dispose).
 */

let buttonRefs = 0;
let hoverRefs = 0;
let sgrRefs = 0;
let pendingDisable = "";

function write(tui: TUI | undefined, sequence: string): void {
	if (!tui) return;
	try {
		tui.terminal.write(sequence);
	} catch {
		// Teardown may race terminal disposal; the next flush retries.
		if (sequence.includes("l")) pendingDisable += sequence;
	}
}

/** A shared-disposer style handle: release is idempotent and safe to call twice. */
export interface MouseReportingLease {
	release(): void;
}

export function acquireMouseReporting(tui: TUI, mode: "button" | "hover"): MouseReportingLease {
	if (mode === "button") {
		buttonRefs += 1;
		if (buttonRefs === 1) write(tui, "\u001b[?1002h");
	} else {
		hoverRefs += 1;
		if (hoverRefs === 1) write(tui, "\u001b[?1003h");
	}
	sgrRefs += 1;
	if (sgrRefs === 1) write(tui, "\u001b[?1006h");
	let released = false;
	return {
		release(): void {
			if (released) return;
			released = true;
			if (mode === "button") {
				buttonRefs = Math.max(0, buttonRefs - 1);
				if (buttonRefs === 0) write(tui, "\u001b[?1002l");
			} else {
				hoverRefs = Math.max(0, hoverRefs - 1);
				if (hoverRefs === 0) write(tui, "\u001b[?1003l");
			}
			sgrRefs = Math.max(0, sgrRefs - 1);
			if (sgrRefs === 0) write(tui, "\u001b[?1006l");
		},
	};
}

/** Retry any disable sequences that failed earlier; call from dispose paths. */
export function flushMouseReportingWrites(tui: TUI): void {
	if (pendingDisable === "") return;
	const sequence = pendingDisable;
	pendingDisable = "";
	write(tui, sequence);
}
