import { test } from "node:test";
import assert from "node:assert/strict";
import { TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS, TEAMMATE_STALL_TIMEOUT_MS } from "pi-maestro-teammate/v1/types";
import { AgentsStore, AGENT_LINGER_MS, COMPLETED_TOMBSTONE_MS, FAILED_LINGER_MS, SESSION_CONTENT_MAX, SLEEPING_LINGER_MS, TERMINATED_LINGER_MS, effectiveAgentStatus, mapAgentStatus } from "../src/agents-store.ts";

test("started adds a running row with derived role and label", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer", name: "scan auth" }, 1000);
	assert.equal(s.size, 1);
	const row = s.snapshot()[0];
	assert.equal(row.correlationId, "c1");
	assert.equal(row.role, "explorer");
	assert.equal(row.task, "scan auth");
	assert.equal(row.status, "running");
	assert.equal(row.startedAt, 1000);
	assert.equal(row.lastActivityAt, 1000);
});

test("expected-silence phases use the shared bounded stall deadline", () => {
	const s = new AgentsStore();
	const startedAt = 1_000;
	s.applyStarted({ correlationId: "thinking", agent: "analyst", status: "running", phase: "prompting" }, startedAt);
	const row = s.snapshot()[0];

	assert.equal(effectiveAgentStatus(row, startedAt + TEAMMATE_STALL_TIMEOUT_MS), "running");
	assert.equal(effectiveAgentStatus(row, startedAt + TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS), "stalled");

	s.applyStarted({ correlationId: "queued", agent: "worker", status: "pending", phase: "starting" }, startedAt);
	s.applyMessage({
		correlationId: "queued",
		status: "pending",
		phase: "starting",
		lastActivityAt: startedAt,
	}, startedAt);
	const queued = s.snapshot().find((entry) => entry.correlationId === "queued")!;
	assert.equal(effectiveAgentStatus(queued, startedAt + TEAMMATE_STALL_TIMEOUT_MS), "pending");
	assert.equal(effectiveAgentStatus(queued, startedAt + TEAMMATE_EXPECTED_SILENCE_TIMEOUT_MS), "stalled");
});

test("started preserves parent, source status and source start time", () => {
	const s = new AgentsStore();
	s.applyStarted({
		correlationId: "child",
		agent: "executor",
		name: "implement",
		spawnedBy: "parent",
		status: "running",
		phase: "starting",
		startedAt: "2026-07-26T00:00:00.000Z",
	}, 999);
	const row = s.snapshot()[0];
	assert.equal(row.parentCorrelationId, "parent");
	assert.equal(row.status, "running");
	assert.equal(row.startedAt, Date.parse("2026-07-26T00:00:00.000Z"));
});

test("message keeps a bounded session-content tail", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyMessage({ correlationId: "c1", message: "x".repeat(SESSION_CONTENT_MAX + 100) });
	const tail = s.snapshot()[0].tail;
	assert.ok(tail.length <= SESSION_CONTENT_MAX, `tail too long: ${tail.length}`);
	assert.ok(tail.endsWith("…"));
});

test("message flattens whitespace", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyMessage({ correlationId: "c1", message: "  read   src/x.ts  " });
	assert.equal(s.snapshot()[0].tail, "read src/x.ts");
});

test("progress message projects teammate tools, tokens, status and last message", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({
		correlationId: "c1",
		lastMessage: "implementing footer",
		recentTools: [
			{ name: "read", status: "completed" },
			{ name: "edit", status: "running", argsPreview: "file_path=src/x.ts" },
		],
		toolCount: 4,
		tokens: 1200,
		inputTokens: 1_000,
		outputTokens: 200,
		status: "running",
	});
	const row = s.snapshot()[0];
	assert.equal(row.tail, "implementing footer");
	assert.equal(row.activeTool, "edit");
	assert.equal(row.activeToolArgs, "file_path=src/x.ts");
	assert.equal(row.toolCount, 4);
	assert.equal(row.tokens, 1200);
	assert.equal(row.inputTokens, 1_000);
	assert.equal(row.outputTokens, 200);
	assert.equal(row.taskStatus, "running");
});

