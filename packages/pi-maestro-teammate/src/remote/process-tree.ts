import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";

/**
 * Kill a child process and, where the platform supports it, its entire process
 * tree. On Windows this uses `taskkill /T` so grandchildren are not orphaned
 * when the direct child is signalled; on POSIX the process group is signalled.
 * The helper is synchronous so it can run inside process event handlers.
 */
export function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const command = process.env.SystemRoot
        ? `${process.env.SystemRoot}\System32\taskkill.exe`
        : "taskkill.exe";
      if (fs.existsSync(command)) {
        spawn(command, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      } else {
        child.kill(signal);
      }
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
