import { sanitizeExtensionStatusText } from "./extension-status.ts";
import {
	MAESTRO_UI_SNAPSHOT_VERSION,
	type MaestroGoalV1,
	type MaestroModeV1,
	type MaestroSwarmBestV1,
	type MaestroSwarmV1,
	type MaestroSwarmWorkerV1,
	type MaestroUiSnapshotV1,
	type MaestroUiStateSnapshotV1,
	type MaestroWorkflowChainV1,
	type MaestroWorkflowGatesV1,
	type MaestroWorkflowRunV1,
	type MaestroWorkflowSessionV1,
	type MaestroWorkflowV1,
} from "./public/v1/events.ts";

/** Authoritative, generation-fenced replacement store for Maestro UI snapshots. */
export class MaestroStore {
	private value: MaestroUiStateSnapshotV1 | undefined;
	private sessionGeneration: string | undefined;
	private revision: number | undefined;
	private readonly fencedGenerations = new Set<string>();

	applySnapshot(payload: unknown): boolean {
		let next: MaestroUiSnapshotV1 | undefined;
		try {
			next = parseSnapshot(payload);
		} catch {
			return false;
		}
		if (!next) return false;

		if (this.sessionGeneration !== undefined) {
			if (next.sessionGeneration === this.sessionGeneration) {
				if (this.revision !== undefined && next.revision <= this.revision) return false;
			} else {
				if (this.fencedGenerations.has(next.sessionGeneration)) return false;
				this.fencedGenerations.add(this.sessionGeneration);
			}
		}

		this.sessionGeneration = next.sessionGeneration;
		this.revision = next.revision;
		this.value = next.cleared === true ? undefined : next;
		return true;
	}

	snapshot(): MaestroUiStateSnapshotV1 | undefined {
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	clear(): void {
		this.value = undefined;
		this.sessionGeneration = undefined;
		this.revision = undefined;
		this.fencedGenerations.clear();
	}
}

function parseSnapshot(value: unknown): MaestroUiSnapshotV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== MAESTRO_UI_SNAPSHOT_VERSION
		|| !isOpaqueId(value.sessionGeneration)
		|| !isNonNegativeInteger(value.revision)
		|| !isNonNegativeNumber(value.publishedAt)
	) return undefined;

	const envelope = {
		version: MAESTRO_UI_SNAPSHOT_VERSION,
		sessionGeneration: value.sessionGeneration,
		revision: value.revision,
		publishedAt: value.publishedAt,
	};
	if (value.cleared === true) return { ...envelope, cleared: true };
	if (value.cleared !== undefined && value.cleared !== false) return undefined;

	const workflow = value.workflow === null ? null : parseWorkflow(value.workflow);
	if (workflow === undefined) return undefined;
	if (!Array.isArray(value.goals)) return undefined;
	const goals: MaestroGoalV1[] = [];
	for (const item of value.goals) {
		const goal = parseGoal(item);
		if (!goal) return undefined;
		goals.push(goal);
	}
	const swarm = value.swarm === null ? null : parseSwarm(value.swarm);
	if (swarm === undefined) return undefined;
	const mode = parseMode(value.mode);
	if (mode === undefined) return undefined;
	if (value.currentGoalId !== undefined && !isOpaqueId(value.currentGoalId)) return undefined;

	return {
		...envelope,
		...(value.cleared === false ? { cleared: false as const } : {}),
		workflow,
		goals,
		...(value.currentGoalId === undefined ? {} : { currentGoalId: value.currentGoalId }),
		swarm,
		mode,
	};
}

function parseWorkflow(value: unknown): MaestroWorkflowV1 | undefined {
	if (!isRecord(value)) return undefined;
	const session = parseWorkflowSession(value.session);
	const run = value.run === null ? null : parseWorkflowRun(value.run);
	const chain = parseWorkflowChain(value.chain);
	const gates = parseWorkflowGates(value.gates);
	const next = value.next === null ? null : displayString(value.next);
	if (!session || run === undefined || !chain || !gates || next === undefined) return undefined;
	return { session, run, chain, gates, next };
}

function parseWorkflowSession(value: unknown): MaestroWorkflowSessionV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const label = displayString(value.label);
	const status = displayString(value.status);
	return label === undefined || status === undefined ? undefined : { id: value.id, label, status };
}

function parseWorkflowRun(value: unknown): MaestroWorkflowRunV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const command = displayString(value.command);
	const status = displayString(value.status);
	return command === undefined || status === undefined ? undefined : { id: value.id, command, status };
}

