import type {
	SessionEndpoint,
	SessionHostSnapshot,
	SessionMessageRequest,
	SessionMessageResult,
	SessionMonitorOptions,
	SessionViewMode,
	WindowThreadEntry,
} from "pi-maestro-teammate/v1/sessions";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { AgentRow } from "./types.ts";

export const SESSION_HOST_REGISTRY_EVENT = "teammate:sessions";
export const SESSION_HOST_REGISTRY_KEY = Symbol.for("pi-maestro-teammate.session-host-registry.v1");
export const LEGACY_MAIN_ENDPOINT_ID = "cockpit-session/v1/main";

export interface SessionMessageRouterLike {
	route(request: SessionMessageRequest): Promise<SessionMessageResult>;
}

/** Structural subset used so Cockpit can still load without the optional peer. */
export interface SessionHostRegistryLike {
	snapshot(): SessionHostSnapshot;
	subscribe(
		subscriber: (snapshot: SessionHostSnapshot) => void,
		options?: { emitCurrent?: boolean },
	): () => void;
	send?(request: SessionMessageRequest): Promise<SessionMessageResult>;
	requestWindowMode?(action: "enter" | "exit"): Promise<void>;
	setMonitored?(endpointId: string, enabled: boolean, options?: SessionMonitorOptions): Promise<void>;
	router?: SessionMessageRouterLike;
}

export interface SessionEventSource {
	on(event: string, handler: (payload: unknown) => void): () => void;
}

export interface CockpitEndpoint {
	/** Canonical registry id when available; deterministic legacy id otherwise. */
	id: string;
	/** Source-independent identity used to migrate UI state onto canonical ids. */
	logicalKey: string;
	kind: "root" | "agent" | "window";
	label: string;
	ordinal: number;
	correlationId?: string;
	status: SessionEndpoint["status"];
	contentRevision: string;
	/** Changes only when user-visible output changes, not for heartbeat/status churn. */
	outputRevision?: string;
	/** Exact selector passed to SessionHostRegistry.send/MessageRouter. */
	routeSelector: string;
	source: "registry" | "legacy";
	registryEndpoint?: SessionEndpoint;
	agentRow?: AgentRow;
	contextPressure?: number;
	agentCount?: number;
	remoteAgents?: readonly SessionEndpoint[];
}

export interface EndpointStoreSnapshot {
	contentRevision: string;
	mainEndpointId: string;
	viewMode: SessionViewMode;
	monitoredEndpointIds: readonly string[];
	endpoints: readonly CockpitEndpoint[];
	windows: readonly CockpitEndpoint[];
	thread: readonly WindowThreadEntry[];
}

export interface EndpointStoreOptions {
	getLegacyAgents: () => readonly AgentRow[];
}

export interface EndpointStoreConnectOptions {
	registry?: SessionHostRegistryLike;
	events?: SessionEventSource;
}

function legacyAgentEndpointId(correlationId: string): string {
	return `cockpit-session/v1/agent/${encodeURIComponent(correlationId)}`;
}

function endpointLogicalKey(endpoint: Pick<SessionEndpoint, "kind" | "correlationId">): string {
	return endpoint.kind === "root" ? "main" : `agent:${endpoint.correlationId ?? ""}`;
}

function cleanLabel(value: string | undefined, fallback: string): string {
	const clean = sanitizeExtensionStatusText(value ?? "").trim();
	return clean || fallback;
}

