/**
 * Tool-call argument previews for progress telemetry.
 *
 * The child emits `tool_execution_start` with the raw arguments; only a small,
 * redacted one-line summary should ever leave the child process. Key names that
 * look like secrets are replaced wholesale, value patterns for common bearer
 * credentials are scrubbed, nesting and list lengths are bounded, and the final
 * string is truncated as UTF-8.
 */
/**
 * Build a one-line, redacted summary of tool arguments for progress display.
 * Returns undefined when nothing informative survives, so callers can omit the
 * field entirely instead of emitting an empty preview.
 */
export declare function previewToolCallArgs(args: unknown, toolName?: string): string | undefined;
