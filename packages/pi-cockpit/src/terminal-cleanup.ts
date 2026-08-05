/**
 * Ref-counted process-level terminal cleanup owner.
 *
 * Guarantees the terminal is fully restored on BOTH graceful and forced
 * (catchable) exit — pi's own restore only runs on its graceful shutdown, so a
 * SIGINT (or any exit where pi's stop() is skipped) would otherwise leave the
 * TTY in raw mode / with keyboard protocols on, making arrow keys and combos
 * echo as literal characters. The restore sequence is deliberately broad (alt
 * screen, all mouse modes, bracketed paste, DECCKM, kitty protocol, cursor,
 * style reset) so it also covers modes a terminal may have kept from pi or the
 * host; unknown modes are ignored by terminals.
 *
 * Exactly one owner registers the handlers; they are removed when the last
 * consumer unregisters. SIGKILL / power loss cannot run any code — the
 * documented recovery for that physical case is `reset` / `stty sane`.
 */

type WriteFn = (sequence: string) => void;

import { execSync } from "node:child_process";

/** Broad, idempotent restore: leave alt screen, drop every mouse mode, disable
 * bracketed paste, DECCKM and the kitty keyboard protocol, show the cursor,
 * and reset styles. Unknown modes are ignored by terminals. */
export const TERMINAL_RESTORE_SEQUENCE =
	"\x1b[?1049l\x1b[?1l" +
	"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" +
	"\x1b[?2004l" +
	"\x1b[?2027l\x1b[?2028l\x1b[?2029l\x1b[<u\x1b[?2031l" +
	"\x1b[?25h\x1b[0m";

const writers = new Set<WriteFn>();
let handlersInstalled = false;

/** Restore raw mode to cooked, unconditionally. Primary path is Node's stream
 * API; `stty sane` is a best-effort fallback for platforms where the console
 * state is not fully reflected by setRawMode (e.g. Windows). */
function restoreRawMode(): void {
	try {
		process.stdin.setRawMode(false);
		return;
	} catch {
		// fall through to stty
	}
	try {
		execSync("stty sane", { stdio: "ignore", timeout: 1000 });
	} catch {
		// Best effort: no stty on this platform.
	}
}

function flush(): void {
	// Writing then clearing makes this naturally idempotent: a second signal in
	// the same shutdown has nothing left to write, and a later registration
	// (writers 0 -> 1) reinstalls the handlers.
	for (const write of [...writers]) {
		try {
			write(TERMINAL_RESTORE_SEQUENCE);
		} catch {
			// Best effort: the terminal may already be gone.
		}
	}
	writers.clear();
	restoreRawMode();
}

function handleSigint(): void {
	flush();
	// Terminate definitively: on a forced exit pi's graceful shutdown (which also
	// restores the terminal) is skipped, so we restore above and then exit. Do not
	// re-raise SIGINT — it may be swallowed (e.g. while suspended) and would not
	// run our restore again anyway.
	process.exit(1);
}

// SIGTERM/SIGHUP are handled gracefully by pi (session_shutdown -> our dispose), so
// we only flush as a safety net and never terminate — pi owns the exit there.
function handleTerminateSignal(): void {
	flush();
}

function install(): void {
	if (handlersInstalled) return;
	handlersInstalled = true;
	process.on("exit", flush);
	process.on("SIGINT", handleSigint);
	process.on("SIGTERM", handleTerminateSignal);
	process.on("SIGHUP", handleTerminateSignal);
}

function uninstall(): void {
	if (!handlersInstalled) return;
	handlersInstalled = false;
	process.removeListener("exit", flush);
	process.removeListener("SIGINT", handleSigint);
	process.removeListener("SIGTERM", handleTerminateSignal);
	process.removeListener("SIGHUP", handleTerminateSignal);
}

/**
 * Register a terminal whose alternate-screen state must be restored on process
 * exit or external SIGINT. Returns an idempotent disposer; the process handlers
 * are installed on first use and removed once the last consumer unregisters.
 */
export function registerTerminalCleanup(write: WriteFn): () => void {
	writers.add(write);
	if (writers.size === 1) install();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		writers.delete(write);
		if (writers.size === 0) uninstall();
	};
}

/** True when the process-level restore handlers are currently installed. */
export function isTerminalCleanupInstalled(): boolean {
	return handlersInstalled;
}