/** Stable 32-bit FNV-1a. This is change detection, not a security boundary. */
function revisionOf(value: unknown): string {
	const text = JSON.stringify(value);
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isEndpoint(value: unknown): value is SessionEndpoint {
	if (!value || typeof value !== "object") return false;
	const endpoint = value as Partial<SessionEndpoint>;
	return endpoint.version === 1
		&& typeof endpoint.id === "string"
		&& endpoint.id.length > 0
		&& (endpoint.kind === "root" || endpoint.kind === "agent")
		&& (endpoint.scope === "local" || endpoint.scope === "workspace-peer")
		&& typeof endpoint.workspaceId === "string"
		&& typeof endpoint.ownerId === "string"
		&& typeof endpoint.ownerNonce === "string"
		&& typeof endpoint.ordinal === "number"
		&& Number.isSafeInteger(endpoint.ordinal)
		&& typeof endpoint.contentRevision === "string"
		&& (endpoint.status === "running" || endpoint.status === "sleeping" || endpoint.status === "settled");
}

function sessionSnapshot(value: unknown): SessionHostSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const snapshot = value as Partial<SessionHostSnapshot>;
	if (snapshot.version !== 1 || !Array.isArray(snapshot.endpoints)) return undefined;
	if (!snapshot.endpoints.every(isEndpoint)) return undefined;
	return snapshot as SessionHostSnapshot;
}

export function isSessionHostRegistryLike(value: unknown): value is SessionHostRegistryLike {
	if (!value || typeof value !== "object") return false;
	const registry = value as Partial<SessionHostRegistryLike>;
	return typeof registry.snapshot === "function" && typeof registry.subscribe === "function";
}

function sameOwner(left: SessionEndpoint, right: SessionEndpoint): boolean {
	return left.workspaceId === right.workspaceId
		&& left.ownerId === right.ownerId
		&& left.ownerNonce === right.ownerNonce;
}

function visibleLegacyRows(rows: readonly AgentRow[]): AgentRow[] {
	return rows
		.filter((row) => !row.agent.startsWith("graph("))
		.sort((left, right) => left.startedAt - right.startedAt || left.correlationId.localeCompare(right.correlationId, "en"));
}

/**
 * Canonical local endpoint projection for Cockpit.
 *
 * Registry snapshots own ids and ordinals. AgentsStore remains the content and
 * status fallback for older Teammate versions and for the short startup window
 * before the registry publishes its local root.
 */
