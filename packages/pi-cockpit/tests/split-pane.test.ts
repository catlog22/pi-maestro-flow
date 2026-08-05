import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
	COCKPIT_SPLIT_PANE_MARKER,
	createSplitPaneController,
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_MAIN_WIDTH,
	MIN_SIDEBAR_WIDTH,
	MIN_SPLIT_TERMINAL_WIDTH,
	parseSgrMouseEvent,
} from "../src/split-pane.ts";

interface TuiHarness {
	tui: TUI;
	widths: number[];
	writes: string[];
	renders: () => number;
	baseRender: TUI["render"];
}

function tuiHarness(columns = 120, render?: TUI["render"]): TuiHarness {
	const widths: number[] = [];
	const writes: string[] = [];
	let renderRequests = 0;
	const baseRender: TUI["render"] = render ?? ((width: number) => {
		widths.push(width);
		return [`main:${width}`];
	});
	const tui = {
		terminal: {
			columns,
			rows: 30,
			write: (value: string) => { writes.push(value); },
		},
		render: baseRender,
		requestRender: () => { renderRequests++; },
	} as unknown as TUI;
	return { tui, widths, writes, renders: () => renderRequests, baseRender };
}

test("split pane reserves the clamped dock width and auto-hides below 104 columns", () => {
	assert.equal(DEFAULT_SIDEBAR_WIDTH, 40);
	assert.equal(MIN_SIDEBAR_WIDTH, 32);
	assert.equal(MAX_SIDEBAR_WIDTH, 56);
	assert.equal(MIN_MAIN_WIDTH, 72);
	assert.equal(MIN_SPLIT_TERMINAL_WIDTH, 104);

	const harness = tuiHarness();
	const controller = createSplitPaneController();
	controller.attach(harness.tui);
	controller.show();
	assert.equal(controller.overlayOptions().anchor, "top-right");
	assert.equal(controller.overlayOptions().maxHeight, "100%");
	assert.equal(controller.overlayOptions().nonCapturing, true);

	harness.tui.render(103);
	harness.tui.render(104);
	harness.tui.render(120);
	assert.deepEqual(harness.widths, [103, 72, 80]);
	assert.equal(controller.getEffectiveSidebarWidth(103), 0);
	assert.equal(controller.getEffectiveSidebarWidth(104), 32);
	assert.equal(controller.getEffectiveSidebarWidth(120), 40);
	assert.equal(controller.overlayOptions().width, 40);
});

test("deferred dock callbacks keep one render snapshot coherent under reentrancy", () => {
	const harness = tuiHarness();
	const scheduled: Array<() => void> = [];
	const visibility: boolean[] = [];
	const widths: number[] = [];
	let controller!: ReturnType<typeof createSplitPaneController>;
	controller = createSplitPaneController({
		schedule: (callback) => { scheduled.push(callback); },
		onVisibilityChange: (visible) => {
			visibility.push(visible);
			if (visible) controller.hide();
		},
		onEffectiveWidthChange: (width) => { widths.push(width); },
	});
	controller.attach(harness.tui);
	controller.show();
	harness.tui.render(120);
	scheduled.shift()?.();
	assert.deepEqual(visibility, [true]);
	assert.deepEqual(widths, [40], "the paired width belongs to the same rendered dock state");
	scheduled.shift()?.();
	assert.deepEqual(visibility, [true, false]);
	assert.deepEqual(widths, [40, 0]);
});

test("resize input is temporary, commits on Enter, rolls back on Escape, and cleans up once", () => {
	const harness = tuiHarness();
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let unsubscribes = 0;
	const commits: number[] = [];
	const resizeStates: boolean[] = [];
	const controller = createSplitPaneController({
		subscribeInput: (next) => {
			handler = next;
			return () => { unsubscribes++; };
		},
		onResizeCommit: (width) => { commits.push(width); },
		onResizeChange: (resizing) => { resizeStates.push(resizing); },
	});
	controller.attach(harness.tui);
	controller.show();

	assert.equal(controller.beginResize(), true);
	assert.equal(controller.beginResize(), true);
	handler?.("\x1b[D");
	handler?.("\x1b[d");
	assert.equal(controller.getSidebarWidth(), 45);
	handler?.("\x1b");
	assert.equal(controller.getSidebarWidth(), 40);
	assert.deepEqual(commits, []);
	assert.equal(unsubscribes, 1);

	assert.equal(controller.beginResize(), true);
	handler?.("\x1b[C");
	handler?.("\r");
	assert.equal(controller.getSidebarWidth(), 39);
	assert.deepEqual(commits, [39]);
	assert.equal(unsubscribes, 2);
	assert.deepEqual(resizeStates, [true, false, true, false]);
	assert.equal(harness.writes.filter((value) => value.includes("?1006h")).length, 2);
	assert.equal(harness.writes.filter((value) => value.includes("?1006l")).length, 2);
});

