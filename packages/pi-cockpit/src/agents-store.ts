import type {
	TeammateCompleteEvent,
	TeammateProgressMessageEvent,
	TeammateStartedEvent,
} from "pi-maestro-teammate/v1/events";
import {
	TEAMMATE_STALL_TIMEOUT_MS,
	AgentProgressSnapshot,
	AgentRuntimeProjection,
	AgentTurnSnapshot,
} from "pi-maestro-teammate/v1/types";
import type {
	RuntimeAgentReadEntityV2,
	RuntimeReadModelDeltaV2,
	RuntimeReadModelSnapshotV2,
} from "pi-maestro-teammate/v2/runtime";
import { RuntimeReadModelProjectionV2 } from "pi-maestro-teammate/v2/runtime";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import { EXPERT_LEADER_NAME, type AgentRow, type AgentStatus } from "./types.ts";

const STATUS_TEXT_MAX = 48;
/** Selected-session output kept for the expandable fixed detail region. */
export const SESSION_CONTENT_MAX = 2_048;
export const CONVERSATION_ENTRY_MAX = 8_192;
export const CONVERSATION_MAX_ENTRIES = 16;
export const RECENT_TOOL_MAX = 8;

// Every string here originates in an LLM-authored teammate event. A raw newline
// would split one widget row into several physical terminal rows and a raw escape
// (e.g. ESC[2J) would clear or recolor the whole screen — and neither is caught by
// width checks, because both measure as zero columns. Sanitize on ingest so no
// renderer has to remember to.
function clean(raw: string | undefined): string {
	return raw === undefined ? "" : sanitizeExtensionStatusText(raw);
}

function truncateText(raw: string, max: number): string {
	const flat = clean(raw);
	if (flat.length === 0) return "";
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function truncateStatusText(raw: string): string {
	return truncateText(raw, STATUS_TEXT_MAX);
}

function truncateSessionContent(raw: string): string {
	return truncateText(raw, SESSION_CONTENT_MAX);
}

function conversationText(raw: string): string {
	const lines = raw
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => clean(line))
		.filter(Boolean);
	const text = lines.join("\n");
	return text.length > CONVERSATION_ENTRY_MAX
		? text.slice(0, CONVERSATION_ENTRY_MAX - 1) + "…"
		: text;
}

function appendConversation(row: AgentRow, role: "user" | "assistant", raw: string): void {
	const text = conversationText(raw);
	if (!text) return;
	const entries = [...(row.conversation ?? [])];
	const last = entries.at(-1);
	if (last?.role === role && last.text === text) return;
	if (role === "assistant" && last?.role === "assistant") {
		if (text.startsWith(last.text)) last.text = text;
		else if (last.text.startsWith(text)) return;
		else entries.push({ role, text });
	} else {
		entries.push({ role, text });
	}
	row.conversation = entries.slice(-CONVERSATION_MAX_ENTRIES);
}

function normalizedRecentTools(
	tools: Array<string | { name?: string; status?: string; argsPreview?: string }>,
): NonNullable<AgentRow["recentTools"]> {
	return tools.flatMap((tool) => {
		if (typeof tool === "string") {
			const name = truncateStatusText(tool);
			return name ? [{ name, status: "unknown" }] : [];
		}
		const name = truncateStatusText(tool.name ?? "");
		if (!name) return [];
		const status = truncateStatusText(tool.status ?? "unknown") || "unknown";
		const argsPreview = typeof tool.argsPreview === "string" ? truncateText(tool.argsPreview, 140) : "";
		return [{ name, status, ...(argsPreview ? { argsPreview } : {}) }];
	}).slice(-RECENT_TOOL_MAX);
}

// Store inputs are compatibility-relaxed projections of the versioned public
// contract. The event boundary validates discriminators and identifiers; the
// optional fields let older teammate versions continue to feed the same store.
export type StartedPayload = Pick<TeammateStartedEvent, "correlationId" | "agent">
	& Partial<Omit<TeammateStartedEvent, "correlationId" | "agent" | "startedAt">>
	& { startedAt?: number | string; task?: string; runtime?: AgentRuntimeProjection; turn?: AgentTurnSnapshot };
export type ProgressPayload = Pick<AgentProgressSnapshot, "correlationId" | "agent" | "taskIndex">
	& Partial<Omit<AgentProgressSnapshot, "correlationId" | "agent" | "taskIndex" | "startedAt" | "completedAt">>
	& { startedAt?: number | string; completedAt?: number | string };
