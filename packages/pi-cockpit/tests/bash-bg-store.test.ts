import assert from "node:assert/strict";
import test from "node:test";
import { BashBgStore } from "../src/bash-bg-store.ts";
import type { BashBgJob, BashBgStatus } from "../src/types.ts";

function job(id: string, status: BashBgStatus, startedAt: number): BashBgJob {
	return {
		id,
		command: `node ${id}.js`,
		cwd: "/workspace",
		pid: startedAt,
		status,
		startedAt,
		updatedAt: startedAt + 10,
		...(status === "running" || status === "stopping" ? {} : { finishedAt: startedAt + 1000 }),
		exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null,
		outputTail: `${id} output`,
		outputBytes: 20,
		logPath: `/tmp/${id}.log`,
	};
}

test("full snapshot is authoritative and sorts active jobs first", () => {
	const store = new BashBgStore();
	assert.equal(store.applySnapshot({
		jobs: [
			job("done", "completed", 30),
			job("run-old", "running", 10),
			job("stopping", "stopping", 40),
			job("run-new", "running", 20),
		],
	}), true);
	assert.deepEqual(store.snapshot().map((entry) => entry.id), ["run-new", "run-old", "stopping", "done"]);
	assert.equal(store.hasActive(), true);

	assert.equal(store.applySnapshot({ jobs: [job("failed", "failed", 50)] }), true);
	assert.deepEqual(store.snapshot().map((entry) => entry.id), ["failed"]);
	assert.equal(store.hasActive(), false);
});

test("malformed payload does not replace valid state and malformed rows are ignored", () => {
	const store = new BashBgStore();
	store.applySnapshot({ jobs: [job("run", "running", 10)] });
	assert.equal(store.applySnapshot({ nope: [] }), false);
	assert.deepEqual(store.snapshot().map((entry) => entry.id), ["run"]);

	assert.equal(store.applySnapshot({
		jobs: [
			{ ...job("bad-status", "running", 20), status: "unknown" },
			{ ...job("bad-time", "running", 30), startedAt: Number.NaN },
			job("killed", "killed", 40),
		],
	}), true);
	assert.deepEqual(store.snapshot().map((entry) => entry.id), ["killed"]);
});

test("clear removes session-local background jobs", () => {
	const store = new BashBgStore();
	store.applySnapshot({ jobs: [job("run", "running", 10)] });
	store.clear();
	assert.deepEqual(store.snapshot(), []);
	assert.equal(store.hasActive(), false);
});
