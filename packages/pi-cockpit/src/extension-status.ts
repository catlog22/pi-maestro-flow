import { stripVTControlCharacters } from "node:util";

export interface ExtensionStatusSegment {
	key: string;
	text: string;
}

export function sanitizeExtensionStatusText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\r\n\t\f\v]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function collectExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): ExtensionStatusSegment[] {
	const segments: ExtensionStatusSegment[] = [];
	for (const [key, value] of statuses) {
		const text = sanitizeExtensionStatusText(value);
		if (text) segments.push({ key, text });
	}
	return segments.sort((a, b) => a.key.localeCompare(b.key));
}
