import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	BASH_BG_QUERY_EVENT,
	BASH_BG_UPDATE_EVENT,
	BashBgParams,
	type BashBgDetails,
	type BashBgJobSnapshot,
	type BashBgSnapshotPayload,
	type RegisterBashBgOptions,
	classifyWindowsTaskkill,
	registerBashBg,
	windowsTaskkillFailure,
} from "../src/tools/bash-bg.ts";
import { setQuietMode } from "../src/quiet-state.ts";
import {
	observeTargets,
	registerObservationProvider,
	type ObservationProvider,
} from "pi-maestro-teammate/v1/observation";

test("bash_bg action description recommends run without implying an omitted default", () => {
	const action = BashBgParams.properties.action as unknown as { description?: string };
	const timeout = BashBgParams.properties.timeout as unknown as { description?: string };
	assert.match(action.description ?? "", /recommended for uncertain-duration commands/);
	assert.doesNotMatch(action.description ?? "", /recommended default/);
	assert.match(timeout.description ?? "", /run: foreground seconds.*wait: max seconds to block/);
	assert.doesNotMatch(timeout.description ?? "", /start|max(?:imum)? runtime/i, "background jobs remain intentionally unbounded");
});

test("bash_bg classifies Windows taskkill outcomes instead of trusting direct process exit", () => {
	assert.equal(windowsTaskkillFailure({ status: 0, signal: null }), undefined);
	assert.deepEqual(classifyWindowsTaskkill({ status: 0, signal: null }), { treeCleanupConfirmed: true });
	assert.deepEqual(
		classifyWindowsTaskkill({ status: 128, signal: null }),
		{ treeCleanupConfirmed: false },
		"a leader-exit race is idempotent without claiming descendant cleanup",
	);
	assert.equal(windowsTaskkillFailure({ status: 5, signal: null }), "taskkill failed (exit 5)");
	assert.equal(windowsTaskkillFailure({ status: 128, signal: null }), undefined, "a target that exits during cleanup is idempotent");
	assert.equal(
		windowsTaskkillFailure({ status: 128, signal: null }, false),
		"taskkill failed (exit 128)",
		"a target that was already gone cannot confirm descendant cleanup",
	);
	assert.equal(windowsTaskkillFailure({ status: null, signal: "SIGKILL" }), "taskkill failed (signal SIGKILL)");
	assert.equal(windowsTaskkillFailure({ status: null, signal: null }), "taskkill failed (unknown status)");
	assert.equal(
		windowsTaskkillFailure({
			status: null,
			signal: null,
			error: Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }),
		}),
		"taskkill failed to start: spawn taskkill ENOENT",
	);
	assert.equal(
		windowsTaskkillFailure({
			status: null,
			signal: "SIGKILL",
			error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
		}),
		"taskkill timed out",
	);
});

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
	shutdown: () => Promise<void>;
	startSession: () => void;
}

function createHarness(options: RegisterBashBgOptions = {}): Harness {
	let registeredTool: ToolLike | undefined;
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, Array<(event?: unknown) => unknown>>();
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
		shutdown: async () => {
			await Promise.all((lifecycleHandlers.get("session_shutdown") ?? []).map((handler) => handler()));
		},
		startSession: () => {
			for (const handler of lifecycleHandlers.get("session_start") ?? []) handler({ reason: "startup" });
		},
	};
}

test("bash_bg quiet render shows a running glyph in flight and an exit-aware glyph when done", async () => {
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
		await harness.shutdown();
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
		await harness.shutdown();
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
		await harness.shutdown();
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
		await harness.shutdown();
	}
});

test("bash_bg Windows kill never reports confirmed cleanup after the direct shell already exited", { skip: process.platform !== "win32" }, async () => {
	const harness = createHarness();
	let descendantPid: number | undefined;
	try {
		const script = [
			"const {spawn}=require('node:child_process')",
			"const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'})",
			"child.unref()",
			"console.log(child.pid)",
		].join(";");
		const started = await harness.tool.execute("detached-descendant", {
			action: "start",
			command: `node -e ${JSON.stringify(script)}`,
		});
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		const completed = await waitForStatus(harness.snapshots, jobId, "completed");
		descendantPid = Number(completed.outputTail.match(/^(\d+)/)?.[1]);
		assert.ok(descendantPid);
		assert.equal(isProcessRunning(descendantPid), true);

		await assert.rejects(
			harness.tool.execute("kill-after-shell-exit", { action: "kill", jobId }),
			/Windows process-tree cleanup is unconfirmed/,
		);
		assert.equal(isProcessRunning(descendantPid), true, "an unconfirmed tree must not be reported as reclaimed");
	} finally {
		if (descendantPid && isProcessRunning(descendantPid)) {
			try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
		}
		await harness.shutdown();
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
		await harness.shutdown();
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
		await harness.shutdown();
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
		assert.equal(harness.snapshots.at(-1)?.jobs.find((job) => job.id === jobId)?.background, true);
		assert.deepEqual(harness.messages, []);
		await waitForStatus(harness.snapshots, jobId, "completed");
		await waitForMessage(harness.messages, "bash-bg-complete");
		assert.equal(harness.messages.length, 1);
		assert.equal(harness.messages[0]?.options?.triggerTurn, true);
		assert.equal(harness.messages[0]?.options?.deliverAs, undefined);
	} finally {
		await harness.shutdown();
	}
});

