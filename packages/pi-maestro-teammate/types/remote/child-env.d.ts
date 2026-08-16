/**
 * Sanitize a child process environment so sensitive credential variables never
 * leak into remote bridge child processes. Keeps the platform-neutral vars the
 * runtime may need but drops anything that looks like an API key, token, or
 * credential, and only includes vars the caller explicitly opts in to when an
 * allowlist is provided.
 */
/** Whether an environment variable name looks like it carries a secret. */
export declare function isSecretEnvName(name: string): boolean;
/**
 * Build a sanitized child environment.
 * - When `allow` is provided, only those named variables are copied (still
 *   filtered for secrets).
 * - Otherwise the full environment is copied with any secret-looking variable
 *   removed.
 */
export declare function sanitizeChildEnv(source: NodeJS.ProcessEnv, allow?: readonly string[]): NodeJS.ProcessEnv;