export class EndpointStore {
	readonly #getLegacyAgents: EndpointStoreOptions["getLegacyAgents"];
	#registry: SessionHostRegistryLike | undefined;
	#registrySnapshot: SessionHostSnapshot | undefined;
	#registryDisposer: (() => void) | undefined;
	#eventDisposer: (() => void) | undefined;
	#mainOutputRevision: string | undefined;
	#snapshot: EndpointStoreSnapshot = Object.freeze({
		contentRevision: revisionOf([]),
		mainEndpointId: LEGACY_MAIN_ENDPOINT_ID,
		viewMode: "agents",
		monitoredEndpointIds: Object.freeze([]),
		endpoints: Object.freeze([]),
		windows: Object.freeze([]),
		thread: Object.freeze([]),
	});
	#subscribers = new Set<(snapshot: EndpointStoreSnapshot) => void>();

	constructor(options: EndpointStoreOptions) {
		this.#getLegacyAgents = options.getLegacyAgents;
		this.refreshLegacy();
	}

	connect(options: EndpointStoreConnectOptions = {}): void {
		this.disconnect();
		this.#registrySnapshot = undefined;
		this.#registry = options.registry;
		if (options.registry) {
			try {
				this.applyRegistrySnapshot(options.registry.snapshot());
			} catch {
				this.#registrySnapshot = undefined;
			}
			try {
				this.#registryDisposer = options.registry.subscribe(
					(snapshot) => this.applyRegistrySnapshot(snapshot),
					{ emitCurrent: false },
				);
			} catch {
				this.#registryDisposer = undefined;
			}
		}
		if (options.events) {
			this.#eventDisposer = options.events.on(
				SESSION_HOST_REGISTRY_EVENT,
				(payload) => this.applyRegistrySnapshot(payload),
			);
		}
		this.refreshLegacy();
	}

	disconnect(): void {
		try { this.#registryDisposer?.(); } catch { /* best effort */ }
		try { this.#eventDisposer?.(); } catch { /* best effort */ }
		this.#registryDisposer = undefined;
		this.#eventDisposer = undefined;
		this.#registry = undefined;
	}

	get registry(): SessionHostRegistryLike | undefined {
		return this.#registry;
	}

	applyRegistrySnapshot(value: unknown): boolean {
		const next = sessionSnapshot(value);
		if (!next) return false;
		this.#registrySnapshot = next;
		return this.#rebuild();
	}

	refreshLegacy(): boolean {
		return this.#rebuild();
	}

	setMainOutputRevision(revision: string | undefined): boolean {
		if (revision === this.#mainOutputRevision) return false;
		this.#mainOutputRevision = revision;
		return this.#rebuild();
	}

	snapshot(): EndpointStoreSnapshot {
		return this.#snapshot;
	}

	get(id: string): CockpitEndpoint | undefined {
		return this.#snapshot.endpoints.find((endpoint) => endpoint.id === id)
			?? this.#snapshot.windows.find((endpoint) => endpoint.id === id);
	}

	findAgent(correlationId: string): CockpitEndpoint | undefined {
		return this.#snapshot.endpoints.find(
			(endpoint) => endpoint.kind === "agent" && endpoint.correlationId === correlationId,
		);
	}

	findWindow(ownerId: string): CockpitEndpoint | undefined {
		return this.#snapshot.windows.find((endpoint) => endpoint.registryEndpoint?.ownerId === ownerId);
	}

	subscribe(
		subscriber: (snapshot: EndpointStoreSnapshot) => void,
		options: { emitCurrent?: boolean } = {},
	): () => void {
		this.#subscribers.add(subscriber);
		if (options.emitCurrent !== false) subscriber(this.#snapshot);
		return () => this.#subscribers.delete(subscriber);
	}

	#rebuild(): boolean {
		const rows = visibleLegacyRows(this.#getLegacyAgents());
		const rowsById = new Map(rows.map((row) => [row.correlationId, row]));
		const registrySnapshot = this.#registrySnapshot;
		const local = (registrySnapshot?.endpoints ?? [])
			.filter((endpoint) => endpoint.scope === "local")
			.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"));
		const remote = (registrySnapshot?.endpoints ?? [])
			.filter((endpoint) => endpoint.scope === "workspace-peer")
			.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"));
		const root = local.find((endpoint) => endpoint.kind === "root");
		const registryAgents = root
			? local.filter((endpoint) => endpoint.kind === "agent" && sameOwner(root, endpoint))
			: [];
		const mainEndpointId = root?.id ?? LEGACY_MAIN_ENDPOINT_ID;
		const endpoints: CockpitEndpoint[] = [{
			id: mainEndpointId,
			logicalKey: "main",
			kind: "root",
			label: "main",
			ordinal: root?.ordinal ?? 0,
			status: root?.status ?? "running",
			contentRevision: root?.contentRevision ?? "legacy-main",
			...(this.#mainOutputRevision ? { outputRevision: this.#mainOutputRevision } : {}),
			routeSelector: root?.id ?? "main",
			source: root ? "registry" : "legacy",
			...(root ? { registryEndpoint: root } : {}),
		}];

		const usedRows = new Set<string>();
		for (const endpoint of registryAgents) {
			if (!endpoint.correlationId) continue;
			const row = rowsById.get(endpoint.correlationId);
			if ((row?.agent ?? endpoint.agent ?? "").startsWith("graph(")) continue;
			if (row) usedRows.add(row.correlationId);
			const output = row?.tail?.trim() || endpoint.summary?.trim();
			endpoints.push({
				id: endpoint.id,
				logicalKey: endpointLogicalKey(endpoint),
				kind: "agent",
				label: cleanLabel(row?.name || row?.role || row?.agent || endpoint.name || endpoint.agent, "agent"),
				ordinal: endpoint.ordinal,
				correlationId: endpoint.correlationId,
				status: endpoint.status,
				contentRevision: revisionOf([endpoint.contentRevision, row?.status, row?.phase, row?.lastActivityAt]),
				...(output ? { outputRevision: revisionOf(output) } : {}),
				routeSelector: endpoint.correlationId,
				source: "registry",
				registryEndpoint: endpoint,
				...(row ? { agentRow: row } : {}),
			});
		}

		let ordinal = endpoints.reduce((highest, endpoint) => Math.max(highest, endpoint.ordinal), 0) + 1;
		for (const row of rows) {
			if (usedRows.has(row.correlationId)) continue;
			const output = row.tail.trim();
			endpoints.push({
				id: legacyAgentEndpointId(row.correlationId),
				logicalKey: `agent:${row.correlationId}`,
				kind: "agent",
				label: cleanLabel(row.name || row.role || row.agent, "agent"),
				ordinal: ordinal++,
				correlationId: row.correlationId,
				status: row.status === "sleeping" ? "sleeping"
					: row.status === "done" || row.status === "failed" || row.status === "terminated" ? "settled"
						: "running",
				contentRevision: revisionOf([row.correlationId, row.status, row.phase, row.lastActivityAt, row.tail]),
				...(output ? { outputRevision: revisionOf(output) } : {}),
				routeSelector: row.correlationId,
				source: "legacy",
				agentRow: row,
			});
		}

		endpoints.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id, "en"));

		const thread = registrySnapshot?.thread ?? [];
		const windows: CockpitEndpoint[] = remote
			.filter((endpoint) => endpoint.kind === "root")
			.map((endpoint) => {
				const remoteAgents = remote.filter((candidate) =>
					candidate.kind === "agent" && sameOwner(endpoint, candidate)
				);
				const peerThread = thread.filter((entry) =>
					entry.peerOwnerId === endpoint.ownerId && entry.peerOwnerNonce === endpoint.ownerNonce
				);
				return {
					id: endpoint.id,
					logicalKey: `window:${endpoint.ownerId}`,
					kind: "window" as const,
					label: cleanLabel(endpoint.sessionName, `window:${endpoint.ownerId.slice(0, 6)}`),
					ordinal: endpoint.ordinal,
					status: endpoint.status,
					contentRevision: revisionOf([
						endpoint.contentRevision,
						remoteAgents.map((agent) => agent.contentRevision),
						peerThread.map((entry) => entry.contentRevision),
					]),
					...(peerThread.length ? { outputRevision: revisionOf(peerThread.map((entry) => entry.contentRevision)) } : {}),
					routeSelector: endpoint.id,
					source: "registry" as const,
					registryEndpoint: endpoint,
					...(endpoint.contextPressure === undefined ? {} : { contextPressure: endpoint.contextPressure }),
					agentCount: endpoint.agentCount ?? remoteAgents.filter((agent) => agent.status !== "settled").length,
					remoteAgents: Object.freeze(remoteAgents),
				};
			});
		const viewMode = registrySnapshot?.viewMode ?? "agents";
		const monitoredEndpointIds = Object.freeze([...(registrySnapshot?.monitoredEndpointIds ?? [])]);
		const contentRevision = revisionOf([
			viewMode,
			monitoredEndpointIds,
			endpoints.map((endpoint) => [
				endpoint.id,
				endpoint.logicalKey,
				endpoint.ordinal,
				endpoint.contentRevision,
				endpoint.outputRevision,
			]),
			windows.map((endpoint) => [endpoint.id, endpoint.contentRevision, endpoint.outputRevision]),
		]);
		if (contentRevision === this.#snapshot.contentRevision) return false;
		this.#snapshot = Object.freeze({
			contentRevision,
			mainEndpointId,
			viewMode,
			monitoredEndpointIds,
			endpoints: Object.freeze(endpoints),
			windows: Object.freeze(windows),
			thread: Object.freeze([...thread]),
		});
		for (const subscriber of this.#subscribers) subscriber(this.#snapshot);
		return true;
	}
}
