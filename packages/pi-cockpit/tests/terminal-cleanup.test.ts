import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
	ensureProcessTerminalCleanup,
	isTerminalCleanupInstalled,
	registerTerminalCleanup,
	TERMINAL_RESTORE_SEQUENCE,
} from "../src/terminal-cleanup.ts";

test("restore sequence leaves alternate screen, drops modes, and shows the cursor", () => {
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?1049l"), "leaves alternate screen");
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?1002l"), "drops button mouse mode");
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?1006l"), "drops SGR mouse mode");
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?2004l"), "drops bracketed paste");
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?25h"), "shows the cursor");
	assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[0m"), "resets styles");
});

test("handlers install on first registration and uninstall when the last consumer releases", () => {
	assert.equal(isTerminalCleanupInstalled(), false);
	const a = registerTerminalCleanup(() => {});
	assert.equal(isTerminalCleanupInstalled(), true);
	const b = registerTerminalCleanup(() => {});
	assert.equal(isTerminalCleanupInstalled(), true, "ref-counted across consumers");
	a();
	assert.equal(isTerminalCleanupInstalled(), true, "still installed while one consumer remains");
	b();
	assert.equal(isTerminalCleanupInstalled(), false, "uninstalled once the last consumer releases");
});

test("disposer is idempotent and never double-uninstalls", () => {
	const release = registerTerminalCleanup(() => {});
	release();
	release();
	assert.equal(isTerminalCleanupInstalled(), false);
});

test("exit flush writes the restore sequence to every registered writer exactly once", () => {
	const writes: string[][] = [];
	const releaseA = registerTerminalCleanup((seq) => writes.push([seq]));
	const releaseB = registerTerminalCleanup((seq) => writes.push([seq]));
	process.emit("exit", 0);
	assert.equal(writes.length, 2, "both writers flushed");
	for (const [sequence] of writes) assert.equal(sequence, TERMINAL_RESTORE_SEQUENCE);
	// flush cleared the writers; releasing is now a no-op.
	releaseA();
	releaseB();
	assert.equal(isTerminalCleanupInstalled(), false);
});

test("a new registration after a flush reinstalls handlers and flushes again", () => {
	process.emit("exit", 0); // flush any pre-existing registration
	const writes: string[] = [];
	const release = registerTerminalCleanup((seq) => writes.push(seq));
	assert.equal(isTerminalCleanupInstalled(), true);
	process.emit("exit", 0);
	assert.deepEqual(writes, [TERMINAL_RESTORE_SEQUENCE]);
	release();
});

test("SIGINT listener is added on install and removed on uninstall", () => {
	const before = process.listeners("SIGINT").length;
	const release = registerTerminalCleanup(() => {});
	assert.equal(process.listeners("SIGINT").length, before + 1, "SIGINT handler registered");
	release();
	assert.equal(process.listeners("SIGINT").length, before, "SIGINT handler removed");
});

test("process fallback is bounded and survives the final consumer release", (t) => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let restores = 0;
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		if (chunk === TERMINAL_RESTORE_SEQUENCE) { restores++; return true; }
		return originalWrite(chunk);
	});
	for (let i = 0; i < 1000; i++) ensureProcessTerminalCleanup();
	const release = registerTerminalCleanup(() => assert.fail("released consumer must not be flushed"));
	release();
	assert.equal(isTerminalCleanupInstalled(), true, "singleton exit safety net remains");
	process.emit("exit", 0);
	assert.equal(restores, 1);
	process.emit("exit", 0);
	assert.equal(restores, 1);
	// Release an ordinary lease after flush to remove handlers for other tests.
	registerTerminalCleanup(() => {})();
});

test("graceful exit and catchable signal paths retain broad restore and raw-mode fallback", () => {
	const moduleUrl = new URL("../src/terminal-cleanup.ts", import.meta.url).href;
	for (const signal of ["exit", "SIGTERM", "SIGINT"]) {
		const script = `
			import { ensureProcessTerminalCleanup, registerTerminalCleanup } from ${JSON.stringify(moduleUrl)};
			process.stdin.setRawMode = (mode) => { process.stdout.write('raw:' + mode); return process.stdin; };
			for (let i = 0; i < 5; i++) ensureProcessTerminalCleanup();
			registerTerminalCleanup(() => { throw new Error('consumer failure'); });
			registerTerminalCleanup(() => {})();
			${signal === "exit" ? "process.exit(0);" : `process.emit(${JSON.stringify(signal)});`}
		`;
		const result = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.error, undefined, `${signal}: ${result.error?.message}`);
		assert.equal(result.status, signal === "SIGINT" ? 1 : 0, `${signal}: ${result.stderr}`);
		assert.equal(result.stdout.split(TERMINAL_RESTORE_SEQUENCE).length - 1, 1, `${signal}: one broad restore`);
		assert.ok(result.stdout.includes("raw:false"), `${signal}: cooked mode restored`);
	}
});