test("graph progress updates the task row instead of flattening child state onto parent", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "child", agent: "executor", name: "implement", spawnedBy: "root", status: "running", phase: "starting" }, 2);
	s.applyStarted({ correlationId: "root", agent: "graph(1)", name: "plan" }, 1);
	s.applyMessage({
		correlationId: "root",
		taskCorrelationId: "child",
		taskIndex: 0,
		dependencies: [],
		status: "running",
		lastMessage: "writing code",
		toolCount: 2,
		tokens: 300,
		progress: [{
			correlationId: "child",
			agent: "executor",
			name: "implement",
			taskIndex: 0,
			dependencies: [],
			status: "running",
			lastMessage: "writing code",
			toolCount: 2,
			tokens: 300,
			inputTokens: 240,
			outputTokens: 60,
		}],
	});
	const [root, child] = ["root", "child"].map((id) => s.snapshot().find((row) => row.correlationId === id)!);
	assert.equal(root.status, "running");
	assert.equal(root.tail, "");
	assert.equal(child.status, "running");
	assert.equal(child.tail, "writing code");
	assert.equal(child.parentCorrelationId, "root");
	assert.equal(child.toolCount, 2);
	assert.equal(child.tokens, 300);
	assert.equal(child.inputTokens, 240);
	assert.equal(child.outputTokens, 60);
});

test("completed graph progress freezes elapsed time from its completion timestamp", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 1_000);
	s.applyMessage({
		correlationId: "root",
		progress: [{
			correlationId: "child",
			agent: "explorer",
			taskIndex: 0,
			status: "completed",
			startedAt: 2_000,
			completedAt: 7_000,
			durationMs: 99_000,
		}],
	}, 8_000);
	const child = s.snapshot(50_000).find((row) => row.correlationId === "child");
	assert.equal(child?.status, "done");
	assert.equal(child?.startedAt, 2_000);
	assert.equal(child?.finishedAt, 7_000);
});

test("completed graph progress falls back to its reported duration", () => {
	const s = new AgentsStore();
	s.applyMessage({
		correlationId: "root",
		progress: [{
			correlationId: "child",
			agent: "explorer",
			taskIndex: 0,
			status: "completed",
			startedAt: 2_000,
			durationMs: 5_000,
		}],
	}, 20_000);
	assert.equal(s.snapshot(50_000).find((row) => row.correlationId === "child")?.finishedAt, 7_000);
});

test("progress does not overwrite an authoritative spawnedBy parent", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "child", agent: "explorer", spawnedBy: "actual-parent" }, 1_000);
	s.applyMessage({
		correlationId: "progress-envelope",
		progress: [{
			correlationId: "child",
			agent: "explorer",
			taskIndex: 0,
			status: "running",
		}],
	}, 2_000);
	assert.equal(
		s.snapshot().find((row) => row.correlationId === "child")?.parentCorrelationId,
		"actual-parent",
	);
});

test("message for unknown correlationId self-heals a running row", () => {
	const s = new AgentsStore();
	s.applyMessage({ correlationId: "nope", agent: "explorer", name: "scan", message: "hi" }, 500);
	assert.equal(s.size, 1);
	const row = s.snapshot()[0];
	assert.equal(row.correlationId, "nope");
	assert.equal(row.role, "explorer");
	assert.equal(row.task, "scan");
	assert.equal(row.status, "running");
	assert.equal(row.tail, "hi");
});

test("message without agent identity self-heals a placeholder row that later refines", () => {
	const s = new AgentsStore();
	// A send-style delta carries no agent/name; the row still materializes so a
	// running agent is never invisible, and a later progress delta refines it.
	s.applyMessage({ correlationId: "c1", message: "queued" }, 500);
	assert.equal(s.size, 1);
	assert.equal(s.snapshot()[0].role, "agent");
	// Identity flows in through progress deltas, which refine the placeholder.
	s.applyMessage({
		correlationId: "c1",
		progress: [{ correlationId: "c1", agent: "reviewer", name: "review", taskIndex: 0, status: "running" }],
	}, 600);
	const row = s.snapshot()[0];
	assert.equal(row.role, "reviewer");
	assert.equal(row.task, "review");
	assert.equal(s.size, 1);
});

test("progress for an unknown graph child self-heals its own row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(2)" }, 1);
	s.applyMessage({
		correlationId: "root",
		progress: [{
			correlationId: "child-1",
			agent: "executor",
			name: "step",
			taskIndex: 0,
			status: "running",
			lastMessage: "working",
		}],
	}, 500);
	const child = s.snapshot().find((r) => r.correlationId === "child-1");
	assert.ok(child);
	assert.equal(child.role, "executor");
	assert.equal(child.status, "running");
	assert.equal(child.parentCorrelationId, "root");
	assert.equal(child.tail, "working");
});