export type MessagePayload = Partial<Omit<
	TeammateProgressMessageEvent,
	"progress" | "recentTools" | "isSend" | "isInteraction"
>> & {
	progress?: ProgressPayload[];
	recentTools?: Array<string | { name?: string; status?: string; argsPreview?: string }>;
	isSend?: boolean;
	isInteraction?: boolean;
	sendError?: boolean;
	/** Compatibility with pre-v1 progress deltas; discriminated send events are retained as user conversation. */
	message?: string;
	runtime?: AgentRuntimeProjection;
	turn?: AgentTurnSnapshot;
};
export type CompletePayload = Pick<TeammateCompleteEvent, "correlationId" | "exitCode">
	& Partial<Pick<TeammateCompleteEvent, "durationMs" | "wakeable" | "cancelled">>;

export const AGENT_LINGER_MS = 60_000;
/** Compatibility exports: every terminal state now uses one visible window. */
export const FAILED_LINGER_MS = AGENT_LINGER_MS;
export const SLEEPING_LINGER_MS = AGENT_LINGER_MS;
export const TERMINATED_LINGER_MS = AGENT_LINGER_MS;

/**
 * How long a completed agent's tombstone suppresses self-healing.
 *
 * `complete` deletes a row, but the teammate extension can still publish
 * progress afterwards: the flush gate may re-arm after disposal, a graph task
 * that returned result-ready carries `status:"running"` until its lifecycle
 * confirms (up to a 60s deadline), and nested/IPC deltas reorder freely. Any
 * such late delta would otherwise self-heal a ghost row that no second
 * `complete` ever removes — the footer keeps showing an agent as running long
 * after its tool result was already returned. The tombstone blocks that
 * rebuild. It must outlive the lifecycle-confirmation deadline with margin.
 * An explicit `started` (a genuine new lifecycle, e.g. a woken agent) clears
 * the tombstone, so legitimate reuse is never suppressed.
 */
export const COMPLETED_TOMBSTONE_MS = 120_000;

function deriveRole(agent: string | undefined, name: string | undefined): string {
	if (agent && !agent.startsWith("graph(")) return clean(agent);
	return clean(name) || "agent";
}

/**
 * True when the row is the workflow Leader of an expert-mode dispatch
 * (pi-maestro-teammate EXPERT_MODE_LEADER_NAME). The Leader keeps the same
 * tree + dependency-arrow presentation as parallel/DAG runs; this only adds
 * its strategy marker.
 */
export function isExpertLeader(row: { name: string | undefined }): boolean {
	return row.name === EXPERT_LEADER_NAME;
}

export function mapAgentStatus(status: unknown): AgentStatus {
	switch (status) {
		case "pending":
			return "pending";
		case "retrying":
			return "retrying";
		case "sleeping":
			return "sleeping";
		case "completed":
		case "complete":
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "terminated":
			return "terminated";
		case "running":
		default:
			return "running";
	}
}

function activityFromProgressStatus(status: unknown): "running" | "sleeping" | undefined {
	if (typeof status !== "string") return undefined;
	return status === "sleeping" || status === "completed" || status === "failed" || status === "terminated"
		? "sleeping"
		: "running";
}

export const AGENT_STALL_TIMEOUT_MS = TEAMMATE_STALL_TIMEOUT_MS;
export type AgentDisplayStatus = AgentStatus | "result-ready" | "stalled";

export function effectiveAgentStatus(row: AgentRow, _now: number = Date.now()): AgentDisplayStatus {
	if (row.status !== "running" && row.status !== "pending") return row.status;
	if (row.runtime?.resultReady === true || row.resultReadyAt !== undefined) return "result-ready";
	if (row.runtime?.health === "stalled") return "stalled";
	return row.status;
}

function normalizeStartedAt(value: number | string | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function terminalTime(
	row: AgentRow,
	payload: { completedAt?: number | string; durationMs?: number },
	now: number,
): number {
	const completedAt = normalizeStartedAt(payload.completedAt, Number.NaN);
	const turnStartedAt = row.turnStartedAt ?? row.startedAt;
	if (Number.isFinite(completedAt)) return Math.max(turnStartedAt, completedAt);
	if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
		return turnStartedAt + Math.max(0, payload.durationMs);
	}
	return row.finishedAt ?? now;
}