test("bash_bg run abort cancels the process tree without background transfer or completion", async () => {
	const harness = createHarness();
	try {
		const controller = new AbortController();
		const running = harness.tool.execute("abort-run", {
			action: "run",
			command: 'node -e "setInterval(()=>{},1000)"',
			timeout: 30,
		}, controller.signal);
		const started = harness.snapshots.at(-1)?.jobs[0];
		assert.ok(started);
		assert.equal(started.status, "running");
		assert.equal(started.background, false, "action=run is foreground until its detach deadline");

		controller.abort();
		await assert.rejects(running, /aborted/);
		const killed = await waitForStatus(harness.snapshots, started.id, "killed");
		assert.equal(killed.pid, started.pid);
		if (process.platform !== "win32") assert.equal(isProcessGroupRunning(started.pid), false);
		await delay(150);
		assert.deepEqual(harness.messages, []);
	} finally {
		await harness.shutdown();
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
		await harness.shutdown();
	}
});

test("bash_bg kill escalates to SIGKILL when a POSIX child ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness();
	try {
		const command = 'node -e "process.on(\'SIGTERM\',()=>console.log(\'ignored\'));console.log(\'ready\');setInterval(()=>{},1000)"';
		const started = await harness.tool.execute("ignore-term-kill", { action: "start", command });
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		await waitForOutput(harness.snapshots, jobId, /ready/);
		const stopStartedAt = Date.now();

		await harness.tool.execute("kill-ignoring-term", { action: "kill", jobId });
		const elapsedMs = Date.now() - stopStartedAt;
		const killed = await waitForStatus(harness.snapshots, jobId, "killed");
		assert.ok(elapsedMs >= 800, `expected SIGTERM grace before escalation, got ${elapsedMs}ms`);
		assert.equal(isProcessGroupRunning(killed.pid), false);
	} finally {
		await harness.shutdown();
	}
});

test("bash_bg shutdown escalates and retains POSIX process ownership through the deadline", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness();
	try {
		const command = 'node -e "process.on(\'SIGTERM\',()=>console.log(\'ignored\'));console.log(\'ready\');setInterval(()=>{},1000)"';
		const started = await harness.tool.execute("ignore-term-shutdown", { action: "start", command });
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		const running = await waitForOutput(harness.snapshots, jobId, /ready/);
		const shutdownStartedAt = Date.now();

		await harness.shutdown();
		const elapsedMs = Date.now() - shutdownStartedAt;
		assert.ok(elapsedMs >= 800, `expected SIGTERM grace before escalation, got ${elapsedMs}ms`);
		assert.equal(isProcessGroupRunning(running.pid), false);
		assert.deepEqual(harness.messages, []);
	} finally {
		await harness.shutdown();
	}
});

test("bash_bg shutdown reclaims remaining POSIX jobs when one process group cannot be killed", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness();
	const originalKill = process.kill;
	let blockedPid: number | undefined;
	let otherPid: number | undefined;
	let processKillPatched = false;
	try {
		const command = 'node -e "console.log(\'ready\');setInterval(()=>{},1000)"';
		const blocked = await harness.tool.execute("shutdown-blocked", { action: "start", command });
		const other = await harness.tool.execute("shutdown-other", { action: "start", command });
		const blockedId = blocked.details?.jobId;
		const otherId = other.details?.jobId;
		assert.ok(blockedId);
		assert.ok(otherId);
		blockedPid = (await waitForOutput(harness.snapshots, blockedId, /ready/)).pid;
		otherPid = (await waitForOutput(harness.snapshots, otherId, /ready/)).pid;

		process.kill = ((targetPid: number, signal?: string | number) => {
			if (targetPid === -blockedPid) return true;
			return originalKill(targetPid, signal);
		}) as typeof process.kill;
		processKillPatched = true;

		await assert.rejects(
			harness.shutdown(),
			/Failed to fully reclaim 1 bash background resource during session shutdown/,
		);
		assert.equal(isProcessGroupRunning(otherPid), false, "one failed termination must not skip the other job");
	} finally {
		if (processKillPatched) process.kill = originalKill;
		if (blockedPid && isProcessGroupRunning(blockedPid)) {
			try { originalKill(-blockedPid, "SIGKILL"); } catch { /* already gone */ }
		}
		await harness.shutdown();
	}
});

