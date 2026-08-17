/**
 * The one child-process environment model, shared by both dispatch chains: the
 * dsh runtime subprocess and the remote bridge's ACP / Pi-RPC children.
 *
 * Three gates apply to every child: a secret gate on names that look like they
 * carry a credential, a launch-policy gate on names that decide what code the
 * child loads, and a NUL gate on names and values.
 *
 * The secret gate disposes of its two inputs differently — a hit in `source` is
 * dropped, a hit in `additions` throws — because the inputs mean different
 * things. `source` is a whole-environment sweep of the host process, which holds
 * credentials for every provider and service it talks to, so a hit there is
 * expected and dropping it is the point. `additions` is the caller's explicit
 * statement of what this child must see, so a hit there is either a mistake
 * worth naming or a deliberate hand-over the caller declares with
 * `allowSecretAdditions`.
 */

const DEFAULT_ENV_ALLOWLIST = new Set([
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
]);

/** Names that decide what the child loads, so no caller may set them. */
export const IMMUTABLE_ENV_NAMES = new Set([
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PYTHONHOME",
  "PYTHONPATH",
  "SYSTEMROOT",
]);

/** Names shaped like a credential, by convention rather than by value. */
export const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_?ID)?|ACCESS_?TOKEN|AUTH|BEARER|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

export interface SanitizedChildEnvironmentOptions {
  source?: NodeJS.ProcessEnv;
  allow?: readonly string[];
  additions?: Readonly<Record<string, string | undefined>>;
  /**
   * Permit secret-bearing names (e.g. CODEX_API_KEY) in `additions`.
   * Only for values sourced from an explicitly trusted target configuration;
   * launch-policy variables stay rejected regardless.
   */
  allowSecretAdditions?: boolean;
}

/**
 * Build the child environment for a trusted target's CLI: the standard
 * allowlist plus the target-declared `env` names forwarded from the daemon
 * process environment (explicit opt-in; secret names allowed here because the
 * declaration itself lives in the trusted, private remote config).
 *
 * @param envNames - names read out of this process's environment and forwarded.
 * @param additions - variables the caller hands over by value.
 * @param allow - the base allowlist applied to this process's environment.
 * Omitting it keeps the remote bridge's own default list; a caller that passes
 * one owns its child's baseline environment outright.
 * @returns the variables the child is given, and nothing else.
 */
export function targetChildEnvironment(
  envNames: readonly string[] | undefined,
  additions?: Readonly<Record<string, string | undefined>>,
  allow?: readonly string[],
): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = {};
  for (const name of envNames ?? []) {
    const value = process.env[name];
    if (value !== undefined) merged[name] = value;
  }
  if (additions) Object.assign(merged, additions);
  return sanitizedChildEnvironment({
    additions: merged,
    allowSecretAdditions: true,
    ...(allow === undefined ? {} : { allow }),
  });
}

/**
 * Build a minimal child environment without allowing launch policy overrides.
 *
 * @param options - the source environment, its allowlist, and the additions.
 * @returns the variables the child is given, and nothing else.
 */
export function sanitizedChildEnvironment(
  options: SanitizedChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const allow = new Set(options.allow ?? DEFAULT_ENV_ALLOWLIST);
  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !allow.has(name) || SECRET_ENV_NAME.test(name)) continue;
    result[name] = value;
  }

  for (const [name, value] of Object.entries(options.additions ?? {})) {
    if (value === undefined) continue;
    if (!options.allowSecretAdditions && SECRET_ENV_NAME.test(name)) {
      throw new Error(`Child environment variable ${name} is secret-bearing`);
    }
    if (IMMUTABLE_ENV_NAMES.has(name.toUpperCase())) {
      throw new Error(`Child environment variable ${name} cannot replace launch policy`);
    }
    if (name.includes("\0") || value.includes("\0")) {
      throw new Error("Child environment variables cannot contain NUL bytes");
    }
    result[name] = value;
  }

  return result;
}