function parseWorkflowChain(value: unknown): MaestroWorkflowChainV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!isNonNegativeInteger(value.completed)
		|| !isNonNegativeInteger(value.running)
		|| !isNonNegativeInteger(value.pending)
		|| !isNonNegativeInteger(value.total)
	) return undefined;
	return {
		completed: value.completed,
		running: value.running,
		pending: value.pending,
		total: value.total,
	};
}

function parseWorkflowGates(value: unknown): MaestroWorkflowGatesV1 | undefined {
	if (!isRecord(value) || !isNonNegativeInteger(value.passed) || !isNonNegativeInteger(value.total)) return undefined;
	if (value.failed !== undefined && !isNonNegativeInteger(value.failed)) return undefined;
	return {
		passed: value.passed,
		total: value.total,
		...(value.failed === undefined ? {} : { failed: value.failed }),
	};
}

function parseGoal(value: unknown): MaestroGoalV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const objective = displayString(value.objective);
	const status = displayString(value.status);
	const pauseReason = value.pauseReason === undefined ? undefined : displayString(value.pauseReason);
	if (
		objective === undefined
		|| status === undefined
		|| (value.pauseReason !== undefined && pauseReason === undefined)
		|| !isNonNegativeInteger(value.iteration)
		|| !isNonNegativeNumber(value.tokensUsed)
		|| (value.tokenBudget !== undefined && !isNonNegativeNumber(value.tokenBudget))
		|| !isNonNegativeNumber(value.timeUsedSeconds)
		|| !isNonNegativeNumber(value.startedAt)
		|| !isNonNegativeNumber(value.updatedAt)
	) return undefined;
	return {
		id: value.id,
		objective,
		status,
		...(pauseReason === undefined ? {} : { pauseReason }),
		iteration: value.iteration,
		tokensUsed: value.tokensUsed,
		...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
		timeUsedSeconds: value.timeUsedSeconds,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
	};
}

function parseSwarm(value: unknown): MaestroSwarmV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.sessionId) || !Array.isArray(value.workers)) return undefined;
	const objective = displayString(value.objective);
	const status = displayString(value.status);
	if (
		objective === undefined
		|| status === undefined
		|| !isNonNegativeInteger(value.iteration)
		|| !isNonNegativeInteger(value.maxIterations)
		|| !isNonNegativeNumber(value.updatedAt)
	) return undefined;
	const workers: MaestroSwarmWorkerV1[] = [];
	for (const item of value.workers) {
		const worker = parseSwarmWorker(item);
		if (!worker) return undefined;
		workers.push(worker);
	}
	const best = value.best === null ? null : parseSwarmBest(value.best);
	if (best === undefined) return undefined;
	return {
		sessionId: value.sessionId,
		objective,
		status,
		iteration: value.iteration,
		maxIterations: value.maxIterations,
		workers,
		best,
		updatedAt: value.updatedAt,
	};
}

function parseSwarmWorker(value: unknown): MaestroSwarmWorkerV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const label = value.label === undefined ? undefined : displayString(value.label);
	const status = displayString(value.status);
	if (status === undefined || (value.label !== undefined && label === undefined)) return undefined;
	return { id: value.id, ...(label === undefined ? {} : { label }), status };
}

function parseSwarmBest(value: unknown): MaestroSwarmBestV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (value.workerId !== undefined && !isOpaqueId(value.workerId)) return undefined;
	const summary = value.summary === undefined ? undefined : displayString(value.summary);
	if (
		(value.summary !== undefined && summary === undefined)
		|| !isNonNegativeInteger(value.iteration)
		|| !isFiniteNumber(value.score)
	) return undefined;
	return {
		...(value.workerId === undefined ? {} : { workerId: value.workerId }),
		iteration: value.iteration,
		score: value.score,
		...(summary === undefined ? {} : { summary }),
	};
}

function parseMode(value: unknown): MaestroModeV1 | undefined {
	if (typeof value === "string") return sanitizeExtensionStatusText(value);
	if (!isRecord(value)) return undefined;
	const kind = displayString(value.kind);
	const label = value.label === undefined ? undefined : displayString(value.label);
	if (kind === undefined || (value.label !== undefined && label === undefined)) return undefined;
	return { kind, ...(label === undefined ? {} : { label }) };
}

function displayString(value: unknown): string | undefined {
	return typeof value === "string" ? sanitizeExtensionStatusText(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value);
}
