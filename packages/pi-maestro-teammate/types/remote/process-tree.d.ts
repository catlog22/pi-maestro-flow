import type { ChildProcessWithoutNullStreams } from "node:child_process";
/**
 * Kill a child process and, where the platform supports it, its entire process
 * tree. On Windows this delegates to the canonical bounded `taskkill /T`
 * implementation; on POSIX the captured process group is signalled.
 * The helper remains synchronous so it can run inside process event handlers.
 */
export declare function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void;
