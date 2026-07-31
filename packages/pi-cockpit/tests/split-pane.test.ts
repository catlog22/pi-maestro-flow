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