test("missing graph child self-heals its own row and never flattens onto the parent", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)", name: "plan" }, 1);
	s.applyMessage({
		correlationId: "root",
		taskCorrelationId: "missing-child",
		agent: "executor",
		name: "step",
		status: "failed",
		lastMessage: "child failed",
	}, 500);
	const byId = new Map(s.snapshot(500).map((r) => [r.correlationId, r]));
	// The child materializes as its own failed row...
	const child = byId.get("missing-child");
	assert.ok(child);
	assert.equal(child.status, "failed");
	assert.equal(child.tail, "child failed");
	assert.equal(child.parentCorrelationId, "root");
	// ...and the parent is untouched: still running, empty tail.
	const parent = byId.get("root");
	assert.ok(parent);
	assert.equal(parent.status, "running");
	assert.equal(parent.tail, "");
});

test("complete retains a self-healed row as done for one minute", () => {
	const s = new AgentsStore();
	s.applyMessage({ correlationId: "c1", agent: "explorer", message: "hi" }, 500);
	assert.equal(s.size, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 600);
	assert.equal(s.snapshot(600)[0]?.status, "done");
	assert.equal(s.size, 1);
	s.snapshot(600 + AGENT_LINGER_MS);
	assert.equal(s.size, 0);
});

test("complete retains the row as done", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.snapshot(1_000)[0]?.status, "done");
	assert.equal(s.size, 1);
});

test("complete retains the full descendant tree as done", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "grandchild", agent: "reviewer", spawnedBy: "child" }, 3);
	s.applyStarted({ correlationId: "child", agent: "executor", spawnedBy: "root" }, 2);
	s.applyStarted({ correlationId: "root", agent: "planner" }, 1);
	s.applyComplete({ correlationId: "root", exitCode: 0 }, 1_000);
	assert.equal(s.size, 3);
	assert.ok(s.snapshot(1_000).every((row) => row.status === "done"));
	s.snapshot(1_000 + AGENT_LINGER_MS);
	assert.equal(s.size, 0);
});

test("complete for unknown correlationId does not throw", () => {
	const s = new AgentsStore();
	assert.doesNotThrow(() => s.applyComplete({ correlationId: "nope", exitCode: 0 }));
});

test("snapshot orders by latest activity regardless of start time or status", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "older-active", agent: "explorer" }, 100);
	s.applyStarted({ correlationId: "newer-idle", agent: "executor" }, 200);
	s.applyMessage({ correlationId: "older-active", message: "new activity" }, 300);
	assert.deepEqual(s.snapshot().map((r) => r.correlationId), ["older-active", "newer-idle"]);
});

test("activity timestamps prefer explicit values, fall back to receipt time, and tie-break by id", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "b", agent: "executor", lastActivityAt: 50 }, 1_000);
	s.applyStarted({ correlationId: "a", agent: "executor", lastActivityAt: 50 }, 2_000);
	s.applyStarted({ correlationId: "fallback", agent: "executor" }, 75);
	assert.equal(s.snapshot().find((row) => row.correlationId === "b")?.lastActivityAt, 50);
	assert.equal(s.snapshot().find((row) => row.correlationId === "fallback")?.lastActivityAt, 75);
	assert.deepEqual(s.snapshot().map((row) => row.correlationId), ["fallback", "a", "b"]);
});

test("progress preserves explicit lastActivityAt and missing message timestamps use receipt time", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 1);
	s.applyStarted({ correlationId: "child", agent: "executor", spawnedBy: "root" }, 2);
	s.applyMessage({
		correlationId: "root",
		taskCorrelationId: "child",
		progress: [{
			correlationId: "child",
			agent: "executor",
			taskIndex: 0,
			status: "running",
			lastActivityAt: 123,
		}],
	}, 999);
	assert.equal(s.snapshot().find((row) => row.correlationId === "child")?.lastActivityAt, 123);
	s.applyMessage({ correlationId: "root", message: "receipt fallback" }, 456);
	assert.equal(s.snapshot().find((row) => row.correlationId === "root")?.lastActivityAt, 456);
});