test("bash_bg keeps a completed shell active and retained while its same-group POSIX descendant lives", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness({ maxActiveJobs: 1, maxRetainedCompletedJobs: 0 });
	try {
		const started = await harness.tool.execute("completed-shell-kill", {
			action: "start",
			command: `node -e ${JSON.stringify("setInterval(()=>{},1000)")} &`,
		});
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		const completed = await waitForStatus(harness.snapshots, jobId, "completed");
		await waitForMessage(harness.messages, "bash-bg-complete");
		assert.equal(isProcessGroupRunning(completed.pid), true);

		await assert.rejects(
			harness.tool.execute("same-group-quota-bypass", { action: "start", command: 'node -e "process.exit(0)"' }),
			/Too many active background jobs \(1\/1\)/,
		);
		harness.emit(BASH_BG_QUERY_EVENT);
		assert.equal(harness.snapshots.at(-1)?.jobs.some((job) => job.id === jobId), true);
		const observed = await observeTargets({
			action: "status",
			targets: [{ kind: "bash_bg", id: jobId }],
		});
		assert.equal(observed.observations[0]?.nativeStatus, "completed");
		assert.equal(observed.observations[0]?.phase, "active");
		assert.equal(observed.observations[0]?.capabilities?.cancel, true);
		const ownershipWait = observeTargets({
			action: "wait",
			targets: [{ kind: "bash_bg", id: jobId }],
			timeoutMs: 2_000,
		});

		const result = await harness.tool.execute("kill-completed-shell-group", { action: "kill", jobId });
		assert.match(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", /Stopped job/);
		const settled = await ownershipWait;
		assert.equal(settled.reason, "all");
		assert.equal(settled.observations[0]?.nativeStatus, "killed");
		assert.equal(settled.observations[0]?.phase, "settled");
		await waitForStatus(harness.snapshots, jobId, "killed");
		assert.equal(isProcessGroupRunning(completed.pid), false);
	} finally {
		await harness.shutdown();
	}
});

test("bash_bg shutdown owns a retained same-group POSIX descendant after output finalization", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness({ maxRetainedCompletedJobs: 0 });
	try {
		const started = await harness.tool.execute("completed-shell-shutdown", {
			action: "start",
			command: `node -e ${JSON.stringify("setInterval(()=>{},1000)")} &`,
		});
		const jobId = started.details?.jobId;
		assert.ok(jobId);
		const completed = await waitForStatus(harness.snapshots, jobId, "completed");
		await waitForMessage(harness.messages, "bash-bg-complete");
		assert.equal(isProcessGroupRunning(completed.pid), true);
		harness.emit(BASH_BG_QUERY_EVENT);
		assert.equal(harness.snapshots.at(-1)?.jobs.some((job) => job.id === jobId), true);

		await harness.shutdown();
		assert.equal(isProcessGroupRunning(completed.pid), false);
	} finally {
		await harness.shutdown();
	}
});

test("bash_bg pruning conservatively retains history when a POSIX group liveness probe throws", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness({ maxRetainedCompletedJobs: 0 });
	const originalKill = process.kill;
	let processKillPatched = false;
	try {
		const started = await harness.tool.execute("probe-error-history", {
			action: "start",
			command: 'node -e "setTimeout(()=>{},150)"',
		});
		const jobId = started.details?.jobId;
		const pid = started.details?.pid;
		assert.ok(jobId);
		assert.ok(pid);

		process.kill = ((targetPid: number, signal?: string | number) => {
			if (targetPid === -pid && signal === 0) throw Object.assign(new Error("probe denied"), { code: "EPERM" });
			return originalKill(targetPid, signal);
		}) as typeof process.kill;
		processKillPatched = true;
		await waitForMessage(harness.messages, "bash-bg-complete");
		harness.emit(BASH_BG_QUERY_EVENT);
		assert.equal(harness.snapshots.at(-1)?.jobs.some((job) => job.id === jobId), true);
	} finally {
		if (processKillPatched) process.kill = originalKill;
		await harness.shutdown();
	}
});

