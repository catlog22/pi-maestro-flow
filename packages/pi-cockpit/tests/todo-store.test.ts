import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoStore, mapStatus } from "../src/todo-store.ts";

function todoEntry(tasks: Record<string, Record<string, unknown>>) {
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
		{ id: "#0", subject: "map auth", status: "completed", blockedBy: [], skills: [] },
		{ id: "#1", subject: "implement", status: "in_progress", blockedBy: [], skills: [] },
		{ id: "#2", subject: "test", status: "pending", blockedBy: [], skills: [] },
	]);
});

test("hydrate preserves blocked dependencies, actors and skill bindings", () => {
	const s = new TodoStore();
	s.hydrateFromEntries([todoEntry({
		"#1": {
			subject: "verify",
			status: "blocked",
			blockedBy: ["#0", "#0", "", 12],
			createdBy: { id: "root", label: "root", kind: "root" },
			assignee: { id: "worker-1", label: "executor", kind: "teammate" },
			skills: [
				{ name: "team-testing", role: "primary", args: "unit" },
				{ role: "guard" },
				"invalid",
			],
		},
	})]);
	assert.deepEqual(s.snapshot()[0], {
		id: "#1",
		subject: "verify",
		status: "blocked",
		blockedBy: ["#0"],
		createdBy: { id: "root", label: "root" },
		assignee: { id: "worker-1", label: "executor" },
		skills: [{ name: "team-testing", role: "primary" }],
	});
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

test("hydrate reports changes and preserves the map on identical display content", () => {
	const s = new TodoStore();
	const initial = todoEntry({
		a: { subject: "A", status: "pending", blockedBy: [] },
		b: { subject: "B", status: "blocked", blockedBy: ["a"] },
	});
	assert.equal(s.hydrateFromEntries([initial]), true);
	const snapshot = s.snapshot();
	assert.equal(s.hydrateFromEntries([initial]), false);
	assert.equal(s.snapshot()[0], snapshot[0], "no-op hydrate preserves existing item identities");

	assert.equal(s.hydrateFromEntries([todoEntry({
		a: { subject: "A", status: "completed", blockedBy: [] },
		b: { subject: "B", status: "blocked", blockedBy: ["a"] },
	})]), true, "status changes are visible");
	assert.equal(s.hydrateFromEntries([todoEntry({
		b: { subject: "B", status: "blocked", blockedBy: ["a"] },
		a: { subject: "A", status: "completed", blockedBy: [] },
	})]), true, "id order changes are visible");
});

test("hydrate reports teammate reassignment even when Todo status is already in progress", () => {
	const s = new TodoStore();
	const rootTask = todoEntry({
		a: {
			subject: "A",
			status: "in_progress",
			assignee: { id: "root", label: "root" },
			updatedAt: 1,
		},
	});
	assert.equal(s.hydrateFromEntries([rootTask]), true);

	assert.equal(s.hydrateFromEntries([todoEntry({
		a: {
			subject: "A",
			status: "in_progress",
			assignee: { id: "native-at", label: "native-at" },
			updatedAt: 2,
		},
	})]), true);
	assert.deepEqual(s.snapshot()[0]?.assignee, { id: "native-at", label: "native-at" });
});

// The todo snapshot is LLM-authored; same zero-width injection risk as teammate events.
test("todo snapshot strings are stripped of control characters on hydrate", () => {
	const store = new TodoStore();
	store.hydrateFromEntries([{
		type: "custom",
		customType: "todo-state",
		data: {
			tasks: {
				t1: {
					subject: "ship\nit\x1b[2J",
					status: "in_progress",
					assignee: { id: "u1", label: "dev\x1b[31m" },
					createdBy: { id: "u2", label: "lead\nx" },
					skills: [{ name: "review\nfast", role: "primary\x1b[0m" }],
				},
			},
		},
	}]);
	const item = store.snapshot()[0];
	const values = [
		item.subject,
		item.assignee?.label ?? "",
		item.createdBy?.label ?? "",
		item.skills[0]?.name ?? "",
		item.skills[0]?.role ?? "",
	];
	for (const value of values) {
		assert.doesNotMatch(value, /[\n\r\x1b]/, `control char survived in ${JSON.stringify(value)}`);
	}
	assert.equal(item.subject, "ship it");
});
