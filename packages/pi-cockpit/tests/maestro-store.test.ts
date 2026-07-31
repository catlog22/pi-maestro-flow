import assert from "node:assert/strict";
import test from "node:test";
import { MaestroStore } from "../src/maestro-store.ts";
import { MAESTRO_UI_SNAPSHOT_VERSION } from "../src/public/v1/events.ts";

function snapshot(sessionGeneration: string, revision: number): Record<string, unknown> {
	return {
		version: MAESTRO_UI_SNAPSHOT_VERSION,
		sessionGeneration,
		revision,
		workflow: {
			session: { id: "session-1", label: "Main session", status: "running" },
			run: { id: "run-1", command: "execute", status: "running" },
			chain: { completed: 1, running: 1, pending: 2, total: 4 },
			gates: { passed: 1, total: 2, failed: 0 },
			next: "maestro run brief run-1",
		},
		goals: [{
			id: "goal-1",
			objective: "Ship sidebar",
			status: "active",
			iteration: 2,
			tokensUsed: 200,
			tokenBudget: 1_000,
			timeUsedSeconds: 20,
			startedAt: 100,
			updatedAt: 200,
		}],
		currentGoalId: "goal-1",
		swarm: {
			sessionId: "swarm-1",
			objective: "Review",
			status: "active",
			iteration: 1,
			maxIterations: 3,
			workers: [{ id: "worker-1", label: "Reviewer", status: "running" }],
			best: { workerId: "worker-1", iteration: 1, score: 0.8, summary: "Best result" },
			updatedAt: 200,
		},
		mode: { kind: "workflow", label: "Running" },
		publishedAt: 200,
	};
}

test("accepts increasing revisions and rejects stale or exact duplicate snapshots", () => {
	const store = new MaestroStore();
	assert.equal(store.applySnapshot(snapshot("generation-a", 1)), true);
	assert.equal(store.applySnapshot(snapshot("generation-a", 1)), false);
	assert.equal(store.applySnapshot(snapshot("generation-a", 0)), false);
	assert.equal(store.applySnapshot(snapshot("generation-a", 2)), true);
	assert.equal(store.snapshot()?.revision, 2);
});

test("a new generation fences late snapshots from the superseded generation", () => {
	const store = new MaestroStore();
	assert.equal(store.applySnapshot(snapshot("generation-a", 9)), true);
	assert.equal(store.applySnapshot(snapshot("generation-b", 0)), true);
	assert.equal(store.applySnapshot(snapshot("generation-a", 10)), false);
	assert.equal(store.snapshot()?.sessionGeneration, "generation-b");

	assert.equal(store.applySnapshot(snapshot("generation-c", 0)), true);
	assert.equal(store.applySnapshot(snapshot("generation-b", 1)), false);
	assert.equal(store.snapshot()?.sessionGeneration, "generation-c");
});

test("minimal clear tombstones remove state without weakening ordering fences", () => {
	const store = new MaestroStore();
	assert.equal(store.applySnapshot(snapshot("generation-a", 1)), true);
	assert.equal(store.applySnapshot({
		version: MAESTRO_UI_SNAPSHOT_VERSION,
		sessionGeneration: "generation-a",
		revision: 2,
		publishedAt: 300,
		cleared: true,
	}), true);
	assert.equal(store.snapshot(), undefined);
	assert.equal(store.applySnapshot(snapshot("generation-a", 2)), false);
	assert.equal(store.applySnapshot(snapshot("generation-a", 3)), true);
	assert.equal(store.snapshot()?.revision, 3);
});

test("rejects unsupported versions and malformed envelopes without replacing state", () => {
	const store = new MaestroStore();
	assert.equal(store.applySnapshot(snapshot("generation-a", 1)), true);
	assert.equal(store.applySnapshot({ ...snapshot("generation-a", 2), version: 2 }), false);
	assert.equal(store.applySnapshot({ ...snapshot("generation-a", 2), publishedAt: Number.NaN }), false);
	assert.equal(store.applySnapshot({ ...snapshot("generation-a", 2), mode: { kind: undefined } }), false);
	assert.equal(store.snapshot()?.revision, 1);
});

