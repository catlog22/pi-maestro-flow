// Guarded edit tool: wraps pi's built-in edit with UTF-8 validation,
// frozen-snapshot version checks, duplicate candidate diagnostics, and an
// optional 1-based occurrence selector for exact duplicate matches. Pi still
// owns the final atomic validation/diff/write path. Quiet mode reuses this same
// schema and execute function so rendering changes cannot bypass the guards.

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { type Static, Type } from "typebox";
import {
	createEditTool,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const guardedReplacementSchema = Type.Object({
	oldText: Type.String({
		description: "Exact text for one targeted replacement. It must be unique unless occurrence explicitly selects one exact match.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
	occurrence: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Optional 1-based exact-match selector when oldText occurs more than once. Omit when oldText is already unique.",
	})),
});

export const GUARDED_EDIT_PARAMETERS = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(guardedReplacementSchema, {
		description: "One or more replacements matched against the same frozen original file. Use occurrence only to select one of several exact oldText matches.",
	}),
});

export type GuardedEditInput = Static<typeof GUARDED_EDIT_PARAMETERS>;
type GuardedReplacement = GuardedEditInput["edits"][number];
type EditOnUpdate = Parameters<ReturnType<typeof createEditTool>["execute"]>[3];

/** Read a file once for guarded preflight. Read/path failures pass through so
 * pi's built-in edit keeps ownership of its normal access errors. */
async function readValidatedUtf8File(
	path: string,
	cwd: string,
): Promise<{ bytes: Buffer; text: string } | undefined> {
	let absolute: string;
	try {
		absolute = isAbsolute(path) ? path : resolve(cwd, path);
	} catch {
		return undefined;
	}
	let buffer: Buffer;
	try {
		buffer = await fsReadFile(absolute);
	} catch {
		return undefined;
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new Error(
			`Refusing to edit ${path}: the file is not valid UTF-8 (non-UTF-8 bytes detected). ` +
			`The edit tool decodes and writes UTF-8, so editing this file would corrupt its non-ASCII content. ` +
			`Convert the file to UTF-8 first (e.g. iconv -f GBK -t UTF-8) and retry.`,
		);
	}
	return { bytes: buffer, text: buffer.toString("utf8") };
}

