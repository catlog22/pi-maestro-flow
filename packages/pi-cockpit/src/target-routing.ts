/**
 * Pure parsing, resolution, and staged completion for Cockpit's canonical
 * `#` target routes.  This module deliberately has no TUI or transport
 * dependencies: callers provide a safe target catalogue and decide how a
 * resolved route is delivered.
 */

export const TARGET_KINDS = ["agent", "window", "ssh"] as const;
export const DIRECT_TARGET_KINDS = ["agent", "window"] as const;
export const TARGET_SEND_MODES = ["follow_up", "steer", "interrupt"] as const;
export const DEFAULT_TARGET_SEND_MODE = "follow_up" as const;

/** Decoded ids are intentionally bounded before they can enter a route. */
export const MAX_TARGET_ID_CHARS = 512;
/** Percent encoding can expand a UTF-8 id by at most three bytes per char. */
export const MAX_ENCODED_TARGET_ID_CHARS = MAX_TARGET_ID_CHARS * 3;
/** Keep parser output bounded while leaving normal multi-line requests intact. */
export const MAX_TARGET_BODY_CHARS = 64 * 1024;
export const MAX_TARGET_BODY_BYTES = 64 * 1024;
export const MAX_TARGET_DISPLAY_CHARS = 160;
export const MAX_TARGET_SELECTOR_ITEMS = 64;

export type TargetKind = (typeof TARGET_KINDS)[number];
export type DirectTargetKind = (typeof DIRECT_TARGET_KINDS)[number];
export type TargetSendMode = (typeof TARGET_SEND_MODES)[number];

/**
 * The only target metadata the selector consumes.  In particular, this type
 * has no host, user, authentication, or other credential-bearing fields.
 */
export interface TargetDescriptor {
	readonly kind: TargetKind;
	/** Canonical decoded id (endpoint id or SSH host reference id). */
	readonly id: string;
	readonly label?: string;
	readonly description?: string;
	/** Marks the currently selected target without changing its canonical id. */
	readonly current?: boolean;
}

export interface ParsedTargetReference {
	readonly ok: true;
	readonly form: "reference";
	readonly direct: false;
	readonly kind: TargetKind;
	/** Decoded id as entered by the user; resolution may replace it with a full id. */
	readonly id: string;
	/** The bounded token before decoding, useful for diagnostics only. */
	readonly encodedId: string;
	readonly request: string;
}

export interface ParsedDirectSend {
	readonly ok: true;
	readonly form: "direct-send";
	readonly direct: true;
	readonly kind: DirectTargetKind;
	/** Decoded id as entered by the user; resolution may replace it with a full id. */
	readonly id: string;
	/** The bounded token before decoding, useful for diagnostics only. */
	readonly encodedId: string;
	readonly mode: TargetSendMode;
	readonly message: string;
}

export type ParsedTargetRoute = ParsedTargetReference | ParsedDirectSend;

export type TargetParseErrorCode = "invalid" | "body" | "unsupported";
export type TargetParseErrorReason =
	| "syntax"
	| "id"
	| "id-too-long"
	| "id-encoding"
	| "body-required"
	| "body-too-long"
	| "body-invalid"
	| "mode"
	| "direct-kind";

export interface TargetParseError {
	readonly ok: false;
	/** True means this was a recognized Cockpit target form, not ordinary text. */
	readonly matched: true;
	readonly code: TargetParseErrorCode;
	readonly reason: TargetParseErrorReason;
	readonly message: string;
	readonly kind?: string;
}

/** Ordinary non-target text returns undefined; recognized malformed input is data. */
export type TargetParseResult = ParsedTargetRoute | TargetParseError | undefined;

export type TargetResolutionCode = "resolved" | "stale" | "ambiguous" | "invalid";

export interface ResolvedTargetId {
	readonly code: "resolved";
	readonly kind: TargetKind;
	readonly requestedId: string;
	readonly target: TargetDescriptor;
	readonly match: "exact" | "prefix";
}

