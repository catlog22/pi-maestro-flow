import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { TodoActor, TodoItem, TodoSkill, TodoState } from "./types.ts";
import { TODO_STATE_ENTRY_TYPE } from "./types.ts";

// The todo snapshot is LLM-authored. A subject carrying a raw newline or an ANSI
// escape measures zero columns, so it slips past every width guard and then splits
// or repaints the terminal. Strip control characters where the data enters.
function clean(raw: string): string {
	return sanitizeExtensionStatusText(raw);
}

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

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function asActor(value: unknown): TodoActor | undefined {
	const actor = asRecord(value);
	if (typeof actor?.id !== "string" || typeof actor.label !== "string") return undefined;
	return { id: clean(actor.id), label: clean(actor.label) };
}

function asSkills(value: unknown): TodoSkill[] {
	if (!Array.isArray(value)) return [];
	const skills: TodoSkill[] = [];
	for (const raw of value) {
		const skill = asRecord(raw);
		if (typeof skill?.name !== "string" || skill.name.length === 0) continue;
		skills.push({
			name: clean(skill.name),
			...(typeof skill.role === "string" ? { role: clean(skill.role) } : {}),
		});
	}
	return skills;
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
				const item: TodoItem = {
					id,
					subject: typeof r?.subject === "string" ? clean(r.subject) : "",
					status,
					blockedBy: asStringArray(r?.blockedBy),
					skills: asSkills(r?.skills),
				};
				const createdBy = asActor(r?.createdBy);
				const assignee = asActor(r?.assignee);
				if (createdBy) item.createdBy = createdBy;
				if (assignee) item.assignee = assignee;
				if (typeof r?.updatedAt === "number") item.updatedAt = r.updatedAt;
				next.set(id, item);
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
