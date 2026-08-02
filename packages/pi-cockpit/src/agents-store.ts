import type {
	TeammateCompleteEvent,
	TeammateProgressMessageEvent,
	TeammateStartedEvent,
} from "pi-maestro-teammate/v1/events";
import type { AgentProgressSnapshot } from "pi-maestro-teammate/v1/types";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { AgentRow, AgentStatus } from "./types.ts";

const TAIL_MAX = 48;

// Every string here originates in an LLM-authored teammate event. A raw newline
// would split one widget row into several physical terminal rows and a raw escape
// (e.g. ESC[2J) would clear or recolor the whole screen — and neither is caught by
// width checks, because both measure as zero columns. Sanitize on ingest so no
// renderer has to remember to.
function clean(raw: string | undefined): string {
	return raw === undefined ? "" : sanitizeExtensionStatusText(raw);
}

function truncateTail(raw: string): string {
	const flat = clean(raw);
	if (flat.length === 0) return "";
	return flat.length > TAIL_MAX ? flat.slice(0, TAIL_MAX - 1) + "…" : flat;
}

// Store inputs are compatibility-relaxed projections of the versioned public
// contract. The event boundary validates discriminators and identifiers; the
// optional fields let older teammate versions continue to feed the same store.
export type StartedPayload = Pick<TeammateStartedEvent, "correlationId" | "agent">
	& Partial<Omit<TeammateStartedEvent, "correlationId" | "agent" | "startedAt">>
	& { startedAt?: number | string };
export type ProgressPayload = Pick<AgentProgressSnapshot, "correlationId" | "agent" | "taskIndex">
	& Partial<Omit<AgentProgressSnapshot, "correlationId" | "agent" | "taskIndex" | "startedAt" | "completedAt">>
	& { startedAt?: number | string; completedAt?: number | string };
export type MessagePayload = Partial<Omit<
	TeammateProgressMessageEvent,
	"progress" | "recentTools" | "isSend" | "isInteraction"
>> & {
	progress?: ProgressPayload[];
	recentTools?: Array<string | { name?: string; status?: string }>;
	isSend?: boolean;
	isInteraction?: boolean;
	/** Compatibility with pre-v1 progress deltas; discriminated send events are ignored. */
	message?: string;
};
export type CompletePayload = Pick<TeammateCompleteEvent, "correlationId" | "exitCode">
	& Partial<Pick<TeammateCompleteEvent, "durationMs" | "wakeable" | "cancelled">>;

/**
 * How long a failed agent stays on screen after it completes.
 *
 * Long enough to read the role and the tail that explains it; short enough that
 * the panel still empties itself without the user clearing anything.
 */
export const FAILED_LINGER_MS = 30_000;

/**
 * How long a sleeping (wakeable) row stays visible after completion.
 *
 * Matches the native widget's idle-hide window so both surfaces agree on
 * when an idle agent stops occupying screen space.
 */
export const SLEEPING_LINGER_MS = 60_000;

/**
 * How long a terminated (cancelled/aborted) row stays on screen after it ends.
 *
 * Shorter than a failure: cancellation is expected, but the user should still
 * see the × long enough to read which agent was taken down.
 */
export const TERMINATED_LINGER_MS = 15_000;

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

export const AGENT_STALL_TIMEOUT_MS = 30_000;
export type AgentDisplayStatus = AgentStatus | "result-ready" | "stalled";