/** Reject editing a file whose bytes are not valid UTF-8. */
export async function assertUtf8File(path: string, cwd: string): Promise<void> {
	await readValidatedUtf8File(path, cwd);
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Keep this aligned with pi's fuzzy matching so duplicate preflight reports
// the same candidates that the delegated built-in edit would reject.
function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function occurrenceIndexes(content: string, needle: string): number[] {
	if (needle === "") return [];
	const indexes: number[] = [];
	let from = 0;
	while (from <= content.length - needle.length) {
		const index = content.indexOf(needle, from);
		if (index === -1) break;
		indexes.push(index);
		from = index + needle.length;
	}
	return indexes;
}

function lineNumberAt(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

function candidateDetails(content: string, fuzzyContent: string, indexes: number[]): string {
	const lines = content.split("\n");
	const shown = indexes.slice(0, 8).map((index, candidateIndex) => {
		const line = lineNumberAt(fuzzyContent, index);
		const raw = (lines[line - 1] ?? "").trim();
		const preview = raw === "" ? "<blank line>" : raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
		return `${candidateIndex + 1}. line ${line}: ${preview}`;
	});
	if (indexes.length > shown.length) shown.push(`… ${indexes.length - shown.length} more candidate(s)`);
	return shown.join("\n");
}

function duplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	content: string,
	fuzzyContent: string,
	indexes: number[],
): Error {
	const target = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	const lines = indexes.map((index) => lineNumberAt(fuzzyContent, index));
	return new Error(
		`Found ${indexes.length} occurrences of ${target} in ${path} at lines ${lines.join(", ")}. ` +
		`The frozen original contains multiple matches. Add surrounding context or set occurrence to a 1-based candidate number (1-${indexes.length}); the tool will not guess.\n` +
		`Candidates:\n${candidateDetails(content, fuzzyContent, indexes)}`,
	);
}

interface SnapshotEdit {
	edit: GuardedReplacement;
	oldText: string;
	newText: string;
	exactIndexes: number[];
	fuzzyIndexes: number[];
	selectedStart?: number;
	selectedEnd?: number;
}

interface EditRange {
	editIndex: number;
	start: number;
	end: number;
}

function previousCodePointStart(text: string, index: number): number {
	const previous = index - 1;
	if (previous > 0) {
		const currentCode = text.charCodeAt(previous);
		const priorCode = text.charCodeAt(previous - 1);
		if (currentCode >= 0xdc00 && currentCode <= 0xdfff && priorCode >= 0xd800 && priorCode <= 0xdbff) {
			return previous - 1;
		}
	}
	return previous;
}

function nextCodePointEnd(text: string, index: number): number {
	if (index >= text.length) return index;
	const currentCode = text.charCodeAt(index);
	const nextCode = text.charCodeAt(index + 1);
	return currentCode >= 0xd800 && currentCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff
		? index + 2
		: index + 1;
}

function overlapsOtherEdit(start: number, end: number, editIndex: number, ranges: EditRange[]): boolean {
	return ranges.some((range) => range.editIndex !== editIndex && range.start < end && range.end > start);
}

function makeOccurrenceUnique(
	content: string,
	fuzzyContent: string,
	state: SnapshotEdit,
	editIndex: number,
	ranges: EditRange[],
	path: string,
): { oldText: string; newText: string } {
	const matchStart = state.selectedStart;
	const matchEnd = state.selectedEnd;
	if (matchStart === undefined || matchEnd === undefined) {
		return { oldText: state.oldText, newText: state.newText };
	}
	let start = matchStart;
	let end = matchEnd;
	let matchCount = occurrenceIndexes(fuzzyContent, normalizeForFuzzyMatch(content.slice(start, end))).length;
	while (matchCount !== 1) {
		const candidates: Array<{ start: number; end: number; count: number }> = [];
		if (start > 0) {
			const expandedStart = previousCodePointStart(content, start);
			if (!overlapsOtherEdit(expandedStart, end, editIndex, ranges)) {
				candidates.push({
					start: expandedStart,
					end,
					count: occurrenceIndexes(fuzzyContent, normalizeForFuzzyMatch(content.slice(expandedStart, end))).length,
				});
			}
		}
		if (end < content.length) {
			const expandedEnd = nextCodePointEnd(content, end);
			if (!overlapsOtherEdit(start, expandedEnd, editIndex, ranges)) {
				candidates.push({
					start,
					end: expandedEnd,
					count: occurrenceIndexes(fuzzyContent, normalizeForFuzzyMatch(content.slice(start, expandedEnd))).length,
				});
			}
		}
		const viable = candidates.filter((candidate) => candidate.count > 0);
		if (viable.length === 0) {
			throw new Error(
				`Could not disambiguate edits[${editIndex}] occurrence ${state.edit.occurrence} in ${path} without overlapping another edit. ` +
				`Merge the nearby changes into one edit or provide a larger unique oldText.`,
			);
		}
		viable.sort((a, b) => a.count - b.count || (a.end - a.start) - (b.end - b.start));
		start = viable[0].start;
		end = viable[0].end;
		matchCount = viable[0].count;
	}
	return {
		oldText: content.slice(start, end),
		newText: content.slice(start, matchStart) + state.newText + content.slice(matchEnd, end),
	};
}

function prepareSnapshotEdits(rawContent: string, path: string, edits: GuardedReplacement[]): Array<{ oldText: string; newText: string }> {
	const withoutBom = rawContent.startsWith("\uFEFF") ? rawContent.slice(1) : rawContent;
	const content = normalizeToLF(withoutBom);
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const states: SnapshotEdit[] = edits.map((edit, editIndex) => {
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText);
		const exactIndexes = occurrenceIndexes(content, oldText);
		const fuzzyIndexes = occurrenceIndexes(fuzzyContent, normalizeForFuzzyMatch(oldText));
		if (edit.occurrence === undefined && fuzzyIndexes.length > 1) {
			throw duplicateError(path, editIndex, edits.length, content, fuzzyContent, fuzzyIndexes);
		}
		if (edit.occurrence !== undefined && oldText !== "") {
			if (exactIndexes.length !== fuzzyIndexes.length) {
				throw new Error(
					`Cannot use occurrence for edits[${editIndex}] in ${path}: the candidates only match after fuzzy normalization. ` +
					`Read one candidate and provide exact surrounding context instead.\nCandidates:\n` +
					candidateDetails(content, fuzzyContent, fuzzyIndexes),
				);
			}
			if (edit.occurrence > exactIndexes.length) {
				throw new Error(
					`edits[${editIndex}].occurrence is ${edit.occurrence}, but ${path} contains only ${exactIndexes.length} exact match(es). ` +
					`Choose a value from 1-${exactIndexes.length || 0}.`,
				);
			}
			const selectedStart = exactIndexes[edit.occurrence - 1];
			return {
				edit,
				oldText,
				newText,
				exactIndexes,
				fuzzyIndexes,
				selectedStart,
				selectedEnd: selectedStart + oldText.length,
			};
		}
		return { edit, oldText, newText, exactIndexes, fuzzyIndexes };
	});
	const ranges: EditRange[] = states.flatMap((state, editIndex) => {
		if (state.selectedStart !== undefined && state.selectedEnd !== undefined) {
			return [{ editIndex, start: state.selectedStart, end: state.selectedEnd }];
		}
		if (state.exactIndexes.length === 1 && state.fuzzyIndexes.length === 1) {
			return [{ editIndex, start: state.exactIndexes[0], end: state.exactIndexes[0] + state.oldText.length }];
		}
		return [];
	});
	return states.map((state, editIndex) =>
		state.edit.occurrence === undefined
			? { oldText: state.oldText, newText: state.newText }
			: makeOccurrenceUnique(content, fuzzyContent, state, editIndex, ranges, path),
	);
}

