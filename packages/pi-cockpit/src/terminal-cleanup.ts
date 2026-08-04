/**
 * Ref-counted process-level terminal cleanup owner.
 *
 * Guarantees the alternate screen, mouse modes, bracketed paste, cursor and raw
 * mode are restored on BOTH graceful and forced (catchable) exit — pi's own
 * terminal restore only runs on its graceful shutdown, so a SIGINT (or any exit
 * where pi's stop() is skipped) would otherwise leave the terminal in raw mode,
 * making arrow keys / combos echo as literal characters.
 *
 * Exactly one owner registers the handlers; they are removed when the last
 * consumer unregisters. SIGKILL / power loss cannot run any code — the documented
 * recovery for that physical case is `reset` / `stty sane`.
 */

type WriteFn = (sequence: string) => void;

/** Best-effort restore: leave the alternate screen, drop mouse modes, disable
 * bracketed paste, show the cursor, and reset styles. */
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m";

const writers = new Set<WriteFn>();
let handlersInstalled = false;

/** Restore raw mode (cooked) only if it is currently raw — idempotent and safe
 * when pi already restored it on its graceful path. */
function restoreRawMode(): void {
	try {
		const stdin = process.stdin;
		if (stdin && (stdin as { isRaw?: boolean }).isRaw) {
			(stdin as { setRawMode(mode: boolean): unknown }).setRawMode(false);
		}
	} catch {
		// Best effort: the stream may already be closed.
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

function install(): void {
	if (handlersInstalled) return;
	handlersInstalled = true;
	process.on("exit", flush);
	process.on("SIGINT", handleSigint);
}

function uninstall(): void {
	if (!handlersInstalled) return;
	handlersInstalled = false;
	process.removeListener("exit", flush);
	process.removeListener("SIGINT", handleSigint);
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
