import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { SshHostPickerEntry } from "pi-maestro-teammate/v1/ssh-hosts";
import type { EndpointStoreSnapshot } from "./endpoint-store.ts";
import {
	applyTargetSelectorCompletion,
	buildTargetSelectorItems,
	isSshAttachmentControlInput,
	parseTargetInput,
	parseTargetSelector,
	resolveTargetId,
	resolveTargetRoute,
	type DirectTargetKind,
	type TargetDescriptor,
	type TargetSelectorItem,
	type TargetSendMode,
} from "./target-routing.ts";

export interface CanonicalEndpointTarget {
	readonly kind: DirectTargetKind;
	readonly id: string;
	readonly label: string;
	readonly routeSelector: string;
	readonly status: string;
	readonly capabilities: readonly string[];
}

export interface CockpitTargetCatalogue {
	readonly targets: readonly TargetDescriptor[];
	readonly endpoints: readonly CanonicalEndpointTarget[];
	/** False means exact SSH activation may still unlock and validate the id. */
	readonly sshAvailable: boolean;
}

export interface PendingTargetReference {
	readonly kind: DirectTargetKind;
	readonly id: string;
}

export type CanonicalTargetInputAction =
	| { readonly action: "handled" }
	| { readonly action: "transform"; readonly text: string; readonly reference?: PendingTargetReference };

export interface CanonicalTargetInputOptions {
	readonly text: string;
	readonly hasImages: boolean;
	readonly getCatalogue: () => Promise<CockpitTargetCatalogue>;
	readonly activateSsh: (hostId: string) => Promise<void>;
	readonly send?: (request: {
		readonly selector: string;
		readonly message: string;
		readonly mode: TargetSendMode;
	}) => Promise<{ readonly delivered: boolean; readonly error?: string }>;
	readonly notify: (message: string, type: "warning" | "error") => void;
	readonly restore: (text: string) => void;
}

function endpointTarget(
	kind: DirectTargetKind,
	id: string,
	label: string,
	routeSelector: string,
	status: string,
	capabilities: readonly string[],
): CanonicalEndpointTarget {
	return { kind, id, label, routeSelector, status, capabilities: [...capabilities] };
}

/** Build bounded selector descriptors from one authoritative endpoint snapshot. */
export function buildCockpitTargetCatalogue(
	snapshot: EndpointStoreSnapshot,
	sshEntries: readonly SshHostPickerEntry[] = [],
	sshAvailable = true,
): CockpitTargetCatalogue {
	const endpoints: CanonicalEndpointTarget[] = [];
	const targets: TargetDescriptor[] = [];
	for (const endpoint of snapshot.endpoints) {
		if (endpoint.kind !== "agent" || !endpoint.correlationId) continue;
		const capabilities = endpoint.registryEndpoint?.capabilities ?? [];
		endpoints.push(endpointTarget(
			"agent",
			endpoint.correlationId,
			endpoint.label,
			endpoint.routeSelector,
			endpoint.status,
			capabilities,
		));
		targets.push({
			kind: "agent",
			id: endpoint.correlationId,
			label: endpoint.label,
			description: [endpoint.status, ...capabilities].join(" · "),
		});
	}

	const seenOwners = new Set<string>();
	const windows = [
		...snapshot.endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.registryEndpoint?.scope === "local"),
		...snapshot.windows.filter((endpoint) => endpoint.kind === "window"),
	];
	for (const endpoint of windows) {
		const registryEndpoint = endpoint.registryEndpoint;
		if (!registryEndpoint || seenOwners.has(registryEndpoint.ownerId)) continue;
		seenOwners.add(registryEndpoint.ownerId);
		const current = registryEndpoint.scope === "local";
		const label = current ? "control" : endpoint.label;
		endpoints.push(endpointTarget(
			"window",
			registryEndpoint.ownerId,
			label,
			endpoint.routeSelector,
			endpoint.status,
			registryEndpoint.capabilities,
		));
		targets.push({
			kind: "window",
			id: registryEndpoint.ownerId,
			label,
			description: `${endpoint.status} · ${registryEndpoint.scope}`,
			...(current ? { current: true } : {}),
		});
	}

	for (const entry of sshEntries) {
		const host = entry.host.includes(":") && !entry.host.startsWith("[") ? `[${entry.host}]` : entry.host;
		targets.push({
			kind: "ssh",
			id: entry.id,
			label: entry.label,
			description: `${entry.user}@${host}:${entry.port} · ${entry.shell}`,
			...(entry.selected ? { current: true } : {}),
		});
	}
	return { targets, endpoints, sshAvailable };
}

export function findCanonicalEndpoint(
	catalogue: CockpitTargetCatalogue,
	kind: DirectTargetKind,
	id: string,
): CanonicalEndpointTarget | undefined {
	return catalogue.endpoints.find((endpoint) => endpoint.kind === kind && endpoint.id === id);
}

function autocompleteKey(item: AutocompleteItem): string {
	return `${item.value}\0${item.label ?? ""}\0${item.description ?? ""}`;
}

function autocompleteItem(item: TargetSelectorItem): { ui: AutocompleteItem; target: TargetSelectorItem } {
	const value = item.nextValue ?? item.value;
	const target = value === item.value ? item : { ...item, value, insertText: value };
	return {
		ui: {
			value,
			label: item.label,
			...(item.description ? { description: item.description } : {}),
		},
		target,
	};
}

