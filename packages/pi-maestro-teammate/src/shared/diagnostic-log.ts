/**
 * Centralized diagnostic logger for pi-maestro-teammate.
 *
 * Replaces scattered `console.error`/`console.warn` calls with a single
 * sink that:
 *   1. Appends the message to a per-day log file under
 *      `<rootDir>/logs/error-YYYY-MM-DD.log` (default root: `~/.pi/teammate`).
 *   2. Rotates by day and by size (a file exceeding `maxFileBytes` is renamed
 *      to `*.1` and a fresh file is started; at most `maxRotatedFiles` rotated
 *      copies are kept).
 *   3. Prunes log files older than `retentionDays`.
 *   4. Tracks an in-memory summary (count + last message) so the extension's
 *      status bar segment can surface a badge without re-reading the file.
 *   5. Optionally fires a one-shot UI notify/toast when a new error arrives,
 *      and exposes the status key the footer reads.
 *
 * The module is process-singleton: one logger instance per Pi process.
 * Writes are synchronous (`appendFileSync`) so diagnostics survive a crash
 * that follows immediately after — matching the reliability expectation of
 * an error reporter. All file I/O is best-effort: a write failure must never
 * throw back into the caller's error-handling path.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DIAGNOSTIC_STATUS_KEY = "pi-teammate-diagnostic";

const DEFAULT_ROOT_DIR = join(homedir(), ".pi", "teammate");
const LOG_DIR_NAME = "logs";
const LOG_FILE_PREFIX = "error-";
const LOG_FILE_SUFFIX = ".log";
const ROTATED_SUFFIX = ".1";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_ROTATED_FILES = 1;
const DEFAULT_RETENTION_DAYS = 7;

const SUMMARY_TRUNCATE_CHARS = 160;

export type DiagnosticLevel = "error" | "warn";

export interface DiagnosticLogConfig {
	/** Root directory holding the `logs/` folder. Defaults to `~/.pi/teammate`. */
	rootDir: string;
	/** Max bytes before a log file is rotated. */
	maxFileBytes: number;
	/** Number of rotated `*.1` copies to keep per day. */
	maxRotatedFiles: number;
	/** Days of log files to retain; older files are pruned. */
	retentionDays: number;
}

export const DEFAULT_DIAGNOSTIC_CONFIG: DiagnosticLogConfig = {
	rootDir: DEFAULT_ROOT_DIR,
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	maxRotatedFiles: DEFAULT_MAX_ROTATED_FILES,
	retentionDays: DEFAULT_RETENTION_DAYS,
};

// ---------------------------------------------------------------------------
// UI bridge — injected by the extension entry point
// ---------------------------------------------------------------------------

export interface DiagnosticUiBridge {
	/** Set the status-bar segment text; pass undefined to clear. */
	setStatus(text: string | undefined): void;
	/** Fire a one-shot toast. */
	notify(message: string, type: "info" | "warning" | "error"): void;
}

// ---------------------------------------------------------------------------
// In-memory summary (read by the status-bar segment writer)
// ---------------------------------------------------------------------------