test("SGR mouse parsing and divider dragging resize the dock", () => {
	assert.deepEqual(parseSgrMouseEvent("\x1b[<0;81;5M"), {
		button: 0,
		x: 81,
		y: 5,
		release: false,
		motion: false,
	});
	assert.equal(parseSgrMouseEvent("not mouse"), undefined);

	const harness = tuiHarness();
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const commits: number[] = [];
	const controller = createSplitPaneController({
		subscribeInput: (next) => {
			handler = next;
			return () => undefined;
		},
		onResizeCommit: (width) => { commits.push(width); },
	});
	controller.attach(harness.tui);
	controller.show();
	controller.beginResize();
	handler?.("\x1b[<0;81;5M");
	handler?.("\x1b[<32;76;5M");
	assert.equal(controller.getSidebarWidth(), 45);
	handler?.("\x1b[<0;76;5m");
	assert.deepEqual(commits, [45]);
});

test("drag motion coalesces renders and skips unchanged clamped widths", () => {
	const harness = tuiHarness();
	const scheduled: Array<() => void> = [];
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const controller = createSplitPaneController({
		schedule: (callback) => { scheduled.push(callback); },
		subscribeInput: (next) => {
			handler = next;
			return () => undefined;
		},
	});
	controller.attach(harness.tui);
	controller.show();
	while (scheduled.length > 0) scheduled.shift()?.();
	controller.beginResize();
	const beforeMotion = harness.renders();

	handler?.("\x1b[<0;81;5M");
	handler?.("\x1b[<32;76;5M");
	handler?.("\x1b[<32;75;5M");
	assert.equal(harness.renders(), beforeMotion, "motion renders are deferred");
	while (scheduled.length > 0) scheduled.shift()?.();
	assert.equal(harness.renders(), beforeMotion + 1, "a motion burst requests one render");
	assert.equal(controller.getSidebarWidth(), 46, "the latest motion width wins");

	const beforeClampedMotion = harness.renders();
	handler?.("\x1b[<32;1;5M");
	while (scheduled.length > 0) scheduled.shift()?.();
	assert.equal(controller.getSidebarWidth(), 120 - MIN_MAIN_WIDTH);
	assert.equal(harness.renders(), beforeClampedMotion + 1);

	const atMaximum = harness.renders();
	handler?.("\x1b[<32;1;5M");
	assert.equal(scheduled.length, 0, "an unchanged clamped width schedules nothing");
	assert.equal(harness.renders(), atMaximum);
});

test("a narrow-render failure disables the split and retries the prior renderer at full width", () => {
	const calls: number[] = [];
	const errors: unknown[] = [];
	const baseRender = ((width: number) => {
		calls.push(width);
		if (width === 80) throw new Error("narrow failed");
		return [`main:${width}`];
	}) as TUI["render"];
	const harness = tuiHarness(120, baseRender);
	const controller = createSplitPaneController({ onError: (error) => { errors.push(error); } });
	controller.attach(harness.tui);
	controller.show();

	assert.deepEqual(harness.tui.render(120), ["main:120"]);
	assert.deepEqual(calls, [80, 120]);
	assert.equal(controller.isEnabled(), false);
	assert.equal(errors.length, 1);
	controller.dispose();
	assert.equal(harness.tui.render, baseRender);
	controller.dispose();
});