function latestTool(tools: Array<string | { name?: string; status?: string; argsPreview?: string }> | undefined): { name: string; argsPreview?: string } | undefined {
	if (!tools?.length) return undefined;
	const tool = tools.find((candidate) => typeof candidate === "object" && candidate?.status === "running")
		?? tools.at(-1);
	if (!tool) return undefined;
	if (typeof tool === "string") {
		const name = truncateStatusText(tool);
		return name ? { name } : undefined;
	}
	const name = tool?.name?.trim();
	if (!name) return undefined;
	const status = tool.status?.trim();
	// The active tool is by definition the one in flight, so "bash (running)"
	// only repeats the row's own live state. Keep the suffix only for
	// anomalies (failed/error) that the row state does not already convey.
	const displayName = truncateStatusText(
		status && status !== "completed" && status !== "running" ? `${name} (${status})` : name,
	);
	return {
		name: displayName,
		...(typeof tool.argsPreview === "string" && tool.argsPreview.trim()
			? { argsPreview: truncateText(tool.argsPreview, 140) }
			: {}),
	};
}

function runtimeEntityToRow(entity: RuntimeAgentReadEntityV2): AgentRow {
	const status = mapAgentStatus(entity.status);
	const recentTools = entity.recentTools ? normalizedRecentTools(entity.recentTools) : undefined;
	const activeTool = latestTool(entity.recentTools);
	const finishedAt = status === "done" || status === "failed" || status === "terminated" || status === "sleeping"
		? entity.lastOutcome?.settledAt ?? entity.lastActivityAt
		: undefined;
	return {
		correlationId: entity.correlationId,
		runtimeGeneration: entity.generation,
		agent: clean(entity.agent),
		name: entity.name === undefined ? undefined : clean(entity.name),
		role: deriveRole(entity.agent, entity.name),
		task: entity.task === undefined ? clean(entity.name) : conversationText(entity.task),
		status,
		...(entity.spawnedBy ? { spawnedBy: entity.spawnedBy } : {}),
		...(entity.parentCorrelationId ? { parentCorrelationId: entity.parentCorrelationId } : {}),
		...(entity.phase ? { phase: clean(entity.phase) } : {}),
		...(entity.runtime ? { runtime: structuredClone(entity.runtime) } : {}),
		...(entity.turn ? { turn: structuredClone(entity.turn) } : {}),
		...(entity.lastOutcome ? { lastOutcome: structuredClone(entity.lastOutcome) } : {}),
		tail: entity.lastMessage ? truncateSessionContent(entity.lastMessage) : "",
		startedAt: entity.startedAt,
		lastActivityAt: entity.lastActivityAt,
		...(finishedAt === undefined ? {} : { finishedAt }),
		...(entity.resultReadyAt === undefined ? {} : { resultReadyAt: entity.resultReadyAt }),
		...(entity.taskIndex === undefined ? {} : { taskIndex: entity.taskIndex }),
		...(entity.dependencies === undefined ? {} : { dependencies: [...entity.dependencies] }),
		...(recentTools === undefined ? {} : { recentTools }),
		...(activeTool ? {
			activeTool: activeTool.name,
			...(activeTool.argsPreview ? { activeToolArgs: activeTool.argsPreview } : {}),
		} : {}),
		...(entity.toolCount === undefined ? {} : { toolCount: entity.toolCount }),
		...(entity.tokens === undefined ? {} : { tokens: entity.tokens }),
		...(entity.inputTokens === undefined ? {} : { inputTokens: entity.inputTokens }),
		...(entity.outputTokens === undefined ? {} : { outputTokens: entity.outputTokens }),
		...(entity.cacheReadTokens === undefined ? {} : { cacheReadTokens: entity.cacheReadTokens }),
		...(entity.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: entity.cacheWriteTokens }),
		...(entity.requestedModel === undefined ? {} : { requestedModel: clean(entity.requestedModel) }),
		...(entity.resolvedModel === undefined ? {} : { resolvedModel: clean(entity.resolvedModel) }),
		...(entity.attemptedModels === undefined ? {} : { attemptedModels: entity.attemptedModels.map(clean).filter(Boolean) }),
		...(entity.error === undefined ? {} : { error: truncateStatusText(entity.error) }),
	};
}

