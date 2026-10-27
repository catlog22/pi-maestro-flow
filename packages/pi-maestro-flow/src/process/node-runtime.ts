/**
 * Resolve the runtime used to start a child process *by script path*
 * (`fork({ execPath })`, `spawn(execPath, [script])`).
 *
 * `process.execPath` is only such a runtime when Pi itself runs on Node or Bun.
 * Bundled single-file builds put the application there instead — Pi-Bolt ships
 * `pi-bin`, a Pi binary — so the script path is handed to the application as an
 * argv, and Pi starts another agent session rather than the script. Each retry
 * then adds one more agent process, and that session repeats the same launch.
 */
const JS_RUNTIME_NAMES = new Set(["node", "node.exe", "nodejs", "nodejs.exe", "bun", "bun.exe"]);

/** True when the executable is itself a JavaScript runtime rather than an application bundle. */
export function isJavaScriptRuntime(executable: string): boolean {
  const name = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return JS_RUNTIME_NAMES.has(name);
}

/**
 * Executable that can run a plain `.js`/`.mjs` script.
 *
 * Reuses `process.execPath` whenever it is a real runtime, so existing Node and
 * Bun deployments keep their exact behavior, and otherwise falls back to `node`
 * on `PATH`. A missing `node` then fails as an ordinary spawn error instead of
 * silently launching a second agent session.
 */
export function resolveJavaScriptRuntime(execPath: string = process.execPath): string {
  if (isJavaScriptRuntime(execPath)) return execPath;
  return process.platform === "win32" ? "node.exe" : "node";
}