export interface DiagnosticSummary {
	/** Total errors logged since the process started (monotonic). */
	errorCount: number;
	/** Total warnings logged since the process started (monotonic). */
	warnCount: number;
	/** Unread error count — reset by `acknowledge()`. */
	unreadErrors: number;
	/** Truncated last error message (first line), or undefined when none. */
	lastErrorMessage: string | undefined;
	/** ISO timestamp of the last error, or undefined when none. */
	lastErrorAt: string | undefined;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface DiagnosticLogger {
	logError(message: string, error?: unknown): void;
	logWarn(message: string, error?: unknown): void;
	/** Get a snapshot of the current in-memory summary. */
	getSummary(): Readonly<DiagnosticSummary>;
	/** Mark all currently-unread errors as acknowledged (resets the badge). */
	acknowledge(): void;
	/** Inject the UI bridge; without it, logging still writes files. */
	setUiBridge(bridge: DiagnosticUiBridge | undefined): void;
	/** Reconfigure (mainly for tests with a temp rootDir). */
	configure(config: Partial<DiagnosticLogConfig>): void;
}

function todayStamp(d: Date = new Date()): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function todayLogFile(config: DiagnosticLogConfig): string {
	return join(config.rootDir, LOG_DIR_NAME, `${LOG_FILE_PREFIX}${todayStamp()}${LOG_FILE_SUFFIX}`);
}

function extractFirstLine(value: string): string {
	const idx = value.indexOf("\n");
	const line = idx === -1 ? value : value.slice(0, idx);
	return line.length > SUMMARY_TRUNCATE_CHARS ? `${line.slice(0, SUMMARY_TRUNCATE_CHARS)}…` : line;
}

function formatErrorDetail(error: unknown): string {
	if (error === undefined || error === null) return "";
	if (error instanceof Error) {
		const stack = error.stack?.trim();
		return stack ? `${error.message}\n${stack}` : String(error.message ?? error);
	}
	if (typeof error === "object") {
		try { return JSON.stringify(error); } catch { return String(error); }
	}
	return String(error);
}

function buildLogLine(level: DiagnosticLevel, message: string, error?: unknown): string {
	const ts = new Date().toISOString();
	const detail = formatErrorDetail(error);
	const body = detail ? `${message} ${detail}` : message;
	return `${ts} [${level.toUpperCase()}] ${body}\n`;
}

class DiagnosticLoggerImpl implements DiagnosticLogger {
	private config: DiagnosticLogConfig = { ...DEFAULT_DIAGNOSTIC_CONFIG };
	private summary: DiagnosticSummary = {
		errorCount: 0,
		warnCount: 0,
		unreadErrors: 0,
		lastErrorMessage: undefined,
		lastErrorAt: undefined,
	};
	private ui: DiagnosticUiBridge | undefined;
	private lastNotifyKey = "";
	private prunedToday = "";

	constructor(config?: Partial<DiagnosticLogConfig>) {
		if (config) this.config = { ...this.config, ...config };
	}

	logError(message: string, error?: unknown): void {
		this.write("error", message, error);
	}

	logWarn(message: string, error?: unknown): void {
		this.write("warn", message, error);
	}

	getSummary(): Readonly<DiagnosticSummary> {
		return { ...this.summary };
	}

	acknowledge(): void {
		this.summary.unreadErrors = 0;
		this.refreshStatus();
	}

	setUiBridge(bridge: DiagnosticUiBridge | undefined): void {
		this.ui = bridge;
		this.refreshStatus();
	}

	configure(config: Partial<DiagnosticLogConfig>): void {
		this.config = { ...this.config, ...config };
	}

	private write(level: DiagnosticLevel, message: string, error: unknown): void {
		const line = buildLogLine(level, message, error);
		this.writeFile(level, line);
		this.updateSummary(level, message, error);
	}

	private writeFile(level: DiagnosticLevel, line: string): void {
		const cfg = this.config;
		try {
			mkdirSync(join(cfg.rootDir, LOG_DIR_NAME), { recursive: true });
			const file = todayLogFile(cfg);
			if (existsSync(file)) {
				try {
					if (statSync(file).size >= cfg.maxFileBytes) this.rotate(file);
				} catch {
					// stat failed — proceed to append best-effort.
				}
			}
			appendFileSync(file, line, "utf8");
			this.maybePrune();
		} catch {
			// Logging must never throw into the caller's error path.
		}
		// Mirror warnings/errors to stderr so CLI/child-mode runs still emit a
		// visible diagnostic when a log file is unwritable. Errors via
		// console.error, warns via console.warn — kept here, at the sink, so
		// the 67 call sites stay single-purpose.
		if (level === "error") {
			// eslint-disable-next-line no-console
			console.error(line.trimEnd());
		} else {
			// eslint-disable-next-line no-console
			console.warn(line.trimEnd());
		}
	}

	private rotate(filePath: string): void {
		const cfg = this.config;
		try {
			// Keep only one rotated copy per day (maxRotatedFiles default 1).
			const rotated = `${filePath}${ROTATED_SUFFIX}`;
			if (cfg.maxRotatedFiles <= 0) {
				if (existsSync(rotated)) unlinkSync(rotated);
			}
			if (existsSync(rotated)) unlinkSync(rotated);
			renameSync(filePath, rotated);
		} catch {
			// Rotation is best-effort; appending to the oversized file is acceptable.
		}
	}