// Self-accumulating roster. The teammate extension only broadcasts deltas
// (started/message/complete), never a full snapshot, so we rebuild the list here.
// Cold start is empty by design — we only reflect activity observed after load.
// The roster is self-healing: message/progress deltas for an agent whose
// `started` delta was missed still materialize a row, so a running agent is
// always represented as long as it keeps emitting activity.
export class AgentsStore {
	private readonly roster = new Map<string, AgentRow>();
	private readonly runtimeProjection = new RuntimeReadModelProjectionV2();
	private canonicalRoster = false;
	/** correlationId -> completion time; suppresses post-complete self-healing. */
	private readonly completedAt = new Map<string, number>();
	/** correlationId of the agent currently shown in teammate's viewing view. */
	private viewingId: string | undefined;

	private isTombstoned(id: string | undefined, now: number): boolean {
		if (id === undefined) return false;
		const at = this.completedAt.get(id);
		return at !== undefined && now - at < COMPLETED_TOMBSTONE_MS;
	}

	private canMaterialize(id: string, parentId: string | undefined, now: number): boolean {
		if (this.isTombstoned(parentId, now)) return false;
		if (!this.isTombstoned(id, now)) return true;
		// An explicit parent restart clears only the graph container's tombstone.
		// Its next full snapshot is authoritative for the child lifecycle too.
		return parentId !== undefined && parentId !== id && this.roster.has(parentId);
	}

	applyStarted(p: StartedPayload, now: number = Date.now()): void {
		this.canonicalRoster = false;
		if (typeof p.correlationId !== "string" || p.correlationId.length === 0) return;
		const id = p.correlationId;
		// An explicit start is authoritative: a woken or re-dispatched agent
		// reuses its correlationId and must reappear even if an earlier run was
		// tombstoned.
		this.completedAt.delete(id);
		const prev = this.roster.get(id);
		const prevIsTerminal = prev?.status === "done"
			|| prev?.status === "failed"
			|| prev?.status === "terminated"
			|| prev?.status === "sleeping";
		const nextStatus = p.status === undefined
			? prevIsTerminal ? "running" : prev?.status ?? "running"
			: mapAgentStatus(p.status);
		if ((clean(p.agent) || prev?.agent || "").startsWith("graph(") && nextStatus === "running") {
			// Restarting a graph is authoritative for its retained descendants too;
			// their next progress snapshot may reuse the same correlation ids.
			const pending = [id];
			const visited = new Set<string>();
			while (pending.length > 0) {
				const parent = pending.pop()!;
				if (visited.has(parent)) continue;
				visited.add(parent);
				for (const candidate of this.roster.values()) {
					if (candidate.parentCorrelationId !== parent) continue;
					this.completedAt.delete(candidate.correlationId);
					pending.push(candidate.correlationId);
				}
			}
		}
		const row: AgentRow = {
			...prev,
			correlationId: id,
			agent: clean(p.agent) || prev?.agent || "",
			name: p.name === undefined ? prev?.name : clean(p.name),
			role: deriveRole(p.agent, p.name),
			task: typeof p.task === "string"
				? conversationText(p.task)
				: prev?.task ?? clean(p.name),
			status: nextStatus,
			phase: typeof p.phase === "string" ? clean(p.phase) : prev?.phase,
			runtime: p.runtime ?? prev?.runtime,
			turn: p.turn ?? prev?.turn,
			lastOutcome: p.lastOutcome
				? {
					status: p.lastOutcome.status,
					...(p.lastOutcome.message ? { message: truncateStatusText(p.lastOutcome.message) } : {}),
					settledAt: p.lastOutcome.settledAt,
				}
				: prev?.lastOutcome,
			tail: prev?.tail ?? "",
			startedAt: prev?.startedAt ?? normalizeStartedAt(p.startedAt, now),
			lastActivityAt: normalizeStartedAt(p.lastActivityAt, now),
			...(p.spawnedBy && p.spawnedBy !== id
				? { spawnedBy: p.spawnedBy, parentCorrelationId: p.spawnedBy }
				: prev?.parentCorrelationId
					? { parentCorrelationId: prev.parentCorrelationId }
					: {}),
		};
		if (row.status === "running") {
			row.turnStartedAt = now;
			delete row.finishedAt;
			delete row.failedAt;
			delete row.resultReadyAt;
		} else if (row.status === "sleeping") {
			row.finishedAt = row.lastOutcome?.settledAt ?? prev?.finishedAt ?? now;
		} else if (row.status !== "done" && row.status !== "failed" && row.status !== "terminated") {
			delete row.finishedAt;
		}
		this.roster.set(id, row);
		if (row.status === "done" || row.status === "failed" || row.status === "terminated" || row.status === "sleeping") {
			this.completedAt.set(id, row.finishedAt ?? now);
		}
	}

