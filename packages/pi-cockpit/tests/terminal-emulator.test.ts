import assert from "node:assert/strict";
import test from "node:test";
import { TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { attachViewportStability } from "../src/viewport-stability.ts";
import { TerminalEmulator, stripAnsi } from "./terminal-emulator.ts";

class EmulatedTerminal implements Terminal {
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	emu: TerminalEmulator;
	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.emu = new TerminalEmulator(columns, rows);
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.emu.write(data); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

interface TuiInternals {
	doRender(): void;
	previousLines: string[];
	previousViewportTop: number;
	previousHeight: number;
	previousWidth: number;
	hardwareCursorRow: number;
}

function harness(columns: number, rows: number, initial: string[]) {
	const terminal = new EmulatedTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	let lines = [...initial];
	const component: Component = {
		render: () => [...lines],
		invalidate: () => undefined,
	};
	tui.addChild(component);
	const internals = tui as unknown as TuiInternals;
	return {
		terminal,
		tui,
		internals,
		setLines(next: string[]) { lines = [...next]; },
		render() { internals.doRender(); },
		/** What the model believes the visible screen shows. */
		expectedScreen(): string[] {
			const top = internals.previousViewportTop;
			return Array.from({ length: rows }, (_, r) =>
				stripAnsi(internals.previousLines[top + r] ?? ""));
		},
		/** Emulated visible screen. */
		actualScreen(): string[] {
			return terminal.emu.visibleText();
		},
	};
}

function assertScreenMatches(h: ReturnType<typeof harness>, label: string) {
	const expected = h.expectedScreen();
	const actual = h.actualScreen();
	assert.deepEqual(
		actual,
		expected,
		`${label}\nexpected:\n${expected.map((l, i) => `  [${i}] ${l}`).join("\n")}\nactual:\n${actual.map((l, i) => `  [${i}] ${l}`).join("\n")}`,
	);
}

test("emulator: transcript growth + dock churn leaves no residue", () => {
	const W = 60;
	const H = 10;
	// 5 transcript + 5 dock lines; viewportTop = 5.
	const dock = (agentRows: string[]) => [
		"─".repeat(20),
		"· · Agent · 1 running",
		...agentRows,
		"─".repeat(20),
		"[editor]",
		"[footer]",
	];
	let transcript = ["t1", "t2", "t3", "t4", "t5"];
	let agents = ["└─ ● running general # task A"];
	const h = harness(W, H, [...transcript, ...dock(agents)]);
	attachViewportStability(h.tui);
	h.render();
	assertScreenMatches(h, "initial");

	// Simulate 40 frames: transcript grows, agent rows churn.
	for (let i = 0; i < 40; i += 1) {
		transcript.push(`t${transcript.length + 1}`);
		// Rotate agent rows (churn).
		agents = [
			`└─ ● running general # task ${i % 3}`,
			...(i % 2 ? [`└─ ● prompting general # task ${i}`] : []),
		];
		h.setLines([...transcript, ...dock(agents)]);
		h.render();
		assertScreenMatches(h, `frame ${i}`);
	}
});

test("emulator: moving and editing a boundary row does not leave its old copy in scrollback", () => {
	const h = harness(60, 3, ["history", "agent A running 1s", "todo", "editor", "footer"]);
	const patch = attachViewportStability(h.tui);
	try {
		h.render();
		for (const next of [
			["history", "new heading", "agent A running 2s", "editor", "footer"],
			["history", "agent A completed", "new heading", "editor", "footer"],
			["history", "new heading", "agent A sleeping", "editor", "footer"],
		]) {
			h.setLines(next);
			h.render();
			// Compare with the intended frame, not previousLines: a corrupted
			// diff baseline can agree with the physical terminal and still be wrong.
			assert.deepEqual([...h.terminal.emu.scrollback, ...h.actualScreen()], next);
		}
	} finally { patch.detach(); }
});

test("emulator: external stderr write scrolls screen outside the model → residue", () => {
	const W = 60;
	const H = 10;
	const dock = (agentRows: string[]) => [
		"─".repeat(20),
		"· · Agent · 1 running",
		...agentRows,
		"─".repeat(20),
		"[editor]",
		"[footer]",
	];
	const transcript = ["t1", "t2", "t3", "t4", "t5"];
	const agents = ["└─ ● running general # task A", "└─ ● prompting general # task B"];
	const h = harness(W, H, [...transcript, ...dock(agents)]);
	attachViewportStability(h.tui);
	h.render();
	assertScreenMatches(h, "initial");

	// An external write (console.error from diagnostic-log) hits the TTY at the
	// hardware cursor (bottom), scrolling the screen without the model knowing.
	h.terminal.emu.write("diagnostic: relay tick failed\n");

	// Next render: model still thinks the screen matches its buffer. The diff
	// only rewrites changed rows, so the scrolled-off dock rows stay as residue.
	transcript.push("t6");
	h.setLines([...transcript, ...dock(agents)]);
	h.render();

	// The model's expected screen vs the emulated physical screen now diverge:
	// the external scroll pushed a row up that the model never rewrote.
	const expected = h.expectedScreen();
	const actual = h.actualScreen();
	const diverged = expected.some((line, i) => line !== actual[i]);
	assert.ok(diverged, "external write should desync model from physical screen");
});

test("emulator: dock shrink while transcript grows", () => {
	const W = 60;
	const H = 10;
	const dock = (agentRows: string[]) => [
		"─".repeat(20),
		"· · Agent · header",
		...agentRows,
		"─".repeat(20),
		"[editor]",
		"[footer]",
	];
	let transcript = ["t1", "t2", "t3", "t4", "t5"];
	// Start with many agent rows.
	let agents = Array.from({ length: 8 }, (_, i) => `└─ ● running general # task ${i}`);
	const h = harness(W, H, [...transcript, ...dock(agents)]);
	attachViewportStability(h.tui);
	h.render();
	assertScreenMatches(h, "initial");

	for (let i = 0; i < 30; i += 1) {
		transcript.push(`t${transcript.length + 1}`);
		// Shrink agent rows over time.
		agents = agents.slice(0, Math.max(1, agents.length - (i % 3 === 0 ? 1 : 0)));
		h.setLines([...transcript, ...dock(agents)]);
		h.render();
		assertScreenMatches(h, `frame ${i}`);
	}
});
