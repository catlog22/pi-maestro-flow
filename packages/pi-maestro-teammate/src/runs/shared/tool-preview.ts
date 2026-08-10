/**
 * Tool-call argument previews for progress telemetry.
 *
 * The child emits `tool_execution_start` with the raw arguments; only a small,
 * redacted one-line summary should ever leave the child process. Key names that
 * look like secrets are replaced wholesale, value patterns for common bearer
 * credentials are scrubbed, nesting and list lengths are bounded, and the final
 * string is truncated as UTF-8.
 */

/** Canonical credential names shared by structured keys and string arguments. */
const CREDENTIAL_NAME_SOURCE = String.raw`(?:authorization|cookie|credential|passphrase|password|secret|session|token|api[-_]?(?:key|token)|private[-_]?key|access[-_]?(?:key|token)|refresh[-_]?token|client[-_]?secret)`;
/** Key names whose values are replaced entirely. */
const SECRET_KEY = new RegExp(CREDENTIAL_NAME_SOURCE, "i");
/** Common credential value shapes (bearer, sk-, ghp-, github_pat, xox*, basic, key=...). */
const SECRET_VALUE = /\b(?:Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]{8,}|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/gi;
/** Credential-bearing HTTP headers, kept narrow to avoid treating arbitrary `name: value` text as secret. */
const QUOTED_CREDENTIAL_HEADER = /(["'])((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:\s*)(?:(?!\1).)*\1/gi;
const UNQUOTED_CREDENTIAL_HEADER = /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:\s*)[^\s"']+/gi;
/** Shell environment assignments with an explicit credential suffix. */
const ENV_CREDENTIAL_SUFFIX_SOURCE = String.raw`(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY|_ACCESS_KEY|_PRIVATE_KEY|_PASSPHRASE|_CREDENTIAL|_CLIENT_SECRET)`;
const QUOTED_ENV_CREDENTIAL_ASSIGNMENT = new RegExp(
	String.raw`(\b[A-Za-z][A-Za-z0-9_]*${ENV_CREDENTIAL_SUFFIX_SOURCE}\s*=\s*)(["'])(?:(?!\2).)*\2`,
	"gi",
);
const UNQUOTED_ENV_CREDENTIAL_ASSIGNMENT = new RegExp(
	String.raw`(\b[A-Za-z][A-Za-z0-9_]*${ENV_CREDENTIAL_SUFFIX_SOURCE}\s*=\s*)[^\s&#;,"'\x60]+`,
	"gi",
);
/** Explicit credential assignments in CLI arguments and URL queries. */
const QUOTED_CREDENTIAL_ASSIGNMENT = new RegExp(
	String.raw`(\b${CREDENTIAL_NAME_SOURCE}\s*=\s*)(["'])(?:(?!\2).)*\2`,
	"gi",
);
const UNQUOTED_CREDENTIAL_ASSIGNMENT = new RegExp(
	String.raw`(\b${CREDENTIAL_NAME_SOURCE}\s*=\s*)[^\s&#;,"'\x60]+`,
	"gi",
);
/** Space-separated values for exact credential-bearing long options. */
const QUOTED_CREDENTIAL_OPTION = new RegExp(
	String.raw`(^|[\s;&|])(--${CREDENTIAL_NAME_SOURCE}\s+)(["'])(?:(?!\3).)*\3`,
	"gi",
);
const UNQUOTED_CREDENTIAL_OPTION = new RegExp(
	String.raw`(^|[\s;&|])(--${CREDENTIAL_NAME_SOURCE}\s+)(?!["'\-;&|])[^\s;&|]+`,
	"gi",
);
/** `scheme://user:password@host` userinfo — drop the password half. */
const URL_USERINFO = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/@\s:]+):([^@\s/]+)@/g;

const MAX_REDACT_DEPTH = 3;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 20;
/** Bound hostile input before terminal-sequence parsing or pattern matching. */
const MAX_SANITIZE_INPUT_CHARS = 4096;
const MAX_STRING_CHARS = 500;
/** Final preview budget, mirroring the permission preview cap. */
const MAX_PREVIEW_BYTES = 2048;

/** Priority order for picking the single most informative argument. */
const PREVIEW_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
const EDIT_WRITE_CONTENT_KEYS = new Set(["content", "oldText", "newText"]);

function boundedInput(value: string): string {
	if (value.length <= MAX_SANITIZE_INPUT_CHARS) return value;
	const bounded = value.slice(0, MAX_SANITIZE_INPUT_CHARS);
	const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
	return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF ? bounded.slice(0, -1) : bounded;
}

/** Return the first byte after a CSI sequence, including an unterminated one. */
function skipCsi(value: string, start: number): number {
	let index = start;
	while (index < value.length && value.charCodeAt(index) >= 0x30 && value.charCodeAt(index) <= 0x3F) index += 1;
	while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2F) index += 1;
	if (index < value.length && value.charCodeAt(index) >= 0x40 && value.charCodeAt(index) <= 0x7E) index += 1;
	return index;
}

/** Return the first byte after an OSC/control string, or EOF if it is unterminated. */
function skipControlString(value: string, start: number, bellTerminates: boolean): number {
	for (let index = start; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((bellTerminates && code === 0x07) || code === 0x9C) return index + 1;
		if (code === 0x1B && value.charCodeAt(index + 1) === 0x5C) return index + 2;
	}
	return value.length;
}

