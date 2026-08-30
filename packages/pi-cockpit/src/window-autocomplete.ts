import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { CockpitEndpoint, EndpointStoreSnapshot } from "./endpoint-store.ts";

const OWNER_LABEL_LENGTH = 6;
const MAX_WINDOW_SUGGESTIONS = 20;

export interface WindowAutocompleteLabels {
	current: string;
	peer: string;
}

export interface WindowAutocompleteTarget {
	token: string;
	label: string;
	description: string;
	routeSelector: string;
	ownerId: string;
	ownerNonce: string;
	current: boolean;
}

export type WindowRouteResolution = {
	code: "resolved";
	token: string;
	target: WindowAutocompleteTarget;
	message: string;
} | {
	code: "stale" | "ambiguous";
	token: string;
	message: string;
};

function targetToken(label: string, ownerId: string): string {
	const normalized = label
		.replace(/[\s#]+/g, "-")
		.replace(/^-+|-+$/g, "") || "window";
	const suffix = `·${ownerId.slice(0, OWNER_LABEL_LENGTH)}`;
	return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function targetFromEndpoint(
	endpoint: CockpitEndpoint,
	current: boolean,
	labels: WindowAutocompleteLabels,
): WindowAutocompleteTarget | undefined {
	const registryEndpoint = endpoint.registryEndpoint;
	if (!registryEndpoint || registryEndpoint.kind !== "root") return undefined;
	const ownerTarget = `owner:${registryEndpoint.ownerId}`;
	const displayLabel = current ? "control" : endpoint.label;
	return {
		token: targetToken(displayLabel, registryEndpoint.ownerId),
		label: displayLabel,
		description: [
			current ? labels.current : labels.peer,
			ownerTarget,
			`incarnation:${registryEndpoint.ownerNonce}`,
			registryEndpoint.sessionId ? `session:${registryEndpoint.sessionId}` : undefined,
		].filter(Boolean).join(" · "),
		routeSelector: endpoint.routeSelector,
		ownerId: registryEndpoint.ownerId,
		ownerNonce: registryEndpoint.ownerNonce,
		current,
	};
}

export function buildWindowAutocompleteTargets(
	snapshot: EndpointStoreSnapshot,
	labels: WindowAutocompleteLabels,
): WindowAutocompleteTarget[] {
	const currentRoot = snapshot.endpoints.find((endpoint) =>
		endpoint.kind === "root" && endpoint.registryEndpoint?.scope === "local"
	);
	const targets: WindowAutocompleteTarget[] = [];
	if (currentRoot) {
		const current = targetFromEndpoint(currentRoot, true, labels);
		if (current) targets.push(current);
	}
	for (const endpoint of snapshot.windows) {
		if (endpoint.registryEndpoint?.scope !== "workspace-peer") continue;
		const target = targetFromEndpoint(endpoint, false, labels);
		if (target) targets.push(target);
	}
	return targets;
}

export function extractWindowCompletionQuery(textBeforeCursor: string): string | undefined {
	return /^[ \t]*#([^\s#]*)$/.exec(textBeforeCursor)?.[1];
}

function matchingTargets(
	targets: readonly WindowAutocompleteTarget[],
	query: string,
): WindowAutocompleteTarget[] {
	const normalized = query.trim().toLocaleLowerCase("en");
	if (!normalized) return targets.slice(0, MAX_WINDOW_SUGGESTIONS);
	return targets.filter((target) => [
		target.token,
		target.label,
		target.ownerId,
		target.description,
	].some((value) => value.toLocaleLowerCase("en").includes(normalized)))
		.slice(0, MAX_WINDOW_SUGGESTIONS);
}

function completionItem(target: WindowAutocompleteTarget): AutocompleteItem {
	return {
		value: `#${target.token}`,
		label: `#${target.token}`,
		description: target.description,
	};
}

export function createWindowAutocompleteProvider(
	current: AutocompleteProvider,
	getTargets: () => readonly WindowAutocompleteTarget[],
	onSelect: (target: WindowAutocompleteTarget) => void,
): AutocompleteProvider {
	const suggestedTargets = new Map<string, WindowAutocompleteTarget>();
	const suggestionKey = (item: AutocompleteItem): string => `${item.value}\0${item.description ?? ""}`;
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#"])],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			if (cursorLine !== 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const currentLine = lines[cursorLine] ?? "";
			const query = extractWindowCompletionQuery(currentLine.slice(0, cursorCol));
			if (query === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const targets = matchingTargets(getTargets(), query);
			if (targets.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const items = targets.map(completionItem);
			for (let index = 0; index < items.length; index++) {
				suggestedTargets.set(suggestionKey(items[index]!), targets[index]!);
			}
			return {
				items,
				prefix: `#${query}`,
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const selected = suggestedTargets.get(suggestionKey(item));
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			if (!selected || !prefix.startsWith("#") || beforePrefix.trim()) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			onSelect(selected);
			const afterCursor = currentLine.slice(cursorCol);
			const separator = afterCursor.length === 0 || !/^\s/.test(afterCursor) ? " " : "";
			const nextLine = `${beforePrefix}${item.value}${separator}${afterCursor}`;
			const nextLines = [...lines];
			nextLines[cursorLine] = nextLine;
			return {
				lines: nextLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + separator.length,
			};
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function resolveWindowRouteInput(
	text: string,
	targets: readonly WindowAutocompleteTarget[],
	selectedTargets: ReadonlyMap<string, WindowAutocompleteTarget> = new Map(),
): WindowRouteResolution | undefined {
	const match = /^[ \t]*#([^\s#]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const rawToken = match[1]!;
	const token = rawToken.toLocaleLowerCase("en");
	const message = (match[2] ?? "").trim();
	const selected = selectedTargets.get(token);
	if (selected) {
		const live = targets.filter((candidate) =>
			candidate.routeSelector === selected.routeSelector
			&& candidate.ownerId === selected.ownerId
			&& candidate.ownerNonce === selected.ownerNonce
		);
		return live.length === 1
			? { code: "resolved", token, target: live[0]!, message }
			: { code: "stale", token: rawToken, message };
	}
	const matches = targets.filter((candidate) => candidate.token.toLocaleLowerCase("en") === token);
	if (matches.length > 1) return { code: "ambiguous", token: rawToken, message };
	if (matches.length === 0) return undefined;
	return { code: "resolved", token, target: matches[0]!, message };
}
