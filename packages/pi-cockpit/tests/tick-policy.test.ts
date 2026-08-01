import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAnimateFrames, shouldAnimateSidebar, shouldRunTick, type TickPolicyState } from "../src/tick-policy.ts";

function state(over: Partial<TickPolicyState> = {}): TickPolicyState {
	return {
		staticMode: false,
		running: false,
		bashActive: false,
		lingering: false,
		ticking: false,
		...over,
	};
}

test("shouldRunTick keeps the loop alive for any activity in dynamic mode", () => {
	assert.equal(shouldRunTick(state({})), false, "idle stays stopped");
	assert.equal(shouldRunTick(state({ running: true })), true);
	assert.equal(shouldRunTick(state({ bashActive: true })), true);
	assert.equal(shouldRunTick(state({ lingering: true })), true);
});

test("shouldRunTick in static mode only keeps lingering rows alive", () => {
	const base = { staticMode: true };
	assert.equal(shouldRunTick(state({ ...base, running: true })), false, "running without lingering does not tick");
	assert.equal(shouldRunTick(state({ ...base, bashActive: true })), false, "jobs without lingering do not tick");
	assert.equal(shouldRunTick(state({ ...base, lingering: true })), true, "failure retention must outlive the loop");
	assert.equal(shouldRunTick(state({ ...base, running: true, lingering: true })), true);
});

test("shouldAnimateFrames freezes spinners in static mode and without a live tick", () => {
	assert.equal(shouldAnimateFrames(state({ running: true, ticking: true })), true, "dynamic running animates");
	assert.equal(shouldAnimateFrames(state({ bashActive: true, ticking: true })), true, "dynamic job animates");
	assert.equal(shouldAnimateFrames(state({ running: true, ticking: false })), false, "no loop, no animation");
	assert.equal(shouldAnimateFrames(state({ staticMode: true, running: true, ticking: true })), false, "static never animates");
	assert.equal(shouldAnimateFrames(state({ staticMode: true, lingering: true, ticking: true })), false);
	// Lingering rows are static by nature: even with the tick alive they must not spin.
	assert.equal(shouldAnimateFrames(state({ lingering: true, ticking: true })), false);
});

test("shouldAnimateSidebar mirrors the static gate and includes lingering", () => {
	assert.equal(shouldAnimateSidebar(state({ running: true })), true);
	assert.equal(shouldAnimateSidebar(state({ lingering: true })), true, "lingering rows occupy the dock");
	assert.equal(shouldAnimateSidebar(state({ staticMode: true, running: true })), false);
	assert.equal(shouldAnimateSidebar(state({ staticMode: true, lingering: true })), false);
	assert.equal(shouldAnimateSidebar(state({})), false);
});
