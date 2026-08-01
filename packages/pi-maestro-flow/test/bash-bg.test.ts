import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	type BashBgDetails,
	type BashBgJobSnapshot,
	type BashBgSnapshotPayload,
	type RegisterBashBgOptions,
	registerBashBg,
} from "../src/tools/bash-bg.ts";
import { setQuietMode } from "../src/quiet-state.ts";
import {
	observeTargets,
	registerObservationProvider,
	type ObservationProvider,
} from "pi-maestro-teammate/v1/observation";

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
	renderResult(
		result: AgentToolResult<BashBgDetails>,
		options: { expanded: boolean },
		theme: Theme,
	): { render(width: number): string[] };
}

interface Harness {
	tool: ToolLike;
	emit: (channel: string, payload?: unknown) => void;
	snapshots: BashBgSnapshotPayload[];
	messages: Array<{
		message: { customType?: string; content?: string };
		options?: { triggerTurn?: boolean; deliverAs?: string };
	}>;
	shutdown: () => void;
	startSession: () => void;
}

function createHarness(options: RegisterBashBgOptions = {}): Harness {
	let registeredTool: ToolLike | undefined;
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, Array<(event?: unknown) => void>>();
	const snapshots: BashBgSnapshotPayload[] = [];
	const messages: Harness["messages"] = [];
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
				return () => {
					eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((entry) => entry !== handler));
				};
			},
		},
		on(event: string, handler: (event?: unknown) => void) {
			lifecycleHandlers.set(event, [...(lifecycleHandlers.get(event) ?? []), handler]);
		},
		sendMessage(message: Harness["messages"][number]["message"], options?: Harness["messages"][number]["options"]) {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	registerBashBg(api, options);
	assert.ok(registeredTool);
	return {
		tool: registeredTool,
		emit,
		snapshots,
		messages,
		shutdown: () => {
			for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) handler();
		},
		startSession: () => {
			for (const handler of lifecycleHandlers.get("session_start") ?? []) handler({ reason: "startup" });
		},
	};
}

test("bash_bg quiet render shows a running glyph in flight and an exit-aware glyph when done", () => {
	const harness = createHarness();
	try {
		setQuietMode(true);
		const theme = { fg: (_color: string, value: string) => value } as Theme;
		const running = {
			content: [{ type: "text", text: "job j1: running after 2s\ncommand: sleep 10\noutput (tail):\n(empty)" }],
			details: { jobId: "j1", running: true, exitCode: null },
		} as unknown as AgentToolResult<BashBgDetails>;
		const rRun = harness.tool.renderResult(running, { expanded: false }, theme).render(200);
		assert.equal(rRun.length, 1);
		assert.match(rRun[0], /^\s*•/);
		assert.match(rRun[0], /j1/);
		assert.doesNotMatch(rRun[0], /✓/);

		const completed = {
			content: [{ type: "text", text: "job j1: completed (exit 0)\ncommand: echo hi\noutput (tail):\nhi" }],
			details: { jobId: "j1", running: false, exitCode: 0 },
		} as unknown as AgentToolResult<BashBgDetails>;
		const rOk = harness.tool.renderResult(completed, { expanded: false }, theme).render(200);
		assert.equal(rOk.length, 1);
		assert.match(rOk[0], /✓/);
		assert.match(rOk[0], /exit 0/);

		const failed = {
			content: [{ type: "text", text: "job j1: failed (exit 3)\ncommand: false\noutput (tail):\n" }],
			details: { jobId: "j1", running: false, exitCode: 3 },
		} as unknown as AgentToolResult<BashBgDetails>;
		const rFail = harness.tool.renderResult(failed, { expanded: false }, theme).render(200);
		assert.equal(rFail.length, 1);
		assert.match(rFail[0], /✗/);
		assert.match(rFail[0], /exit 3/);
	} finally {
		setQuietMode(false);
		harness.shutdown();
	}
});

