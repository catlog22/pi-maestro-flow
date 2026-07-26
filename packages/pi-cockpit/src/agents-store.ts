import type { AgentRow, AgentStatus } from "./types.ts";

const TAIL_MAX = 48;

function truncateTail(raw: string): string {
	const flat = raw.replace(/\s+/g, " ").trim();
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
	recentTools?: Array<string | { name?: string; status?: string }>;
	toolCount?: number;
	tokens?: number;
	lastMessage?: string;
}
export interface MessagePayload {
	correlationId: string;
	taskCorrelationId?: string;
	taskIndex?: number;
	dependencies?: number[];
	message?: string;
	lastMessage?: string;
	recentTools?: Array<string | { name?: string; status?: string }>;
	toolCount?: number;
	tokens?: number;
	status?: string;
	progress?: ProgressPayload[];
}
export interface CompletePayload {
	correlationId: string;
}

function deriveRole(agent: string | undefined, name: string | undefined): string {
	if (agent && !agent.startsWith("graph(")) return agent;
	return name ?? "agent";
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
export class AgentsStore {
	private readonly roster = new Map<string, AgentRow>();

	applyStarted(p: StartedPayload, now: number = Date.now()): void {
		const id = p.correlationId;
		const prev = this.roster.get(id);
		this.roster.set(id, {
			...prev,
			correlationId: id,
			agent: p.agent ?? prev?.agent ?? "",
			name: p.name ?? prev?.name,
			role: deriveRole(p.agent, p.name),
			task: prev?.task ?? p.name ?? "",
			status: p.status === undefined ? prev?.status ?? "running" : mapAgentStatus(p.status),
			tail: prev?.tail ?? "",
			startedAt: prev?.startedAt ?? normalizeStartedAt(p.startedAt, now),
			...(p.spawnedBy && p.spawnedBy !== id
				? { parentCorrelationId: p.spawnedBy }
				: prev?.parentCorrelationId
					? { parentCorrelationId: prev.parentCorrelationId }
					: {}),
		});
	}

	applyMessage(p: MessagePayload): void {
		if (p.progress) {
			for (const progress of p.progress) this.applyProgress(p.correlationId, progress);
		}
		const targetId = p.taskCorrelationId ?? p.correlationId;
		const row = this.roster.get(targetId);
		if (!row) return;
		const tail = p.message ?? p.lastMessage;
		if (typeof tail === "string" && tail.length > 0) row.tail = truncateTail(tail);
		if (p.recentTools) {
			const tool = latestTool(p.recentTools);
			if (tool) row.activeTool = tool;
			else delete row.activeTool;
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.status === "string") {
			row.taskStatus = p.status;
			row.status = mapAgentStatus(p.status);
		}
		if (typeof p.taskIndex === "number") row.taskIndex = p.taskIndex;
		if (Array.isArray(p.dependencies)) row.dependencies = [...p.dependencies];
	}

	applyComplete(p: CompletePayload): void {
		const pending = [p.correlationId];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (visited.has(id)) continue;
			visited.add(id);
			for (const row of this.roster.values()) {
				if (row.parentCorrelationId === id) pending.push(row.correlationId);
			}
			this.roster.delete(id);
		}
	}

	private applyProgress(parentCorrelationId: string, p: ProgressPayload): void {
		const row = this.roster.get(p.correlationId);
		if (!row) return;
		row.parentCorrelationId = parentCorrelationId === p.correlationId
			? row.parentCorrelationId
			: parentCorrelationId;
		row.agent = p.agent || row.agent;
		row.name = p.name ?? row.name;
		row.role = deriveRole(p.agent, p.name);
		row.task = p.name ?? row.task;
		if (typeof p.status === "string") {
			row.taskStatus = p.status;
			row.status = mapAgentStatus(p.status);
		}
		row.taskIndex = p.taskIndex;
		row.dependencies = Array.isArray(p.dependencies) ? [...p.dependencies] : [];
		if (p.startedAt !== undefined) row.startedAt = normalizeStartedAt(p.startedAt, row.startedAt);
		if (p.recentTools) {
			const tool = latestTool(p.recentTools);
			if (tool) row.activeTool = tool;
			else delete row.activeTool;
		}
		if (typeof p.toolCount === "number") row.toolCount = p.toolCount;
		if (typeof p.tokens === "number") row.tokens = p.tokens;
		if (typeof p.lastMessage === "string" && p.lastMessage.length > 0) {
			row.tail = truncateTail(p.lastMessage);
		}
	}

	snapshot(): AgentRow[] {
		return [...this.roster.values()].sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			return a.startedAt - b.startedAt;
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