	private maybePrune(): void {
		const cfg = this.config;
		const stamp = todayStamp();
		if (this.prunedToday === stamp) return; // prune once per day.
		this.prunedToday = stamp;
		try {
			const dir = join(cfg.rootDir, LOG_DIR_NAME);
			if (!existsSync(dir)) return;
			const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
			for (const name of readdirSync(dir)) {
				if (!name.startsWith(LOG_FILE_PREFIX) || !name.endsWith(LOG_FILE_SUFFIX)) continue;
				let mtime: number;
				try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
				if (mtime < cutoff) {
					try { unlinkSync(join(dir, name)); } catch { /* best-effort */ }
				}
			}
		} catch {
			// Pruning is best-effort.
		}
	}

	private updateSummary(level: DiagnosticLevel, message: string, error: unknown): void {
		if (level === "error") {
			this.summary.errorCount += 1;
			this.summary.unreadErrors += 1;
			const firstLine = extractFirstLine(message);
			this.summary.lastErrorMessage = firstLine || this.summary.lastErrorMessage;
			this.summary.lastErrorAt = new Date().toISOString();
			this.notifyIfNew();
		} else {
			this.summary.warnCount += 1;
		}
		this.refreshStatus();
	}

	private notifyIfNew(): void {
		const ui = this.ui;
		if (!ui) return;
		const key = this.summary.lastErrorMessage ?? "";
		if (key === this.lastNotifyKey) return; // dedup identical consecutive errors.
		this.lastNotifyKey = key;
		try {
			ui.notify(`pi-maestro-teammate 报错：${this.summary.lastErrorMessage ?? "未知错误"}（详见 logs）`, "error");
		} catch {
			// Notification is cosmetic — never break the log path.
		}
	}

	private refreshStatus(): void {
		const ui = this.ui;
		if (!ui) return;
		try {
			if (this.summary.unreadErrors > 0) {
				ui.setStatus(`⚠${this.summary.unreadErrors}`);
			} else {
				ui.setStatus(undefined);
			}
		} catch {
			// Status bar is cosmetic.
		}
	}
}

// ---------------------------------------------------------------------------
// Process-singleton accessor
// ---------------------------------------------------------------------------

let singleton: DiagnosticLogger | undefined;

/**
 * Get the process-wide diagnostic logger. The first call lazily initializes it
 * with the default config; tests may call `configureDiagnosticLogger` to point
 * it at a temp directory before exercising it.
 */
export function getDiagnosticLogger(): DiagnosticLogger {
	if (!singleton) singleton = new DiagnosticLoggerImpl();
	return singleton;
}

/**
 * Configure (or reset) the process singleton. Intended for tests that need a
 * temp `rootDir` and deterministic size/retention thresholds.
 */
export function configureDiagnosticLogger(config: Partial<DiagnosticLogConfig>): DiagnosticLogger {
	const logger = getDiagnosticLogger();
	logger.configure(config);
	return logger;
}

/**
 * Reset the singleton to a fresh instance (tests only). Swaps out the in-memory
 * summary so tests start clean.
 */
export function resetDiagnosticLogger(config?: Partial<DiagnosticLogConfig>): DiagnosticLogger {
	singleton = new DiagnosticLoggerImpl(config);
	return singleton;
}

/**
 * Convenience entry points so call sites can write
 * `logDiagnosticError("…", err)` without holding a logger reference.
 */
export function logDiagnosticError(message: string, error?: unknown): void {
	getDiagnosticLogger().logError(message, error);
}

export function logDiagnosticWarn(message: string, error?: unknown): void {
	getDiagnosticLogger().logWarn(message, error);
}

export { todayStamp, todayLogFile, buildLogLine, extractFirstLine };
export const DIAGNOSTIC_LOG_CONSTANTS = {
	LOG_DIR_NAME,
	LOG_FILE_PREFIX,
	LOG_FILE_SUFFIX,
	ROTATED_SUFFIX,
};
