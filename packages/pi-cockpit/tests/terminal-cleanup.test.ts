import assert from "node:assert/strict";
import test from "node:test";
import {
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
