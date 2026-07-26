import type { TodoItem, TodoState } from "./types.ts";
import { TODO_STATE_ENTRY_TYPE } from "./types.ts";

// Minimal structural view of a session entry — matches the shape todo.ts reads back
// (type:"custom" + customType + data), without importing core session types.
interface RawEntry {
	readonly type?: string;
	readonly customType?: string;
	readonly data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// Map the todo tool's status strings onto our four display states.
// "deleted" is returned verbatim so the caller can drop the task.
export function mapStatus(raw: unknown): TodoState | "deleted" {
	switch (raw) {
		case "in_progress":
		case "in-progress":
			return "in_progress";
		case "completed":
		case "complete":
			return "completed";
		case "blocked":
			return "blocked";
		case "deleted":
			return "deleted";
		case "pending":
		default:
			return "pending";
	}
}

// Rebuilt from the durable todo-state snapshot the todo tool persists after every
// mutation (tools/todo.ts:1091). We do NOT parse tool args: create-args carry no
// assigned ids, so an incremental rebuild could never match later updates by id.
// The snapshot is authoritative for both cold start and live refresh.
export class TodoStore {
	private items = new Map<string, TodoItem>();

	hydrateFromEntries(entries: readonly RawEntry[]): void {
		let entry: RawEntry | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e && e.type === "custom" && e.customType === TODO_STATE_ENTRY_TYPE) {
				entry = e;
				break;
			}
		}
		const rawTasks = asRecord(asRecord(entry?.data)?.tasks);
		const next = new Map<string, TodoItem>();
		if (rawTasks) {
			for (const [id, raw] of Object.entries(rawTasks)) {
				const r = asRecord(raw);
				const status = mapStatus(r?.status);
				if (status === "deleted") continue;
				next.set(id, {
					id,
					subject: typeof r?.subject === "string" ? r.subject : "",
					status,
				});
			}
		}
		this.items = next;
	}

	snapshot(): TodoItem[] {
		return [...this.items.values()];
	}

	get size(): number {
		return this.items.size;
	}

	clear(): void {
		this.items.clear();
	}
}