test("parallel agents are both present", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "a", agent: "explorer" }, 1);
	s.applyStarted({ correlationId: "b", agent: "explorer" }, 2);
	assert.equal(s.snapshot().length, 2);
});

test("deriveRole falls back to name for graph(...) agents", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "g", agent: "graph(foo)", name: "planner" }, 1);
	assert.equal(s.snapshot()[0].role, "planner");
});

test("re-start of same correlationId preserves startedAt", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 100);
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 999);
	assert.equal(s.snapshot()[0].startedAt, 100);
});

test("re-start preserves previously projected metrics", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 100);
	s.applyMessage({ correlationId: "c1", toolCount: 2, tokens: 90, lastMessage: "working" });
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running" }, 999);
	const row = s.snapshot()[0];
	assert.equal(row.toolCount, 2);
	assert.equal(row.tokens, 90);
	assert.equal(row.tail, "working");
});

test("started ingests running phase and previous outcome", () => {
	const s = new AgentsStore();
	s.applyStarted({
		correlationId: "c1",
		agent: "executor",
		status: "running",
		phase: "tool-execution",
		lastOutcome: { status: "failed", message: "timeout\nsecond line", settledAt: 900 },
	}, 1_000);
	const row = s.snapshot()[0];
	assert.equal(row.phase, "tool-execution");
	assert.equal(row.lastOutcome?.status, "failed");
	assert.equal(row.lastOutcome?.message, "timeout second line");
});

test("restart preserves outcome when the next started event only changes phase", () => {
	const s = new AgentsStore();
	s.applyStarted({
		correlationId: "c1",
		agent: "executor",
		status: "sleeping",
		lastOutcome: { status: "failed", settledAt: 1 },
	}, 1);
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running", phase: "restoring" }, 2);
	const row = s.snapshot()[0];
	assert.equal(row.status, "running");
	assert.equal(row.phase, "restoring");
	assert.equal(row.lastOutcome?.status, "failed");
});

test("mapAgentStatus covers teammate lifecycle states", () => {
	assert.equal(mapAgentStatus("pending"), "pending");
	assert.equal(mapAgentStatus("retrying"), "retrying");
	assert.equal(mapAgentStatus("sleeping"), "sleeping");
	assert.equal(mapAgentStatus("completed"), "done");
	assert.equal(mapAgentStatus("failed"), "failed");
	assert.equal(mapAgentStatus("unknown"), "running");
});

// Teammate payloads are LLM-authored. A raw newline splits one widget row into
// several physical rows and a raw escape repaints the terminal; both measure as
// zero columns, so width assertions alone can never catch them.
test("teammate strings are stripped of control characters on ingest", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "exec\x1b[31mutor", name: "build\nauth\x1b[2J" }, 1);
	s.applyMessage({
		correlationId: "c1",
		message: "line one\nline two\x1b[2K",
		recentTools: ["grep\x1b[1m"],
	});
	const row = s.snapshot()[0];
	for (const value of [row.agent, row.role, row.task, row.tail, row.activeTool ?? ""]) {
		assert.doesNotMatch(value, /[\n\r\x1b]/, `control char survived in ${JSON.stringify(value)}`);
	}
	assert.equal(row.role, "executor");
	assert.equal(row.task, "build auth");
});

test("a successful wake lifecycle reuses a retained completed row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 100);
	assert.equal(s.snapshot(100)[0]?.status, "done");
	assert.equal(s.size, 1);

	s.applyStarted({
		correlationId: "c1",
		agent: "executor",
		name: "worker",
		status: "running",
		startedAt: 1,
		lastActivityAt: 200,
	}, 200);

	const row = s.snapshot(200)[0];
	assert.equal(row.correlationId, "c1");
	assert.equal(row.status, "running");
	assert.equal(row.lastActivityAt, 200);
});

test("a failed descendant keeps its own terminal time when the parent completes", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 100);
	s.applyMessage({
		correlationId: "root",
		progress: [{
			correlationId: "child",
			agent: "executor",
			taskIndex: 0,
			status: "failed",
			startedAt: 200,
			completedAt: 700,
		}],
	}, 800);
	s.applyComplete({ correlationId: "root", exitCode: 0, durationMs: 5_000 }, 6_000);
	const child = s.snapshot(6_000).find((row) => row.correlationId === "child");
	assert.equal(child?.status, "failed");
	assert.equal(child?.finishedAt, 700);
});

