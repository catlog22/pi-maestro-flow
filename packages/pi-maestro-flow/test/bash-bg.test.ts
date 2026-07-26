import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	type BashBgDetails,
	type BashBgJobSnapshot,
	type BashBgSnapshotPayload,
	registerBashBg,
} from "../src/tools/bash-bg.ts";

interface ToolLike {
	execute(
		id: string,
		params: {
			action: "run" | "start" | "status" | "wait" | "kill" | "list";
			command?: string;
			jobId?: string;
			timeout?: number;
			tail?: number;
		},
		signal?: AbortSignal,
	): Promise<AgentToolResult<BashBgDetails>>;
}

interface Harness {
	tool: ToolLike;
	emit: (channel: string, payload?: unknown) => void;
	snapshots: BashBgSnapshotPayload[];
	shutdown: () => void;
}

function createHarness(): Harness {
	let registeredTool: ToolLike | undefined;
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, Array<() => void>>();
	const snapshots: BashBgSnapshotPayload[] = [];
	const emit = (channel: string, payload?: unknown): void => {
		if (channel === BASH_BG_UPDATE_EVENT) snapshots.push(payload as BashBgSnapshotPayload);
		for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
	};
	const api = {
		registerTool(tool: ToolDefinition) {
			registeredTool = tool as unknown as ToolLike;
		},
		events: {
			emit,
			on(channel: string, handler: (payload: unknown) => void) {
				eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
				return () => undefined;
			},
		},
		on(event: string, handler: () => void) {
			lifecycleHandlers.set(event, [...(lifecycleHandlers.get(event) ?? []), handler]);
		},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	registerBashBg(api);
	assert.ok(registeredTool);
	return {
		tool: registeredTool,
		emit,
		snapshots,
		shutdown: () => {
			for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) handler();
		},
	};
}

test("bash_bg publishes running, completion, failure and killed snapshots", async () => {
	const harness = createHarness();
	try {
		const completed = await harness.tool.execute("completed", {
			action: "start",
			command: 'node -e "setTimeout(function(){console.log(\'ready\')},150)"',
		});
		const completedId = completed.details?.jobId;
		assert.ok(completedId);
		const completedJob = await waitForStatus(harness.snapshots, completedId, "completed");
		assert.equal(completedJob.exitCode, 0);
		assert.match(completedJob.outputTail, /ready/);
		assert.ok(completedJob.finishedAt);
		assert.ok(completedJob.outputBytes > 0);

		const failed = await harness.tool.execute("failed", {
			action: "start",
			command: 'node -e "console.error(\'boom\');process.exit(3)"',
		});
		const failedId = failed.details?.jobId;
		assert.ok(failedId);
		const failedJob = await waitForStatus(harness.snapshots, failedId, "failed");
		assert.equal(failedJob.exitCode, 3);
		assert.match(failedJob.outputTail, /boom/);

		const killed = await harness.tool.execute("killed", {
			action: "start",
			command: 'node -e "setInterval(function(){console.log(\'tick\')},50)"',
		});
		const killedId = killed.details?.jobId;
		assert.ok(killedId);
		await waitForStatus(harness.snapshots, killedId, "running");
		await harness.tool.execute("kill", { action: "kill", jobId: killedId });
		await waitForStatus(harness.snapshots, killedId, "stopping");
		const killedJob = await waitForStatus(harness.snapshots, killedId, "killed");
		assert.notEqual(killedJob.exitCode, 0);

		const beforeQuery = harness.snapshots.length;
		harness.emit(BASH_BG_QUERY_EVENT);
		assert.equal(harness.snapshots.length, beforeQuery + 1);
		assert.equal(harness.snapshots.at(-1)?.jobs.length, 3);
	} finally {
		harness.shutdown();
	}
});

async function waitForStatus(
	snapshots: readonly BashBgSnapshotPayload[],
	jobId: string,
	status: BashBgJobSnapshot["status"],
): Promise<BashBgJobSnapshot> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		for (let index = snapshots.length - 1; index >= 0; index--) {
			const job = snapshots[index]?.jobs.find((entry) => entry.id === jobId && entry.status === status);
			if (job) return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${jobId} to reach ${status}`);
}
