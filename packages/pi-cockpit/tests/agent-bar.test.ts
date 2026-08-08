import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentBar } from "../src/agent-bar.ts";
import type { CockpitEndpoint } from "../src/endpoint-store.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import type { AgentRow } from "../src/types.ts";

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (color, text) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : color === "success" ? 32 : 36}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

const row: AgentRow = {
	correlationId: "c1",
	agent: "general",
	name: "builder",
	role: "general",
	task: "build",
	status: "running",
	tail: "working",
	startedAt: 1_000,
	lastActivityAt: 9_000,
};

const endpoints: CockpitEndpoint[] = [{
	id: "root",
	logicalKey: "main",
	kind: "root",
	label: "main",
	ordinal: 0,
	status: "running",
	contentRevision: "root-r1",
	routeSelector: "root",
	source: "registry",
}, {
	id: "agent",
	logicalKey: "agent:c1",
	kind: "agent",
	label: "builder",
	ordinal: 1,
	correlationId: "c1",
	status: "running",
	contentRevision: "agent-r1",
	outputRevision: "output-r1",
	routeSelector: "agent",
	source: "registry",
	agentRow: row,
}];

test("Agent Bar renders canonical tabs, unread, status and context pressure", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints.map(({ id, logicalKey }) => ({ id, logicalKey })), "root");
	state.reconcile("agent", endpoints, "root");
	const [line] = renderAgentBar(endpoints, state, 120, theme as Theme, {
		mainRunning: true,
		contextPressure: 87,
		now: 10_000,
	});
	assert.match(line, /@main/);
	assert.match(line, /@builder/);
	assert.match(line, /1 unread/);
	assert.match(line, /running/);
	assert.match(line, /ctx 87%/);
});

test("Agent Bar is action-first below 40 and safe at widths 1 through 120", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.select("agent");
	const narrow = renderAgentBar(endpoints, state, 24, theme as Theme, { now: 10_000 })[0];
	assert.match(narrow, /@builder/);
	assert.doesNotMatch(narrow, /@main/);

	for (let width = 1; width <= 120; width++) {
		const [line] = renderAgentBar(endpoints, state, width, theme as Theme, {
			contextPressure: 100,
			now: 10_000,
		});
		assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
	}
});