/** Compose canonical staged `#` completion ahead of the legacy window provider. */
export function createTargetAutocompleteProvider(
	current: AutocompleteProvider,
	getCatalogue: () => Promise<CockpitTargetCatalogue>,
): AutocompleteProvider {
	const selections = new Map<string, TargetSelectorItem>();
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#", ":"])],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			if (cursorLine !== 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const query = parseTargetSelector(beforeCursor);
			if (!query || query.stage === "none") {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const catalogue = await getCatalogue();
			const built = buildTargetSelectorItems(beforeCursor, catalogue.targets).map(autocompleteItem);
			if (built.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			for (const item of built) selections.set(autocompleteKey(item.ui), item.target);
			return { items: built.map((item) => item.ui), prefix: beforeCursor };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const selected = selections.get(autocompleteKey(item));
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			if (!selected || prefix !== beforeCursor) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const applied = applyTargetSelectorCompletion(beforeCursor, selected);
			if (!applied) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const nextLines = [...lines];
			nextLines[cursorLine] = `${applied.text}${line.slice(cursorCol)}`;
			return { lines: nextLines, cursorLine, cursorCol: applied.cursor };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Route one recognized canonical target input; ordinary and legacy text returns undefined. */
export async function routeCanonicalTargetInput(
	options: CanonicalTargetInputOptions,
): Promise<CanonicalTargetInputAction | undefined> {
	if (isSshAttachmentControlInput(options.text)) return undefined;
	const parsed = parseTargetInput(options.text);
	if (parsed === undefined) return undefined;
	const fail = (message: string, type: "warning" | "error" = "warning"): CanonicalTargetInputAction => {
		options.notify(message, type);
		options.restore(options.text);
		return { action: "handled" };
	};
	if (!parsed.ok) return fail(parsed.message);
	if (parsed.direct && options.hasImages) {
		return fail("Images cannot be delivered directly to another target; reattach them in that target session.");
	}

	let catalogue: CockpitTargetCatalogue;
	try {
		catalogue = await options.getCatalogue();
	} catch (error) {
		return fail(errorText(error), "error");
	}

	if (parsed.kind === "ssh") {
		let hostId = parsed.id;
		if (catalogue.sshAvailable) {
			const resolved = resolveTargetRoute(parsed, catalogue.targets);
			if (resolved.code !== "resolved") return fail(resolved.message);
			hostId = resolved.target.id;
		}
		try {
			await options.activateSsh(hostId);
		} catch (error) {
			return fail(errorText(error), "error");
		}
		return parsed.request
			? { action: "transform", text: parsed.request }
			: { action: "handled" };
	}

	const resolved = resolveTargetRoute(parsed, catalogue.targets);
	if (resolved.code !== "resolved") return fail(resolved.message);
	if (!parsed.direct) {
		const endpoint = findCanonicalEndpoint(catalogue, parsed.kind, resolved.target.id);
		if (!endpoint) return fail("The target is no longer available.");
		return {
			action: "transform",
			text: parsed.request,
			reference: { kind: parsed.kind, id: endpoint.id },
		};
	}

	let fresh: CockpitTargetCatalogue;
	try {
		fresh = await options.getCatalogue();
	} catch (error) {
		return fail(errorText(error), "error");
	}
	const live = resolveTargetId(parsed.kind, resolved.target.id, fresh.targets);
	if (live.code !== "resolved" || live.match !== "exact") return fail("The target is no longer available.");
	const endpoint = findCanonicalEndpoint(fresh, parsed.kind, live.target.id);
	if (!endpoint) return fail("The target is no longer available.");
	if (!endpoint.capabilities.includes(parsed.mode)) {
		return fail(`Target ${JSON.stringify(endpoint.label)} does not support ${parsed.mode}.`);
	}
	if (!options.send) return fail("Target delivery is unavailable.", "error");
	try {
		const delivery = await options.send({
			selector: endpoint.routeSelector,
			message: parsed.message,
			mode: parsed.mode,
		});
		return delivery.delivered
			? { action: "handled" }
			: fail(delivery.error ?? "Target delivery was rejected.", "error");
	} catch (error) {
		return fail(errorText(error), "error");
	}
}

function contextText(value: string, maximum: number): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/** Resolve and format one fresh, bounded main-agent reference context. */
export function formatPendingTargetContext(
	reference: PendingTargetReference,
	catalogue: CockpitTargetCatalogue,
): string | undefined {
	const endpoint = findCanonicalEndpoint(catalogue, reference.kind, reference.id);
	if (!endpoint) return undefined;
	const capabilities = endpoint.capabilities
		.slice(0, 32)
		.map((capability) => contextText(capability, 64))
		.filter(Boolean);
	return `<cockpit-target-context>\nThe user referenced a ${endpoint.kind} target for this one main-agent request. Authoritative target metadata: id ${JSON.stringify(contextText(endpoint.id, 512))}, label ${JSON.stringify(contextText(endpoint.label, 160))}, route ${JSON.stringify(contextText(endpoint.routeSelector, 1024))}, status ${JSON.stringify(contextText(endpoint.status, 64))}, capabilities ${JSON.stringify(capabilities)}. This context does not reroute the request or prove that another model consumed a message.\n</cockpit-target-context>`;
}