test("a failed agent survives its own completion so the failure can be read", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({ correlationId: "c1", status: "failed", lastMessage: "build broke" });
	s.applyComplete({ correlationId: "c1", exitCode: 1 }, 1_000);
	const row = s.snapshot(1_000)[0];
	assert.equal(row.status, "failed");
	assert.equal(row.tail, "build broke");
	assert.equal(row.lastActivityAt, 1_000);
	assert.ok(s.hasLingering());
});

test("a lingering failure expires on its own without anyone clearing it", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({ correlationId: "c1", status: "failed" });
	s.applyComplete({ correlationId: "c1", exitCode: 1 }, 1_000);
	assert.equal(s.prune(1_000 + FAILED_LINGER_MS - 1), false, "not yet");
	assert.equal(s.size, 1);
	assert.equal(s.prune(1_000 + FAILED_LINGER_MS), true);
	assert.equal(s.size, 0);
	assert.equal(s.hasLingering(), false);
});

test("a lingering failure drops its active tool, which is no longer running", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({
		correlationId: "c1",
		status: "failed",
		recentTools: [{ name: "grep", status: "running" }],
	});
	s.applyComplete({ correlationId: "c1", exitCode: 1 }, 1_000);
	assert.equal(s.snapshot(1_000)[0].activeTool, undefined);
});

test("a nonzero complete exit code preserves a running row as failed", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({ correlationId: "c1", status: "running", lastMessage: "process exited quickly" });

	s.applyComplete({ correlationId: "c1", exitCode: 2 }, 1_000);

	const row = s.snapshot(1_000)[0];
	assert.equal(row.status, "failed");
	assert.equal(row.taskStatus, "failed");
	assert.equal(row.tail, "process exited quickly");
	assert.equal(row.lastActivityAt, 1_000);
	assert.ok(s.hasLingering());
});

// Regression: a teammate returns its tool result early (result-ready) and the
// extension emits `complete`, but late progress deltas keep arriving afterwards
// (flush gate re-arms, a graph task stays status:"running" until its lifecycle
// confirms, IPC reorders). These used to self-heal a ghost row that no second
// `complete` ever removed, so the panel showed an agent running forever.
test("a late running message after complete cannot regress the retained done row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.snapshot(1_000)[0]?.status, "done");
	// The tool result was already returned; this delta is a stale in-flight one.
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running", lastMessage: "stale" }, 1_500);
	const row = s.snapshot(1_500)[0];
	assert.equal(row?.status, "done");
	assert.notEqual(row?.tail, "stale");
});

test("a late graph progress snapshot after complete does not resurrect child rows", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(2)" }, 1);
	s.applyMessage({
		correlationId: "root",
		progress: [
			{ correlationId: "child-1", agent: "executor", name: "a", taskIndex: 0, status: "running" },
			{ correlationId: "child-2", agent: "executor", name: "b", taskIndex: 1, status: "running" },
		],
	}, 500);
	assert.equal(s.size, 3);
	s.applyComplete({ correlationId: "root", exitCode: 0 }, 1_000);
	assert.equal(s.size, 3);
	assert.ok(s.snapshot(1_000).every((row) => row.status === "done"));
	// A result-ready task publishes status:"running" again once its lifecycle
	// confirms; retained terminal rows must not regress.
	s.applyMessage({
		correlationId: "root",
		progress: [
			{ correlationId: "child-1", agent: "executor", name: "a", taskIndex: 0, status: "running" },
			{ correlationId: "child-2", agent: "executor", name: "b", taskIndex: 1, status: "running" },
		],
	}, 1_500);
	assert.equal(s.size, 3, "retained graph rows remain present during the linger window");
	assert.ok(s.snapshot(1_500).every((row) => row.status === "done"));
});

test("an explicitly restarted graph can recreate child rows from its new progress", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 1);
	s.applyMessage({
		correlationId: "root",
		progress: [
			{ correlationId: "child", agent: "executor", name: "worker", taskIndex: 0, status: "running" },
		],
	}, 500);
	s.applyComplete({ correlationId: "root", exitCode: 0 }, 1_000);
	assert.equal(s.size, 2);
	assert.ok(s.snapshot(1_000).every((row) => row.status === "done"));

	// A wake reuses the graph correlationId and explicitly republishes started.
	s.applyStarted({ correlationId: "root", agent: "graph(1)", status: "running" }, 2_000);
	s.applyMessage({
		correlationId: "root",
		progress: [
			{ correlationId: "child", agent: "executor", name: "worker", taskIndex: 0, status: "running" },
		],
	}, 2_500);

	const child = s.snapshot(2_500).find((row) => row.correlationId === "child");
	assert.equal(child?.status, "running");
	assert.equal(child?.parentCorrelationId, "root");
});

