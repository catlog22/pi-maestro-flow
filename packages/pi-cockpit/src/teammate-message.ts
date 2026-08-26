import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { tuiT } from "./tui-i18n.ts";

export const TEAMMATE_MESSAGE_CUSTOM_TYPE = "teammate-message";

interface TeammateMessageDetails {
	source?: unknown;
	provenance?: unknown;
}

interface TeammateMessageEnvelope {
	kind?: string;
	sender: string;
	guidance: string;
	body: string;
}

type MessageContent = string | Array<{ type: string; text?: string }>;

function cleanMultiline(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
		.trimEnd();
}

function contentText(content: MessageContent): string {
	if (typeof content === "string") return cleanMultiline(content);
	return cleanMultiline(content
		.filter((entry) => entry.type === "text" && typeof entry.text === "string")
		.map((entry) => entry.text)
		.join("\n"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function provenanceHeader(details: TeammateMessageDetails | undefined): { sender?: string; kind?: string } {
	if (!isRecord(details?.provenance)) return {};
	const provenance = details.provenance;
	const sender = isRecord(provenance.sender) && typeof provenance.sender.label === "string"
		? provenance.sender.label.trim()
		: typeof provenance.legacyLabel === "string"
			? provenance.legacyLabel.trim()
			: undefined;
	const kind = typeof provenance.messageKind === "string"
		? provenance.messageKind.trim()
		: undefined;
	return {
		...(sender ? { sender } : {}),
		...(kind ? { kind } : {}),
	};
}

export function parseTeammateMessageEnvelope(
	content: MessageContent,
	details?: TeammateMessageDetails,
): TeammateMessageEnvelope {
	const text = contentText(content);
	const lines = text.split("\n");
	const header = lines[0]?.match(/^\[(?:teammate|workspace):([^\]]+)\]\s+from\s+(.+)$/);
	const fallback = provenanceHeader(details);
	const sender = header?.[2]?.trim() || fallback.sender || "teammate";
	const kind = header?.[1]?.trim() || fallback.kind;
	const payloadLines = header ? lines.slice(1) : lines;
	const separator = payloadLines.findIndex((line) => line.trim() === "---");
	if (separator < 0) {
		return { sender, ...(kind ? { kind } : {}), guidance: "", body: payloadLines.join("\n").trim() };
	}
	return {
		sender,
		...(kind ? { kind } : {}),
		guidance: payloadLines.slice(0, separator).join("\n").trim(),
		body: payloadLines.slice(separator + 1).join("\n").trim(),
	};
}

const KIND_KEYS: Readonly<Record<string, string>> = {
	message: "message.kind.message",
	coordination: "message.kind.coordination",
	request: "message.kind.request",
	status: "message.kind.status",
	supervision: "message.kind.supervision",
};

function kindLabel(kind: string | undefined): string | undefined {
	if (!kind) return undefined;
	const key = KIND_KEYS[kind];
	return key ? tuiT(key) : kind;
}

const COLLAPSED_BODY_LINES = 2;

function collapsedBody(value: string, width: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return "";
	const lineWidth = Math.max(1, width);
	const lines = wrapTextWithAnsi(text, lineWidth);
	if (lines.length <= COLLAPSED_BODY_LINES) return lines.join("\n");

	const preview = lines.slice(0, COLLAPSED_BODY_LINES);
	const last = preview.length - 1;
	const ellipsisWidth = Math.max(1, visibleWidth("…"));
	const prefix = truncateToWidth(
		preview[last] ?? "",
		Math.max(0, lineWidth - ellipsisWidth),
		"",
	);
	preview[last] = `${prefix}…`;
	return preview.join("\n");
}

export function renderIncomingTeammateMessage(
	message: { content: MessageContent; details?: TeammateMessageDetails },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const envelope = parseTeammateMessageEnvelope(message.content, message.details);
	const kind = kindLabel(envelope.kind);
	const header = [
		`${theme.fg("accent", "←")} ${theme.bold(tuiT("message.receivedFrom", { sender: envelope.sender }))}`,
		kind ? theme.fg("muted", `· ${kind}`) : "",
	].filter(Boolean).join(" ");
	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild({
		render(width: number): string[] {
			const sections = [header];
			if (options.expanded && envelope.guidance) sections.push(theme.fg("dim", envelope.guidance));
			if (envelope.body) {
				const body = options.expanded ? envelope.body : collapsedBody(envelope.body, width);
				sections.push(theme.fg("text", body));
			} else if (!options.expanded && envelope.guidance) {
				sections.push(theme.fg("text", collapsedBody(envelope.guidance, width)));
			}
			return new Text(sections.join("\n"), 0, 0).render(width);
		},
		invalidate(): void {},
	});
	return box;
}

export function registerTeammateMessageRenderer(
	pi: Pick<ExtensionAPI, "registerMessageRenderer">,
	isEnabled: () => boolean = () => true,
): void {
	pi.registerMessageRenderer<TeammateMessageDetails>(
		TEAMMATE_MESSAGE_CUSTOM_TYPE,
		(message, options, theme) => isEnabled()
			? renderIncomingTeammateMessage(message, options, theme)
			: undefined,
	);
}
