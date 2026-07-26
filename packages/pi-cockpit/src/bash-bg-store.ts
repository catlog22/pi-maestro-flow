import type { BashBgJob, BashBgStatus } from "./types.ts";

const STATUSES = new Set<BashBgStatus>(["running", "stopping", "completed", "failed", "killed"]);

export class BashBgStore {
	private jobs = new Map<string, BashBgJob>();

	applySnapshot(payload: unknown): boolean {
		if (!isRecord(payload) || !Array.isArray(payload.jobs)) return false;
		const next = new Map<string, BashBgJob>();
		for (const value of payload.jobs) {
			const job = parseJob(value);
			if (job) next.set(job.id, job);
		}
		this.jobs = next;
		return true;
	}

	snapshot(): BashBgJob[] {
		return [...this.jobs.values()].sort((a, b) =>
			statusRank(a.status) - statusRank(b.status)
			|| b.startedAt - a.startedAt
			|| a.id.localeCompare(b.id));
	}

	hasActive(): boolean {
		for (const job of this.jobs.values()) {
			if (job.status === "running" || job.status === "stopping") return true;
		}
		return false;
	}

	clear(): void {
		this.jobs.clear();
	}
}

function parseJob(value: unknown): BashBgJob | undefined {
	if (!isRecord(value)) return undefined;
	const status = value.status;
	if (
		typeof value.id !== "string"
		|| !value.id
		|| typeof value.command !== "string"
		|| typeof value.cwd !== "string"
		|| typeof value.pid !== "number"
		|| !Number.isFinite(value.pid)
		|| typeof status !== "string"
		|| !STATUSES.has(status as BashBgStatus)
		|| typeof value.startedAt !== "number"
		|| !Number.isFinite(value.startedAt)
		|| typeof value.updatedAt !== "number"
		|| !Number.isFinite(value.updatedAt)
		|| (value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt)))
		|| (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isFinite(value.exitCode)))
		|| typeof value.outputTail !== "string"
		|| typeof value.outputBytes !== "number"
		|| !Number.isFinite(value.outputBytes)
		|| value.outputBytes < 0
		|| typeof value.logPath !== "string"
	) {
		return undefined;
	}
	return {
		id: value.id,
		command: value.command,
		cwd: value.cwd,
		pid: value.pid,
		status: status as BashBgStatus,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
		exitCode: value.exitCode,
		outputTail: value.outputTail,
		outputBytes: value.outputBytes,
		logPath: value.logPath,
	};
}

function statusRank(status: BashBgStatus): number {
	if (status === "running") return 0;
	if (status === "stopping") return 1;
	if (status === "failed") return 2;
	if (status === "killed") return 3;
	return 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