test("complete that beats the first delta still suppresses the self-heal that follows", () => {
	const s = new AgentsStore();
	// Event reorder: `complete` arrives before any row existed for this agent.
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running", message: "late" }, 1_500);
	assert.equal(s.size, 0);
});

test("an explicit started clears the tombstone on a retained row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.snapshot(1_000)[0]?.status, "done");
	assert.equal(s.size, 1);
	// Waking a sleeping agent reuses its correlationId and re-emits `started`.
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running" }, 2_000);
	assert.equal(s.size, 1);
	s.applyMessage({ correlationId: "c1", status: "running", lastMessage: "awake" }, 2_500);
	assert.equal(s.snapshot(2_500)[0].tail, "awake");
});

test("an explicit started without status restarts a retained completed row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.snapshot(1_000)[0]?.status, "done");
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 2_000);
	assert.equal(s.snapshot(2_000)[0]?.status, "running");
});

test("restart clears the previous lifecycle's result-ready marker", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({
		correlationId: "c1",
		progress: [{ correlationId: "c1", agent: "executor", taskIndex: 0, status: "running", resultReadyAt: 400 }],
	}, 400);
	assert.equal(effectiveAgentStatus(s.snapshot(400)[0], 400), "result-ready");
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 500);
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 600);
	const row = s.snapshot(600)[0];
	assert.equal(row.resultReadyAt, undefined);
	assert.equal(effectiveAgentStatus(row, 600), "running");
});

test("a tombstone expires so a genuinely fresh agent is not suppressed forever", () => {
	const s = new AgentsStore();
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running" }, 1_000 + COMPLETED_TOMBSTONE_MS - 1);
	assert.equal(s.size, 0, "still suppressed just before expiry");
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running" }, 1_000 + COMPLETED_TOMBSTONE_MS);
	assert.equal(s.size, 1, "self-heal allowed again after the tombstone expires");
});

test("a wakeable completion keeps the row as sleeping instead of deleting it", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0, wakeable: true }, 1_000);
	const row = s.snapshot(1_000)[0];
	assert.equal(row?.status, "sleeping", "wakeable agent must stay visible as sleeping");
	assert.equal(row?.finishedAt, 1_000);
	assert.equal(s.size, 1);
});

test("a wakeable failed completion sleeps and retains the failed outcome", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 1, wakeable: true }, 1_000);
	const row = s.snapshot(1_000)[0];
	assert.equal(row?.status, "sleeping");
	assert.equal(row?.lastOutcome?.status, "failed");
	assert.equal(row?.failedAt, 1_000, "failed outcome keeps the readable failure linger");
	assert.equal(s.size, 1);
});

test("a second wakeable turn freezes at the second turn instead of the logical lifetime start", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running" }, 1_000);
	s.applyComplete({ correlationId: "c1", exitCode: 0, wakeable: true, durationMs: 100 }, 1_100);
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running", phase: "restoring" }, 120_000);
	s.applyComplete({ correlationId: "c1", exitCode: 1, wakeable: true, durationMs: 250 }, 120_250);
	const row = s.snapshot(120_250)[0];
	assert.equal(row.status, "sleeping");
	assert.equal(row.finishedAt, 120_250);
	assert.equal(row.lastOutcome?.status, "failed");
	assert.equal(s.size, 1, "the fresh second completion must not be pruned using the first turn timestamp");
});

test("a sleeping started replay seeds a bounded completion time", () => {
	const s = new AgentsStore();
	s.applyStarted({
		correlationId: "c1",
		agent: "executor",
		status: "sleeping",
		lastOutcome: { status: "completed", settledAt: 5_000 },
	}, 10_000);
	const row = s.snapshot(10_000)[0];
	assert.equal(row.finishedAt, 5_000);
	assert.equal(s.hasLingering(), true);
	s.snapshot(5_000 + SLEEPING_LINGER_MS);
	assert.equal(s.size, 0);
});

