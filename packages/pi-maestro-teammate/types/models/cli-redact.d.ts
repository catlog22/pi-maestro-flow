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
/**
 * Report whether a string looks like a secret value rather than a name.
 *
 * Names (deployment ids, env variable names, model ids) are upper- or
 * lower-case-with-separators and never flagged. Values produced by key
 * generators mix character classes at random, which is what the structural
 * checks look for.
 */
export declare function looksLikeSecret(value: string): boolean;
/**
 * Mask one value completely: the byte length survives (useful for diffing),
 * the content does not.
 */
export declare function redactValue(value: string): string;
/**
 * Mask every secret-looking token in free-form output.
 *
 * Applied to external-change diff summaries and any other text that embeds
 * document content, so an operator's pasted secret cannot leak through a
 * path that was only supposed to show structure.
 */
export declare function redactText(text: string): string;
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
export declare function checkCredentialRefInput(input: string): {
    kind: "accept";
    value: string;
} | {
    kind: "reject";
    reason: string;
    secretWarning: boolean;
};
