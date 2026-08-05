import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveGlyphs } from "../src/icons.ts";
import {
	ThinkingFoldTimer,
	THINKING_TICK_PERIOD_MS,
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
	static?: boolean;
}

interface Harness {
	timer: ThinkingFoldTimer;
	advance: (ms: number) => void;
	global: (string | undefined)[];
	renderCalls: () => number;
	setHidden: (hidden: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	setStatic: (staticMode: boolean) => void;
	setBaseLabel: (label: string | undefined) => void;
}

const makeHarness = (options: HarnessOptions = {}): Harness => {
	let nowMs = 1_000;
	let hidden = options.hidden ?? true;
	let enabled = options.enabled ?? true;
	let staticMode = options.static === true;
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
		isStatic: () => staticMode,
		setGlobalLabel: (label) => {
			global.push(label);
		},
		now: () => nowMs,
		settleMs: options.settleMs,
	});
	timer.onAssistantMessageStart();
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
		setStatic: (value) => {
			staticMode = value;
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

test("target lookup is cached between message boundaries and ticks only across seconds", () => {
	assert.equal(THINKING_TICK_PERIOD_MS, 1_000);
	const first = fakeTarget();
	const second = fakeTarget();
	const root = { children: [first] as unknown[] };
	const h = makeHarness({ tui: fakeTui(root) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(first.labels.length, 1);
	root.children = [second];
	h.advance(500);
	h.timer.tick();
	assert.equal(first.labels.length, 1, "sub-second ticks do not repaint");
	assert.equal(second.labels.length, 0, "tick does not rescan the component tree");

	h.advance(600);
	h.timer.tick();
	assert.equal(first.labels.at(-1), "thinking 1.1s", "the cached target receives the next second");
	assert.equal(second.labels.length, 0);

	h.timer.onAssistantMessageEnd();
	assert.equal(second.labels.at(-1), `thoughts${GLYPHS.separator}1.1s`, "message_end rebuilds the target once");
});

test("a thinking run ticks a live elapsed with no spinner and settles its duration", () => {
	const older = fakeTarget();
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(older, current) });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(current.labels.length, 1, "first frame paints immediately");
	assert.equal(current.labels[0], "thinking 0.0s", "no spinner prefix on the live label");
	assert.equal(older.labels.length, 0, "earlier messages are never touched");

	h.advance(3_200);
	h.timer.tick();
	assert.equal(current.labels.at(-1), "thinking 3.2s");
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
	assert.match(current.labels.at(-1) ?? "", /thinking 2\.0s$/, "last paint stays a live frame");

	const painted = current.labels.length;
	h.advance(2_000);
	h.timer.tick();
	h.timer.onAssistantMessageEnd();
	assert.equal(current.labels.length, painted, "nothing settles after stop");
});

test("static mode keeps a stable label and still settles the real duration", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current), static: true });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(current.labels.length, 1, "one paint at begin, no ticker");
	assert.equal(current.labels[0], "thoughts", "stable base label, no spinner, no live elapsed");

	h.advance(3_200);
	h.timer.tick();
	assert.equal(current.labels.length, 1, "static mode never ticks a live elapsed");

	h.advance(5_200);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.at(-1), `thoughts${GLYPHS.separator}${formatThinkingDuration(8_400)}`);
});

test("syncMode resumes ticking when static turns off mid-run and freezes it when turning on", () => {
	const current = fakeTarget();
	const h = makeHarness({ tui: fakeTui(current), static: true });

	h.timer.onAssistantMessageEvent(ev("thinking_start"));
	assert.equal(current.labels[0], "thoughts");

	// static -> dynamic: the run that began without a ticker starts ticking.
	h.setStatic(false);
	h.timer.syncMode();
	assert.equal(current.labels.at(-1), "thinking 0.0s", "first live frame paints immediately");
	h.advance(3_200);
	h.timer.syncMode();
	assert.equal(current.labels.at(-1), "thinking 3.2s");

	// dynamic -> static: the stable label replaces the live frame and stays.
	h.setStatic(true);
	h.timer.syncMode();
	assert.equal(current.labels.at(-1), "thoughts");
	h.advance(1_000);
	h.timer.tick();
	assert.equal(current.labels.at(-1), "thoughts", "frozen after the toggle");

	// The run still settles its real duration at the end.
	h.advance(4_200);
	h.timer.onAssistantMessageEvent(ev("thinking_end"));
	assert.equal(current.labels.at(-1), `thoughts${GLYPHS.separator}${formatThinkingDuration(8_400)}`);
});
