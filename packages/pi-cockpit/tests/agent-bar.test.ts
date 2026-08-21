import { altKey } from "pi-maestro-settings-core/v1";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentBar } from "../src/agent-bar.ts";
import type { CockpitEndpoint } from "../src/endpoint-store.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import type { AgentRow } from "../src/types.ts";

/** `altKey` escaped for use inside a regular expression: `+` is a metacharacter. */
const altRe = (key: string): string => altKey(key).replaceAll("+", "\\+");

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (color, text) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : color === "success" ? 32 : 36}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

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

test("Agent Bar renders chips with the selected session highlighted and per-chip unread badges, no status summary", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.reconcile("agent", endpoints, "root");
	const [line] = renderAgentBar(endpoints, state, 120, theme as Theme, {
		mainRunning: true,
		now: 10_000,
	});
	assert.match(stripAnsi(line), /@main/);
	assert.match(stripAnsi(line), /@builder/);
	// The selected (root) chip is highlighted with the ▸ marker.
	assert.match(stripAnsi(line), /▸ @main/);
	// Unread stays as a per-chip badge, not a summary line.
	assert.match(stripAnsi(line), /•1/);
	// The removed right-edge summary (● @label · status · ctx N%) stays gone.
	assert.doesNotMatch(stripAnsi(line), /●/);
	assert.doesNotMatch(stripAnsi(line), /ctx/);
	assert.doesNotMatch(stripAnsi(line), /running/);
});

test("Agent Bar keeps a selected sleeping teammate in the accent color", () => {
	const sleeping = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, status: "sleeping" as const, agentRow: { ...row, status: "sleeping" as const } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", sleeping, "agent");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(sleeping, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<accent>▸<\/accent> <accent>@builder<\/accent>/);
	assert.doesNotMatch(line, /<muted>▸<\/muted>/);
});

test("Agent Bar pans horizontally and keeps the selected chip visible when agents overflow", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	state.select("agent7");
	const [line] = renderAgentBar(many, state, 60, theme as Theme, { now: 10_000 });
	const plain = stripAnsi(line);
	// The selection is always visible, at the right edge of the panned window.
	assert.match(plain, /▸ @worker7/);
	// Both sides report what stays hidden; chips far left are out of view.
	assert.match(plain, /◀4/);
	assert.match(plain, /2▶/);
	assert.doesNotMatch(plain, /@main/);
	assert.ok(visibleWidth(line) <= 60);
});

test("Agent Bar falls back to a highlighted chip when the selected id is stale", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.select("ghost");
	const plain = stripAnsi(renderAgentBar(endpoints, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /▸ @main/);
});

test("Agent Bar pans so every selection stays visible and highlighted at a fixed width", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	for (let index = 0; index < many.length; index++) {
		const endpoint = many[index]!;
		state.select(endpoint.id);
		const plain = stripAnsi(renderAgentBar(many, state, 60, theme as Theme, { now: 10_000 })[0]);
		const label = endpoint.kind === "root" ? "main" : endpoint.label;
		assert.match(plain, new RegExp(`▸ @${label}`), `selection ${endpoint.id}`);
		// At the first chip nothing is hidden on the left; at the last, on the right.
		if (index === 0) assert.doesNotMatch(plain, /◀/, `selection ${endpoint.id}`);
		if (index === many.length - 1) assert.doesNotMatch(plain, /▶/, `selection ${endpoint.id}`);
	}
});

test("Agent Bar renders every chip without markers at the exact-fit width", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.select("agent");
	const wide = renderAgentBar(endpoints, state, 200, theme as Theme, { now: 10_000 })[0];
	const exact = visibleWidth(wide);
	const plain = stripAnsi(renderAgentBar(endpoints, state, exact, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /▸ @builder/);
	assert.match(plain, /@main/);
	assert.doesNotMatch(plain, /◀|▶/);
});

test("Agent Bar is safe at widths 1 through 120 and never exceeds the width", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	for (let width = 1; width <= 120; width++) {
		state.select("agent7");
		const [line] = renderAgentBar(many, state, width, theme as Theme, { now: 10_000 });
		assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
	}
});

