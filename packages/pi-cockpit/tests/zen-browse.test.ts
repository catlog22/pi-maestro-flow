import assert from "node:assert/strict";
import test from "node:test";
import { createZenBrowseController } from "../src/zen-browse.ts";

function harness(initialRows: string[] = ["mission", "run", "task:1"]) {
	let rows = [...initialRows];
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renders = 0;
	let subscribes = 0;
	let unsubscribes = 0;
	let yielding = false;
	const activations: string[] = [];
	const warnings: string[] = [];
	const controller = createZenBrowseController({
		getNavRows: () => rows,
		subscribeInput: (next) => {
			subscribes++;
			handler = next;
			return () => {
				unsubscribes++;
				handler = undefined;
			};
		},
		requestRender: () => { renders++; },
		onActivate: (id) => { activations.push(id); },
		shouldYield: () => yielding,
		onWarning: (message) => { warnings.push(message); },
		emptyNotice: () => "nothing to browse",
	});
	return {
		controller,
		input: (data: string) => handler?.(data),
		setRows: (next: string[]) => { rows = [...next]; },
		setYielding: (next: boolean) => { yielding = next; },
		renders: () => renders,
		subscribes: () => subscribes,
		unsubscribes: () => unsubscribes,
		activations,
		warnings,
	};
}

test("begin selects the first row and subscribes once", () => {
	const h = harness();
	assert.equal(h.controller.begin(), true);
	assert.equal(h.controller.begin(), true, "begin is idempotent while active");
	assert.equal(h.controller.isActive(), true);
	assert.deepEqual(h.controller.state(), { selectedId: "mission" });
	assert.equal(h.subscribes(), 1);
	assert.equal(h.renders(), 1);
});

test("empty browse refuses focus and emits the configured notice", () => {
	const h = harness([]);
	assert.equal(h.controller.begin(), false);
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.subscribes(), 0);
	assert.deepEqual(h.warnings, ["nothing to browse"]);
});

test("arrows, vim keys, Home and End move within stable row bounds", () => {
	const h = harness();
	h.controller.begin();
	assert.deepEqual(h.input("\x1b[B"), { consume: true });
	assert.equal(h.controller.state()?.selectedId, "run");
	h.input("j");
	assert.equal(h.controller.state()?.selectedId, "task:1");
	h.input("j");
	assert.equal(h.controller.state()?.selectedId, "task:1", "down clamps at the tail");
	h.input("k");
	assert.equal(h.controller.state()?.selectedId, "run");
	h.input("\x1b[H");
	assert.equal(h.controller.state()?.selectedId, "mission");
	h.input("\x1b[F");
	assert.equal(h.controller.state()?.selectedId, "task:1");
});

test("Enter toggles L2 expansion and Escape steps up before leaving", () => {
	const h = harness();
	h.controller.begin();
	assert.deepEqual(h.input("\r"), { consume: true });
	assert.deepEqual(h.controller.state(), { selectedId: "mission", expandedId: "mission" });
	assert.deepEqual(h.input("\x1b"), { consume: true });
	assert.deepEqual(h.controller.state(), { selectedId: "mission" });
	assert.equal(h.controller.isActive(), true);
	assert.deepEqual(h.input("\x1b"), { consume: true });
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.controller.state(), undefined);
	assert.equal(h.unsubscribes(), 1);
});

test("second Enter activates the selected row after releasing browse focus", () => {
	const h = harness();
	h.controller.begin();
	h.input("\x1b[B");
	h.input("\r");
	assert.deepEqual(h.controller.state(), { selectedId: "run", expandedId: "run" });
	assert.deepEqual(h.input("\r"), { consume: true });
	assert.deepEqual(h.activations, ["run"]);
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.unsubscribes(), 1, "input hook is released before activation");
});

test("moving away collapses the expanded row", () => {
	const h = harness();
	h.controller.begin();
	h.input("\r");
	h.input("\x1b[B");
	assert.deepEqual(h.controller.state(), { selectedId: "run" });
});

test("capturing surfaces receive keys while browse preserves its state", () => {
	const h = harness();
	h.controller.begin();
	h.setYielding(true);
	assert.equal(h.input("j"), undefined);
	assert.deepEqual(h.controller.state(), { selectedId: "mission" });
});

test("live row reordering preserves a stable selection and removal falls back", () => {
	const h = harness();
	h.controller.begin();
	h.input("\x1b[B");
	h.setRows(["task:1", "run", "mission"]);
	assert.equal(h.controller.state()?.selectedId, "run");
	h.setRows(["task:1", "mission"]);
	assert.deepEqual(h.controller.state(), { selectedId: "task:1" });
});

test("an empty live stack ends browse and releases its input subscription", () => {
	const h = harness();
	h.controller.begin();
	h.setRows([]);
	assert.equal(h.controller.state(), undefined);
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.unsubscribes(), 1);
});

test("dispose is idempotent and releases the input subscription", () => {
	const h = harness();
	h.controller.begin();
	h.controller.dispose();
	h.controller.dispose();
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.unsubscribes(), 1);
});

test("subscription failure rolls back the active state", () => {
	const controller = createZenBrowseController({
		getNavRows: () => ["mission"],
		subscribeInput: () => { throw new Error("input unavailable"); },
		requestRender: () => undefined,
	});
	assert.equal(controller.begin(), false);
	assert.equal(controller.isActive(), false);
	assert.equal(controller.state(), undefined);
});