test("bash_bg records terminal failure when the final POSIX group boundary remains alive", { skip: process.platform === "win32" }, async () => {
	const harness = createHarness();
	const originalKill = process.kill;
	let processKillPatched = false;
	try {
		const started = await harness.tool.execute("forced-live-boundary", {
			action: "start",
			command: 'node -e "console.log(\'ready\');setInterval(()=>{},1000)"',
		});
		const jobId = started.details?.jobId;
		const pid = started.details?.pid;
		assert.ok(jobId);
		assert.ok(pid);
		await waitForOutput(harness.snapshots, jobId, /ready/);

		process.kill = ((targetPid: number, signal?: string | number) => {
			if (targetPid === -pid) return true;
			return originalKill(targetPid, signal);
		}) as typeof process.kill;
		processKillPatched = true;
		await assert.rejects(
			harness.tool.execute("forced-live-kill", { action: "kill", jobId }),
			/POSIX process group .* is still alive/,
		);
		const failed = await waitForStatus(harness.snapshots, jobId, "failed");
		assert.equal(failed.pid, pid);
		const observed = await observeTargets({
			action: "status",
			targets: [{ kind: "bash_bg", id: jobId }],
		});
		assert.match(observed.observations[0]?.error ?? "", /POSIX process group .* is still alive/);
		assert.equal(harness.snapshots.some((snapshot) => snapshot.jobs.some((job) => job.id === jobId && job.status === "killed")), false);

		process.kill = originalKill;
		processKillPatched = false;
		await delay(0);
		await harness.tool.execute("retry-live-kill", { action: "kill", jobId });
		await waitForStatus(harness.snapshots, jobId, "killed");
		assert.equal(isProcessGroupRunning(pid), false);
	} finally {
		if (processKillPatched) process.kill = originalKill;
		await harness.shutdown();
	}
});

test("bash_bg Windows taskkill has a source-enforced cleanup timeout and validates its result", () => {
	const source = fs.readFileSync(new URL("../src/tools/bash-bg.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/spawnSync\("taskkill"[\s\S]{0,500}timeout: WINDOWS_TASKKILL_TIMEOUT_MS[\s\S]{0,100}killSignal: "SIGKILL"/,
	);
	assert.match(source, /const taskkillOutcome = classifyWindowsTaskkill\(result, targetWasRunningBeforeCleanup\)/);
	assert.match(source, /job\.treeCleanupConfirmed = treeCleanupConfirmed/);
	assert.match(source, /treeCleanupConfirmed: job\.treeCleanupConfirmed/);
	assert.match(source, /Leader exited; Windows descendant cleanup is unconfirmed/);
	assert.match(source, /const terminationTargets = retiringJobs\.filter\(jobIsActive\);[\s\S]{0,200}Promise\.allSettled/);
});

test("bash_bg Windows taskkill termination behavior is bounded", { skip: process.platform !== "win32" }, async () => {
	const harness = createHarness();
	try {
		const started = await harness.tool.execute("bounded-taskkill", {
			action: "start",
			command: 'node -e "setInterval(()=>{},1000)"',
		});
		const jobId = started.details?.jobId;
		const pid = started.details?.pid;
		assert.ok(jobId);
		assert.ok(pid);
		const startedAt = Date.now();
		await harness.tool.execute("bounded-taskkill-stop", { action: "kill", jobId });
		assert.ok(Date.now() - startedAt < 8_000, "taskkill plus its final boundary check must remain bounded");
		await waitForStatus(harness.snapshots, jobId, "killed");
		assert.equal(isProcessRunning(pid), false);
	} finally {
		await harness.shutdown();
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
		await harness.shutdown();
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
		await harness.shutdown();
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
		await harness.shutdown();
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
		const shutdown = delay(25).then(() => harness.shutdown());
		const result = await waiting;
		await shutdown;
		assert.equal(result.reason, "all");
		assert.equal(result.observations[0]?.nativeStatus, "killed");
		assert.equal(result.observations[0]?.waitStatus, "failed");
	} finally {
		await harness.shutdown();
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
		await harness.shutdown();
	}
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOutput(
	snapshots: readonly BashBgSnapshotPayload[],
	jobId: string,
	pattern: RegExp,
): Promise<BashBgJobSnapshot> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		for (let index = snapshots.length - 1; index >= 0; index--) {
			const job = snapshots[index]?.jobs.find((entry) => entry.id === jobId && pattern.test(entry.outputTail));
			if (job) return job;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${jobId} output to match ${pattern}`);
}

function isProcessGroupRunning(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

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
