/**
 * Ref-counted process-level terminal cleanup owner.
 *
 * The fullscreen controller restores the normal screen on its own dispose, but
 * a crash while the alternate screen is active would strand the terminal (blank
 * alt screen, mouse modes left on). pi already restores the terminal on
 * SIGTERM/SIGHUP and uncaught exceptions, and `process.exit()` emits `exit`, so
 * the remaining gaps this module covers are the `exit` event itself and an
 * external SIGINT. Exactly one owner registers the handlers; they are removed
 * when the last consumer unregisters, so the process never accumulates
 * listeners across extension reloads or multiple sessions.
 */

type WriteFn = (sequence: string) => void;

/** Best-effort restore: leave the alternate screen and drop mouse modes. */
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l\x1b[?1002l\x1b[?1006l";

const writers = new Set<WriteFn>();
let handlersInstalled = false;

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
}

function handleSigint(): void {
	flush();
	// Re-raise with the default action so Ctrl+C still terminates the process.
	process.removeListener("SIGINT", handleSigint);
	process.kill(process.pid, "SIGINT");
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
