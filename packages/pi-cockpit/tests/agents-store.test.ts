import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentsStore, COMPLETED_TOMBSTONE_MS, FAILED_LINGER_MS, mapAgentStatus } from "../src/agents-store.ts";

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

test("started preserves parent, source status and source start time", () => {
	const s = new AgentsStore();
	s.applyStarted({
		correlationId: "child",
		agent: "executor",
		name: "implement",
		spawnedBy: "parent",
		status: "pending",
		startedAt: "2026-07-26T00:00:00.000Z",
	}, 999);
	const row = s.snapshot()[0];
	assert.equal(row.parentCorrelationId, "parent");
	assert.equal(row.status, "pending");
	assert.equal(row.startedAt, Date.parse("2026-07-26T00:00:00.000Z"));
});

test("message updates tail of a known row, truncated to bound", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyMessage({ correlationId: "c1", message: "x".repeat(80) });
	const tail = s.snapshot()[0].tail;
	assert.ok(tail.length <= 48, `tail too long: ${tail.length}`);
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
			{ name: "edit", status: "running" },
		],
		toolCount: 4,
		tokens: 1200,
		inputTokens: 1_000,
		outputTokens: 200,
		status: "running",
	});
	const row = s.snapshot()[0];
	assert.equal(row.tail, "implementing footer");
	assert.equal(row.activeTool, "edit (running)");
	assert.equal(row.toolCount, 4);
	assert.equal(row.tokens, 1200);
	assert.equal(row.inputTokens, 1_000);
	assert.equal(row.outputTokens, 200);
	assert.equal(row.taskStatus, "running");
});

test("graph progress updates the task row instead of flattening child state onto parent", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "child", agent: "executor", name: "implement", spawnedBy: "root", status: "pending" }, 2);
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
	const byId = new Map(s.snapshot().map((r) => [r.correlationId, r]));
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

test("complete still removes a self-healed row", () => {
	const s = new AgentsStore();
	s.applyMessage({ correlationId: "c1", agent: "explorer", message: "hi" }, 500);
	assert.equal(s.size, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 600);
	assert.equal(s.size, 0);
});

test("complete removes the row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 });
	assert.equal(s.size, 0);
});

test("complete removes the full descendant tree", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "grandchild", agent: "reviewer", spawnedBy: "child" }, 3);
	s.applyStarted({ correlationId: "child", agent: "executor", spawnedBy: "root" }, 2);
	s.applyStarted({ correlationId: "root", agent: "planner" }, 1);
	s.applyComplete({ correlationId: "root", exitCode: 0 });
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

test("a successful wake lifecycle recreates a row removed at completion", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor", name: "worker" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 100);
	assert.equal(s.size, 0);

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
test("a late running message after complete does not resurrect a ghost row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.size, 0);
	// The tool result was already returned; this delta is a stale in-flight one.
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running", lastMessage: "stale" }, 1_500);
	assert.equal(s.size, 0, "ghost row must not be self-healed after complete");
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
	assert.equal(s.size, 0);
	// A result-ready task publishes status:"running" again once its lifecycle
	// confirms; the whole snapshot is post-complete and must stay deleted.
	s.applyMessage({
		correlationId: "root",
		progress: [
			{ correlationId: "child-1", agent: "executor", name: "a", taskIndex: 0, status: "running" },
			{ correlationId: "child-2", agent: "executor", name: "b", taskIndex: 1, status: "running" },
		],
	}, 1_500);
	assert.equal(s.size, 0, "graph children must not be self-healed after the root completed");
});

test("complete that beats the first delta still suppresses the self-heal that follows", () => {
	const s = new AgentsStore();
	// Event reorder: `complete` arrives before any row existed for this agent.
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running", message: "late" }, 1_500);
	assert.equal(s.size, 0);
});

test("an explicit started clears the tombstone so a woken agent reappears", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "executor" }, 1);
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	assert.equal(s.size, 0);
	// Waking a sleeping agent reuses its correlationId and re-emits `started`.
	s.applyStarted({ correlationId: "c1", agent: "executor", status: "running" }, 2_000);
	assert.equal(s.size, 1);
	s.applyMessage({ correlationId: "c1", status: "running", lastMessage: "awake" }, 2_500);
	assert.equal(s.snapshot(2_500)[0].tail, "awake");
});

test("a tombstone expires so a genuinely fresh agent is not suppressed forever", () => {
	const s = new AgentsStore();
	s.applyComplete({ correlationId: "c1", exitCode: 0 }, 1_000);
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running" }, 1_000 + COMPLETED_TOMBSTONE_MS - 1);
	assert.equal(s.size, 0, "still suppressed just before expiry");
	s.applyMessage({ correlationId: "c1", agent: "explorer", status: "running" }, 1_000 + COMPLETED_TOMBSTONE_MS);
	assert.equal(s.size, 1, "self-heal allowed again after the tombstone expires");
});