/** Fold to one line and remove ECMA-48 terminal controls without retaining payloads. */
function flattenOneLine(rawValue: string): string {
	const value = boundedInput(rawValue);
	let normalized = "";
	for (let index = 0; index < value.length;) {
		const code = value.charCodeAt(index);
		if (code === 0x1B) {
			const next = value.charCodeAt(index + 1);
			if (next === 0x5B) index = skipCsi(value, index + 2);
			else if (next === 0x5D) index = skipControlString(value, index + 2, true);
			else if (next === 0x50 || next === 0x58 || next === 0x5E || next === 0x5F) {
				index = skipControlString(value, index + 2, false);
			} else {
				// Other ESC sequences contain optional intermediates and one final byte.
				index += 1;
				while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2F) index += 1;
				if (index < value.length && value.charCodeAt(index) >= 0x30 && value.charCodeAt(index) <= 0x7E) index += 1;
			}
			normalized += " ";
			continue;
		}
		if (code === 0x9B) {
			index = skipCsi(value, index + 1);
			normalized += " ";
			continue;
		}
		if (code === 0x9D || code === 0x90 || code === 0x98 || code === 0x9E || code === 0x9F) {
			index = skipControlString(value, index + 1, code === 0x9D);
			normalized += " ";
			continue;
		}
		if (code <= 0x1F || (code >= 0x7F && code <= 0x9F)) {
			normalized += " ";
			index += 1;
			continue;
		}
		normalized += value[index];
		index += 1;
	}
	return normalized.replace(/\s+/g, " ").trim();
}

/** Truncate at a code point boundary so astral characters are never split. */
function truncateCodePoints(value: string, maxChars: number): string {
	if ([...value].length <= maxChars) return value;
	return `${[...value].slice(0, maxChars - 1).join("")}…`;
}

function redactValue(value: unknown, key = "", depth = 0, omitEditWriteContent = false): unknown {
	if (omitEditWriteContent && EDIT_WRITE_CONTENT_KEYS.has(key) && typeof value === "string") {
		return `[omitted ${value.length} chars; use tool result diff]`;
	}
	if (SECRET_KEY.test(key)) return "[redacted]";
	if (depth >= MAX_REDACT_DEPTH) return "[truncated]";
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, "", depth + 1, omitEditWriteContent));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.slice(0, MAX_OBJECT_KEYS)
				.map(([entryKey, entryValue]) => [
					entryKey,
					redactValue(entryValue, entryKey, depth + 1, omitEditWriteContent),
				]),
		);
	}
	if (typeof value === "string") {
		let scrubbed = flattenOneLine(value);
		scrubbed = scrubbed
			.replace(QUOTED_CREDENTIAL_HEADER, "$1$2[redacted]$1")
			.replace(SECRET_VALUE, "[redacted]")
			.replace(UNQUOTED_CREDENTIAL_HEADER, "$1[redacted]")
			.replace(QUOTED_ENV_CREDENTIAL_ASSIGNMENT, "$1$2[redacted]$2")
			.replace(UNQUOTED_ENV_CREDENTIAL_ASSIGNMENT, "$1[redacted]")
			.replace(QUOTED_CREDENTIAL_ASSIGNMENT, "$1$2[redacted]$2")
			.replace(UNQUOTED_CREDENTIAL_ASSIGNMENT, "$1[redacted]")
			.replace(QUOTED_CREDENTIAL_OPTION, "$1$2$3[redacted]$3")
			.replace(UNQUOTED_CREDENTIAL_OPTION, "$1$2[redacted]")
			.replace(URL_USERINFO, "$1:[redacted]@");
		return truncateCodePoints(scrubbed, MAX_STRING_CHARS);
	}
	return value;
}

function truncatePreviewUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let preview = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		preview += character;
		bytes += characterBytes;
	}
	return `${preview}…`;
}

function scalarPreview(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? truncateCodePoints(trimmed, 50) : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

/**
 * Build a one-line, redacted summary of tool arguments for progress display.
 * Returns undefined when nothing informative survives, so callers can omit the
 * field entirely instead of emitting an empty preview.
 */
export function previewToolCallArgs(args: unknown, toolName?: string): string | undefined {
	if (args === undefined || args === null) return undefined;
	const omitEditWriteContent = toolName === "edit" || toolName === "write";
	const redacted = redactValue(args, "", 0, omitEditWriteContent);
	if (typeof redacted === "string") return truncatePreviewUtf8(redacted, MAX_PREVIEW_BYTES);
	if (typeof redacted !== "object") return undefined;
	const record = redacted as Record<string, unknown>;
	// Prefer a keyed summary; fall back to a compact JSON for small payloads.
	for (const key of PREVIEW_KEYS) {
		const value = scalarPreview(record[key]);
		if (value !== undefined) {
			const line = `${key}=${value}`;
			return truncatePreviewUtf8(line, MAX_PREVIEW_BYTES);
		}
	}
	const serialized = JSON.stringify(record);
	if (!serialized || serialized.length === 0 || serialized === "{}") return undefined;
	return truncatePreviewUtf8(serialized, MAX_PREVIEW_BYTES);
}
