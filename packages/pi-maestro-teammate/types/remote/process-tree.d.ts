import { type ChildProcessWithoutNullStreams } from "node:child_process";
/**
 * Kill a child process and, where the platform supports it, its entire process
 * tree. On Windows this uses `taskkill /T` so grandchildren are not orphaned
 * when the direct child is signalled; on POSIX the process group is signalled.
 * The helper is synchronous so it can run inside process event handlers.
 */
export declare function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void;