test("Agent Bar shows the Alt+R list hint only when the surface is not covered by an overlay", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	const visible = stripAnsi(renderAgentBar(endpoints, state, 80, theme as Theme, {
		now: 10_000,
		shortcutHint: `${altKey("R")} list`,
	})[0]);
	const hidden = stripAnsi(renderAgentBar(endpoints, state, 80, theme as Theme, { now: 10_000 })[0]);
	assert.match(visible, new RegExp(`${altRe("R")} list$`));
	assert.doesNotMatch(hidden, new RegExp(`${altRe("R")}`));
});

test("Agent Bar appends the live tool to a running agent chip", () => {
	const running = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, activeTool: "bash" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", running, "root");
	const plain = stripAnsi(renderAgentBar(running, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /@builder · bash/);
	// The main chip (no agentRow) stays bare.
	assert.doesNotMatch(plain, /@main ·/);
});

test("Agent Bar appends the redacted args preview to the live tool", () => {
	const running = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, activeTool: "bash", activeToolArgs: "command=git diff" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", running, "root");
	const plain = stripAnsi(renderAgentBar(running, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /@builder · bash command=git diff/);
});

test("Agent Bar does not show a tool suffix on a sleeping agent", () => {
	const sleeping = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, status: "sleeping" as const, agentRow: { ...row, status: "sleeping" as const, activeTool: "bash" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", sleeping, "root");
	const plain = stripAnsi(renderAgentBar(sleeping, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.doesNotMatch(plain, /· bash/);
});

test("Agent Bar marks stalled chips with a leading error bang", () => {
	// stalled: derived from a stale lastActivityAt, no terminal outcome yet.
	const stalled = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, status: "running" as const, lastActivityAt: -30_000 } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", stalled, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(stalled, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<error>!<\/error>.*@builder/);
});

test("Agent Bar shows the completed check on a done agent", () => {
	const done = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "done" as const,
				lastOutcome: { status: "completed" as const, settledAt: 9_500 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", done, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(done, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<success> ✓<\/success>/);
	assert.doesNotMatch(line, /<error>!/);
});

test("Agent Bar shows the failed cross with a truncated reason", () => {
	const failed = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "failed" as const,
				lastOutcome: {
					status: "failed" as const,
					message: "provider timeout: " + "x".repeat(80),
					settledAt: 9_500,
				},
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", failed, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(failed, state, 200, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<error> ✗ provider timeout:/);
	assert.match(line, /provider timeout:/);
	// The reason is bounded; the tail beyond the 24-char window is dropped.
	assert.doesNotMatch(line, /x{40}/);
});

test("Agent Bar shows the terminated cross without a reason", () => {
	const terminated = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "terminated" as const,
				lastOutcome: { status: "terminated" as const, settledAt: 9_500 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", terminated, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(terminated, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<warning> ✗<\/warning>/);
});

test("Agent Bar hides the previous turn outcome while the agent is live again", () => {
	// The store deliberately retains lastOutcome across a restart; a running
	// agent must not carry the previous turn's ✓/✗ badge.
	const restarted = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "running" as const,
				lastOutcome: { status: "failed" as const, message: "old failure", settledAt: 9_000 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", restarted, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(restarted, state, 200, taggedTheme as Theme, { now: 10_000 })[0];
	assert.doesNotMatch(line, / ✗ old failure/);
	assert.doesNotMatch(line, /<error> ✗/);
	assert.match(line, /@builder/);
});

test("Agent Bar appends selected-session tool/token metrics when width allows", () => {
	const withMetrics = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, toolCount: 3, tokens: 1_200 } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", withMetrics, "agent");
	const plain = stripAnsi(renderAgentBar(withMetrics, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /3 .*tools|3 .*工具/);
	assert.match(plain, /1\.2k/);
});

test("Agent Bar drops the metrics summary before the chips when width is tight", () => {
	const withMetrics = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, toolCount: 3, tokens: 1_200 } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", withMetrics, "agent");
	// Chip-only width: metrics must yield, chips stay intact and in-bounds.
	const plain = stripAnsi(renderAgentBar(withMetrics, state, 22, theme as Theme, { now: 10_000 })[0]);
	assert.doesNotMatch(plain, /tools/);
	assert.match(plain, /@builder/);
	assert.ok(visibleWidth(renderAgentBar(withMetrics, state, 22, theme as Theme, { now: 10_000 })[0]) <= 22);
});
