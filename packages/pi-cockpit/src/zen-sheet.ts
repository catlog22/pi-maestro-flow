import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import type { MaestroGoalV1, MaestroUiStateSnapshotV1 } from "./public/v1/events.ts";
import type { TodoItem } from "./types.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";
import { overlayListRows } from "./viewport.ts";

export interface ZenSheetField {
	label: string;
	value: string;
	color?: ThemeColor;
}

export interface ZenSheetDocument {
	breadcrumb: string;
	title: string;
	status?: string;
	fields: ZenSheetField[];
}

export interface ZenSheetParams {
	getDocument: () => ZenSheetDocument | undefined;
	requestRender: () => void;
	close: () => void;
	theme: Theme;
	glyphs: IconGlyphs;
	getTerminalRows?: () => number | undefined;
}

const CARD_CHROME_ROWS = 5;

function clean(value: string | undefined): string {
	return value === undefined ? "" : sanitizeExtensionStatusText(value);
}

function finite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function timestamp(value: number | undefined): string {
	return value === undefined || !Number.isFinite(value) ? "" : new Date(value).toLocaleString();
}

function duration(seconds: number): string {
	const total = finite(seconds);
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const rest = total % 60;
	return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${rest}s`].filter(Boolean).join(" ");
}

function goalFor(snapshot: MaestroUiStateSnapshotV1, id?: string): MaestroGoalV1 | undefined {
	return (id ? snapshot.goals.find((goal) => goal.id === id) : undefined)
		?? snapshot.goals.find((goal) => goal.id === snapshot.currentGoalId)
		?? snapshot.goals[0];
}

export function buildZenMissionSheet(snapshot: MaestroUiStateSnapshotV1 | undefined): ZenSheetDocument | undefined {
	if (!snapshot) return undefined;
	const workflow = snapshot.workflow;
	const goal = goalFor(snapshot);
	if (!workflow && !goal) return undefined;
	const title = clean(workflow?.session.label) || clean(goal?.objective) || clean(workflow?.session.id) || clean(goal?.id);
	const status = clean(workflow?.session.status) || clean(goal?.status);
	const fields: ZenSheetField[] = [
		{ label: tuiT("zen.sheet.field.session"), value: clean(workflow?.session.id) },
		{ label: tuiT("zen.sheet.field.goal"), value: clean(goal?.id) },
		{ label: tuiT("zen.sheet.field.status"), value: tuiStatus(status || "unknown"), color: statusColor(status) },
		{ label: tuiT("zen.sheet.field.gates"), value: workflow ? `${finite(workflow.gates.passed)}/${finite(workflow.gates.total)}` : "" },
		{ label: tuiT("zen.sheet.field.run"), value: clean(workflow?.run?.command) },
		{ label: tuiT("zen.sheet.field.chain"), value: workflow
			? `${finite(workflow.chain.completed)}/${finite(workflow.chain.total)} · ${finite(workflow.chain.running)} running · ${finite(workflow.chain.pending)} pending`
			: "" },
		{ label: tuiT("zen.sheet.field.next"), value: clean(workflow?.next ?? undefined) },
		{ label: tuiT("zen.sheet.field.iteration"), value: goal ? String(finite(goal.iteration)) : "" },
		{ label: tuiT("zen.sheet.field.tokens"), value: goal
			? `${finite(goal.tokensUsed)}${goal.tokenBudget === undefined ? "" : ` / ${finite(goal.tokenBudget)}`}`
			: "" },
		{ label: tuiT("zen.sheet.field.time"), value: goal ? duration(goal.timeUsedSeconds) : "" },
		{ label: tuiT("zen.sheet.field.pause"), value: clean(goal?.pauseReason), color: "warning" },
	];
	return {
		breadcrumb: tuiT("zen.sheet.breadcrumb.mission"),
		title,
		...(status ? { status } : {}),
		fields: fields.filter((field) => field.value !== ""),
	};
}

export function buildZenRunSheet(snapshot: MaestroUiStateSnapshotV1 | undefined): ZenSheetDocument | undefined {
	const workflow = snapshot?.workflow;
	if (!workflow) return undefined;
	const run = workflow.run;
	const status = clean(run?.status) || clean(workflow.session.status);
	return {
		breadcrumb: tuiT("zen.sheet.breadcrumb.run"),
		title: clean(run?.command) || clean(run?.id) || clean(workflow.session.label),
		...(status ? { status } : {}),
		fields: [
			{ label: tuiT("zen.sheet.field.run"), value: clean(run?.id) },
			{ label: tuiT("zen.sheet.field.status"), value: tuiStatus(status || "unknown"), color: statusColor(status) },
			{ label: tuiT("zen.sheet.field.session"), value: clean(workflow.session.id) },
			{ label: tuiT("zen.sheet.field.chain"), value: `${finite(workflow.chain.completed)}/${finite(workflow.chain.total)} · ${finite(workflow.chain.running)} running · ${finite(workflow.chain.pending)} pending` },
			{ label: tuiT("zen.sheet.field.gates"), value: `${finite(workflow.gates.passed)}/${finite(workflow.gates.total)}` },
			{ label: tuiT("zen.sheet.field.next"), value: clean(workflow.next ?? undefined) },
		].filter((field) => field.value !== ""),
	};
}

export function buildZenSwarmSheet(snapshot: MaestroUiStateSnapshotV1 | undefined): ZenSheetDocument | undefined {
	const swarm = snapshot?.swarm;
	if (!swarm) return undefined;
	const status = clean(swarm.status);
	return {
		breadcrumb: tuiT("zen.sheet.breadcrumb.swarm"),
		title: clean(swarm.objective) || clean(swarm.sessionId),
		...(status ? { status } : {}),
		fields: [
			{ label: tuiT("zen.sheet.field.session"), value: clean(swarm.sessionId) },
			{ label: tuiT("zen.sheet.field.status"), value: tuiStatus(status || "unknown"), color: statusColor(status) },
			{ label: tuiT("zen.sheet.field.objective"), value: clean(swarm.objective) },
			{ label: tuiT("zen.sheet.field.iteration"), value: `${finite(swarm.iteration)} / ${finite(swarm.maxIterations)}` },
			{ label: tuiT("zen.sheet.field.workers"), value: swarm.workers.map((worker) => `${clean(worker.label) || clean(worker.id)} (${tuiStatus(clean(worker.status) || "unknown")})`).join(", ") },
			{ label: tuiT("zen.sheet.field.best"), value: swarm.best ? `${swarm.best.score}${swarm.best.summary ? ` · ${clean(swarm.best.summary)}` : ""}` : "" },
			{ label: tuiT("zen.sheet.field.updated"), value: timestamp(swarm.updatedAt) },
		].filter((field) => field.value !== ""),
	};
}

export function buildZenTaskSheet(item: TodoItem | undefined): ZenSheetDocument | undefined {
	if (!item) return undefined;
	const fields: ZenSheetField[] = [
		{ label: tuiT("zen.sheet.field.task"), value: item.id },
		{ label: tuiT("zen.sheet.field.status"), value: tuiStatus(item.status), color: statusColor(item.status) },
		{ label: tuiT("zen.sheet.field.assignee"), value: item.assignee ? `@${clean(item.assignee.label)}` : "" },
		{ label: tuiT("zen.sheet.field.createdBy"), value: item.createdBy ? `@${clean(item.createdBy.label)}` : "" },
		{ label: tuiT("zen.sheet.field.blockedBy"), value: item.blockedBy.join(", "), ...(item.blockedBy.length > 0 ? { color: "warning" as const } : {}) },
		{ label: tuiT("zen.sheet.field.skills"), value: item.skills.map((skill) => clean(skill.name)).filter(Boolean).join(", ") },
		{ label: tuiT("zen.sheet.field.updated"), value: timestamp(item.updatedAt) },
	];
	return {
		breadcrumb: tuiT("zen.sheet.breadcrumb.task"),
		title: clean(item.subject) || item.id,
		status: item.status,
		fields: fields.filter((field) => field.value !== ""),
	};
}

export class ZenSheet implements Component, Focusable {
	focused = false;
	private scroll = 0;
	private maxScroll = 0;

	constructor(private readonly params: ZenSheetParams) {}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.params.close();
			return;
		}
		const page = this.pageRows();
		if (matchesKey(data, Key.up) || data === "k") this.move(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-page);
		else if (matchesKey(data, Key.pageDown)) this.move(page);
		else if (matchesKey(data, Key.home)) this.move(-Number.MAX_SAFE_INTEGER);
		else if (matchesKey(data, Key.end)) this.move(Number.MAX_SAFE_INTEGER);
		else return;
		this.params.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, 100));
		const document = this.params.getDocument();
		if (!document) return [truncateToWidth(tuiT("zen.sheet.unavailable"), safeWidth, this.params.glyphs.ellipsis)];
		if (safeWidth < 20) return [truncateToWidth(`${document.breadcrumb} · ${document.title} · Esc`, safeWidth, this.params.glyphs.ellipsis)];

		const inner = safeWidth - 2;
		const content = this.content(document, inner);
		const page = this.pageRows();
		this.maxScroll = Math.max(0, content.length - page);
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
		const visible = content.slice(this.scroll, this.scroll + page);
		const above = this.scroll > 0 ? this.params.glyphs.arrow : "";
		const below = this.scroll < this.maxScroll ? this.params.glyphs.arrow : "";
		const help = [above, tuiT("zen.sheet.help"), below].filter(Boolean).join(" ");
		return this.card([
			this.params.theme.fg("dim", document.breadcrumb),
			this.params.theme.fg("borderMuted", this.params.glyphs.box.horizontal.repeat(inner)),
			...visible,
			this.params.theme.fg("dim", truncateToWidth(help, inner, this.params.glyphs.ellipsis)),
		], safeWidth);
	}

	private pageRows(): number {
		return overlayListRows(this.params.getTerminalRows?.(), CARD_CHROME_ROWS);
	}

	private content(document: ZenSheetDocument, width: number): string[] {
		const lines = [this.params.theme.bold(truncateToWidth(document.title, width, this.params.glyphs.ellipsis))];
		const labelWidth = Math.min(18, Math.max(6, ...document.fields.map((field) => visibleWidth(field.label))));
		for (const field of document.fields) {
			const label = truncateToWidth(field.label, labelWidth, this.params.glyphs.ellipsis);
			const prefix = `${this.params.theme.fg("dim", label.padEnd(labelWidth))}  `;
			const valueWidth = Math.max(1, width - labelWidth - 2);
			const colored = this.params.theme.fg(field.color ?? "muted", field.value);
			const wrapped = wrapTextWithAnsi(colored, valueWidth).slice(0, 8);
			lines.push(`${prefix}${wrapped[0] ?? ""}`);
			for (const continuation of wrapped.slice(1)) lines.push(`${" ".repeat(labelWidth + 2)}${continuation}`);
		}
		return lines;
	}

	private card(rows: string[], width: number): string[] {
		const box = this.params.glyphs.box;
		const edge = box.horizontal.repeat(Math.max(0, width - 2));
		const background = (value: string) => this.params.theme.bg("customMessageBg", value);
		return [
			background(this.params.theme.fg("borderMuted", `${box.topLeft}${edge}${box.topRight}`)),
			...rows.map((row) => background(pad(` ${row}`, width))),
			background(this.params.theme.fg("borderMuted", `${box.bottomLeft}${edge}${box.bottomRight}`)),
		];
	}

	private move(delta: number): void {
		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
	}
}

function statusColor(status: string): ThemeColor {
	const normalized = status.toLowerCase();
	if (/fail|error|blocked/.test(normalized)) return "error";
	if (/pause|retry|waiting|idle/.test(normalized)) return "warning";
	if (/done|complete|success|passed|ready/.test(normalized)) return "success";
	return /run|active|progress|working/.test(normalized) ? "accent" : "muted";
}

function pad(value: string, width: number): string {
	const fitted = truncateToWidth(value, width, "…");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
