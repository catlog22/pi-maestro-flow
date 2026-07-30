import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveGlyphs, spinFrame } from "../src/icons.ts";
import {
	ThinkingFoldTimer,
	findThinkingLabelTargets,
	formatThinkingDuration,
	type ThinkingLabelTarget,
} from "../src/thinking-timer.ts";

interface FakeTarget extends ThinkingLabelTarget {
	labels: string[];
}

const fakeTarget = (): FakeTarget => ({
	labels: [],
	setHiddenThinkingLabel(label: string): void {
		this.labels.push(label);
	},
	setHideThinkingBlock: (): void => {},
});

const fakeComponent = (): { render: (w: number) => string[]; invalidate: () => void } => ({
	render: () => [],
	invalidate: (): void => {},
});

const fakeTui = (...children: unknown[]): TUI => ({ children }) as unknown as TUI;

const ev = (type: string): AssistantMessageEvent => ({ type }) as unknown as AssistantMessageEvent;

const GLYPHS = resolveGlyphs("nerd");

interface HarnessOptions {
	tui?: TUI;
	baseLabel?: string | undefined;
	hidden?: boolean;
	enabled?: boolean;
	settleMs?: number;
}

interface Harness {
	timer: ThinkingFoldTimer;
	advance: (ms: number) => void;
	global: (string | undefined)[];
	renderCalls: () => number;
	setHidden: (hidden: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	setBaseLabel: (label: string | undefined) => void;
}

const makeHarness = (options: HarnessOptions = {}): Harness => {
	let nowMs = 1_000;
	let hidden = options.hidden ?? true;
	let enabled = options.enabled ?? true;
	let baseLabel: string | undefined = options.baseLabel === undefined ? "thoughts" : options.baseLabel;
	let renders = 0;
	const global: (string | undefined)[] = [];
	const timer = new ThinkingFoldTimer({
		getTui: () => options.tui,
		requestRender: () => {
			renders++;
		},
		getBaseLabel: () => baseLabel,
		getGlyphs: () => GLYPHS,
		isThinkingHidden: () => hidden,
		isEnabled: () => enabled,
		setGlobalLabel: (label) => {
			global.push(label);
		},
		now: () => nowMs,
		settleMs: options.settleMs,
	});
	return {
		timer,
		advance: (ms) => {
			nowMs += ms;
		},
		global,
		renderCalls: () => renders,
		setHidden: (value) => {
			hidden = value;
		},
		setEnabled: (value) => {
			enabled = value;
		},
		setBaseLabel: (label) => {
			baseLabel = label;
		},
	};
};

test("findThinkingLabelTargets returns targets in document order", () => {
	const first = fakeTarget();
	const second = fakeTarget();
	const tui = fakeTui(
		{ children: [first] },
		{ children: [{ children: [second] }] },
		fakeComponent(),
	);
	assert.deepEqual(findThinkingLabelTargets(tui), [first, second]);
});

test("findThinkingLabelTargets ignores partial duck types and survives cycles", () => {
	const onlyLabel = { setHiddenThinkingLabel: () => {} };
	const onlyHide = { setHideThinkingBlock: () => {} };
	const editorLike = { actionHandlers: new Map([["app.thinking.toggle", () => {}]]) };
	const a: Record<string, unknown> = { children: [] };
	const b: Record<string, unknown> = { children: [a] };
	a.children = [b, onlyLabel, onlyHide, editorLike, fakeComponent()];
	assert.deepEqual(findThinkingLabelTargets(fakeTui(a)), []);
});

test("formatThinkingDuration formats tenths, seconds and minutes", () => {
	assert.equal(formatThinkingDuration(0), "0.0s");
	assert.equal(formatThinkingDuration(-5), "0.0s");
	assert.equal(formatThinkingDuration(Number.NaN), "0.0s");
	assert.equal(formatThinkingDuration(300), "0.3s");
	assert.equal(formatThinkingDuration(8_400), "8.4s");
	assert.equal(formatThinkingDuration(9_999), "10.0s");
	assert.equal(formatThinkingDuration(10_000), "10s");
	assert.equal(formatThinkingDuration(59_400), "59s");
	assert.equal(formatThinkingDuration(65_400), "1m05s");
	assert.equal(formatThinkingDuration(3_600_000), "60m00s");
});

test("a thinking run animates only the newest row and settles its actual duration", () => {
	const older = fakeTarget();
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(older, current) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(current.labels.length, 1, "first frame paints immediately");
	assert.equal(current.labels[0], `${spinFrame(GLYPHS, 1_000)} thinking 0.0s`);
	assert.equal(older.labels.length, 0, "earlier messages are never touched");

	h.advance(3_200);
	h.timer.tick();
	assert.equal(current.labels.at(-1), `${spinFrame(GLYPHS, 4_200)} thinking 3.2s`);
	assert.ok(h.renderCalls() >= 2, "instance writes schedule paints");

	h.advance(5_200);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.at(-1), `thoughts${GLYPHS.separator}8.4s`);

	const painted = current.labels.length;
	h.advance(1_000);
	h.timer.tick();
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.length, painted, "settled run ignores further frames and ends");
});

test("message_end settles an interrupted run while the row is still mounted", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.advance(5_200);
	h.timer.onAssistantMessageEnd();
	assert.equal(current.labels.at(-1), `thoughts${GLYPHS.separator}5.2s`);

	// The late thinking_end for the same run must not repaint.
	const painted = current.labels.length;
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.length, painted);
});

test("stop() drops an active run without settling a duration", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.advance(2_000);
	h.timer.tick();
	h.timer.stop();
	assert.match(current.labels.at(-1) ?? "", /thinking 2\.0s$/, "last paint stays an animation frame");

	const painted = current.labels.length;
	h.advance(2_000);
	h.timer.tick();
	h.timer.onAssistantMessageEnd();
	assert.equal(current.labels.length, painted, "nothing settles after stop");
});

test("unfolded thinking is left alone", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current), hidden: false });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.advance(2_000);
	h.timer.tick();
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.length, 0);
	assert.equal(h.global.length, 0);
});

test("disabling cockpit stops an active run", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.setEnabled(false);
	h.timer.onAssistantMessageEvent(ev("thinking_delta"));

	const painted = current.labels.length;
	h.advance(2_000);
	h.timer.tick();
	assert.equal(current.labels.length, painted);
});

test("without reachable components the global label carries animation and settle", async () => {
	const h = makeHarness({ tui: fakeTui(fakeComponent()), settleMs: 25 });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(h.global[0], `${spinFrame(GLYPHS, 1_000)} thinking 0.0s`);

	h.advance(8_400);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(h.global.at(-1), `thoughts${GLYPHS.separator}8.4s`);

	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(h.global.at(-1), "thoughts", "base label returns once the settle window passes");
});

test("reset() cancels a pending global restore", async () => {
	const h = makeHarness({ tui: undefined, settleMs: 25 });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.advance(1_000);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	const writes = h.global.length;

	h.timer.reset();
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(h.global.length, writes, "no restore fires across a session boundary");
});

test("the settle restore follows the base label that is current at restore time", async () => {
	const h = makeHarness({ tui: undefined, settleMs: 25 });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	h.advance(1_000);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	// Quiet mode toggles off while the final label lingers: the restore must
	// hand the label back to pi's default, not to the stale quiet label.
	h.setBaseLabel(undefined);

	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(h.global.at(-1), undefined);
});