test("a non-wakeable completion retains done for the shared window", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.snapshot(1_000)[0]?.status, "done");
	assert.equal(s.size, 1);
	s.snapshot(1_000 + AGENT_LINGER_MS - 1);
	assert.equal(s.size, 1);
	s.snapshot(1_000 + AGENT_LINGER_MS);
	assert.equal(s.size, 0);
});

test("a sleeping row expires after the linger window", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0, wakeable: true }, 1_000);
	assert.equal(s.size, 1);
	s.snapshot(1_000 + SLEEPING_LINGER_MS - 1);
	assert.equal(s.size, 1, "still visible just before expiry");
	s.snapshot(1_000 + SLEEPING_LINGER_MS);
	assert.equal(s.size, 0, "pruned after linger window");
});

test("hasLingering includes sleeping rows so the redraw loop keeps running", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0, wakeable: true }, 1_000);
	assert.equal(s.hasLingering(), true);
});

test("message variants without an agent correlation never create ghost rows", () => {
	const s = new AgentsStore();
	s.applyMessage({ agent: "executor", status: "running", isInteraction: true }, 1_000);
	assert.equal(s.size, 0);
});

test("send variants do not overwrite the agent progress tail", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({ correlationId: "c1", lastMessage: "building" }, 100);
	s.applyMessage({ correlationId: "c1", isSend: true, message: "abort now" }, 200);
	assert.equal(s.snapshot(200)[0].tail, "building");
	assert.equal(s.snapshot(200)[0].lastActivityAt, 100, "send receipts are not progress activity");
});

test("wakeable graph completion sleeps the owner and retains descendants as done", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 1);
	s.applyStarted({ correlationId: "child", agent: "executor", spawnedBy: "root" }, 2);
	s.applyComplete({ correlationId: "root", exitCode: 0, wakeable: true }, 1_000);
	assert.equal(s.snapshot(1_000).find((row) => row.correlationId === "root")?.status, "sleeping");
	assert.equal(s.snapshot(1_000).find((row) => row.correlationId === "child")?.status, "done");
});

test("full progress snapshots project and clear diagnostic telemetry", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "root", agent: "graph(1)" }, 1);
	s.applyMessage({
		correlationId: "root",
		progress: [{
			correlationId: "child",
			agent: "executor",
			taskIndex: 0,
			status: "retrying",
			cacheReadTokens: 120,
			cacheWriteTokens: 4,
			error: "provider timeout",
			requestedModel: "primary",
			resolvedModel: "fallback",
			attemptedModels: ["primary", "fallback"],
		}],
	}, 100);
	let row = s.snapshot(100).find((candidate) => candidate.correlationId === "child")!;
	assert.equal(row.cacheReadTokens, 120);
	assert.equal(row.cacheWriteTokens, 4);
	assert.equal(row.error, "provider timeout");
	assert.equal(row.resolvedModel, "fallback");
	assert.deepEqual(row.attemptedModels, ["primary", "fallback"]);

	s.applyMessage({
		correlationId: "root",
		progress: [{ correlationId: "child", agent: "executor", taskIndex: 0, status: "running" }],
	}, 200);
	row = s.snapshot(200).find((candidate) => candidate.correlationId === "child")!;
	assert.equal(row.error, undefined);
	assert.equal(row.requestedModel, undefined);
	assert.equal(row.resolvedModel, undefined);
	assert.equal(row.attemptedModels, undefined);
});

test("mapAgentStatus maps the teammate terminated state instead of defaulting to running", () => {
	assert.equal(mapAgentStatus("terminated"), "terminated");
	assert.equal(mapAgentStatus("unknown"), "running", "unknown values still fall back to running");
});

test("a terminated progress delta freezes the row instead of leaving it spinning", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyMessage({ correlationId: "c1", agent: "executor", status: "terminated", lastActivityAt: 500 }, 500);
	const row = s.snapshot(500)[0];
	assert.equal(row.status, "terminated");
	assert.equal(row.taskStatus, "terminated");
	assert.equal(row.finishedAt, 500, "elapsed time must freeze at the terminal delta");
	assert.equal(s.hasLingering(), true, "the terminated row keeps the redraw loop alive until pruned");
});

