import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentsStore } from "../src/agents-store.ts";

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

test("message for unknown correlationId is ignored", () => {
	const s = new AgentsStore();
	s.applyMessage({ correlationId: "nope", message: "hi" });
	assert.equal(s.size, 0);
});

test("complete removes the row", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "c1", agent: "explorer" }, 1);
	s.applyComplete({ correlationId: "c1" });
	assert.equal(s.size, 0);
});

test("complete for unknown correlationId does not throw", () => {
	const s = new AgentsStore();
	assert.doesNotThrow(() => s.applyComplete({ correlationId: "nope" }));
});

test("snapshot orders running before others, then by startedAt", () => {
	const s = new AgentsStore();
	s.applyStarted({ correlationId: "a", agent: "explorer" }, 300);
	s.applyStarted({ correlationId: "b", agent: "executor" }, 100);
	assert.deepEqual(s.snapshot().map((r) => r.correlationId), ["b", "a"]);
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
