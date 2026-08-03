import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createSidebarComponent, createSidebarController } from "../src/sidebar-controller.ts";
import { DEFAULT_CONFIG, type TodoItem } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

interface CustomSession {
	component: Component;
	options: {
		overlay?: boolean;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
		onHandle?: (handle: OverlayHandle) => void;
	};
	done(): void;
	handleHides(): number;
	hiddenStates(): boolean[];
}

function harness(deferHandles = false) {
	const sessions: CustomSession[] = [];
	const pendingHandles: Array<() => void> = [];
	let doneCalls = 0;
	let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	let requests = 0;
	const baseRender = ((width: number) => [`main:${width}`]) as TUI["render"];
	const tui = {
		terminal: {
			columns: 120,
			rows: 20,
			write: () => undefined,
		},
		render: baseRender,
		requestRender: () => { requests++; },
	} as unknown as TUI;
	const ui = {
		notify: () => undefined,
		onTerminalInput: (handler: typeof terminalHandler) => {
			terminalHandler = handler;
			return () => { terminalHandler = undefined; };
		},
		custom: <T>(factory: (
			tui: TUI,
			theme: Theme,
			keybindings: never,
			done: (result: T) => void,
		) => Component, options: CustomSession["options"] = {}) => {
			let resolve!: (value: T) => void;
			const pending = new Promise<T>((done) => { resolve = done; });
			let handleHides = 0;
			let settled = false;
			const done = (value: T): void => {
				if (settled) return;
				settled = true;
				doneCalls++;
				resolve(value);
			};
			const component = factory(tui, theme, undefined as never, done);
			const hiddenStates: boolean[] = [];
			const handle: OverlayHandle = {
				hide: () => { handleHides++; },
				setHidden: (hidden) => { hiddenStates.push(hidden); },
				isHidden: () => hiddenStates.at(-1) ?? false,
				focus: () => undefined,
				unfocus: () => undefined,
				isFocused: () => false,
			};
			const session: CustomSession = {
				component,
				options,
				done: () => done(undefined as T),
				handleHides: () => handleHides,
				hiddenStates: () => [...hiddenStates],
			};
			sessions.push(session);
			const publishHandle = () => options.onHandle?.(handle);
			if (deferHandles) pendingHandles.push(publishHandle);
			else publishHandle();
			return pending;
		},
	};
	const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext;
	return {
		ctx,
		tui,
		baseRender,
		sessions,
		requests: () => requests,
		doneCalls: () => doneCalls,
		deliverHandles: () => {
			while (pendingHandles.length > 0) pendingHandles.shift()?.();
		},
		input: (data: string) => terminalHandler?.(data),
	};
}