test("a cancelled completion is shown as terminated, not as a failure", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 1, cancelled: true, durationMs: 400 }, 500);
	const row = s.snapshot(500)[0];
	assert.equal(row.status, "terminated", "cancelled runs carry exitCode 1 but are not failures");
	assert.equal(row.failedAt, undefined, "no failed linger must be armed");
	assert.equal(row.finishedAt, 401);
	assert.equal(s.hasLingering(), true);
});

test("a terminated row expires after its linger window", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 1, cancelled: true }, 1_000);
	assert.equal(s.size, 1);
	s.snapshot(1_000 + TERMINATED_LINGER_MS - 1);
	assert.equal(s.size, 1, "still visible just before expiry");
	s.snapshot(1_000 + TERMINATED_LINGER_MS);
	assert.equal(s.size, 0, "pruned after linger window");
});

test("resultReadyAt is ingested from progress and cleared when the snapshot drops it", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyMessage({
		correlationId: "c1",
		agent: "executor",
		status: "running",
		progress: [{ correlationId: "c1", agent: "executor", taskIndex: 0, status: "running", resultReadyAt: 400, lastActivityAt: 400 }],
	}, 400);
	assert.equal(s.snapshot(400)[0].resultReadyAt, 400, "the transitional marker must survive ingestion");
	s.applyMessage({
		correlationId: "c1",
		agent: "executor",
		status: "completed",
		progress: [{ correlationId: "c1", agent: "executor", taskIndex: 0, status: "completed", lastActivityAt: 500 }],
	}, 500);
	const row = s.snapshot(500)[0];
	assert.equal(row.resultReadyAt, undefined, "a snapshot without resultReadyAt clears it");
	assert.equal(row.status, "done");
});

test("all terminal states share the one-minute session-bar and roster linger", () => {
	assert.equal(AGENT_LINGER_MS, 60_000);
	assert.equal(FAILED_LINGER_MS, AGENT_LINGER_MS);
	assert.equal(SLEEPING_LINGER_MS, AGENT_LINGER_MS);
	assert.equal(TERMINATED_LINGER_MS, AGENT_LINGER_MS);
});

test("expired selected session returns to main", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.setViewingAgent("c1");
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.getViewingAgent(), "c1");
	s.snapshot(1_000 + AGENT_LINGER_MS);
	assert.equal(s.getViewingAgent(), undefined);
});

test("setViewingAgent marks the viewed row and clears on exit", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer", name: "scan" }, 1);
	s.applyStarted({ correlationId: "c2", agent: "builder", name: "build" }, 2);

	s.setViewingAgent("c1");
	const rows = s.snapshot(10);
	const viewed = rows.find((row) => row.correlationId === "c1");
	const other = rows.find((row) => row.correlationId === "c2");
	assert.equal(viewed?.viewing, true, "the viewed agent is flagged");
	assert.equal(other?.viewing, undefined, "others are not flagged");

	s.setViewingAgent(undefined);
	const cleared = s.snapshot(10).find((row) => row.correlationId === "c1");
	assert.equal(cleared?.viewing, undefined, "exit clears the flag");
});

test("argsPreview rides along the active tool and clears when the tool ends", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({
		correlationId: "c1",
		recentTools: [{ name: "bash", status: "running", argsPreview: "command=git diff" }],
	}, 2);
	assert.equal(s.snapshot()[0].activeTool, "bash");
	assert.equal(s.snapshot()[0].activeToolArgs, "command=git diff");
	// A later snapshot without argsPreview clears the stale summary.
	s.applyMessage({
		correlationId: "c1",
		recentTools: [{ name: "bash", status: "completed" }],
	}, 3);
	assert.equal(s.snapshot()[0].activeTool, "bash");
	assert.equal(s.snapshot()[0].activeToolArgs, undefined);
});

test("argsPreview from legacy string tool entries is ignored gracefully", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	// Pre-v1 progress deltas used plain strings; they still project a name only.
	s.applyMessage({ correlationId: "c1", recentTools: ["grep"] }, 2);
	assert.equal(s.snapshot()[0].activeTool, "grep");
	assert.equal(s.snapshot()[0].activeToolArgs, undefined);
});

test("argsPreview is bounded to the display budget", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyMessage({
		correlationId: "c1",
		recentTools: [{ name: "bash", status: "running", argsPreview: "x".repeat(500) }],
	}, 2);
	const preview = s.snapshot()[0].activeToolArgs;
	assert.ok(preview);
	assert.ok(preview.length <= 140, `bounded to 140 chars, got ${preview.length}`);
});
