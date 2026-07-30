import type { TeammateCompleteEvent } from "pi-maestro-teammate/v1/events";
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

// Shapes mirror what pi-maestro-teammate emits on pi.events (teammate/.../index.ts:378/1636/3420).
export interface StartedPayload {
	correlationId: string;
	agent: string;
	name?: string;
	spawnedBy?: string;
	startedAt?: number | string;
	lastActivityAt?: number | string;
	status?: string;
}
export interface ProgressPayload {
	agent: string;
	name?: string;
	correlationId: string;
	taskIndex: number;
	dependencies?: number[];
	status?: string;
	startedAt?: number | string;
	completedAt?: number | string;
	durationMs?: number;
	lastActivityAt?: number | string;
	recentTools?: Array<string | { name?: string; status?: string }>;
	toolCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	lastMessage?: string;
}
export interface MessagePayload {
	correlationId: string;
	taskCorrelationId?: string;
	// Present on progress/interaction deltas (teammate/.../index.ts publishProgress);
	// absent on send deltas. Used to self-heal a row when `started` was missed.
	agent?: string;
	name?: string;
	taskIndex?: number;
	dependencies?: number[];
	message?: string;
	lastMessage?: string;
	recentTools?: Array<string | { name?: string; status?: string }>;
	toolCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	status?: string;
	lastActivityAt?: number | string;
	progress?: ProgressPayload[];
}
export type CompletePayload = Pick<TeammateCompleteEvent, "correlationId" | "exitCode">
	& Partial<Pick<TeammateCompleteEvent, "durationMs">>;

/**
 * How long a failed agent stays on screen after it completes.
 *
 * Long enough to read the role and the tail that explains it; short enough that
 * the panel still empties itself without the user clearing anything.
 */
export const FAILED_LINGER_MS = 30_000;

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
		case "running":
		default:
			return "running";
	}
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
	if (Number.isFinite(completedAt)) return Math.max(row.startedAt, completedAt);
	if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
		return row.startedAt + Math.max(0, payload.durationMs);
	}
	return row.finishedAt ?? now;
}

function latestTool(tools: MessagePayload["recentTools"]): string | undefined {
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

	applyStarted(p: StartedPayload, now: number = Date.now()): void {
		const id = p.correlationId;
		const prev = this.roster.get(id);
		const row: AgentRow = {
			...prev,
			correlationId: id,
			agent: clean(p.agent) || prev?.agent || "",
			name: p.name === undefined ? prev?.name : clean(p.name),
			role: deriveRole(p.agent, p.name),
			task: prev?.task ?? clean(p.name),
			status: p.status === undefined ? prev?.status ?? "running" : mapAgentStatus(p.status),
			tail: prev?.tail ?? "",
			startedAt: prev?.startedAt ?? normalizeStartedAt(p.startedAt, now),
			lastActivityAt: normalizeStartedAt(p.lastActivityAt, now),
			...(p.spawnedBy && p.spawnedBy !== id
				? { parentCorrelationId: p.spawnedBy }
				: prev?.parentCorrelationId
					? { parentCorrelationId: prev.parentCorrelationId }
					: {}),
		};
		if (row.status !== "done" && row.status !== "failed") delete row.finishedAt;
		this.roster.set(id, row);
	}

	applyMessage(p: MessagePayload, now = Date.now()): void {
		if (p.progress) {
			for (const progress of p.progress) this.applyProgress(p.correlationId, progress, now);
		}
		const targetId = p.taskCorrelationId ?? p.correlationId;
		if (!this.roster.has(targetId)) {
			// Self-heal the roster: a running agent must stay visible even when its
			// `started` delta was missed (cold start, event reorder, or a foreground
			// dispatch that detached to background). Materialize the row from this
			// event instead of dropping it; later deltas refine the placeholder.
			this.applyStarted({
				correlationId: targetId,
				agent: p.agent ?? "",
				name: p.name,
				status: p.status,
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
		const tail = p.message ?? p.lastMessage;
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
		if (typeof p.status === "string") {
			row.taskStatus = p.status;
			row.status = mapAgentStatus(p.status);
			if (row.status === "done" || row.status === "failed") row.finishedAt ??= now;
			else delete row.finishedAt;
		}
		if (typeof p.taskIndex === "number") row.taskIndex = p.taskIndex;
		if (Array.isArray(p.dependencies)) row.dependencies = [...p.dependencies];
	}

	applyComplete(p: CompletePayload, now = Date.now()): void {
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
			const failedByExitCode = id === p.correlationId
				&& Number.isFinite(p.exitCode)
				&& p.exitCode !== 0;
			if (row && (row.status === "failed" || failedByExitCode)) {
				row.status = "failed";
				row.taskStatus = "failed";
				row.finishedAt = terminalTime(row, id === p.correlationId ? p : {}, now);
				row.failedAt = now;
				row.lastActivityAt = now;
				delete row.activeTool;
			} else {
				this.roster.delete(id);
			}
		}
	}

	/** Drop failed rows that have had their time on screen. Returns true if any went. */
	prune(now = Date.now()): boolean {
		let changed = false;
		for (const [id, row] of this.roster) {
			if (row.failedAt !== undefined && now - row.failedAt >= FAILED_LINGER_MS) {
				this.roster.delete(id);
				changed = true;
			}
		}
		return changed;
	}

	/** True while a failed row is still counting down, so the redraw loop must run. */
	hasLingering(): boolean {
		for (const row of this.roster.values()) {
			if (row.failedAt !== undefined) return true;
		}
		return false;
	}

	private applyProgress(parentCorrelationId: string, p: ProgressPayload, now: number): void {
		if (!this.roster.has(p.correlationId)) {
			// Self-heal: see applyMessage. A graph child whose `started` delta was
			// missed still materializes from its first progress event.
			this.applyStarted({
				correlationId: p.correlationId,
				agent: p.agent,
				name: p.name,
				status: p.status,
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
			if (row.status === "done" || row.status === "failed") {
				row.finishedAt = terminalTime(row, p, now);
			} else {
				delete row.finishedAt;
			}
		}
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
	}
}
