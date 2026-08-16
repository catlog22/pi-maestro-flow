/**
 * Sanitize a child process environment so sensitive credential variables never
 * leak into remote bridge child processes. Keeps the platform-neutral vars the
 * runtime may need but drops anything that looks like an API key, token, or
 * credential, and only includes vars the caller explicitly opts in to when an
 * allowlist is provided.
 */

const SECRET_NAME_PATTERN = /(^|[^A-Z0-9_])?(API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|TOKEN|CREDENTIAL|AUTH|BEARER)(?:[_-]?ID)?([^A-Z0-9_]|$)/i;

/** Whether an environment variable name looks like it carries a secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Build a sanitized child environment.
 * - When `allow` is provided, only those named variables are copied (still
 *   filtered for secrets).
 * - Otherwise the full environment is copied with any secret-looking variable
 *   removed.
 */
export function sanitizeChildEnv(
  source: NodeJS.ProcessEnv,
  allow?: readonly string[],
): NodeJS.ProcessEnv {
  const allowSet = allow ? new Set(allow) : undefined;
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (allowSet !== undefined && !allowSet.has(name)) continue;
    if (isSecretEnvName(name)) continue;
    result[name] = value;
  }
  return result;
}