export function effectiveAgentStatus(row: AgentRow, now: number = Date.now()): AgentDisplayStatus {
	if (row.status !== "running") return row.status;
	if (row.resultReadyAt !== undefined) return "result-ready";
	return now - row.lastActivityAt >= AGENT_STALL_TIMEOUT_MS ? "stalled" : "running";
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

function latestTool(tools: Array<string | { name?: string; status?: string }> | undefined): string | undefined {
	if (!tools?.length) return undefined;
	const tool = tools.find((candidate) => typeof candidate === "object" && candidate?.status === "running")
		?? tools.at(-1);
	if (!tool) return undefined;
	if (typeof tool === "string") return truncateTail(tool);
	const name = tool?.name?.trim();
	if (!name) return undefined;
	const status = tool.status?.trim();
	return truncateTail(status && status !== "completed" ? `${name} (${status})` : name);
}

// Self-accumulating roster. The teammate extension only broadcasts deltas
// (started/message/complete), never a full snapshot, so we rebuild the list here.
// Cold start is empty by design — we only reflect activity observed after load.
// The roster is self-healing: message/progress deltas for an agent whose
// `started` delta was missed still materialize a row, so a running agent is
// always represented as long as it keeps emitting activity.
export class AgentsStore {
	private readonly roster = new Map<string, AgentRow>();
	/** correlationId -> completion time; suppresses post-complete self-healing. */
	private readonly completedAt = new Map<string, number>();

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
		if (typeof p.correlationId !== "string" || p.correlationId.length === 0) return;
		const id = p.correlationId;
		// An explicit start is authoritative: a woken or re-dispatched agent
		// reuses its correlationId and must reappear even if an earlier run was
		// tombstoned.
		this.completedAt.delete(id);
		const prev = this.roster.get(id);
		const row: AgentRow = {
			...prev,
			correlationId: id,
			agent: clean(p.agent) || prev?.agent || "",
			name: p.name === undefined ? prev?.name : clean(p.name),
			role: deriveRole(p.agent, p.name),
			task: prev?.task ?? clean(p.name),
			status: p.status === undefined ? prev?.status ?? "running" : mapAgentStatus(p.status),
			phase: typeof p.phase === "string" ? clean(p.phase) : prev?.phase,
			lastOutcome: p.lastOutcome
				? {
					status: p.lastOutcome.status,
					...(p.lastOutcome.message ? { message: truncateTail(p.lastOutcome.message) } : {}),
					settledAt: p.lastOutcome.settledAt,
				}
				: prev?.lastOutcome,
			tail: prev?.tail ?? "",
			startedAt: prev?.startedAt ?? normalizeStartedAt(p.startedAt, now),
			lastActivityAt: normalizeStartedAt(p.lastActivityAt, now),
			...(p.spawnedBy && p.spawnedBy !== id
				? { parentCorrelationId: p.spawnedBy }
				: prev?.parentCorrelationId
					? { parentCorrelationId: prev.parentCorrelationId }
					: {}),
		};
		if (row.status === "running") {
			row.turnStartedAt = now;
			delete row.finishedAt;
			delete row.failedAt;
		} else if (row.status === "sleeping") {
			row.finishedAt = row.lastOutcome?.settledAt ?? prev?.finishedAt ?? now;
		} else if (row.status !== "done" && row.status !== "failed" && row.status !== "terminated") {
			delete row.finishedAt;
		}
		this.roster.set(id, row);
	}

	applyMessage(p: MessagePayload, now = Date.now()): void {
		if (p.isSend === true || p.isInteraction === true) return;
		if (typeof p.correlationId !== "string" || p.correlationId.length === 0) return;
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
		}
		const row = this.roster.get(targetId);
		if (!row) return;
		const progressActivity = p.progress?.find((progress) => progress.correlationId === targetId)?.lastActivityAt;
		row.lastActivityAt = normalizeStartedAt(p.lastActivityAt ?? progressActivity, now);
		const tail = p.lastMessage ?? p.message;
		if (typeof tail === "string" && tail.length > 0) row.tail = truncateTail(tail);
		if (p.recentTools) {
			const tool = latestTool(p.recentTools);
			if (tool) row.activeTool = tool;
			else delete row.activeTool;
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.inputTokens === "number") row.inputTokens = p.inputTokens;
		if (typeof p.outputTokens === "number") row.outputTokens = p.outputTokens;
		if (typeof p.cacheReadTokens === "number") row.cacheReadTokens = p.cacheReadTokens;
		if (typeof p.cacheWriteTokens === "number") row.cacheWriteTokens = p.cacheWriteTokens;
		if (typeof p.error === "string") row.error = truncateTail(p.error);
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
			} else {
				delete row.finishedAt;
			}
		}
		if (typeof p.phase === "string") row.phase = clean(p.phase);
		else if (row.status === "sleeping") delete row.phase;
		if (typeof p.taskIndex === "number") row.taskIndex = p.taskIndex;
		if (Array.isArray(p.dependencies)) row.dependencies = [...p.dependencies];
	}

	applyComplete(p: CompletePayload, now = Date.now()): void {
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
			// A failed agent used to be deleted the moment its result arrived, so the
			// only evidence of the failure disappeared in the same frame it appeared.
			// Successes still vanish immediately — the work has simply moved on.
			const row = this.roster.get(id);
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
			} else {
				this.roster.delete(id);
				// Tombstone even when the row never existed: a `complete` that beats
				// the first delta must still suppress the self-heal that follows.
				this.completedAt.set(id, now);
			}
		}
	}

	/** Drop failed, terminated or expired sleeping rows that have had their time on screen. Returns true if any went. */
	prune(now = Date.now()): boolean {
		let changed = false;
		for (const [id, row] of this.roster) {
			if (row.failedAt !== undefined && now - row.failedAt >= FAILED_LINGER_MS) {
				this.roster.delete(id);
				changed = true;
			} else if (row.status === "terminated" && row.finishedAt !== undefined && now - row.finishedAt >= TERMINATED_LINGER_MS) {
				this.roster.delete(id);
				changed = true;
			} else if (row.status === "sleeping" && row.finishedAt !== undefined && now - row.finishedAt >= SLEEPING_LINGER_MS) {
				this.roster.delete(id);
				changed = true;
			}
		}
		for (const [id, at] of this.completedAt) {
			if (now - at >= COMPLETED_TOMBSTONE_MS) this.completedAt.delete(id);
		}
		return changed;
	}

	/** True while a failed, terminated or sleeping row is still counting down, so the redraw loop must run. */
	hasLingering(): boolean {
		for (const row of this.roster.values()) {
			if (row.failedAt !== undefined) return true;
			if (row.status === "terminated") return true;
			if (row.status === "sleeping") return true;
		}
		return false;
	}

	private applyProgress(parentCorrelationId: string, p: ProgressPayload, now: number): void {
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
		) row.parentCorrelationId = parentCorrelationId;
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
			} else {
				delete row.finishedAt;
			}
		}
		if (typeof p.phase === "string") row.phase = clean(p.phase);
		else if (row.status === "sleeping") delete row.phase;
		row.resultReadyAt = p.resultReadyAt === undefined
			? undefined
			: normalizeStartedAt(p.resultReadyAt, now);
		row.taskIndex = p.taskIndex;
		row.dependencies = Array.isArray(p.dependencies) ? [...p.dependencies] : [];
		row.lastActivityAt = normalizeStartedAt(p.lastActivityAt, now);
		if (p.recentTools) {
			const tool = latestTool(p.recentTools);
			if (tool) row.activeTool = tool;
			else delete row.activeTool;
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.inputTokens === "number") row.inputTokens = p.inputTokens;
		if (typeof p.outputTokens === "number") row.outputTokens = p.outputTokens;
		row.cacheReadTokens = p.cacheReadTokens;
		row.cacheWriteTokens = p.cacheWriteTokens;
		if (p.error === undefined) delete row.error;
		else row.error = truncateTail(p.error);
		if (p.requestedModel === undefined) delete row.requestedModel;
		else row.requestedModel = clean(p.requestedModel);
		if (p.resolvedModel === undefined) delete row.resolvedModel;
		else row.resolvedModel = clean(p.resolvedModel);
		if (p.attemptedModels === undefined) delete row.attemptedModels;
		else row.attemptedModels = p.attemptedModels.map((model) => clean(model)).filter(Boolean);
		if (typeof p.lastMessage === "string" && p.lastMessage.length > 0) {
			row.tail = truncateTail(p.lastMessage);
		}
	}

	snapshot(now = Date.now()): AgentRow[] {
		// Expiry is driven by reads rather than a dedicated timer: the panel is
		// already redrawn while anything is lingering, and nothing else has to know.
		this.prune(now);
		return [...this.roster.values()].sort((a, b) => {
			const activity = b.lastActivityAt - a.lastActivityAt;
			return activity || a.correlationId.localeCompare(b.correlationId);
		});
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
	}
}