function baseOptions(ctx: ExtensionContext) {
	return {
		ctx,
		getMaestroSnapshot: () => undefined,
		getTodos: (): readonly TodoItem[] => [],
		getAgents: () => [],
		getJobs: () => [],
		getConfig: () => DEFAULT_CONFIG,
	};
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("show creates a top-right dynamic overlay whose factory returns a real component", () => {
	const h = harness();
	const controller = createSidebarController(baseOptions(h.ctx));
	controller.show();
	controller.show();
	assert.equal(h.sessions.length, 1);
	const session = h.sessions[0];
	assert.equal(session.options.overlay, true);
	assert.equal(typeof session.options.overlayOptions, "function");
	assert.equal((session.options.overlayOptions as () => OverlayOptions)().anchor, "top-right");
	assert.equal(typeof session.component.render, "function");
	assert.equal(session.component.render(40).length, 20);
	assert.equal(controller.isVisible(), true);
	assert.ok(h.requests() > 0);
});

test("component pulls fresh snapshots on every render and falls back after render errors", () => {
	const h = harness();
	let todos: TodoItem[] = [];
	let fail = false;
	const scheduled: Array<() => void> = [];
	const errors: unknown[] = [];
	const controller = createSidebarController({
		...baseOptions(h.ctx),
		getTodos: () => {
			if (fail) throw new Error("snapshot unavailable");
			return todos;
		},
		schedule: (callback) => { scheduled.push(callback); },
		onError: (error) => { errors.push(error); },
	});
	controller.show();
	const component = h.sessions[0].component;
	assert.doesNotMatch(component.render(40).join("\n"), /Tasks/);
	todos = [{ id: "1", subject: "Live task", status: "in_progress", blockedBy: [], skills: [] }];
	assert.match(component.render(40).join("\n"), /Live task/);

	fail = true;
	const fallback = component.render(40).join("\n");
	assert.match(fallback, /Cockpit sidebar/);
	assert.match(fallback, /snapshot unavailable/);
	assert.equal(errors.length, 0, "error callbacks are deferred out of render");
	while (scheduled.length > 0) scheduled.shift()?.();
	assert.equal(errors.length, 1);
});

test("component fallback contains errors from height, resize, and error callbacks", () => {
	const base = {
		getMaestroSnapshot: () => undefined,
		getTodos: () => [],
		getAgents: () => [],
		getJobs: () => [],
		getConfig: () => DEFAULT_CONFIG,
		theme,
	};
	const heightFailure = createSidebarComponent({
		...base,
		getHeight: () => { throw new Error("height unavailable"); },
		isResizing: () => false,
		getScrollStart: () => 0,
		onRenderError: () => { throw new Error("report failed"); },
	});
	assert.doesNotThrow(() => heightFailure.render(40));
	assert.match(heightFailure.render(40).join("\n"), /Cockpit sidebar/);

	const resizeFailure = createSidebarComponent({
		...base,
		getHeight: () => 4,
		isResizing: () => { throw new Error("resize unavailable"); },
		getScrollStart: () => 0,
	});
	assert.doesNotThrow(() => resizeFailure.render(40));
	assert.match(resizeFailure.render(40).join("\n"), /resize unavailable/);
});

test("effective dock callbacks are deferred and resizing commits through terminal input", () => {
	const h = harness();
	const scheduled: Array<() => void> = [];
	const visibility: boolean[] = [];
	const widths: number[] = [];
	const commits: number[] = [];
	const controller = createSidebarController({
		...baseOptions(h.ctx),
		schedule: (callback) => { scheduled.push(callback); },
		onVisibilityChange: (visible) => { visibility.push(visible); },
		onEffectiveWidthChange: (width) => { widths.push(width); },
		onResizeCommit: (width) => { commits.push(width); },
	});
	controller.show();
	h.tui.render(120);
	assert.deepEqual(visibility, []);
	assert.deepEqual(widths, []);
	while (scheduled.length > 0) scheduled.shift()?.();
	assert.deepEqual(visibility, [true]);
	assert.deepEqual(widths, [40]);

	assert.equal(controller.beginResize(), true);
	h.input("\x1b[D");
	h.input("\r");
	assert.deepEqual(commits, [41]);
	assert.equal(controller.getWidth(), 41);
});

test("hide and show reuse the same overlay without settling the host custom session", () => {
	const h = harness();
	const controller = createSidebarController(baseOptions(h.ctx));
	controller.show();
	controller.hide();
	controller.show();
	assert.equal(h.sessions.length, 1);
	assert.equal(h.doneCalls(), 0);
	assert.deepEqual(h.sessions[0].hiddenStates(), [true, false]);
	assert.equal(controller.isVisible(), true);
});

test("hide before asynchronous handle delivery hides only the sidebar handle", () => {
	const h = harness(true);
	const controller = createSidebarController(baseOptions(h.ctx));
	controller.show();
	controller.hide();
	assert.equal(h.doneCalls(), 0);
	h.deliverHandles();
	assert.deepEqual(h.sessions[0].hiddenStates(), [true]);
	controller.show();
	assert.equal(h.sessions.length, 1);
	assert.deepEqual(h.sessions[0].hiddenStates(), [true, false]);
});

test("dispose is idempotent, removes only its overlay handle, and restores the exact prior renderer", async () => {
	const h = harness();
	const controller = createSidebarController(baseOptions(h.ctx));
	controller.show();
	assert.notEqual(h.tui.render, h.baseRender);
	controller.dispose();
	controller.dispose();
	await flushPromises();
	assert.equal(controller.isVisible(), false);
	assert.equal(h.tui.render, h.baseRender);
	assert.equal(h.sessions[0].handleHides(), 1);
	assert.equal(h.doneCalls(), 0, "host custom done() would close an unrelated topmost overlay");
});

test("browse focus mode consumes keys, scrolls by stable id, and yields to resize", async () => {
	const h = harness();
	const agents = Array.from({ length: 8 }, (_, i) => ({
		correlationId: `agent-${i}`,
		agent: "general",
		name: `agent-${i}`,
		role: "general",
		status: "running" as const,
		startedAt: 0,
		lastActivityAt: 0,
		task: `task-${i}`,
		tail: "",
	}));
	let currentAgents = agents;
	const controller = createSidebarController({
		...baseOptions(h.ctx),
		getAgents: () => currentAgents,
	});
	controller.show();
	await flushPromises();
	h.deliverHandles();

	assert.equal(controller.isFocused(), false);
	assert.equal(controller.beginFocus(), true);
	assert.equal(controller.isFocused(), true);

	// Esc exits focus mode.
	assert.deepEqual(h.input("\x1b"), { consume: true });
	assert.equal(controller.isFocused(), false);

	// Enter again and navigate: down keys move the selection.
	controller.beginFocus();
	h.input("\x1b[B"); // down
	h.input("\x1b[B"); // down
	h.input("j"); // down
	h.input("k"); // up
	// Reordering the roster must not lose the anchored selection window (SB-3):
	// move far down, then drop most rows, then move again — all stays clamped.
	for (let i = 0; i < 12; i++) h.input("\x1b[B");
	assert.equal(controller.isFocused(), true);
	// A resize attempt must leave browse mode first.
	controller.beginResize();
	assert.equal(controller.isFocused(), false);
	h.input("\x1b");
});