	applyMessage(p: MessagePayload, now = Date.now()): void {
		this.canonicalRoster = false;
		if (p.isInteraction === true) return;
		if (typeof p.correlationId !== "string" || p.correlationId.length === 0) return;
		if (p.isSend === true) {
			const row = this.roster.get(p.correlationId);
			if (!row || p.sendError === true || typeof p.message !== "string") return;
			appendConversation(row, "user", p.message);
			return;
		}
		if (p.progress) {
			for (const progress of p.progress) {
				if (typeof progress.correlationId !== "string" || progress.correlationId.length === 0) continue;
				this.applyProgress(p.correlationId, progress, now);
			}
		}
		const targetId = typeof p.taskCorrelationId === "string" && p.taskCorrelationId.length > 0
			? p.taskCorrelationId
			: p.correlationId;
		const parentId = p.taskCorrelationId && p.taskCorrelationId !== p.correlationId
			? p.correlationId
			: undefined;
		if (!this.roster.has(targetId)
			&& this.canMaterialize(targetId, parentId, now)) {
			// Self-heal the roster: a running agent must stay visible even when its
			// `started` delta was missed (cold start, event reorder, or a foreground
			// dispatch that detached to background). Materialize the row from this
			// event instead of dropping it; later deltas refine the placeholder.
			// A tombstoned target (or graph parent) means `complete` already ran, so
			// this delta is a late ghost, not a missed start — dropping it keeps the
			// row deleted.
			this.applyStarted({
				correlationId: targetId,
				agent: p.agent ?? "",
				name: p.name,
				status: activityFromProgressStatus(p.status),
				lastActivityAt: p.lastActivityAt,
				...(p.taskCorrelationId && p.taskCorrelationId !== p.correlationId
					? { spawnedBy: p.correlationId }
					: {}),
			}, now);
			// This same delta is the authoritative content for the self-healed row;
			// a provisional sleeping seed must not tombstone itself before ingestion.
			this.completedAt.delete(targetId);
		}
		const row = this.roster.get(targetId);
		if (!row || this.isTombstoned(targetId, now)) return;
		const progressActivity = p.progress?.find((progress) => progress.correlationId === targetId)?.lastActivityAt;
		row.lastActivityAt = normalizeStartedAt(p.lastActivityAt ?? progressActivity, now);
		const tail = p.lastMessage ?? p.message;
		if (typeof tail === "string" && tail.length > 0) {
			row.tail = truncateSessionContent(tail);
			appendConversation(row, "assistant", tail);
		}
		if (p.recentTools) {
			row.recentTools = normalizedRecentTools(p.recentTools);
			const tool = latestTool(p.recentTools);
			if (tool) {
				row.activeTool = tool.name;
				if (tool.argsPreview) row.activeToolArgs = tool.argsPreview;
				else delete row.activeToolArgs;
			} else {
				delete row.activeTool;
				delete row.activeToolArgs;
			}
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.inputTokens === "number") row.inputTokens = p.inputTokens;
		if (typeof p.outputTokens === "number") row.outputTokens = p.outputTokens;
		if (typeof p.cacheReadTokens === "number") row.cacheReadTokens = p.cacheReadTokens;
		if (typeof p.cacheWriteTokens === "number") row.cacheWriteTokens = p.cacheWriteTokens;
		if (typeof p.error === "string") row.error = truncateStatusText(p.error);
		if (typeof p.requestedModel === "string") row.requestedModel = clean(p.requestedModel);
		if (typeof p.resolvedModel === "string") row.resolvedModel = clean(p.resolvedModel);
		if (Array.isArray(p.attemptedModels)) {
			row.attemptedModels = p.attemptedModels.map((model) => clean(model)).filter(Boolean);
		}
		if (typeof p.status === "string") {
			row.taskStatus = p.status;
			row.status = mapAgentStatus(p.status);
			if (row.status === "done" || row.status === "failed" || row.status === "terminated") {
				row.finishedAt ??= now;
				this.completedAt.set(targetId, now);
			} else if (row.status === "sleeping") {
				row.finishedAt ??= now;
				this.completedAt.set(targetId, now);
			} else {
				delete row.finishedAt;
			}
		}
		if (typeof p.phase === "string") row.phase = clean(p.phase);
		else if (row.status === "sleeping") delete row.phase;
		if (p.runtime !== undefined) row.runtime = p.runtime;
		if (p.turn !== undefined) row.turn = p.turn;
		if (typeof p.taskIndex === "number") row.taskIndex = p.taskIndex;
		if (Array.isArray(p.dependencies)) row.dependencies = [...p.dependencies];
	}

