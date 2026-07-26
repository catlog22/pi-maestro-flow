import type { AgentRow } from "./types.ts";

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
}
export interface MessagePayload {
	correlationId: string;
	message?: string;
}
export interface CompletePayload {
	correlationId: string;
}

function deriveRole(agent: string | undefined, name: string | undefined): string {
	if (agent && !agent.startsWith("graph(")) return agent;
	return name ?? "agent";
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
			correlationId: id,
			agent: p.agent ?? prev?.agent ?? "",
			name: p.name ?? prev?.name,
			role: deriveRole(p.agent, p.name),
			task: prev?.task ?? p.name ?? "",
			status: "running",
			tail: prev?.tail ?? "",
			startedAt: prev?.startedAt ?? now,
		});
	}

	applyMessage(p: MessagePayload): void {
		const row = this.roster.get(p.correlationId);
		if (!row) return;
		if (typeof p.message === "string" && p.message.length > 0) {
			row.tail = truncateTail(p.message);
		}
	}

	applyComplete(p: CompletePayload): void {
		this.roster.delete(p.correlationId);
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
