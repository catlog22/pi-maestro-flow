import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, existsSync, futimesSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DIAGNOSTIC_STATUS_KEY,
	DIAGNOSTIC_LOG_CONSTANTS,
	configureDiagnosticLogger,
	getDiagnosticLogger,
	resetDiagnosticLogger,
	todayLogFile,
	DEFAULT_DIAGNOSTIC_CONFIG,
	todayStamp,
	type DiagnosticLogConfig,
} from "../src/shared/diagnostic-log.ts";

// Each test gets a fresh logger pointed at a temp root so it never touches the
// developer's real ~/.pi/teammate/logs.
function withTempRoot(fn: (root: string) => Promise<void> | void): () => Promise<void> {
	return async () => {
		const root = mkdtempSync(join(tmpdir(), "teammate-diag-"));
		try {
			await fn(root);
		} finally {
			resetDiagnosticLogger();
		}
	};
}

function cfg(root: string, overrides: Partial<DiagnosticLogConfig> = {}): DiagnosticLogConfig {
	return { ...DEFAULT_DIAGNOSTIC_CONFIG, rootDir: root, ...overrides };
}

test("logError writes a line to the per-day log file", withTempRoot((root) => {
	const logger = configureDiagnosticLogger({ rootDir: root });
	logger.logError("[pi-maestro-teammate] monitor ledger append failed:", new Error("boom"));
	const file = todayLogFile(cfg(root));
	const content = readFileSync(file, "utf8");
	assert.match(content, /\[ERROR\].*monitor ledger append failed:.*boom/s);
}));

test("logWarn appends a WARN-level line and still creates the file", withTempRoot((root) => {
	const logger = configureDiagnosticLogger({ rootDir: root });
	logger.logWarn("[pi-maestro-teammate] completion replay bind failed:", new Error("x"));
	const file = todayLogFile(cfg(root));
	const content = readFileSync(file, "utf8");
	assert.match(content, /\[WARN\].*completion replay bind failed/s);
}));

test("summary tracks error/warn counts and last error message", withTempRoot((root) => {
	const logger = configureDiagnosticLogger({ rootDir: root });
	logger.logError("first error");
	logger.logError("second error", new Error("detail"));
	logger.logWarn("a warning");
	const summary = logger.getSummary();
	assert.equal(summary.errorCount, 2);
	assert.equal(summary.warnCount, 1);
	assert.equal(summary.unreadErrors, 2);
	assert.equal(summary.lastErrorMessage, "second error");
	assert.match(summary.lastErrorAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
}))

test("acknowledge resets unreadErrors but preserves totals and clears the status", withTempRoot((root) => {
	let lastStatus: string | undefined = "init";
	const logger = configureDiagnosticLogger({ rootDir: root });
	logger.setUiBridge({
		setStatus(text) { lastStatus = text; },
		notify() {},
	});
	logger.logError("err one");
	logger.logError("err two");
	assert.equal(logger.getSummary().unreadErrors, 2);
	assert.equal(lastStatus, `⚠2`);
	logger.acknowledge();
	assert.equal(logger.getSummary().unreadErrors, 0);
	assert.equal(lastStatus, undefined, "acknowledge clears the status badge");
	assert.equal(logger.getSummary().errorCount, 2, "totals preserved");
}))

test("notify fires once per unique error (deduped on consecutive identical messages)", withTempRoot((root) => {
	const notifications: string[] = [];
	const logger = configureDiagnosticLogger({ rootDir: root });
	logger.setUiBridge({
		setStatus() {},
		notify(message, type) { notifications.push(`${type}:${message}`); },
	});
	logger.logError("same error", new Error("x"));
	logger.logError("same error", new Error("x"));
	logger.logError("different error", new Error("y"));
	assert.equal(notifications.length, 2, "only two unique errors notify");
	assert.match(notifications[0] ?? "", /报错：same error/);
	assert.match(notifications[1] ?? "", /报错：different error/);
}))

test("rotate: a file exceeding maxFileBytes is renamed to *.1", withTempRoot((root) => {
	const logger = configureDiagnosticLogger({ rootDir: root, maxFileBytes: 200, maxRotatedFiles: 1 });
	const file = todayLogFile(cfg(root, { maxFileBytes: 200, maxRotatedFiles: 1 }));
	logger.logError("padding ".repeat(40));
	// First write under threshold; second pushes total past 200.
	logger.logError("padding ".repeat(40));
	assert.ok(existsSync(`${file}.1`), "rotated copy exists");
	// Current file holds only the second write (fresh after rotation).
	const current = readFileSync(file, "utf8");
	assert.match(current, /\[ERROR\]/);
	assert.ok(Buffer.byteLength(current) < 500, "current file holds only the fresh second write");
}))

test("prune: log files older than retentionDays are removed", withTempRoot((root) => {
	const dir = join(root, DIAGNOSTIC_LOG_CONSTANTS.LOG_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	// Manually create an old log file.
	const oldStamp = todayStamp(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
	const oldFile = join(dir, `${DIAGNOSTIC_LOG_CONSTANTS.LOG_FILE_PREFIX}${oldStamp}${DIAGNOSTIC_LOG_CONSTANTS.LOG_FILE_SUFFIX}`);
	writeFileSync(oldFile, "old\n");
	// Set mtime to 30 days ago explicitly.
	const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const fd = openSync(oldFile, "r+");
	futimesSync(fd, oldTime, oldTime);
	closeSync(fd);
	const logger = configureDiagnosticLogger({ rootDir: root, retentionDays: 7 });
	logger.logError("trigger prune");
	assert.ok(!existsSync(oldFile), "old log pruned");
}))

test("getDiagnosticLogger returns a process singleton", () => {
	const a = getDiagnosticLogger();
	const b = getDiagnosticLogger();
	assert.equal(a, b);
})

test("logDiagnosticError/logDiagnosticWarn convenience helpers write through the singleton", withTempRoot(async (root) => {
	configureDiagnosticLogger({ rootDir: root });
	const { logDiagnosticError } = await import("../src/shared/diagnostic-log.ts");
	logDiagnosticError("via convenience helper", new Error("k"));
	const file = todayLogFile(cfg(root));
	const content = readFileSync(file, "utf8");
	assert.match(content, /via convenience helper.*k/s);
}))
