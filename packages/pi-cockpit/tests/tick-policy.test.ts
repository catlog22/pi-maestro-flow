import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentReadStoreRouter, AGENT_LINGER_MS, COMPLETED_TOMBSTONE_MS } from "../src/agents-store.ts";
import { resolveGlyphs, spinFrame } from "../src/icons.ts";
import { shouldAnimateFrames, shouldAnimateSidebar, shouldRunTick, type TickPolicyState } from "../src/tick-policy.ts";

function state(over: Partial<TickPolicyState> = {}): TickPolicyState {
	return {
		staticMode: false,
		running: false,
		agentActive: false,
		bashActive: false,
		lingering: false,
		ticking: false,
		...over,
	};
}

test("animation advances at a terminal-friendly half-second cadence", () => {
	const glyphs = resolveGlyphs("ascii");
	assert.equal(spinFrame(glyphs, 0), glyphs.spinFrames[0]);
	assert.equal(spinFrame(glyphs, 499), glyphs.spinFrames[0]);
	assert.equal(spinFrame(glyphs, 500), glyphs.spinFrames[1]);
});

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

test("V2 cleanup ticks expire the shadow roster and retain tombstones through their deadline in static mode", () => {
	const router = new AgentReadStoreRouter();
	router.applyRuntimeSnapshot({
		version: 2, revision: 1, kind: "agent-runs-snapshot", cursor: 1,
		source: { streamId: "runtime", revision: 1, generation: 1 }, agents: [],
	});
	for (let i = 0; i < 1000; i++) {
		router.applyLegacyStarted({ correlationId: `agent-${i}`, agent: "general" }, 1);
		router.applyLegacyComplete({ correlationId: `agent-${i}`, exitCode: 0 }, 1000);
	}
	assert.equal(router.legacy.size, 1000, "events do not eagerly prune");
	assert.equal(router.current.size, 0, "V2 remains the rendered source");
	const tickState = () => state({ staticMode: true, lingering: router.hasPendingCleanup() });
	assert.equal(shouldRunTick(tickState()), true, "hidden shadow retention starts the loop");
	assert.equal(router.prune(1000 + AGENT_LINGER_MS - 1), false);
	assert.equal(router.prune(1000 + AGENT_LINGER_MS), true);
	assert.equal(router.legacy.size, 0);
	assert.equal(shouldRunTick(tickState()), true, "tombstone-only retention keeps cleanup running");
	router.applyLegacyMessage({ correlationId: "agent-0", agent: "general", status: "running" }, 1000 + COMPLETED_TOMBSTONE_MS - 1);
	assert.equal(router.legacy.size, 0, "late progress cannot resurrect an expired display row");
	router.prune(1000 + COMPLETED_TOMBSTONE_MS);
	assert.equal(shouldRunTick(tickState()), false, "cleanup stops only after tombstones expire");
	router.applyLegacyStarted({ correlationId: "agent-0", agent: "general" }, 1000 + COMPLETED_TOMBSTONE_MS);
	assert.equal(router.legacy.size, 1, "genuine restart remains allowed");
});

test("extension wires router cleanup into the tick and schedules shadow events before the V2 render gate", () => {
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /lingering: agentReads\.hasPendingCleanup\(\)/);
	assert.match(source, /const agentsPruned = agentReads\.prune\(now\)/);
	for (const name of ["Started", "Message", "Complete"]) {
		assert.match(source, new RegExp(`agentReads\\.applyLegacy${name}\\(payload\\)\\) return;\\s*syncTick\\(\\);\\s*if \\(usingRuntimeV2\\) return;`));
	}
});

test("agentActive remains API-compatible without driving periodic repaint", () => {
	assert.equal(shouldRunTick(state({ agentActive: true })), false);
	assert.equal(shouldAnimateFrames(state({ ticking: true, agentActive: true })), false);
	assert.equal(shouldAnimateSidebar(state({ agentActive: true })), false);
	assert.equal(shouldRunTick(state({ staticMode: true, agentActive: true })), false);
	assert.equal(shouldAnimateFrames(state({ staticMode: true, ticking: true, agentActive: true })), false);
	assert.equal(shouldAnimateSidebar(state({ staticMode: true, agentActive: true })), false);
});
