/**
 * Secret hygiene for the pi-teammate-models CLI (D13).
 *
 * The CLI reads and rewrites registry documents that can sit next to
 * credential *references*, and its edit flow prints prompts, defaults, and
 * external-change diffs. None of that output may ever carry a secret value:
 * a credential-ref field stores a variable NAME (the value lives in the
 * runtime's own env file and never enters this process), and any value that
 * nevertheless looks like a credential is masked before it reaches stdout.
 *
 * Redaction here is deliberately conservative: a false positive masks an
 * operator's own string for one line, while a false negative prints a live
 * credential into a terminal scrollback or a CI log. The heuristics below
 * therefore flag known token shapes plus long mixed-class tokens, and every
 * free-form output path (diff summaries, warnings) passes through
 * `redactText` as a final gate.
 */

/** Token shapes with well-known provider prefixes. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\brsk?_[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+\S{10,}/gi,
];

const MIN_TOKEN_LENGTH = 16;

/**
 * Report whether a string looks like a secret value rather than a name.
 *
 * Names (deployment ids, env variable names, model ids) are upper- or
 * lower-case-with-separators and never flagged. Values produced by key
 * generators mix character classes at random, which is what the structural
 * checks look for.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < MIN_TOKEN_LENGTH) return false;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  // Long uninterrupted hex (digests, half of all raw API keys).
  if (/^[0-9a-fA-F]{32,}$/.test(value)) return true;
  // Base64-shaped or otherwise unsegmented token mixing cases and digits.
  if (value.length >= 20 && !/\s/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) {
    return true;
  }
  return false;
}

/**
 * Mask one value completely: the byte length survives (useful for diffing),
 * the content does not.
 */
export function redactValue(value: string): string {
  return `[redacted ${Buffer.byteLength(value, "utf8")}B]`;
}

/**
 * Mask every secret-looking token in free-form output.
 *
 * Applied to external-change diff summaries and any other text that embeds
 * document content, so an operator's pasted secret cannot leak through a
 * path that was only supposed to show structure.
 */
export function redactText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => redactValue(match));
  }
  result = result.replace(/\S+/g, (token) => (looksLikeSecret(token) ? redactValue(token) : token));
  return result;
}

/**
 * Validate a credential-ref input as a variable NAME only.
 *
 * A credential-ref field never holds the secret: it names the env variable or
 * env-file key the runtime resolves for itself. Anything that is not a valid
 * name is rejected — and when the rejected input looks like a secret value,
 * the message says so explicitly, because the most likely cause is an operator
 * pasting a real key into the one field designed never to store it.
 *
 * @returns an acceptance, a rejection, or a rejection carrying the
 * secret-looking warning.
 */
export function checkCredentialRefInput(
  input: string,
): { kind: "accept"; value: string } | { kind: "reject"; reason: string; secretWarning: boolean } {
  const trimmed = input.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { kind: "accept", value: trimmed };
  const secretWarning = looksLikeSecret(trimmed);
  return {
    kind: "reject",
    reason: secretWarning
      ? "this looks like a secret VALUE; credential fields take a variable NAME (for example DEEPSEEK_API_KEY), never the secret itself"
      : "credential fields take a variable NAME: letters, digits, and underscores, starting with a letter or underscore",
    secretWarning,
  };
}