	applyComplete(p: CompletePayload, now = Date.now()): void {
		this.canonicalRoster = false;
		if (typeof p.correlationId !== "string" || p.correlationId.length === 0) return;
		const pending = [p.correlationId];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (visited.has(id)) continue;
			visited.add(id);
			for (const row of this.roster.values()) {
				if (row.parentCorrelationId === id) pending.push(row.correlationId);
			}
			// Every terminal row remains visible for one minute. Tombstone it now so
			// late progress cannot regress the retained row back to running; an
			// explicit started event clears the tombstone for a genuine new turn.
			const row = this.roster.get(id);
			this.completedAt.set(id, now);
			const cancelledById = id === p.correlationId && p.cancelled === true;
			const failedByExitCode = id === p.correlationId
				&& Number.isFinite(p.exitCode)
				&& p.exitCode !== 0;
			if (row && (cancelledById || row.status === "terminated")) {
				// Cancelled/terminated runs carry exitCode 1 but are not failures:
				// a user abort or a result-ready reclaim must not light the red ✗.
				row.status = "terminated";
				row.taskStatus = "terminated";
				row.finishedAt = terminalTime(row, id === p.correlationId ? p : {}, now);
				row.lastOutcome = { status: "terminated", settledAt: row.finishedAt };
				row.lastActivityAt = now;
				delete row.activeTool;
				delete row.failedAt;
			} else if (row && id === p.correlationId && p.wakeable) {
				// A recoverable logical agent is sleeping regardless of the previous
				// run outcome. Failure remains visible as orthogonal outcome metadata.
				row.status = "sleeping";
				row.taskStatus = "sleeping";
				row.phase = undefined;
				row.finishedAt = terminalTime(row, p, now);
				row.lastActivityAt = now;
				row.lastOutcome = {
					status: failedByExitCode ? "failed" : "completed",
					...(failedByExitCode && row.error ? { message: row.error } : {}),
					settledAt: row.finishedAt,
				};
				if (failedByExitCode) row.failedAt = now;
				else delete row.failedAt;
				delete row.activeTool;
			} else if (row && (row.status === "failed" || failedByExitCode)) {
				row.status = "failed";
				row.taskStatus = "failed";
				row.finishedAt = terminalTime(row, id === p.correlationId ? p : {}, now);
				row.lastOutcome = {
					status: "failed",
					...(row.error ? { message: row.error } : {}),
					settledAt: row.finishedAt,
				};
				row.failedAt = now;
				row.lastActivityAt = now;
				delete row.activeTool;
			} else if (row) {
				row.status = "done";
				row.taskStatus = "completed";
				row.finishedAt = terminalTime(row, id === p.correlationId ? p : {}, now);
				row.lastOutcome = { status: "completed", settledAt: row.finishedAt };
				row.lastActivityAt = now;
				delete row.activeTool;
				delete row.failedAt;
			}
		}
	}

	/** Drop terminal rows after their shared one-minute visible window. */
	prune(now = Date.now()): boolean {
		let changed = false;
		for (const [id, row] of this.roster) {
			const terminal = row.status === "done"
				|| row.status === "failed"
				|| row.status === "terminated"
				|| row.status === "sleeping";
			const settledAt = this.completedAt.get(id);
			if (terminal && settledAt !== undefined && now - settledAt >= AGENT_LINGER_MS) {
				this.roster.delete(id);
				if (this.viewingId === id) this.viewingId = undefined;
				changed = true;
			}
		}
		for (const [id, at] of this.completedAt) {
			if (now - at >= COMPLETED_TOMBSTONE_MS) this.completedAt.delete(id);
		}
		return changed;
	}

	/** True while a terminal row is counting down, so the redraw loop can expire it. */
	hasLingering(): boolean {
		for (const row of this.roster.values()) {
			if (row.status === "done"
				|| row.status === "failed"
				|| row.status === "terminated"
				|| row.status === "sleeping") return true;
		}
		return false;
	}

	/** True while any agent (foreground or background) is still running, so elapsed/stall repaints keep the loop alive. */
	hasActive(): boolean {
		for (const row of this.roster.values()) {
			if (row.status === "running") return true;
		}
		return false;
	}

	private applyProgress(parentCorrelationId: string, p: ProgressPayload, now: number): void {
		if (this.isTombstoned(p.correlationId, now)) return;
		if (!this.roster.has(p.correlationId)
			&& this.canMaterialize(p.correlationId, parentCorrelationId, now)) {
			// Self-heal: see applyMessage. A graph child whose `started` delta was
			// missed still materializes from its first progress event — unless the
			// child or its graph parent already completed, in which case this late
			// snapshot entry is a ghost and the row must stay deleted.
			this.applyStarted({
				correlationId: p.correlationId,
				agent: p.agent,
				name: p.name,
				status: activityFromProgressStatus(p.status),
				startedAt: p.startedAt,
				lastActivityAt: p.lastActivityAt,
				...(parentCorrelationId !== p.correlationId
					? { spawnedBy: parentCorrelationId }
					: {}),
			}, now);
		}
		const row = this.roster.get(p.correlationId);
		if (!row) return;
		if (
			parentCorrelationId !== p.correlationId
			&& row.parentCorrelationId === undefined
		) {
			row.spawnedBy ??= parentCorrelationId;
			row.parentCorrelationId = parentCorrelationId;
		}
		row.agent = clean(p.agent) || row.agent;
		row.name = p.name === undefined ? row.name : clean(p.name);
		row.role = deriveRole(p.agent, p.name);
		row.task = p.name === undefined ? row.task : clean(p.name);
		if (p.startedAt !== undefined) row.startedAt = normalizeStartedAt(p.startedAt, row.startedAt);
		if (typeof p.status === "string") {
			row.taskStatus = p.status;
			row.status = mapAgentStatus(p.status);
			if (row.status === "done" || row.status === "failed" || row.status === "terminated") {
				row.finishedAt = terminalTime(row, p, now);
				this.completedAt.set(p.correlationId, now);
			} else if (row.status === "sleeping") {
				row.finishedAt = terminalTime(row, p, now);
				this.completedAt.set(p.correlationId, now);
			} else {
				delete row.finishedAt;
			}
		}
		if (typeof p.phase === "string") row.phase = clean(p.phase);
		else if (row.status === "sleeping") delete row.phase;
		row.runtime = p.runtime;
		row.turn = p.turn;
		row.resultReadyAt = p.resultReadyAt === undefined
			? undefined
			: normalizeStartedAt(p.resultReadyAt, now);
		row.taskIndex = p.taskIndex;
		row.dependencies = Array.isArray(p.dependencies) ? [...p.dependencies] : [];
		row.lastActivityAt = normalizeStartedAt(p.lastActivityAt, now);
		if (p.recentTools) {
			row.recentTools = normalizedRecentTools(p.recentTools);
			const tool = latestTool(p.recentTools);
			if (tool) {
				row.activeTool = tool.name;
				if (tool.argsPreview) row.activeToolArgs = tool.argsPreview;
				else delete row.activeToolArgs;
			} else {
				delete row.activeTool;
				delete row.activeToolArgs;
			}
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.inputTokens === "number") row.inputTokens = p.inputTokens;
		if (typeof p.outputTokens === "number") row.outputTokens = p.outputTokens;
		row.cacheReadTokens = p.cacheReadTokens;
		row.cacheWriteTokens = p.cacheWriteTokens;
		if (p.error === undefined) delete row.error;
		else row.error = truncateStatusText(p.error);
		if (p.requestedModel === undefined) delete row.requestedModel;
		else row.requestedModel = clean(p.requestedModel);
		if (p.resolvedModel === undefined) delete row.resolvedModel;
		else row.resolvedModel = clean(p.resolvedModel);
		if (p.attemptedModels === undefined) delete row.attemptedModels;
		else row.attemptedModels = p.attemptedModels.map((model) => clean(model)).filter(Boolean);
		if (typeof p.lastMessage === "string" && p.lastMessage.length > 0) {
			row.tail = truncateSessionContent(p.lastMessage);
			appendConversation(row, "assistant", p.lastMessage);
		}
	}

	private replaceFromRuntimeProjection(): void {
		const viewingId = this.viewingId;
		this.roster.clear();
		this.completedAt.clear();
		for (const entity of this.runtimeProjection.snapshot().agents) {
			const row = runtimeEntityToRow(entity);
			this.roster.set(row.correlationId, row);
			if (row.status === "done" || row.status === "failed" || row.status === "terminated" || row.status === "sleeping") {
				this.completedAt.set(row.correlationId, row.finishedAt ?? row.lastActivityAt);
			}
		}
		this.viewingId = viewingId && this.roster.has(viewingId) ? viewingId : undefined;
		this.canonicalRoster = true;
	}

	applyRuntimeSnapshot(snapshot: RuntimeReadModelSnapshotV2 | unknown): boolean {
		if (!this.runtimeProjection.applySnapshot(snapshot)) return false;
		this.replaceFromRuntimeProjection();
		return true;
	}

	applyRuntimeDelta(delta: RuntimeReadModelDeltaV2 | unknown): boolean {
		if (!this.canonicalRoster || !this.runtimeProjection.applyDelta(delta)) return false;
		this.replaceFromRuntimeProjection();
		return true;
	}

	runtimeCursor(): number | undefined {
		return this.canonicalRoster ? this.runtimeProjection.cursor : undefined;
	}

	disableRuntimeProjection(): void {
		this.canonicalRoster = false;
	}

	private visibleCanonicalRow(row: AgentRow): AgentRow {
		if (!this.canonicalRoster || !row.parentCorrelationId) return row;
		const visited = new Set<string>([row.correlationId]);
		let parentId: string | undefined = row.parentCorrelationId;
		while (parentId) {
			if (visited.has(parentId)) return { ...row, parentCorrelationId: undefined };
			visited.add(parentId);
			const parent = this.roster.get(parentId);
			if (!parent) return { ...row, parentCorrelationId: undefined };
			parentId = parent.parentCorrelationId;
		}
		return row;
	}

	snapshot(now = Date.now()): AgentRow[] {
		// Expiry is driven by reads rather than a dedicated timer: the panel is
		// already redrawn while anything is lingering, and nothing else has to know.
		this.prune(now);
		return [...this.roster.values()].sort((a, b) => {
			const activity = b.lastActivityAt - a.lastActivityAt;
			return activity || a.correlationId.localeCompare(b.correlationId);
		}).map((row) => {
			const visible = this.visibleCanonicalRow(row);
			return visible.correlationId === this.viewingId ? { ...visible, viewing: true } : visible;
		});
	}

	/** Mark which agent the teammate viewing view currently shows. */
	setViewingAgent(correlationId: string | undefined): void {
		this.viewingId = correlationId;
	}

	/** Correlation id of the agent currently shown in the viewing view. */
	getViewingAgent(): string | undefined {
		return this.viewingId;
	}

	get size(): number {
		return this.roster.size;
	}

	has(correlationId: string): boolean {
		return this.roster.has(correlationId);
	}

	clear(): void {
		this.roster.clear();
		this.completedAt.clear();
		this.canonicalRoster = false;
		this.viewingId = undefined;
	}
}

/** Keeps the compatibility V1 fold warm while V2 is the rendered source. */
export class AgentReadStoreRouter {
	readonly legacy = new AgentsStore();
	readonly runtime = new AgentsStore();
	private active = this.legacy;

	get current(): AgentsStore {
		return this.active;
	}

	applyLegacyStarted(payload: StartedPayload, now?: number): void {
		this.legacy.applyStarted(payload, now);
	}

	applyLegacyMessage(payload: MessagePayload, now?: number): void {
		this.legacy.applyMessage(payload, now);
	}

	applyLegacyComplete(payload: CompletePayload, now?: number): void {
		this.legacy.applyComplete(payload, now);
	}

	applyRuntimeSnapshot(payload: unknown): boolean {
		if (!this.runtime.applyRuntimeSnapshot(payload)) return false;
		this.active = this.runtime;
		return true;
	}

	applyRuntimeDelta(payload: unknown): boolean {
		if (this.active !== this.runtime || !this.runtime.applyRuntimeDelta(payload)) {
			this.active = this.legacy;
			return false;
		}
		return true;
	}

	fallback(): void {
		this.active = this.legacy;
	}

	clear(): void {
		this.legacy.clear();
		this.runtime.clear();
		this.active = this.legacy;
	}
}