export interface UnresolvedTargetId {
	readonly code: "stale" | "ambiguous" | "invalid";
	readonly kind: TargetKind;
	readonly requestedId: string;
	readonly candidates: readonly TargetDescriptor[];
	readonly message: string;
}

export type TargetIdResolution = ResolvedTargetId | UnresolvedTargetId;

export interface ResolvedTargetRoute {
	readonly code: "resolved";
	readonly route: ParsedTargetRoute;
	readonly target: TargetDescriptor;
	readonly match: "exact" | "prefix";
}

export type TargetRouteResolution = ResolvedTargetRoute | {
	readonly code: "stale" | "ambiguous" | "invalid";
	readonly route?: ParsedTargetRoute;
	readonly target?: undefined;
	readonly match?: undefined;
	readonly candidates: readonly TargetDescriptor[];
	readonly message: string;
};

const TARGET_KIND_SET = new Set<string>(TARGET_KINDS);
const DIRECT_TARGET_KIND_SET = new Set<string>(DIRECT_TARGET_KINDS);
const TARGET_SEND_MODE_SET = new Set<string>(TARGET_SEND_MODES);
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const ID_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SSH_ATTACHMENT_CONTROL_RE = /^#ssh:[+-][A-Za-z0-9][A-Za-z0-9._-]{0,63}$/iu;

/** Exact local SSH attachment controls reserved for the Flow SSH manager. */
export function isSshAttachmentControlInput(text: string): boolean {
	return SSH_ATTACHMENT_CONTROL_RE.test(text.trim());
}

function isTargetKind(value: string): value is TargetKind {
	return TARGET_KIND_SET.has(value);
}

function isDirectTargetKind(value: string): value is DirectTargetKind {
	return DIRECT_TARGET_KIND_SET.has(value);
}

