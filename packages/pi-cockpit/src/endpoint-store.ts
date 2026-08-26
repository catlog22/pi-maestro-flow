import type {
	SessionEndpoint,
	SessionHostSnapshot,
	SessionMessageRequest,
	SessionMessageResult,
	SessionViewMode,
	WindowThreadEntry,
} from "pi-maestro-teammate/v1/sessions";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { AgentRow } from "./types.ts";

export const SESSION_HOST_REGISTRY_EVENT = "teammate:sessions";
export const SESSION_HOST_REGISTRY_KEY = Symbol.for("pi-maestro-teammate.session-host-registry.v1");
export const LEGACY_MAIN_ENDPOINT_ID = "cockpit-session/v1/main";
export const MONITOR_CONTROL_ENDPOINT_PREFIX = "cockpit-session/v1/window-control/";

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
	endpoints: readonly CockpitEndpoint[];
	windows: readonly CockpitEndpoint[];
	thread: readonly WindowThreadEntry[];
}

export interface EndpointStoreOptions {
	getLegacyAgents: () => readonly AgentRow[];
}

export function isMonitorControlEndpoint(endpoint: CockpitEndpoint | undefined): boolean {
	return endpoint?.kind === "window" && endpoint.registryEndpoint?.scope === "local";
}

export interface EndpointStoreConnectOptions {
	registry?: SessionHostRegistryLike;
	events?: SessionEventSource;
	/** Current Cockpit Pi session; stale registry generations are rejected. */
	sessionId?: string;
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

interface LocalSessionProjection {
	workspaceId: string;
	sessionId: string;
	sourceId: string;
	generation: number;
}

function localSessionProjection(endpoint: SessionEndpoint | undefined): LocalSessionProjection | undefined {
	if (!endpoint
		|| endpoint.scope !== "local"
		|| endpoint.kind !== "root"
		|| endpoint.workspaceId.length === 0
		|| typeof endpoint.sessionId !== "string"
		|| endpoint.sessionId.length === 0
		|| typeof endpoint.sourceId !== "string"
		|| endpoint.sourceId.length === 0
		|| !Number.isSafeInteger(endpoint.generation)
		|| (endpoint.generation ?? 0) < 1) return undefined;
	return {
		workspaceId: endpoint.workspaceId,
		sessionId: endpoint.sessionId,
		sourceId: endpoint.sourceId,
		generation: endpoint.generation!,
	};
}

function sameLocalSessionProjection(
	left: LocalSessionProjection,
	right: LocalSessionProjection,
): boolean {
	return left.workspaceId === right.workspaceId
		&& left.sessionId === right.sessionId
		&& left.sourceId === right.sourceId
		&& left.generation === right.generation;
}

function localEndpointsMatchProjection(
	endpoints: readonly SessionEndpoint[],
	projection: LocalSessionProjection,
): boolean {
	return endpoints.every((endpoint) => endpoint.scope !== "local" || (
		endpoint.workspaceId === projection.workspaceId
		&& endpoint.sessionId === projection.sessionId
		&& endpoint.sourceId === projection.sourceId
		&& endpoint.generation === projection.generation
	));
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

function rowOwnedByRoot(row: AgentRow, root: SessionEndpoint): boolean {
	return row.workspaceId === root.workspaceId
		&& row.sessionId === root.sessionId
		&& row.sourceId === root.sourceId
		&& row.sessionGeneration === root.generation;
}

function visibleLegacyRows(rows: readonly AgentRow[]): AgentRow[] {
	return rows
		.filter((row) => !row.agent.startsWith("graph("))
		.sort((left, right) => left.startedAt - right.startedAt || left.correlationId.localeCompare(right.correlationId, "en"));
}

function disambiguateAgentLabels(endpoints: CockpitEndpoint[]): void {
	const counts = new Map<string, number>();
	for (const endpoint of endpoints) {
		if (endpoint.kind !== "agent") continue;
		const key = endpoint.label.toLocaleLowerCase("en");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const ordinals = new Map<string, number>();
	for (const endpoint of endpoints) {
		if (endpoint.kind !== "agent") continue;
		const key = endpoint.label.toLocaleLowerCase("en");
		if ((counts.get(key) ?? 0) < 2) continue;
		const ordinal = (ordinals.get(key) ?? 0) + 1;
		ordinals.set(key, ordinal);
		endpoint.label = `${endpoint.label}·${ordinal}`;
	}
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
	#expectedSessionId: string | undefined;
	#acceptedLocalProjection: LocalSessionProjection | undefined;
	#registryDisposer: (() => void) | undefined;
	#eventDisposer: (() => void) | undefined;
	#mainOutputRevision: string | undefined;
	#snapshot: EndpointStoreSnapshot = Object.freeze({
		contentRevision: revisionOf([]),
		mainEndpointId: LEGACY_MAIN_ENDPOINT_ID,
		viewMode: "agents",
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
		this.#expectedSessionId = options.sessionId;
		this.#registry = options.registry;
		if (options.registry) {
			try {
				this.applyRegistrySnapshot(options.registry.snapshot());
			} catch {
				this.#registrySnapshot = undefined;
				this.#acceptedLocalProjection = undefined;
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
		this.#registrySnapshot = undefined;
		this.#expectedSessionId = undefined;
		this.#acceptedLocalProjection = undefined;
		this.#rebuild();
	}

	get registry(): SessionHostRegistryLike | undefined {
		return this.#registry;
	}

	applyRegistrySnapshot(value: unknown): boolean {
		const next = sessionSnapshot(value);
		if (!next) return false;
		const localRoot = next.endpoints.find((endpoint) => endpoint.scope === "local" && endpoint.kind === "root");
		const nextProjection = localSessionProjection(localRoot);
		const sessionBound = this.#expectedSessionId !== undefined;

		// A session-bound Cockpit has no ownerless canonical compatibility mode:
		// the local root and every local endpoint must carry the full tuple.
		if (sessionBound && (!nextProjection
			|| nextProjection.sessionId !== this.#expectedSessionId
			|| !localEndpointsMatchProjection(next.endpoints, nextProjection))) return false;

		const accepted = this.#acceptedLocalProjection;
		if (accepted) {
			// Once a canonical local tuple is accepted, an incomplete snapshot cannot
			// erase it. Rebinding to a different workspace/session/source is explicit
			// through connect/disconnect, never inferred from an arriving snapshot.
			if (!nextProjection
				|| nextProjection.workspaceId !== accepted.workspaceId
				|| nextProjection.sessionId !== accepted.sessionId
				|| nextProjection.sourceId !== accepted.sourceId
				|| nextProjection.generation < accepted.generation
				|| !localEndpointsMatchProjection(next.endpoints, nextProjection)) return false;
		} else if (nextProjection && !localEndpointsMatchProjection(next.endpoints, nextProjection)) {
			return false;
		}

		if (nextProjection && (!accepted || !sameLocalSessionProjection(accepted, nextProjection))) {
			this.#acceptedLocalProjection = nextProjection;
		}
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
			const candidateRow = rowsById.get(endpoint.correlationId);
			const row = candidateRow && root && rowOwnedByRoot(candidateRow, root) ? candidateRow : undefined;
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
			if (usedRows.has(row.correlationId) || root) continue;
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
		disambiguateAgentLabels(endpoints);

		const thread = registrySnapshot?.thread ?? [];
		const viewMode = registrySnapshot?.viewMode ?? "agents";
		const remoteRoots = remote.filter((endpoint) => endpoint.kind === "root");
		const baseWindowLabels = new Map(remoteRoots.map((endpoint) => [
			endpoint.id,
			cleanLabel(endpoint.sessionName, `window:${endpoint.ownerId.slice(0, 6)}`),
		]));
		const windowLabelCounts = new Map<string, number>();
		for (const label of baseWindowLabels.values()) {
			const key = label.toLocaleLowerCase("en");
			windowLabelCounts.set(key, (windowLabelCounts.get(key) ?? 0) + 1);
		}
		const monitorAggregationEnabled = viewMode === "windows"
			&& root?.capabilities.includes("monitor-workspace-aggregation") === true;
		const windows: CockpitEndpoint[] = (viewMode === "agents" || monitorAggregationEnabled ? remoteRoots : []).map((endpoint) => {
			const remoteAgents = remote.filter((candidate) =>
				candidate.kind === "agent" && sameOwner(endpoint, candidate)
			);
			const peerThread = thread.filter((entry) =>
				entry.peerOwnerId === endpoint.ownerId && entry.peerOwnerNonce === endpoint.ownerNonce
			);
			const baseLabel = baseWindowLabels.get(endpoint.id)!;
			const label = (windowLabelCounts.get(baseLabel.toLocaleLowerCase("en")) ?? 0) > 1
				? `${baseLabel}·${endpoint.ownerId.slice(0, 6)}`
				: baseLabel;
			const activityRevision = revisionOf([
				remoteAgents.map((agent) => agent.contentRevision),
				peerThread.map((entry) => entry.contentRevision),
			]);
			return {
				id: endpoint.id,
				logicalKey: `window:${endpoint.ownerId}:${endpoint.ownerNonce}`,
				kind: "window" as const,
				label,
				ordinal: endpoint.ordinal,
				status: endpoint.status,
				contentRevision: revisionOf([endpoint.contentRevision, activityRevision]),
				...(remoteAgents.length > 0 || peerThread.length > 0 ? { outputRevision: activityRevision } : {}),
				routeSelector: endpoint.id,
				source: "registry" as const,
				registryEndpoint: endpoint,
				...(endpoint.contextPressure === undefined ? {} : { contextPressure: endpoint.contextPressure }),
				agentCount: endpoint.agentCount ?? remoteAgents.filter((agent) => agent.status !== "settled").length,
				remoteAgents: Object.freeze(remoteAgents),
			};
		});
		if (monitorAggregationEnabled && root) {
			const controlAgents = registryAgents.filter((endpoint) =>
				!(endpoint.agent ?? "").startsWith("graph(")
			);
			const controlActivityRevision = revisionOf([
				this.#mainOutputRevision,
				controlAgents.map((agent) => agent.contentRevision),
			]);
			windows.unshift({
				id: `${MONITOR_CONTROL_ENDPOINT_PREFIX}${encodeURIComponent(root.id)}`,
				logicalKey: `monitor-control:${root.ownerId}:${root.ownerNonce}`,
				kind: "window",
				label: "control",
				ordinal: Number.MIN_SAFE_INTEGER,
				status: root.status,
				contentRevision: revisionOf([root.contentRevision, controlActivityRevision]),
				...(this.#mainOutputRevision || controlAgents.length > 0 ? { outputRevision: controlActivityRevision } : {}),
				routeSelector: root.id,
				source: "registry",
				registryEndpoint: root,
				agentCount: controlAgents.filter((agent) => agent.status !== "settled").length,
				remoteAgents: Object.freeze(controlAgents),
			});
		}
		const contentRevision = revisionOf([
			viewMode,
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
			endpoints: Object.freeze(endpoints),
			windows: Object.freeze(windows),
			thread: Object.freeze([...thread]),
		});
		for (const subscriber of this.#subscribers) subscriber(this.#snapshot);
		return true;
	}
}