test("deeply rejects malformed workflow, goal, and swarm fields", () => {
	const store = new MaestroStore();
	assert.equal(store.applySnapshot(snapshot("generation-a", 1)), true);

	const badWorkflow = snapshot("generation-a", 2);
	(badWorkflow.workflow as { chain: { total: unknown } }).chain.total = 4.5;
	assert.equal(store.applySnapshot(badWorkflow), false);

	const badGoal = snapshot("generation-a", 2);
	(badGoal.goals as Array<{ tokensUsed: unknown }>)[0]!.tokensUsed = Number.NaN;
	assert.equal(store.applySnapshot(badGoal), false);

	const badSwarm = snapshot("generation-a", 2);
	(badSwarm.swarm as { workers: Array<{ status: unknown }> }).workers[0]!.status = 7;
	assert.equal(store.applySnapshot(badSwarm), false);
	assert.equal(store.snapshot()?.revision, 1);
});

test("preserves opaque IDs, sanitizes display strings, and returns detached snapshots", () => {
	const store = new MaestroStore();
	const input = snapshot("generation-\nA", 1);
	const workflow = input.workflow as {
		session: { id: string; label: string };
		run: { id: string };
		next: string;
	};
	const goals = input.goals as Array<{ id: string; objective: string }>;
	const swarm = input.swarm as {
		sessionId: string;
		workers: Array<{ id: string; label: string }>;
		best: { workerId: string };
	};
	const mode = input.mode as { label: string };
	workflow.session.id = "session\n1";
	workflow.run.id = "run\u001b[31m1";
	workflow.session.label = "Main\r\nsession\u001b[31m red\u001b[0m";
	workflow.next = "next\u0000\tstep";
	goals[0]!.id = "goal\n1";
	goals[0]!.objective = "Ship\nsidebar";
	input.currentGoalId = "goal\n1";
	swarm.sessionId = "swarm\n1";
	swarm.workers[0]!.id = "worker\u001b[2J1";
	swarm.workers[0]!.label = "Review\u001b[2Jworker";
	swarm.best.workerId = "worker\u001b[2J1";
	mode.label = "Run\u0007ning";

	assert.equal(store.applySnapshot(input), true);
	workflow.session.label = "mutated producer";
	goals[0]!.objective = "mutated producer";

	const first = store.snapshot()!;
	assert.equal(first.sessionGeneration, "generation-\nA");
	assert.equal(first.workflow?.session.id, "session\n1");
	assert.equal(first.workflow?.run?.id, "run\u001b[31m1");
	assert.equal(first.goals[0]?.id, "goal\n1");
	assert.equal(first.currentGoalId, "goal\n1");
	assert.equal(first.swarm?.sessionId, "swarm\n1");
	assert.equal(first.swarm?.workers[0]?.id, "worker\u001b[2J1");
	assert.equal(first.swarm?.best?.workerId, "worker\u001b[2J1");
	assert.equal(first.workflow?.session.label, "Main session red");
	assert.equal(first.workflow?.next, "next step");
	assert.equal(first.goals[0]?.objective, "Ship sidebar");
	assert.equal(first.swarm?.workers[0]?.label, "Reviewworker");
	assert.deepEqual(first.mode, { kind: "workflow", label: "Running" });

	first.goals[0]!.objective = "mutated consumer";
	assert.equal(store.snapshot()!.goals[0]!.objective, "Ship sidebar");
});

test("hostile payload inspection fails closed without throwing", () => {
	const store = new MaestroStore();
	const hostileEnvelope = new Proxy({}, {
		get() {
			throw new Error("hostile getter");
		},
	});
	assert.doesNotThrow(() => assert.equal(store.applySnapshot(hostileEnvelope), false));

	const hostileNested = snapshot("generation-a", 1);
	Object.defineProperty(hostileNested, "workflow", {
		get() {
			throw new Error("hostile nested getter");
		},
	});
	assert.doesNotThrow(() => assert.equal(store.applySnapshot(hostileNested), false));
	assert.equal(store.snapshot(), undefined);
});