function isTargetSendMode(value: string): value is TargetSendMode {
	return TARGET_SEND_MODE_SET.has(value);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function targetParseError(
	code: TargetParseErrorCode,
	reason: TargetParseErrorReason,
	message: string,
	kind?: string,
): TargetParseError {
	return {
		ok: false,
		matched: true,
		code,
		reason,
		message,
		...(kind === undefined ? {} : { kind }),
	};
}

function isRecognizedTargetHeader(header: string): boolean {
	// Bare forms are incomplete selector queries.  Leave them to the selector
	// stage (and preserve the existing bare #ssh picker) rather than reporting a
	// submitted route error before an id has been entered.
	return header.startsWith("#agent:")
		|| header.startsWith("#window:")
		|| header.startsWith("#ssh:")
		|| header.startsWith("#direct-send:");
}

function decodeIdToken(token: string):
	| { ok: true; id: string }
	| { ok: false; reason: "id" | "id-too-long" | "id-encoding" } {
	if (token.length === 0) return { ok: false, reason: "id" };
	if (token.length > MAX_ENCODED_TARGET_ID_CHARS) return { ok: false, reason: "id-too-long" };
	// A slash, hash, or backslash in this position means a full id was not
	// encoded as one grammar segment.  Decoded ids may contain slashes.
	if (/[\/#\\?]/u.test(token)) return { ok: false, reason: "id-encoding" };
	let id: string;
	try {
		id = decodeURIComponent(token);
	} catch {
		return { ok: false, reason: "id-encoding" };
	}
	if (id.length === 0) return { ok: false, reason: "id" };
	if (id.length > MAX_TARGET_ID_CHARS || utf8Length(id) > MAX_TARGET_ID_CHARS * 4) {
		return { ok: false, reason: "id-too-long" };
	}
	if (ID_CONTROL_RE.test(id) || /[\s#]/u.test(id)) return { ok: false, reason: "id" };
	return { ok: true, id };
}

function validateBody(
	body: string,
	required: boolean,
): { ok: true; body: string } | { ok: false; reason: "body-required" | "body-too-long" | "body-invalid" } {
	const normalized = body.trim();
	if (required && normalized.length === 0) return { ok: false, reason: "body-required" };
	if (normalized.length > MAX_TARGET_BODY_CHARS || utf8Length(normalized) > MAX_TARGET_BODY_BYTES) {
		return { ok: false, reason: "body-too-long" };
	}
	if (BODY_CONTROL_RE.test(normalized)) return { ok: false, reason: "body-invalid" };
	return { ok: true, body: normalized };
}

function bodyError(reason: "body-required" | "body-too-long" | "body-invalid"): TargetParseError {
	const message = reason === "body-required"
		? "A request message is required after the target."
		: reason === "body-too-long"
			? "The target request exceeds the bounded message size."
			: "The target request contains unsupported control characters.";
	return targetParseError("body", reason, message);
}

/** Encode a complete id as one grammar-safe URI component. */
export function encodeTargetId(id: string): string {
	try {
		return encodeURIComponent(id).replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
	} catch {
		return "";
	}
}

/**
 * Parse one submitted Cockpit target input.  No target catalogue is consulted
 * here; exact-vs-prefix resolution is deliberately a later stage.
 */
export function parseTargetInput(text: string): TargetParseResult {
	if (typeof text !== "string") return undefined;
	const leading = /^[ \t]*/u.exec(text)?.[0].length ?? 0;
	const source = text.slice(leading);
	if (!source.startsWith("#")) return undefined;
	const boundary = source.search(/[ \t\r\n]/u);
	const header = boundary < 0 ? source : source.slice(0, boundary);
	if (!isRecognizedTargetHeader(header)) return undefined;
	const body = boundary < 0 ? "" : source.slice(boundary);
	const parts = header.slice(1).split(":");

	if (parts[0] === "direct-send") {
		if (parts.length < 3 || parts.length > 4) {
			return targetParseError("invalid", "syntax", "Invalid direct-send target syntax.");
		}
		const rawKind = parts[1] ?? "";
		if (!isDirectTargetKind(rawKind)) {
			return targetParseError(
				rawKind === "ssh" ? "unsupported" : "invalid",
				"direct-kind",
				rawKind === "ssh" ? "Direct send does not support SSH targets." : "Direct send target kind is invalid.",
				rawKind,
			);
		}
		const encodedId = parts[2] ?? "";
		const decoded = decodeIdToken(encodedId);
		if (!decoded.ok) {
			return targetParseError(
				"invalid",
				decoded.reason,
				decoded.reason === "id-too-long" ? "Target id exceeds the bounded id size."
					: decoded.reason === "id-encoding" ? "Target id must be one percent-encoded grammar segment."
						: "Target id is invalid.",
				rawKind,
			);
		}
		const rawMode = parts.length === 4 ? parts[3] : undefined;
		const mode = rawMode === undefined ? DEFAULT_TARGET_SEND_MODE : rawMode;
		if (!isTargetSendMode(mode)) {
			return targetParseError("invalid", "mode", "Direct-send mode must be follow_up, steer, or interrupt.", rawKind);
		}
		const checkedBody = validateBody(body, true);
		if (!checkedBody.ok) return bodyError(checkedBody.reason);
		return {
			ok: true,
			form: "direct-send",
			direct: true,
			kind: rawKind,
			id: decoded.id,
			encodedId,
			mode,
			message: checkedBody.body,
		};
	}

	const rawKindValue = parts[0] ?? "";
	if (parts.length !== 2 || !isTargetKind(rawKindValue)) {
		return targetParseError("invalid", "syntax", "Invalid target reference syntax.");
	}
	const rawKind = rawKindValue;
	const encodedId = parts[1] ?? "";
	const decoded = decodeIdToken(encodedId);
	if (!decoded.ok) {
		return targetParseError(
			"invalid",
			decoded.reason,
			decoded.reason === "id-too-long" ? "Target id exceeds the bounded id size."
				: decoded.reason === "id-encoding" ? "Target id must be one percent-encoded grammar segment."
					: "Target id is invalid.",
			rawKind,
		);
	}
	const checkedBody = validateBody(body, rawKind !== "ssh");
	if (!checkedBody.ok) return bodyError(checkedBody.reason);
	return {
		ok: true,
		form: "reference",
		direct: false,
		kind: rawKind,
		id: decoded.id,
		encodedId,
		request: checkedBody.body,
	};
}

/** Resolve exact ids first, then a unique same-kind decoded-id prefix. */
export function resolveTargetId(
	kind: TargetKind,
	requestedId: string,
	targets: readonly TargetDescriptor[],
): TargetIdResolution {
	if (!isTargetKind(kind) || typeof requestedId !== "string" || !decodeIdToken(encodeTargetId(requestedId)).ok) {
		return {
			code: "invalid",
			kind,
			requestedId: typeof requestedId === "string" ? requestedId : "",
			candidates: [],
			message: "Target id is invalid.",
		};
	}
	const sameKind = targets.filter((target) =>
		target.kind === kind
		&& typeof target.id === "string"
		&& decodeIdToken(encodeTargetId(target.id)).ok
	);
	const exact = sameKind.filter((target) => target.id === requestedId);
	if (exact.length === 1) {
		return { code: "resolved", kind, requestedId, target: exact[0]!, match: "exact" };
	}
	if (exact.length > 1) {
		return {
			code: "ambiguous",
			kind,
			requestedId,
			candidates: exact,
			message: "More than one target has the requested id.",
		};
	}
	const prefixes = sameKind.filter((target) => target.id.startsWith(requestedId));
	if (prefixes.length === 1) {
		return { code: "resolved", kind, requestedId, target: prefixes[0]!, match: "prefix" };
	}
	if (prefixes.length > 1) {
		return {
			code: "ambiguous",
			kind,
			requestedId,
			candidates: prefixes,
			message: "More than one same-kind target matches the id prefix.",
		};
	}
	return {
		code: "stale",
		kind,
		requestedId,
		candidates: [],
		message: "The target is no longer available.",
	};
}

/** Resolve a parsed route against the current catalogue without throwing. */
export function resolveTargetRoute(
	route: ParsedTargetRoute,
	targets: readonly TargetDescriptor[],
): TargetRouteResolution {
	const resolved = resolveTargetId(route.kind, route.id, targets);
	if (resolved.code !== "resolved") {
		return {
			code: resolved.code,
			route,
			candidates: resolved.candidates,
			message: resolved.message,
		};
	}
	return { code: "resolved", route, target: resolved.target, match: resolved.match };
}

/** Parse and resolve in one pure, user-input-safe operation. */
export function parseAndResolveTargetInput(
	text: string,
	targets: readonly TargetDescriptor[],
): TargetRouteResolution | TargetParseError | undefined {
	const parsed = parseTargetInput(text);
	if (parsed === undefined || !parsed.ok) return parsed;
	return resolveTargetRoute(parsed, targets);
}

export type TargetSelectorStage = "category" | "kind" | "target" | "mode" | "none";

export interface TargetSelectorQuery {
	readonly stage: TargetSelectorStage;
	readonly text: string;
	readonly prefix: string;
	/** Text after the leading #, without any body. */
	readonly fragment: string;
	readonly kind?: TargetKind;
	readonly targetFragment?: string;
	readonly modeFragment?: string;
}

export interface TargetSelectorItem {
	readonly stage: Exclude<TargetSelectorStage, "none">;
	/** Complete canonical text to replace the current selector query. */
	readonly value: string;
	/** Alias for UI adapters that call completion text `insertText`. */
	readonly insertText: string;
	readonly label: string;
	readonly description?: string;
	readonly category?: "agent" | "window" | "ssh" | "direct-send";
	readonly kind?: TargetKind;
	readonly id?: string;
	readonly mode?: TargetSendMode;
	readonly current?: boolean;
	/** Direct target continuation for adapters that want to expose mode next. */
	readonly nextValue?: string;
}

const CATEGORY_ORDER = ["agent", "window", "ssh", "direct-send"] as const;

function selectorNone(text: string, prefix: string, fragment: string): TargetSelectorQuery {
	return { stage: "none", text, prefix, fragment };
}

/** Parse the selector query before the cursor; body-bearing input has no stage. */
export function parseTargetSelector(text: string): TargetSelectorQuery | undefined {
	if (typeof text !== "string") return undefined;
	const match = /^[ \t]*(#[^\s#]*)$/u.exec(text);
	if (!match) return undefined;
	const prefix = text.slice(0, text.indexOf("#"));
	const fragment = match[1]!.slice(1);
	if (fragment.length === 0 || !fragment.includes(":")) {
		return {
			stage: "category",
			text,
			prefix,
			fragment,
		};
	}
	const parts = fragment.split(":");
	if (parts[0] === "direct-send") {
		if (parts.length === 2) {
			return { stage: "kind", text, prefix, fragment, };
		}
		const rawKind = parts[1] ?? "";
		if (!isDirectTargetKind(rawKind)) return selectorNone(text, prefix, fragment);
		if (parts.length === 3) {
			return {
				stage: "target",
				text,
				prefix,
				fragment,
				kind: rawKind,
				targetFragment: parts[2] ?? "",
			};
		}
		if (parts.length === 4) {
			return {
				stage: "mode",
				text,
				prefix,
				fragment,
				kind: rawKind,
				targetFragment: parts[2] ?? "",
				modeFragment: parts[3] ?? "",
			};
		}
		return selectorNone(text, prefix, fragment);
	}
	if (parts.length === 2 && isTargetKind(parts[0] ?? "")) {
		return {
			stage: "target",
			text,
			prefix,
			fragment,
			kind: parts[0] as TargetKind,
			targetFragment: parts[1] ?? "",
		};
	}
	return selectorNone(text, prefix, fragment);
}

function safeDisplay(value: string | undefined, fallback: string): string {
	const normalized = typeof value === "string"
		? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim()
		: "";
	return (normalized || fallback).slice(0, MAX_TARGET_DISPLAY_CHARS);
}

function validDescriptor(target: TargetDescriptor): boolean {
	return Boolean(target)
		&& isTargetKind(target.kind)
		&& typeof target.id === "string"
		&& decodeIdToken(encodeTargetId(target.id)).ok;
}

function orderedTargets(
	targets: readonly TargetDescriptor[],
	kind: TargetKind,
): TargetDescriptor[] {
	const seen = new Set<string>();
	const result: TargetDescriptor[] = [];
	for (const target of targets) {
		if (!validDescriptor(target) || target.kind !== kind || seen.has(target.id)) continue;
		seen.add(target.id);
		result.push(target);
	}
	return result.sort((left, right) =>
		encodeTargetId(left.id).localeCompare(encodeTargetId(right.id), "en")
		|| safeDisplay(left.label, left.id).localeCompare(safeDisplay(right.label, right.id), "en"),
	);
}

function targetMatches(target: TargetDescriptor, query: string): boolean {
	if (!query) return true;
	const normalized = query.toLocaleLowerCase("en");
	const encoded = encodeTargetId(target.id).toLocaleLowerCase("en");
	const id = target.id.toLocaleLowerCase("en");
	const label = safeDisplay(target.label, target.id).toLocaleLowerCase("en");
	const description = safeDisplay(target.description, "").toLocaleLowerCase("en");
	return encoded.startsWith(normalized)
		|| id.startsWith(normalized)
		|| label.includes(normalized)
		|| description.includes(normalized);
}

function targetItem(
	stage: "target",
	target: TargetDescriptor,
	kind: TargetKind,
	direct: boolean,
): TargetSelectorItem {
	const encoded = encodeTargetId(target.id);
	const base = direct
		? `#direct-send:${kind}:${encoded}`
		: `#${kind}:${encoded}`;
	const label = safeDisplay(target.label, target.id);
	const descriptionParts = [
		target.current === true ? "current" : undefined,
		safeDisplay(target.description, ""),
		`id=${encoded}`,
	].filter(Boolean);
	const value = `${base} `;
	return {
		stage,
		value,
		insertText: value,
		label,
		description: descriptionParts.join(" · "),
		category: direct ? "direct-send" : kind,
		kind,
		id: target.id,
		...(target.current === true ? { current: true } : {}),
		...(direct ? { nextValue: `${base}:` } : {}),
	};
}

function modeItems(
	query: TargetSelectorQuery,
	target: TargetDescriptor | undefined,
): TargetSelectorItem[] {
	if (!target || !query.kind) return [];
	const raw = query.modeFragment ?? "";
	const base = `#direct-send:${query.kind}:${encodeTargetId(target.id)}`;
	return TARGET_SEND_MODES
		.filter((mode) => !raw || mode.startsWith(raw.toLocaleLowerCase("en")))
		.map((mode) => {
			const value = `${base}:${mode} `;
			return {
				stage: "mode" as const,
				value,
				insertText: value,
				label: mode,
				description: mode === DEFAULT_TARGET_SEND_MODE ? "default" : undefined,
				category: "direct-send" as const,
				kind: query.kind,
				id: target.id,
				mode,
				...(target.current === true ? { current: true } : {}),
			};
		});
}

/** Build deterministic, UI-independent selector items for one query stage. */
export function buildTargetSelectorItems(
	text: string,
	targets: readonly TargetDescriptor[] = [],
): readonly TargetSelectorItem[] {
	const query = parseTargetSelector(text);
	if (!query || query.stage === "none") return [];
	if (query.stage === "category") {
		const fragment = query.fragment.toLocaleLowerCase("en");
		return CATEGORY_ORDER
			.filter((category) => category.startsWith(fragment))
			.map((category) => ({
				stage: "category" as const,
				value: `#${category}:`,
				insertText: `#${category}:`,
				label: `#${category}`,
				category,
			}));
	}
	if (query.stage === "kind") {
		const fragment = (query.fragment.split(":")[1] ?? "").toLocaleLowerCase("en");
		return DIRECT_TARGET_KINDS
			.filter((kind) => kind.startsWith(fragment))
			.map((kind) => ({
				stage: "kind" as const,
				value: `#direct-send:${kind}:`,
				insertText: `#direct-send:${kind}:`,
				label: kind,
				category: "direct-send" as const,
				kind,
			}));
	}
	const kind = query.kind as TargetKind | undefined;
	if (!kind) return [];
	const available = orderedTargets(targets, kind);
	if (query.stage === "mode") {
		let selected: TargetDescriptor | undefined;
		const encodedQuery = query.targetFragment ?? "";
		try {
			const decoded = decodeIdToken(encodedQuery);
			if (decoded.ok) {
				selected = available.find((target) => target.id === decoded.id);
			}
		} catch {
			selected = undefined;
		}
		return modeItems(query, selected);
	}
	const targetQuery = query.targetFragment ?? "";
	return available
		.filter((target) => targetMatches(target, targetQuery))
		.slice(0, MAX_TARGET_SELECTOR_ITEMS)
		.map((target) => targetItem("target", target, kind, query.fragment.startsWith("direct-send:")));
}

/** Apply an item to a selector-only text prefix, returning a cursor position. */
export function applyTargetSelectorCompletion(
	textBeforeCursor: string,
	item: TargetSelectorItem,
): { readonly text: string; readonly cursor: number } | undefined {
	const query = parseTargetSelector(textBeforeCursor);
	if (!query || query.stage === "none") return undefined;
	const text = `${query.prefix}${item.value}`;
	return { text, cursor: text.length };
}

// Intentionally descriptive aliases for integration code that uses either
// "route" or "autocomplete" terminology.
export const parseTargetRoute = parseTargetInput;
export const resolveTargetInput = parseAndResolveTargetInput;
export const buildTargetAutocompleteItems = buildTargetSelectorItems;
export const getTargetSelectorItems = buildTargetSelectorItems;