// Per-cwd cache of the built-in tool, mirroring quiet-tools.ts.
const editToolCache = new Map<string, ReturnType<typeof createEditTool>>();

function getEditTool(cwd: string): ReturnType<typeof createEditTool> {
	let tool = editToolCache.get(cwd);
	if (!tool) {
		tool = createEditTool(cwd);
		editToolCache.set(cwd, tool);
	}
	return tool;
}

function createFrozenEditTool(cwd: string, path: string, snapshot: Buffer): ReturnType<typeof createEditTool> {
	const assertUnchanged = async (absolutePath: string): Promise<void> => {
		const current = await fsReadFile(absolutePath);
		if (!current.equals(snapshot)) {
			throw new Error(
				`Refusing to edit ${path}: the file changed after the frozen snapshot was read. ` +
				`Re-read the file and retry against the current content.`,
			);
		}
	};
	return createEditTool(cwd, {
		operations: {
			access: (absolutePath) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
			readFile: async (absolutePath) => {
				await assertUnchanged(absolutePath);
				return snapshot;
			},
			writeFile: async (absolutePath, content) => {
				await assertUnchanged(absolutePath);
				await fsWriteFile(absolutePath, content, "utf8");
			},
		},
	});
}

/** Model-visible contract: the built-in description plus copy-verbatim,
 * failure-recovery and encoding rules that prevent the common retry loops. */
export const GUARDED_EDIT_DESCRIPTION = `Edit a single file using exact text replacement.

Before calling this tool, read the target file and copy oldText VERBATIM from
the read output — byte-for-byte, including tabs, spaces and trailing
whitespace. Never construct oldText from memory or from a stale diff. Line
endings are normalized (CRLF/LF), but indentation and in-line whitespace are
not: a tab written as spaces, or a mis-copied line, will fail the exact match.

Every edits[].oldText is matched against the same frozen original file. It
must be unique unless occurrence explicitly selects one of several exact
matches using a 1-based candidate number. Matching is exact-first, then fuzzy
(trailing whitespace and Unicode quotes/dashes are ignored). If two changes
affect the same block or nearby lines, merge them into one edit instead of
emitting overlapping edits. Do not include large unchanged regions just to
connect distant changes.

On failure ("Could not find edits[N]" or "Found N occurrences of the text"),
re-read the reported candidate lines and either add enough surrounding context
to make oldText unique or set occurrence to the intended exact match. Never
blindly retry the same oldText, and never guess between ambiguous candidates.

Refusal: files that are not valid UTF-8 (e.g. GBK) are rejected to prevent
corrupting non-ASCII bytes. Convert the file to UTF-8 first (e.g.
iconv -f GBK -t UTF-8) and retry.`;

/** Preserve pi's legacy argument compatibility while validating against the
 * guarded schema that adds edits[].occurrence. */
export function prepareGuardedEditArguments(input: unknown): GuardedEditInput {
	const original = getEditTool(process.cwd());
	return (original.prepareArguments?.(input) ?? input) as GuardedEditInput;
}

/** Shared execute path for normal and quiet renderers. */
export async function executeGuardedEdit(
	toolCallId: string,
	params: GuardedEditInput,
	signal: AbortSignal | undefined,
	onUpdate: EditOnUpdate,
	ctx: ExtensionContext,
) {
	const snapshot = await readValidatedUtf8File(params.path, ctx.cwd);
	const edits = snapshot === undefined
		? params.edits.map(({ oldText, newText }) => ({ oldText, newText }))
		: prepareSnapshotEdits(snapshot.text, params.path, params.edits);
	const tool = snapshot === undefined
		? getEditTool(ctx.cwd)
		: createFrozenEditTool(ctx.cwd, params.path, snapshot.bytes);
	return tool.execute(toolCallId, { path: params.path, edits }, signal, onUpdate);
}

/**
 * Re-register the built-in "edit" tool under the same name. Execution delegates
 * to pi after UTF-8 validation and frozen-snapshot occurrence disambiguation.
 */
export function registerGuardedEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: GUARDED_EDIT_DESCRIPTION,
		parameters: GUARDED_EDIT_PARAMETERS,
		prepareArguments: prepareGuardedEditArguments,
		promptGuidelines: [
			"Before calling edit, read the target file and copy oldText verbatim; all edits match the same frozen original. If oldText has multiple exact matches, add context or set the 1-based occurrence selector instead of guessing.",
		],
		execute: executeGuardedEdit,
	} satisfies ToolDefinition<typeof GUARDED_EDIT_PARAMETERS, EditToolDetails | undefined>);
}