test("the global marker prevents duplicate Cockpit wrappers and exact restore preserves replacements", () => {
	const harness = tuiHarness();
	const first = createSplitPaneController();
	const second = createSplitPaneController();
	first.attach(harness.tui);
	assert.ok((harness.tui.render as TUI["render"] & Record<symbol, unknown>)[COCKPIT_SPLIT_PANE_MARKER]);
	assert.throws(() => second.attach(harness.tui), /already attached/);

	const replacement = ((width: number) => [`replacement:${width}`]) as TUI["render"];
	harness.tui.render = replacement;
	first.dispose();
	assert.equal(harness.tui.render, replacement, "dispose must not overwrite a later renderer");
});

test("SP-2: only the initiating button's release commits a drag, and off-divider clicks do not start one", () => {
	const harness = tuiHarness();
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const commits: number[] = [];
	const controller = createSplitPaneController({
		subscribeInput: (next) => {
			handler = next;
			return () => undefined;
		},
		onResizeCommit: (width) => { commits.push(width); },
	});
	controller.attach(harness.tui);
	controller.show();
	controller.beginResize();
	// Button 1 (middle) release with no drag in flight must not commit anything.
	handler?.("\x1b[<1;81;5m");
	assert.deepEqual(commits, []);
	// Left-button drag, then a different button's release must not commit.
	handler?.("\x1b[<0;81;5M");
	handler?.("\x1b[<32;76;5M");
	handler?.("\x1b[<1;76;5m");
	assert.deepEqual(commits, [], "a non-initiating release must not commit the drag");
	// The initiating button's own release commits.
	handler?.("\x1b[<0;76;5m");
	assert.deepEqual(commits, [45]);
});

test("SP-3: keyboard nudges end an in-flight mouse drag so motion cannot overwrite them", () => {
	const harness = tuiHarness();
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const commits: number[] = [];
	const controller = createSplitPaneController({
		subscribeInput: (next) => {
			handler = next;
			return () => undefined;
		},
		onResizeCommit: (width) => { commits.push(width); },
	});
	controller.attach(harness.tui);
	controller.show();
	controller.beginResize();
	handler?.("\x1b[<0;81;5M");
	handler?.("\x1b[<32;76;5M");
	assert.equal(controller.getSidebarWidth(), 45);
	// Keyboard nudge ends the drag; a subsequent motion must not move the width.
	handler?.("\x1b[C"); // right arrow = one column narrower
	assert.equal(controller.getSidebarWidth(), 44);
	handler?.("\x1b[<32;100;5M");
	assert.equal(controller.getSidebarWidth(), 44, "motion after a keyboard nudge must not overwrite it");
	// The drag ended with the nudge; the mouse release must not commit a width.
	handler?.("\x1b[<0;100;5m");
	assert.deepEqual(commits, [], "release after a keyboard nudge must not commit");
	// Enter still commits the keyboard-adjusted width.
	handler?.("\r");
	assert.deepEqual(commits, [44], "Enter commits the keyboard-adjusted width");
});

test("SP-4: keyboard nudges clamp to the effective maximum on a narrow terminal", () => {
	const harness = tuiHarness(104); // effective max = min(56, 104-72) = 32
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const controller = createSplitPaneController({
		subscribeInput: (next) => {
			handler = next;
			return () => undefined;
		},
	});
	controller.attach(harness.tui);
	controller.show();
	controller.beginResize();
	for (let i = 0; i < 40; i++) handler?.("\x1b[C"); // right = narrower
	// Start from the effective width; nudging wider must stop at 32.
	for (let i = 0; i < 40; i++) handler?.("\x1b[D"); // left = wider
	assert.equal(controller.getSidebarWidth(), 32, "narrow-terminal nudge must not exceed the effective maximum");
});

test("SP-5: a second split controller is rejected even when the render chain is wrapped", () => {
	const harness = tuiHarness();
	const first = createSplitPaneController();
	first.attach(harness.tui);
	// Another renderer wraps the split wrapper (as editor-bottom does in prod).
	const wrapped = ((width: number) => [`wrapped:${width}`]) as TUI["render"];
	harness.tui.render = wrapped;
	// The instance-level owner guard must still reject a second controller.
	const second = createSplitPaneController();
	assert.throws(() => second.attach(harness.tui), /already attached/);
	first.dispose();
	assert.equal(harness.tui.render, wrapped, "dispose restores the wrapper that replaced us");
});
