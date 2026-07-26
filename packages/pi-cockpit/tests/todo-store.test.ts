import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoStore, mapStatus } from "../src/todo-store.ts";

function todoEntry(tasks: Record<string, { subject?: string; status?: string }>) {
	return { type: "custom", customType: "todo-state", data: { version: 1, tasks } };
}

test("hydrate rebuilds items from a custom todo-state entry (object form)", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([
		todoEntry({
			"#0": { subject: "map auth", status: "completed" },
			"#1": { subject: "implement", status: "in_progress" },
			"#2": { subject: "test", status: "pending" },
		}),
	]);
	assert.deepEqual(s.snapshot(), [
		{ id: "#0", subject: "map auth", status: "completed" },
		{ id: "#1", subject: "implement", status: "in_progress" },
		{ id: "#2", subject: "test", status: "pending" },
	]);
});

test("hydrate uses the LAST todo-state entry when several exist", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([
		todoEntry({ "#0": { subject: "old", status: "pending" } }),
		{ type: "message" } as never,
		todoEntry({ "#0": { subject: "new", status: "completed" } }),
	]);
	assert.equal(s.snapshot()[0].subject, "new");
	assert.equal(s.snapshot()[0].status, "completed");
});

test("hydrate drops deleted tasks", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([todoEntry({ "#0": { subject: "keep", status: "pending" }, "#1": { subject: "gone", status: "deleted" } })]);
	assert.deepEqual(s.snapshot().map((t) => t.id), ["#0"]);
});

test("hydrate with no todo-state entry yields empty snapshot, no throw", () => {
	const s = new TodoStore();
	assert.doesNotThrow(() => s.hydrateFromEntries([{ type: "message" } as never]));
	assert.equal(s.size, 0);
});

test("hydrate with empty entries array does not throw", () => {
	const s = new TodoStore();
	assert.doesNotThrow(() => s.hydrateFromEntries([]));
	assert.equal(s.size, 0);
});

test("hydrate tolerates entry.data without tasks", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([{ type: "custom", customType: "todo-state", data: { version: 1 } }]);
	assert.equal(s.size, 0);
});

test("hydrate coerces missing subject to empty string", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([todoEntry({ "#0": { status: "pending" } })]);
	assert.equal(s.snapshot()[0].subject, "");
});

test("mapStatus covers aliases and unknowns", () => {
	assert.equal(mapStatus("in_progress"), "in_progress");
	assert.equal(mapStatus("in-progress"), "in_progress");
	assert.equal(mapStatus("completed"), "completed");
	assert.equal(mapStatus("complete"), "completed");
	assert.equal(mapStatus("blocked"), "blocked");
	assert.equal(mapStatus("pending"), "pending");
	assert.equal(mapStatus("deleted"), "deleted");
	assert.equal(mapStatus(undefined), "pending");
	assert.equal(mapStatus("nonsense"), "pending");
});

test("snapshot preserves insertion order", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([todoEntry({ b: { subject: "B", status: "pending" }, a: { subject: "A", status: "pending" } })]);
	assert.deepEqual(s.snapshot().map((t) => t.id), ["b", "a"]);
});
