import {
	CompactionSummaryMessageComponent,
	keyText,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";

const COMPACTION_STYLE_MARKER = Symbol.for("pi-cockpit.compaction-style");
const NEW_CONTEXT_CAPSULE = "Maestro New Context Recovery Capsule";

interface CompactionSummaryLike {
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

interface CompactionComponentInternals {
	expanded: boolean;
	message: CompactionSummaryLike;
	clear(): void;
	addChild(component: Component): void;
}

interface CompactionTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

interface StyleProvider {
	isEnabled(): boolean;
	getTheme(): CompactionTheme | undefined;
	getGlyphs(): IconGlyphs;
}

const PLAIN_THEME: CompactionTheme = {
	fg: (_role, text) => text,
	bold: (text) => text,
};

type UpdateDisplay = (this: CompactionComponentInternals) => void;

interface CompactionStyleMarker {
	original: UpdateDisplay;
	retain(provider: StyleProvider): () => void;
}

export interface CompactionStylePatch {
	active: boolean;
	detach(): void;
}

export interface CompactionSummaryDetails {
	kind: "new-context" | "compaction";
	checkpoint?: string;
	todo?: string;
	nextTask?: string;
	lineCount: number;
	byteCount: number;
}

function once(action: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		action();
	};
}

function clean(value: string, max = 180): string {
	const safe = value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

function field(summary: string, label: string): string | undefined {
	const line = summary.split("\n").find((candidate) => candidate.trimStart().startsWith(`- ${label}:`));
	if (!line) return undefined;
	const value = clean(line.slice(line.indexOf(":") + 1));
	return value || undefined;
}

function nextTask(summary: string): string | undefined {
	const section = summary.match(/## (?:Active Todo Tasks|Runnable Pending Frontier)\s*\n- \[#([^\]]+)\] ([^\n]+)/);
	if (!section) return undefined;
	const subject = clean(section[2].replace(/ \((?:in_progress|pending|blocked|completed|deleted); assignee=.*$/, ""));
	return clean(`#${section[1]} ${subject}`);
}

export function compactionSummaryDetails(summary: string): CompactionSummaryDetails {
	const normalized = typeof summary === "string" ? summary : "";
	return {
		kind: normalized.includes(NEW_CONTEXT_CAPSULE) || normalized.startsWith("<recovery_capsule")
			? "new-context"
			: "compaction",
		checkpoint: field(normalized, "Checkpoint ID"),
		todo: field(normalized, "Todo"),
		nextTask: nextTask(normalized),
		lineCount: normalized === "" ? 0 : normalized.split("\n").length,
		byteCount: Buffer.byteLength(normalized, "utf8"),
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes}B`;
	const kib = bytes / 1_024;
	return `${kib >= 10 ? Math.round(kib) : kib.toFixed(1)}KB`;
}

function card(message: CompactionSummaryLike, provider: StyleProvider): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			if (safeWidth <= 1) return [];
			const theme = provider.getTheme() ?? PLAIN_THEME;
			const glyphs = provider.getGlyphs();
			const expandHint = keyText("app.tools.expand") || "ctrl+o";
			const tokenText = message.tokensBefore.toLocaleString("en-US");
			if (!provider.isEnabled()) {
				return [
					truncateToWidth(theme.fg("customMessageLabel", theme.bold("[compaction]")), safeWidth, glyphs.ellipsis),
					"",
					truncateToWidth(
						theme.fg("customMessageText", `Compacted from ${tokenText} tokens (`)
							+ theme.fg("dim", expandHint)
							+ theme.fg("customMessageText", " to expand)"),
						safeWidth,
						glyphs.ellipsis,
					),
				];
			}

			const details = compactionSummaryDetails(message.summary);
			const title = details.kind === "new-context" ? "new context" : "compaction";
			const summaryKind = details.kind === "new-context" ? "deterministic recovery capsule" : "model summary";
			const rows = [`${theme.fg("success", `${glyphs.check} complete`)}  ${summaryKind}`];
			if (details.todo) rows.push(`${theme.fg("accent", `${glyphs.pending} todo`)}      ${details.todo}`);
			if (details.nextTask) rows.push(`${theme.fg("warning", `${glyphs.arrow} next`)}      ${details.nextTask}`);
			rows.push(theme.fg("dim", [
				details.checkpoint ? `checkpoint ${details.checkpoint}` : "summary",
				`${details.lineCount} lines`,
				formatBytes(details.byteCount),
				`${expandHint} expand`,
			].join(" · ")));

			const cardWidth = safeWidth - 1;
			const label = `${theme.fg("success", glyphs.check)} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("dim", `· ${tokenText} tokens`)}`;
			if (cardWidth < 6) return [truncateToWidth(label, cardWidth, glyphs.ellipsis)];

			const innerWidth = cardWidth - 2;
			const contentWidth = Math.max(1, innerWidth - 2);
			const fit = (text: string, target: number): string => {
				const clipped = truncateToWidth(text, target, glyphs.ellipsis);
				return `${clipped}${" ".repeat(Math.max(0, target - visibleWidth(clipped)))}`;
			};
			const header = truncateToWidth(` ${label} `, innerWidth, glyphs.ellipsis);
			const body = rows.flatMap((row) => wrapTextWithAnsi(row, contentWidth));
			return [
				`${theme.fg("dim", glyphs.box.topLeft)}${header}${theme.fg("dim", `${glyphs.box.horizontal.repeat(Math.max(0, innerWidth - visibleWidth(header)))}${glyphs.box.topRight}`)}`,
				...body.map((row) => `${theme.fg("dim", glyphs.box.vertical)} ${fit(row, contentWidth)} ${theme.fg("dim", glyphs.box.vertical)}`),
				theme.fg("dim", `${glyphs.box.bottomLeft}${glyphs.box.horizontal.repeat(innerWidth)}${glyphs.box.bottomRight}`),
			];
		},
		invalidate(): void {},
	};
}

function markerOf(value: unknown): CompactionStyleMarker | undefined {
	if (typeof value !== "function") return undefined;
	return (value as UpdateDisplay & Record<symbol, CompactionStyleMarker | undefined>)[COMPACTION_STYLE_MARKER];
}

/**
 * Pi does not expose a renderer hook for its built-in compaction message. Patch
 * the exported component's stable method while Cockpit is active, and retain the
 * native expanded Markdown view and a reversible fallback for incompatible hosts.
 */
export function attachCompactionStyle(provider: StyleProvider): CompactionStylePatch {
	try {
		const prototype = CompactionSummaryMessageComponent.prototype as unknown as object;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
		if (!descriptor || typeof descriptor.value !== "function" || descriptor.writable !== true) {
			return { active: false, detach() {} };
		}
		const existing = markerOf(descriptor.value);
		if (existing) return { active: true, detach: existing.retain(provider) };

		const original = descriptor.value as UpdateDisplay;
		const providers: StyleProvider[] = [provider];
		const wrapped: UpdateDisplay = function () {
			const active = providers.at(-1);
			if (!active || this.expanded || typeof this.message?.summary !== "string") {
				original.call(this);
				return;
			}
			try {
				this.clear();
				this.addChild(card(this.message, active));
			} catch {
				original.call(this);
			}
		};
		const release = (retained: StyleProvider): void => {
			const index = providers.lastIndexOf(retained);
			if (index >= 0) providers.splice(index, 1);
			if (providers.length === 0 && Object.getOwnPropertyDescriptor(prototype, "updateDisplay")?.value === wrapped) {
				Object.defineProperty(prototype, "updateDisplay", descriptor);
			}
		};
		const retain = (retained: StyleProvider): (() => void) => {
			providers.push(retained);
			return once(() => release(retained));
		};
		Object.defineProperty(wrapped, COMPACTION_STYLE_MARKER, {
			value: { original, retain } satisfies CompactionStyleMarker,
		});
		Object.defineProperty(prototype, "updateDisplay", { ...descriptor, value: wrapped });
		if (Object.getOwnPropertyDescriptor(prototype, "updateDisplay")?.value !== wrapped) {
			return { active: false, detach() {} };
		}
		return { active: true, detach: once(() => release(provider)) };
	} catch {
		return { active: false, detach() {} };
	}
}