test("bash_bg run completes inline without queueing a redundant turn", async () => {
	const harness = createHarness();
	try {
		const result = await harness.tool.execute("fast", {
			action: "run",
			command: 'node -e "console.log(\'done\')"',
			timeout: 2,
		});
		assert.equal(result.details?.running, false);
		assert.equal(result.details?.exitCode, 0);
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		assert.match(text, /done/);
		assert.doesNotMatch(text, /\nlog: |\nview: /);
		assert.equal(result.details?.logPath, undefined);
		assert.equal(result.details?.viewCommand, undefined);
		const theme = { fg: (_color: string, value: string) => value } as Theme;
		const collapsed = harness.tool.renderResult(result, { expanded: false }, theme).render(200);
		const expanded = harness.tool.renderResult(result, { expanded: true }, theme).render(200);
		assert.equal(collapsed.length, 1);
		assert.match(expanded.join("\n"), /done/);
		assert.doesNotMatch(expanded.join("\n"), /log: |view: /);
		assert.deepEqual(harness.messages, []);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg exposes log access only when the returned tail is truncated", async () => {
	const harness = createHarness();
	try {
		const result = await harness.tool.execute("truncated", {
			action: "run",
			command: 'node -e "for(let i=1;i<=6;i++)console.log(\'line \'+i)"',
			timeout: 2,
			tail: 2,
		});
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		assert.doesNotMatch(text, /line 1/);
		assert.match(text, /line 5[\s\S]*line 6[\s\S]*\nlog: .+\.log\nview: /);
		assert.equal(result.details?.logPath?.endsWith(".log"), true);
		assert.equal(result.details?.viewCommand?.includes(result.details.logPath ?? ""), true);
		const theme = { fg: (_color: string, value: string) => value } as Theme;
		const expanded = harness.tool.renderResult(result, { expanded: true }, theme).render(200).join("\n");
		assert.match(expanded, /line 5[\s\S]*line 6[\s\S]*log: [\s\S]*view: /);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg treats process exit as completion when a descendant keeps stdio open", async () => {
	const harness = createHarness();
	try {
		const script = [
			"const {spawn}=require('node:child_process')",
			"const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{detached:true,stdio:['ignore',1,2]})",
			"child.unref()",
			"console.log('parent done')",
		].join(";");
		const result = await harness.tool.execute("inherited-pipe", {
			action: "run",
			command: `node -e ${JSON.stringify(script)}`,
			timeout: 1,
		});
		assert.equal(result.details?.running, false);
		assert.equal(result.details?.exitCode, 0);
		assert.deepEqual(harness.messages, []);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg start queues one completion turn after returning control", async () => {
	const harness = createHarness();
	try {
		const result = await harness.tool.execute("background", {
			action: "start",
			command: 'node -e "console.log(\'background done\')"',
		});
		const jobId = result.details?.jobId;
		assert.ok(jobId);
		await waitForStatus(harness.snapshots, jobId, "completed");
		await waitForMessage(harness.messages, "bash-bg-complete");
		assert.equal(harness.messages.length, 1);
		assert.equal(harness.messages[0]?.options?.triggerTurn, true);
		assert.equal(harness.messages[0]?.options?.deliverAs, undefined);
		assert.doesNotMatch(harness.messages[0]?.message.content ?? "", /\nlog: |\nview: /);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg completion includes log access when its notification tail is truncated", async () => {
	const harness = createHarness();
	try {
		const result = await harness.tool.execute("background-truncated", {
			action: "start",
			command: 'node -e "for(let i=1;i<=25;i++)console.log(\'line \'+i)"',
		});
		const jobId = result.details?.jobId;
		assert.ok(jobId);
		await waitForMessage(harness.messages, "bash-bg-complete");
		const content = harness.messages[0]?.message.content ?? "";
		assert.doesNotMatch(content, /(?:^|\n)line 1(?:\n|$)/);
		assert.match(content, /line 6[\s\S]*line 25[\s\S]*\nlog: .+\.log\nview: /);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg run follows teammate detach semantics after the foreground timeout", async () => {
	const harness = createHarness();
	try {
		const result = await harness.tool.execute("auto-background", {
			action: "run",
			command: 'node -e "setTimeout(()=>console.log(\'late done\'),1500)"',
			timeout: 1,
		});
		const jobId = result.details?.jobId;
		assert.ok(jobId);
		assert.equal(result.details?.running, true);
		assert.deepEqual(harness.messages, []);
		await waitForStatus(harness.snapshots, jobId, "completed");
		await waitForMessage(harness.messages, "bash-bg-complete");
		assert.equal(harness.messages.length, 1);
		assert.equal(harness.messages[0]?.options?.triggerTurn, true);
		assert.equal(harness.messages[0]?.options?.deliverAs, undefined);
	} finally {
		harness.shutdown();
	}
});

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

test("bash_bg bounds active processes, retained history, and private log bytes", async () => {
	const harness = createHarness({ maxActiveJobs: 1, maxRetainedCompletedJobs: 1, maxLogBytes: 64 });
	let logPath: string | undefined;
	try {
		const running = await harness.tool.execute("quota-running", {
			action: "start",
			command: 'node -e "setTimeout(()=>{},5000)"',
		});
		await assert.rejects(
			harness.tool.execute("quota-rejected", { action: "start", command: 'node -e "process.exit(0)"' }),
			/Too many active background jobs \(1\/1\)/,
		);
		const runningId = running.details?.jobId;
		assert.ok(runningId);
		await harness.tool.execute("quota-kill", { action: "kill", jobId: runningId });
		await waitForStatus(harness.snapshots, runningId, "killed");

		const capped = await harness.tool.execute("capped-log", {
			action: "run",
			command: 'node -e "process.stdout.write(\'x\'.repeat(256))"',
			timeout: 2,
			tail: 1,
		});
		logPath = capped.details?.logPath;
		assert.ok(logPath, "a disk-truncated log exposes its retained path");
		assert.ok(fs.statSync(logPath).size <= 64);
		assert.match(path.basename(path.dirname(logPath)), /^pi-bash-bg-/);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
			assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
		}

		const newest = await harness.tool.execute("history-newest", {
			action: "run",
			command: 'node -e "console.log(\'newest\')"',
			timeout: 2,
		});
		harness.emit(BASH_BG_QUERY_EVENT);
		assert.deepEqual(harness.snapshots.at(-1)?.jobs.map((job) => job.id), [newest.details?.jobId]);
		assert.equal(fs.existsSync(logPath), false, "evicting completed history reclaims its log file");
	} finally {
		harness.shutdown();
		if (logPath) assert.equal(fs.existsSync(path.dirname(logPath)), false);
	}
});

test("bash_bg teardown fences late callbacks and reinitializes for the next session", async () => {
	const harness = createHarness();
	try {
		await harness.tool.execute("first-session", {
			action: "start",
			command: 'node -e "setTimeout(()=>console.log(\'late\'),500)"',
		});
		harness.shutdown();
		const snapshotsAfterShutdown = harness.snapshots.length;
		const messagesAfterShutdown = harness.messages.length;
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(harness.snapshots.length, snapshotsAfterShutdown, "late child callbacks publish no snapshots");
		assert.equal(harness.messages.length, messagesAfterShutdown, "late child callbacks send no completion turn");

		harness.startSession();
		const next = await harness.tool.execute("next-session", {
			action: "run",
			command: 'node -e "console.log(\'ready again\')"',
			timeout: 2,
		});
		assert.equal(next.details?.exitCode, 0);
		assert.match(next.content[0] && "text" in next.content[0] ? next.content[0].text : "", /ready again/);
	} finally {
		harness.shutdown();
	}
});

test("bash_bg observation wait settles when session shutdown kills the job", async () => {
	const harness = createHarness();
	try {
		const started = await harness.tool.execute("shutdown-observe", {
			action: "start",
			command: 'node -e "setTimeout(()=>{},5000)"',
		});
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		const waiting = observeTargets({
			action: "wait",
			targets: [{ kind: "bash_bg", id: jobId }],
			timeoutMs: 2_000,
		});
		setTimeout(() => harness.shutdown(), 25);
		const result = await waiting;
		assert.equal(result.reason, "all");
		assert.equal(result.observations[0]?.nativeStatus, "killed");
		assert.equal(result.observations[0]?.waitStatus, "failed");
	} finally {
		harness.shutdown();
	}
});

test("observe waits for mixed teammate and bash_bg targets through one barrier", async () => {
	const harness = createHarness();
	const teammateProvider: ObservationProvider = {
		kind: "teammate",
		capabilities: { inspect: true, wait: true, message: true, supervise: true },
		snapshot: (id) => ({
			target: { kind: "teammate", id },
			found: true,
			nativeStatus: "running",
			phase: "active",
			summary: "reviewing",
			updatedAt: Date.now(),
		}),
		wait: async (id) => ({
			target: { kind: "teammate", id },
			found: true,
			nativeStatus: "completed",
			phase: "settled",
			outcome: "success",
			waitStatus: "completed",
			summary: "review complete",
			updatedAt: Date.now(),
		}),
	};
	const disposeTeammate = registerObservationProvider(teammateProvider);
	try {
		const started = await harness.tool.execute("mixed-observe", {
			action: "start",
			command: 'node -e "setTimeout(()=>console.log(\'built\'),150)"',
		});
		const jobId = started.details?.jobId;
		assert.ok(jobId);

		const status = await observeTargets({
			action: "status",
			targets: [
				{ kind: "teammate", id: "reviewer" },
				{ kind: "bash_bg", id: jobId },
			],
		});
		assert.deepEqual(status.observations.map((item) => item.target.kind), ["teammate", "bash_bg"]);
		assert.equal(status.observations[1]?.found, true);

		const waited = await observeTargets({
			action: "wait",
			waitMode: "all",
			timeoutMs: 2_000,
			targets: [
				{ kind: "teammate", id: "reviewer" },
				{ kind: "bash_bg", id: jobId },
			],
		});
		assert.equal(waited.reason, "all");
		assert.deepEqual(waited.observations.map((item) => item.waitStatus), ["completed", "completed"]);
		assert.match(waited.observations[1]?.summary ?? "", /built|completed/);
	} finally {
		disposeTeammate();
		harness.shutdown();
	}
});

async function waitForMessage(
	messages: readonly Harness["messages"][number][],
	customType: string,
): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (messages.some((entry) => entry.message.customType === customType)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${customType}`);
}

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
