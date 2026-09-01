import assert from "node:assert/strict";
import test from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { ambientKeysShouldYield, customComponentCapturesInput } from "../../pi-cockpit/src/capturing-overlay.ts";
import { executeAsk } from "../src/tools/ask.ts";

/**
 * Integration repro: the cockpit session-bar ←/→ agent-cycling listener runs
 * in the TUI's inputListeners (before the focused component). It must yield
 * while a custom component (the ask wizard, ui.custom without overlay) owns
 * input focus, otherwise ←/→ never reaches the wizard. This test drives the
 * real pi-tui input pipeline with a real wizard panel and the real
 * ambientKeysShouldYield guard.
 */

interface FeedableTerminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
	hideCursor(): void;
	showCursor(): void;
	stop(): void;
	feed(data: string): void;
}

function makeTerminal(): FeedableTerminal {
	let onInput: ((data: string) => void) | undefined;
	return {
		start(cb) {
			onInput = cb;
		},
		write() {},
		get columns() {
			return 100;
		},
		get rows() {
			return 30;
		},
		hideCursor() {},
		showCursor() {},
		stop() {},
		feed(data) {
			onInput?.(data);
		},
	};
}

function createAskHarness(tui: TUI) {
	let component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
	let overlay = false;
	const theme = {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: typeof theme,
				_keybindings: unknown,
				done: (result: T | undefined) => void,
			) => unknown,
			options?: { overlay?: boolean; overlayOptions?: unknown },
		) {
			overlay = options?.overlay === true;
			return new Promise<T | undefined>((resolve) => {
				let resolved = false;
				const done = (result: T | undefined) => {
					if (resolved) return;
					resolved = true;
					component?.dispose?.();
					resolve(result);
				};
				component = factory(tui, theme, {}, done) as typeof component;
			});
		},
		onTerminalInput() {
			return () => {};
		},
	};
	const ctx = { hasUI: true, ui } as never;
	return {
		ctx,
		get component() {
			return component;
		},
		get overlay() {
			return overlay;
		},
	};
}

test("ask wizard ←/→ survives the session-bar cycling listener while mounted in the composer", async () => {
	const terminal = makeTerminal();
	const tui = new TuiMainScreen(terminal as never);

	// Mirror the cockpit session-bar hook: consume ←/→ on an empty composer
	// unless ambient keys should yield (capturing overlay or custom component).
	let sessionBarConsumed: string[] = [];
	tui.addInputListener((data) => {
		if (data !== "\x1b[D" && data !== "\x1b[C") return undefined;
		if (ambientKeysShouldYield(tui)) return undefined;
		sessionBarConsumed.push(data);
		return { consume: true };
	});
	tui.start();

	const harness = createAskHarness(tui);
	const pending = executeAsk({
		questions: [
			{ question: "First full question?", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Second full question?", header: "Second", options: [{ label: "C" }, { label: "D" }] },
		],
	}, harness.ctx as never);

	assert.equal(harness.overlay, false, "wizard is no longer an overlay");
	const panel = harness.component;
	assert.ok(panel);

	// With no custom component mounted, ←/→ belongs to the session bar.
	terminal.feed("\x1b[D");
	assert.deepEqual(sessionBarConsumed, ["\x1b[D"], "session bar consumes ← on an empty composer");
	sessionBarConsumed = [];

	// showExtensionCustom's non-overlay branch mounts the panel and focuses it.
	tui.setFocus(panel as never);
	assert.ok(customComponentCapturesInput(tui), "wizard panel is detected as a custom component");
	assert.ok(ambientKeysShouldYield(tui), "ambient keys yield to the mounted wizard");

	// → selects the current option and advances; ← goes back. The session bar
	// must not steal either while the wizard holds input focus.
	terminal.feed("\x1b[C");
	let rendered = panel.render(100).join("\n");
	assert.match(rendered, /Second full question\?/, "→ advanced to the second question");
	assert.deepEqual(sessionBarConsumed, [], "session bar must not consume → while the wizard is focused");

	terminal.feed("\x1b[D");
	rendered = panel.render(100).join("\n");
	assert.match(rendered, /First full question\?/, "← returned to the first question");
	assert.deepEqual(sessionBarConsumed, [], "session bar must not consume ← while the wizard is focused");

	tui.setFocus(null);
	assert.equal(ambientKeysShouldYield(tui), false, "keys return to the session bar after the wizard closes");

	panel.dispose?.();
	const result = await pending;
	assert.equal(result.details?.cancelled, true, "dispose resolves the questionnaire as cancelled");
});
