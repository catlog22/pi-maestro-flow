import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { acquireMouseReporting, flushMouseReportingWrites } from "../mouse-reporting.ts";
import {
	createSettingsTranslator,
	mergeTranslationCatalogs,
	type ConfiguredSettingValue,
	type JsonValue,
	type SettingDefinition,
	type SettingsActivationPlan,
	type SettingsChange,
	type SettingsContextV1,
	type SettingsOverviewRow,
	type SettingsResourceConflict,
	type SettingsScope,
	type SettingsSnapshot,
	type SettingsTranslator,
} from "pi-maestro-settings-core/v1";
import {
	SETTINGS_SECRET_SET_PLACEHOLDER,
} from "pi-maestro-settings-core/v1/schema";
import { parseSgrMouseEvent } from "../split-pane.ts";
import { terminalRows } from "../stack-widget.ts";
import { SettingsCoordinator, type SettingsApplyOutcome, type SettingsProviderFailure } from "./coordinator.ts";
import { SETTINGS_SHELL_CATALOGS } from "./i18n.ts";
import type { SettingsLocaleState } from "./locale-state.ts";
import type { DescribedSettingsProvider, SettingsProviderRegistry } from "./registry.ts";
import { fit, frame, headerLine, helpLine, pad, rule, type FrameTheme } from "./ui-primitives.ts";

export interface SettingsShellLoadResult {
	context: SettingsContextV1;
	providers: DescribedSettingsProvider[];
	failures: SettingsProviderFailure[];
}

export interface SettingsShellActionRequest {
	providerId: string;
	actionId: string;
	key: string;
}

export interface SettingsShellParams {
	registry: SettingsProviderRegistry;
	coordinator: SettingsCoordinator;
	localeState: SettingsLocaleState;
	initial: SettingsShellLoadResult;
	reload: () => Promise<SettingsShellLoadResult>;
	theme: Theme;
	modelOptions?: readonly string[];
	getTerminalRows?: () => number | undefined;
	getTerminalColumns?: () => number | undefined;
	disposeMouseReporting?: () => void;
	requestRender: () => void;
	requestAction: (request: SettingsShellActionRequest) => void;
	close: () => void;
}

interface EditingState {
	providerId: string;
	definition: SettingDefinition;
	value: string;
	replaceOnType: boolean;
	error?: string;
	/** list-crud: when set, committing writes the value back into the item field. */
	itemWriteback?: { key: string; itemIndex: number; fieldKey: string };
}

interface OptionEditingState {
	providerId: string;
	definition: SettingDefinition;
	options: readonly { value: JsonValue; label: string; disabled?: boolean }[];
	selected: number;
}

interface MouseTarget {
	id: string;
	kind: "group" | "setting" | "option" | "list-item" | "list-field";
	index: number;
	row: number;
	startColumn: number;
	endColumn: number;
	disabled?: boolean;
}

interface ListCrudState {
	providerId: string;
	key: string;
	items: JsonValue[];
	selected: number;
}

interface ListCrudFieldState {
	itemIndex: number;
	fieldIndex: number;
}

/** One row of the flat vertical settings list (a group header or a setting). */
interface FlatRow {
	kind: "header" | "setting";
	label: string;
	providerIndex: number;
	settingIndex: number;
}

const OVERVIEW_TONE: Record<NonNullable<SettingsOverviewRow["status"]>, "success" | "warning" | "error" | "dim"> = {
	ok: "success",
	warn: "warning",
	error: "error",
	dim: "dim",
} as const;

const MAX_SETTING_ROWS = 10;
const MAX_PROVIDER_ROWS = 9;
/** Preferred overlay width as a fraction of the terminal, matching sibling overlays; the shell caps its own render width. */
const SETTINGS_OVERLAY_WIDTH_VALUE = "94%" as const;
const SETTINGS_OVERLAY_MAX_HEIGHT = 0.97;
const SETTINGS_OVERLAY_MAX_HEIGHT_VALUE = "97%" as const;
const SETTINGS_OVERLAY_MARGIN = 1;
/** Editor kinds whose value can be edited inline by typing a raw value. */
const EDITABLE_VALUE_KINDS: ReadonlySet<string> = new Set([
	"text", "integer", "number", "json", "string-list", "multiselect",
]);

/** Mask an in-progress secret draft so typed plaintext never renders. */
function maskSecretValue(value: string): string {
	return value ? "•".repeat(visibleWidth(value)) : "";
}

/** Stable status glyph for overview rows so state is never color-only (ui-conventions). */
function overviewGlyph(status: SettingsOverviewRow["status"] | undefined): string {
	switch (status) {
		case "ok": return "●";
		case "warn": return "◐";
		case "error": return "!";
		default: return "○";
	}
}

export class MaestroSettingsShell implements Component, Focusable {
	focused = false;
	private context: SettingsContextV1;
	private providers: DescribedSettingsProvider[];
	private failures: SettingsProviderFailure[];
	/** Index into the top-level group list. */
	private groupIndex = 0;
	/** When set, the shell is showing that group's settings (level 1). */
	private activeGroup: { providerIndex: number; group: string } | undefined;
	/** Index into the active group's settings (level 1). */
	private settingIndex = 0;
	private scope: SettingsScope = "global";
	private search = "";
	private searching = false;
	private editing: EditingState | undefined;
	private optionEditing: OptionEditingState | undefined;
	/** Read-only popup showing an overview setting's diagnostic rows. */
	private viewingOverview = false;
	private listCrud: ListCrudState | undefined;
	private listCrudField: ListCrudFieldState | undefined;
	private deleteArmed = false;
	private applying = false;
	private notice = "";
	private noticeTone: "dim" | "success" | "warning" | "error" = "dim";
	private conflicts: readonly SettingsResourceConflict[] = [];
	private discardArmed = false;
	private translator: SettingsTranslator;
	private mouseTargets: MouseTarget[] = [];
	private hoveredTargetId: string | undefined;
	private lastRenderedWidth = 0;
	private lastRenderedHeight = 0;
	private disposed = false;

	constructor(private readonly params: SettingsShellParams) {
		this.context = params.initial.context;
		this.providers = params.initial.providers;
		this.failures = params.initial.failures;
		this.translator = this.createTranslator();
		this.syncSelection();
	}

	invalidate(): void {}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.params.disposeMouseReporting?.();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(150, Math.trunc(width)));
		// A width switch invalidates hover coordinates even when the target ids
		// are the same: the highlight must not linger at a stale spot until the
		// mouse moves again (SK-7).
		if (safeWidth !== this.lastRenderedWidth) this.hoveredTargetId = undefined;
		this.mouseTargets = [];
		if (safeWidth < 20) {
			const rendered = [truncateToWidth(`${this.t("settings.title")} · Esc`, safeWidth, "…")];
			this.lastRenderedWidth = safeWidth;
			this.lastRenderedHeight = rendered.length;
			return rendered;
		}
		const inner = safeWidth - 2;
		const body = this.editing || this.optionEditing || this.listCrud || this.listCrudField || this.viewingOverview
			? this.renderEditPopup(inner)
			: this.activeGroup
				? this.renderGroupSettings(inner)
				: this.renderGroups(inner);
		const rendered = frame(body, safeWidth, this.params.theme);
		this.lastRenderedWidth = safeWidth;
		this.lastRenderedHeight = rendered.length;
		return rendered;
	}

	handleInput(data: string): void {
		if (this.handleMouseInput(data)) return;
		if (this.applying) return;
		if (this.editing) {
			this.handleEditorInput(data);
			return;
		}
		if (this.listCrudField) {
			this.handleListCrudFieldInput(data);
			return;
		}
		if (this.listCrud) {
			this.handleListCrudInput(data);
			return;
		}
		if (this.optionEditing) {
			this.handleOptionEditorInput(data);
			return;
		}
		if (this.searching) {
			this.handleSearchInput(data);
			return;
		}
		if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
			void this.apply();
			return;
		}
		if (matchesKey(data, Key.ctrl("l")) || data === "\x0c") {
			void this.toggleLocale();
			return;
		}
		if (matchesKey(data, Key.f5)) {
			if (this.params.coordinator.modifiedProviderIds().length > 0 && !this.discardArmed) {
				this.discardArmed = true;
				this.setNotice(this.t("settings.discardConfirm"), "warning");
				return;
			}
			void this.reload();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.viewingOverview) {
				this.viewingOverview = false;
				this.afterNavigation();
				return;
			}
			if (this.activeGroup) {
				this.closeGroup();
				return;
			}
			if (this.params.coordinator.modifiedProviderIds().length > 0 && !this.discardArmed) {
				this.discardArmed = true;
				this.setNotice(this.t("settings.discardConfirm"), "warning");
				return;
			}
			if (this.discardArmed) this.params.coordinator.discard();
			this.params.close();
			return;
		}
		const printable = decodeKittyPrintable(data);
		if (printable === "/" || data === "/") {
			this.searching = true;
			this.discardArmed = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) return this.activeGroup ? this.moveSetting(-1) : this.moveGroup(-1);
		if (matchesKey(data, Key.down)) return this.activeGroup ? this.moveSetting(1) : this.moveGroup(1);
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.moveScope(matchesKey(data, Key.shift("tab")) ? -1 : 1);
			return;
		}
		if (printable === "u" || data === "u" || data === "U") {
			const selected = this.selectedSetting();
			const provider = this.selectedProvider();
			if (selected && provider && selected.scopes.includes(this.scope)) {
				this.params.coordinator.setChange(provider.providerId, { operation: "unset", key: selected.key, scope: this.scope });
				this.afterDraftChange();
			}
			return;
		}
		if (matchesKey(data, Key.space) || data === " " || matchesKey(data, Key.enter) || data === "\r") {
			if (this.activeGroup) void this.activateSelected();
			else this.openGroup();
		}
	}

	private renderGroups(inner: number): string[] {
		const rows = [this.header(inner), rule(inner)];
		const groupRows = this.groupRows();
		const rowStart = rows.length + 1;
		if (groupRows.length === 0) {
			rows.push(this.params.theme.fg("dim", fit(this.t("settings.noMatches"), inner)));
		} else {
			const start = visibleStart(this.groupIndex, groupRows.length, MAX_SETTING_ROWS);
			const end = Math.min(groupRows.length, start + MAX_SETTING_ROWS);
			for (let index = start; index < end; index++) {
				const row = groupRows[index]!;
				const selected = index === this.groupIndex;
				const marker = selected ? this.params.theme.fg("accent", "›") : " ";
				const targetId = `group:${row.providerIndex}:${row.group}`;
				this.mouseTargets.push({
					id: targetId,
					kind: "group",
					index,
					row: rows.length,
					startColumn: 1,
					endColumn: 1 + inner,
				});
				rows.push(this.interactiveRow(
					`${marker} ${selected ? this.params.theme.bold(row.label) : row.label} · ${this.t("settings.groupCount", { count: row.count })}`,
					inner,
					targetId,
					selected,
				));
			}
		}
		rows.push(...this.footerRows(inner));
		return this.padToTarget(rows);
	}

	/** Level 1: the active group's settings as a vertical list. */
	private renderGroupSettings(inner: number): string[] {
		const group = this.activeGroup;
		const provider = group ? this.providers[group.providerIndex] : undefined;
		if (!provider || !group) return [this.params.theme.fg("dim", fit(this.t("settings.noMatches"), inner))];
		const rows = [this.header(inner), rule(inner), headerLine(this.params.theme, this.t(group.group), [], inner), rule(inner)];
		const settings = this.groupSettings();
		if (settings.length === 0) {
			rows.push(this.params.theme.fg("dim", fit(this.t("settings.noMatches"), inner)));
		} else {
			const start = visibleStart(this.settingIndex, settings.length, MAX_SETTING_ROWS);
			const end = Math.min(settings.length, start + MAX_SETTING_ROWS);
			for (let index = start; index < end; index++) {
				const { definition } = settings[index]!;
				const selected = index === this.settingIndex;
				const activeEditor = this.isEditing(provider.providerId, definition.key);
				const marker = activeEditor
					? this.params.theme.fg("accent", "✎")
					: selected ? this.params.theme.fg("accent", "›") : " ";
				const value = this.displayValue(provider.providerId, definition, this.scope);
				const targetId = `setting:${provider.providerId}:${definition.key}`;
				this.mouseTargets.push({
					id: targetId,
					kind: "setting",
					index,
					row: rows.length,
					startColumn: 1,
					endColumn: 1 + inner,
				});
				rows.push(this.interactiveRow(
					`${marker} ${selected ? this.params.theme.bold(this.t(definition.labelKey)) : this.t(definition.labelKey)} · ${value}`,
					inner,
					targetId,
					selected,
				));
			}
		}
		rows.push(...this.footerRows(inner));
		return this.padToTarget(rows);
	}

	/** Shared footer (rule + notice/conflicts/failures + help). */
	private footerRows(inner: number): string[] {
		const footerRows = [rule(inner)];
		if (this.notice) footerRows.push(this.paintNotice(this.notice, inner));
		for (const conflict of this.conflicts.slice(0, 2)) {
			footerRows.push(this.params.theme.fg("error", fit(`! ${conflict.resource.id}`, inner)));
		}
		if (!this.notice && this.failures.length > 0) {
			const failure = this.failures[0]!;
			footerRows.push(this.params.theme.fg("warning", fit(`${failure.providerId} · ${failure.message}`, inner)));
		}
		const dirty = this.params.coordinator.modifiedProviderIds().length > 0;
		footerRows.push(this.params.theme.fg("dim", fit(
			this.activeGroup
				? (dirty ? this.t("settings.helpDirty") : this.t("settings.help"))
				: (dirty ? this.t("settings.helpGroupDirty") : this.t("settings.helpGroup")),
			inner,
		)));
		return footerRows;
	}

	/** Pad so the overlay (frame + content) fills its height target. */
	private padToTarget(rows: string[]): string[] {
		const targetHeight = this.overlayHeightTarget();
		const paddingRows = targetHeight ? Math.max(0, targetHeight - 2 - rows.length) : 0;
		for (let index = 0; index < paddingRows; index++) rows.push("");
		return rows;
	}

	/** Centered editing popup for the selected setting (reuses the editor state machines). */
	private renderEditPopup(inner: number): string[] {
		const provider = this.selectedProvider();
		const definition = this.selectedSetting();
		if (!provider || !definition) return [this.params.theme.fg("dim", fit(this.t("settings.noMatches"), inner))];
		const rows: string[] = [];
		const scopes = definition.scopes.length > 0 ? this.t(`settings.scope.${this.scope}`) : "";
		const activation = this.t(`settings.activation.${definition.activation}`);
		const editingFlag = this.editing || this.optionEditing ? this.t("settings.editing") : "";
		rows.push(headerLine(this.params.theme, this.t(definition.labelKey), [scopes, activation, editingFlag].filter(Boolean), inner));
		if (definition.descriptionKey) rows.push(this.params.theme.fg("dim", fit(this.t(definition.descriptionKey), inner)));
		rows.push(rule(inner));
		if (this.listCrudField) {
			rows.push(...this.listCrudFieldRows(inner, rows.length, 1));
		} else if (this.listCrud) {
			rows.push(...this.listCrudRows(inner, rows.length, 1));
		} else if (this.editing) {
			rows.push(...this.textEditorRows(this.editing, inner));
		} else if (this.optionEditing) {
			rows.push(...this.optionEditorRows(this.optionEditing, inner, rows.length, 1));
		} else if (definition.editor.kind === "overview") {
			rows.push(...this.detailRows(provider, definition, inner, rows.length, 1));
		} else {
			const value = this.displayValue(provider.providerId, definition, this.scope);
			rows.push(fit(`${this.t("settings.effective")} · ${value}`, inner));
			if (definition.editor.kind === "action" || definition.editor.kind === "custom") {
				rows.push(fit(`${this.t("settings.manage")} · Enter`, inner));
			}
		}
		rows.push(rule(inner));
		if (this.notice) rows.push(this.paintNotice(this.notice, inner));
		rows.push(helpLine(this.params.theme, this.t("settings.editHelp"), inner));
		return this.padToTarget(rows);
	}

	/** ●/○ toggle indicator for list items carrying an `enabled` boolean field, mirroring the /skills UI. */
	private listCrudToggleIcon(item: JsonValue): string {
		const enabledField = this.listCrudFields().find((field) => field.key === "enabled" && field.editor.kind === "boolean");
		if (!enabledField) return "";
		const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
		// Strictly true only, matching listCrudFieldValue: null/undefined or a legacy
		// string "false" renders disabled in both the list and the field form.
		const enabled = record?.["enabled"] === true;
		return enabled ? this.params.theme.fg("success", "●") : this.params.theme.fg("dim", "○");
	}

	/**
	 * Boolean field values render with the ●/○ glyph so the field form matches the
	 * item list; an in-progress editor value is echoed inline with a cursor.
	 */
	private listCrudFieldValue(field: SettingDefinition, item: Record<string, unknown> | undefined, itemIndex: number): string {
		const editing = this.editing;
		if (editing?.itemWriteback
			&& editing.itemWriteback.itemIndex === itemIndex
			&& editing.definition.key === field.key) {
			const isSecret = field.editor.kind === "secret";
			const value = (isSecret ? maskSecretValue(editing.value) : editing.value) || this.t("settings.value.empty");
			return editing.replaceOnType ? `[${value}]` : `${value}█`;
		}
		const value = this.formatValue(field, item?.[field.key] as JsonValue | undefined);
		if (field.editor.kind !== "boolean") return value;
		const enabled = item?.[field.key] === true;
		return `${this.params.theme.fg(enabled ? "success" : "dim", enabled ? "●" : "○")} ${value}`;
	}

	private listCrudItemLabel(item: JsonValue, index: number): string {
		const editor = this.selectedSetting()?.editor;
		const labelKey = editor?.itemLabelKey;
		const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
		if (labelKey && record) {
			const vars: Record<string, string | number | boolean> = {};
			for (const [key, value] of Object.entries(record)) {
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") vars[key] = value;
			}
			return this.t(labelKey, vars);
		}
		const firstField = editor?.itemFields?.[0];
		const value = firstField ? record?.[firstField.key] : undefined;
		return typeof value === "string" && value ? value : `${this.t("settings.listCrudItem")} ${index + 1}`;
	}

	private listCrudRows(width: number, rowStart: number, columnStart: number): string[] {
		const list = this.listCrud;
		const definition = this.selectedSetting();
		if (!list || !definition) return [];
		const rows = [headerLine(this.params.theme, this.t(definition.labelKey), [], width), rule(width)];
		if (list.items.length === 0) {
			rows.push(this.params.theme.fg("dim", fit(this.t("settings.listCrudEmpty"), width)));
		} else {
			const limit = this.listCrudRowLimit();
			const start = visibleStart(list.selected, list.items.length, limit);
			const end = Math.min(list.items.length, start + limit);
			for (let index = start; index < end; index++) {
				const marker = index === list.selected ? this.params.theme.fg("accent", "›") : " ";
				const toggle = this.listCrudToggleIcon(list.items[index]!);
				const label = index === list.selected
					? this.params.theme.bold(this.listCrudItemLabel(list.items[index]!, index))
					: this.listCrudItemLabel(list.items[index]!, index);
				const targetId = `list-item:${index}`;
				this.mouseTargets.push({
					id: targetId,
					kind: "list-item",
					index,
					row: rowStart + rows.length,
					startColumn: columnStart,
					endColumn: columnStart + width,
				});
				rows.push(this.interactiveRow(
					`${marker} ${[toggle, label].filter(Boolean).join(" ")}`,
					width,
					targetId,
					index === list.selected,
				));
			}
			if (end < list.items.length) {
				rows.push(this.params.theme.fg("dim", fit(this.t("settings.listCrudMore", { count: list.items.length - end }), width)));
			}
		}
		rows.push(rule(width));
		rows.push(helpLine(this.params.theme, this.t("settings.listCrudHelp"), width));
		return rows;
	}

	private listCrudFieldRows(width: number, rowStart: number, columnStart: number): string[] {
		const list = this.listCrud;
		const fieldState = this.listCrudField;
		if (!list || !fieldState) return [];
		const fields = this.listCrudFields();
		const item = list.items[fieldState.itemIndex] as Record<string, unknown> | undefined;
		const rows = [headerLine(this.params.theme, this.listCrudItemLabel(list.items[fieldState.itemIndex]!, fieldState.itemIndex), [], width), rule(width)];
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index]!;
			const marker = index === fieldState.fieldIndex ? this.params.theme.fg("accent", "›") : " ";
			const label = index === fieldState.fieldIndex ? this.params.theme.bold(this.t(field.labelKey)) : this.t(field.labelKey);
			const value = this.listCrudFieldValue(field, item, fieldState.itemIndex);
			const targetId = `list-field:${index}`;
			this.mouseTargets.push({
				id: targetId,
				kind: "list-field",
				index,
				row: rowStart + rows.length,
				startColumn: columnStart,
				endColumn: columnStart + width,
			});
			rows.push(this.interactiveRow(`${marker} ${label} · ${value}`, width, targetId, index === fieldState.fieldIndex));
		}
		rows.push(rule(width));
		rows.push(helpLine(this.params.theme, this.t("settings.listCrudFieldHelp"), width));
		return rows;
	}

	private detailRows(
		provider: DescribedSettingsProvider,
		definition: SettingDefinition,
		width: number,
		rowStart: number,
		columnStart: number,
	): string[] {
		const snapshot = this.params.coordinator.baseline(provider.providerId);
		const configured = this.configuredValue(snapshot, definition.key, this.scope);
		const effective = snapshot?.effective.values.find((value) => value.key === definition.key);
		const rows = [
			this.params.theme.fg("muted", fit(this.t(definition.group), width)),
			this.params.theme.bold(fit(this.t(definition.labelKey), width)),
			...(definition.descriptionKey ? [this.params.theme.fg("dim", fit(this.t(definition.descriptionKey), width))] : []),
			fit(`${this.t("settings.scope")} · ${this.t(`settings.scope.${this.scope}`)}`, width),
			fit(`${this.t("settings.configured")} · ${this.displayConfigured(definition, configured)}`, width),
			fit(`${this.t("settings.effective")} · ${this.formatValue(definition, effective?.value)}`, width),
			fit(`${this.t("settings.source")} · ${effective?.scope
				? this.t(`settings.scope.${effective.scope}`)
				: this.t(`settings.source.${effective?.source ?? "default"}`)}`, width),
			fit(`${this.t("settings.applies")} · ${this.t(`settings.activation.${definition.activation}`)}`, width),
		];
		if (definition.sensitivity === "secret") rows.push(this.params.theme.fg("warning", fit(this.t("settings.secret"), width)));
		if (definition.editor.kind === "overview") {
			const overview = effective?.value;
			if (Array.isArray(overview)) {
				rows.push(rule(width));
				for (const row of overview as SettingsOverviewRow[]) {
					const label = row.labelKey ? this.t(row.labelKey) : (row.label ?? "");
					const tone = OVERVIEW_TONE[row.status ?? "dim"];
					rows.push(this.params.theme.fg(tone, fit(`${overviewGlyph(row.status)} ${label} · ${row.value}`, width)));
				}
			}
		}
		if (this.editing?.providerId === provider.providerId && this.editing.definition.key === definition.key) {
			rows.push(rule(width), ...this.textEditorRows(this.editing, width));
		}
		if (this.optionEditing?.providerId === provider.providerId && this.optionEditing.definition.key === definition.key) {
			rows.push(rule(width));
			rows.push(...this.optionEditorRows(this.optionEditing, width, rowStart + rows.length, columnStart));
		}
		return rows;
	}

	private header(width: number): string {
		const modified = this.params.coordinator.changes().length;
		const state = modified > 0 ? this.t("settings.modified", { count: modified }) : this.t("settings.clean");
		const search = this.searching || this.search ? ` · ${this.t("settings.search")}: ${this.search || "_"}` : "";
		const editing = this.editing || this.optionEditing ? ` · ${this.t("settings.editing")}` : "";
		return fit(
			`${this.params.theme.bold(this.t("settings.title"))} · ${this.t("settings.language")}: ${this.t(`settings.locale.${this.context.locale}`)} · ${state}${editing}${search}`,
			width,
		);
	}

	private async activateSelected(): Promise<void> {
		const provider = this.selectedProvider();
		const definition = this.selectedSetting();
		if (!provider || !definition || !definition.scopes.includes(this.scope)) return;
		if (definition.editor.kind === "overview") {
			this.viewingOverview = true;
			this.discardArmed = false;
			this.requestRender();
			return;
		}
		if (!provider.description.capabilities.write && definition.editor.kind !== "action" && definition.editor.kind !== "custom") {
			this.setNotice(this.t("settings.readOnly"), "warning");
			return;
		}
		if (definition.editor.kind === "action" || definition.editor.kind === "custom" || definition.editor.kind === "resource") {
			await this.invokeAction(provider, definition);
			return;
		}
		if (definition.editor.kind === "secret") {
			if (definition.editor.writeOnly) {
				// Writable secrets are entered masked and never pre-filled from the
				// snapshot: the provider returns a placeholder, not the plaintext.
				this.editing = {
					providerId: provider.providerId,
					definition,
					value: "",
					replaceOnType: true,
				};
				this.discardArmed = false;
				this.requestRender();
				return;
			}
			this.setNotice(this.t("settings.secret"), "warning");
			return;
		}
		if (definition.editor.kind === "boolean") {
			const current = this.currentValue(provider.providerId, definition);
			this.params.coordinator.setChange(provider.providerId, {
				operation: "set",
				key: definition.key,
				scope: this.scope,
				value: current !== true,
			});
			this.afterDraftChange();
			return;
		}
		if (definition.editor.kind === "enum") {
			const options = (definition.editor.options ?? []).map((option) => ({
				value: option.value as JsonValue,
				label: this.t(option.labelKey),
				disabled: option.disabled,
			}));
			if (options.length === 0) return;
			this.beginOptionEditor(provider.providerId, definition, options);
			return;
		}
		if (definition.editor.kind === "model" && (this.params.modelOptions?.length ?? 0) > 0) {
			const current = this.currentValue(provider.providerId, definition);
			const values = [...new Set([
				...(typeof current === "string" && current ? [current] : []),
				...(this.params.modelOptions ?? []),
			])];
			this.beginOptionEditor(
				provider.providerId,
				definition,
				values.map((value) => ({ value, label: value })),
			);
			return;
		}
		if (definition.editor.kind === "list-crud") {
			const current = this.currentValue(provider.providerId, definition);
			const items = Array.isArray(current) ? [...current] : [];
			this.listCrud = { providerId: provider.providerId, key: definition.key, items, selected: 0 };
			this.listCrudField = undefined;
			this.deleteArmed = false;
			this.requestRender();
			return;
		}
		// Unknown or not-yet-implemented editor kinds degrade to a read-only
		// entry instead of being treated as raw text (forward-compatible with
		// list-crud/overview added by later protocol revisions).
		if (!EDITABLE_VALUE_KINDS.has(definition.editor.kind)) {
			this.setNotice(this.t("settings.readOnly"), "warning");
			return;
		}
		this.editing = {
			providerId: provider.providerId,
			definition,
			value: editableValue(this.currentValue(provider.providerId, definition)),
			replaceOnType: true,
		};
		// Entering a modal editor disarms the pending Esc-discard confirmation.
		this.discardArmed = false;
		this.requestRender();
	}

	private async invokeAction(provider: DescribedSettingsProvider, definition: SettingDefinition): Promise<void> {
		const actionId = definition.editor.actionId ?? definition.editor.surfaceId;
		const registration = this.params.registry.get(provider.providerId);
		if (!actionId || !registration?.provider.invokeAction) {
			this.setNotice(this.t("settings.actionUnavailable"), "warning");
			return;
		}
		// Pi custom UI sessions are not re-entrant. Hand the action to the outer
		// shell loop so this overlay closes before the owning plugin opens its UI.
		this.params.requestAction({ providerId: provider.providerId, actionId, key: definition.key });
	}

	private handleEditorInput(data: string): void {
		const editing = this.editing;
		if (!editing) return;
		if (matchesKey(data, Key.escape)) {
			this.editing = undefined;
			this.discardArmed = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			const parsed = parseEditorValue(editing.definition, editing.value);
			if (!parsed.ok) {
				editing.error = this.t(parsed.messageKey, parsed.params);
				this.setNotice(editing.error, "error");
				return;
			}
			if (editing.itemWriteback && this.listCrud) {
				const { itemIndex, fieldKey } = editing.itemWriteback;
				this.listCrud.items = this.listCrud.items.map((entry, index) => {
					if (index !== itemIndex) return entry;
					// Defensive: only object items can carry the written-back field.
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
					return { ...entry as object, [fieldKey]: parsed.value } as JsonValue;
				});
				this.stageListCrud();
			} else {
				this.params.coordinator.setChange(editing.providerId, {
					operation: "set",
					key: editing.definition.key,
					scope: this.scope,
					value: parsed.value,
				});
			}
			this.editing = undefined;
			this.afterDraftChange();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			editing.value = editing.replaceOnType ? "" : removeLastCodePoint(editing.value);
			editing.replaceOnType = false;
			editing.error = undefined;
			this.notice = "";
			this.requestRender();
			return;
		}
		const printable = decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : "");
		if (printable) {
			editing.value = editing.replaceOnType ? printable : `${editing.value}${printable}`;
			editing.replaceOnType = false;
			editing.error = undefined;
			this.notice = "";
			this.requestRender();
		}
	}

	private beginOptionEditor(
		providerId: string,
		definition: SettingDefinition,
		options: OptionEditingState["options"],
	): void {
		// Entering a modal editor disarms the pending Esc-discard confirmation.
		this.discardArmed = false;
		const current = this.currentValue(providerId, definition);
		const currentIndex = options.findIndex((option) => Object.is(option.value, current) && !option.disabled);
		const firstEnabled = options.findIndex((option) => !option.disabled);
		this.optionEditing = {
			providerId,
			definition,
			options,
			selected: currentIndex >= 0 ? currentIndex : Math.max(0, firstEnabled),
		};
		this.notice = "";
		this.requestRender();
	}

	private listCrudFields(): readonly SettingDefinition[] {
		return this.selectedSetting()?.editor.itemFields ?? [];
	}

	private stageListCrud(): void {
		if (!this.listCrud) return;
		this.params.coordinator.setChange(this.listCrud.providerId, {
			operation: "set",
			key: this.listCrud.key,
			scope: this.scope,
			value: this.listCrud.items,
		});
		this.afterDraftChange();
	}

	private handleListCrudInput(data: string): void {
		const list = this.listCrud;
		if (!list) return;
		const printable = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, Key.escape)) {
			this.listCrud = undefined;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (list.items.length === 0) return;
			list.selected = (list.selected - 1 + list.items.length) % list.items.length;
			this.deleteArmed = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (list.items.length === 0) return;
			list.selected = (list.selected + 1) % list.items.length;
			this.deleteArmed = false;
			this.requestRender();
			return;
		}
		if (printable === "a" || printable === "A" || printable === "+") {
			const fields = this.listCrudFields();
			const blank = Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? null]));
			list.items = [...list.items, blank];
			list.selected = list.items.length - 1;
			this.deleteArmed = false;
			this.stageListCrud();
			return;
		}
		if (printable === "d" || printable === "D") {
			if (list.items.length === 0) return;
			if (!this.deleteArmed) {
				this.deleteArmed = true;
				this.setNotice(this.t("settings.listCrudDeleteConfirm"), "warning");
				this.requestRender();
				return;
			}
			list.items = list.items.filter((_entry, index) => index !== list.selected);
			list.selected = Math.min(list.selected, Math.max(0, list.items.length - 1));
			this.deleteArmed = false;
			this.stageListCrud();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			if (list.items.length === 0 || this.listCrudFields().length === 0) return;
			this.listCrudField = { itemIndex: list.selected, fieldIndex: 0 };
			this.deleteArmed = false;
			this.requestRender();
		}
	}

	private handleListCrudFieldInput(data: string): void {
		const list = this.listCrud;
		const fieldState = this.listCrudField;
		if (!list || !fieldState) return;
		const fields = this.listCrudFields();
		if (matchesKey(data, Key.escape)) {
			this.listCrudField = undefined;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (fields.length === 0) return;
			fieldState.fieldIndex = (fieldState.fieldIndex - 1 + fields.length) % fields.length;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (fields.length === 0) return;
			fieldState.fieldIndex = (fieldState.fieldIndex + 1) % fields.length;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.space) || data === " " || matchesKey(data, Key.enter) || data === "\r") {
			const field = fields[fieldState.fieldIndex];
			if (!field) return;
			if (field.editor.kind === "boolean") {
				// Boolean fields toggle in place (mirrors the /skills Space toggle) instead
				// of opening a raw text editor that would write a string "true"/"false".
				this.toggleListCrudBoolean(list, fieldState, field);
				return;
			}
			if (!(matchesKey(data, Key.enter) || data === "\r")) return;
			const item = list.items[fieldState.itemIndex] as Record<string, unknown> | undefined;
			this.editing = {
				providerId: list.providerId,
				definition: field,
				value: editableValue(item?.[field.key] as JsonValue | undefined),
				replaceOnType: true,
				itemWriteback: { key: list.key, itemIndex: fieldState.itemIndex, fieldKey: field.key },
			};
			this.discardArmed = false;
			this.requestRender();
		}
	}

	private toggleListCrudBoolean(list: ListCrudState, fieldState: ListCrudFieldState, field: SettingDefinition): void {
		const entry = list.items[fieldState.itemIndex];
		// Only object items carry fields; toggling a primitive would spread its
		// index keys into an object and corrupt the entry.
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
		const record = entry as Record<string, unknown>;
		const next = record[field.key] !== true;
		list.items = list.items.map((item, index) =>
			index === fieldState.itemIndex ? { ...item as object, [field.key]: next } as JsonValue : item);
		this.deleteArmed = false;
		this.stageListCrud();
	}

	private handleOptionEditorInput(data: string): void {
		const editing = this.optionEditing;
		if (!editing) return;
		if (matchesKey(data, Key.escape)) {
			this.optionEditing = undefined;
			this.discardArmed = false;
			this.requestRender();
			return;
		}
		if (editing.definition.editor.kind === "model" && (data === "e" || data === "E")) {
			const selected = editing.options[editing.selected];
			this.editing = {
				providerId: editing.providerId,
				definition: editing.definition,
				value: typeof selected?.value === "string" ? selected.value : "",
				replaceOnType: true,
			};
			this.optionEditing = undefined;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			editing.selected = pageEnabledOption(editing.options, editing.selected, -this.optionRowLimit());
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			editing.selected = pageEnabledOption(editing.options, editing.selected, this.optionRowLimit());
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			editing.selected = nextEnabledOption(editing.options, editing.selected, -1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			editing.selected = nextEnabledOption(editing.options, editing.selected, 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || matchesKey(data, Key.space) || data === " ") {
			const selected = editing.options[editing.selected];
			if (!selected || selected.disabled) return;
			this.params.coordinator.setChange(editing.providerId, {
				operation: "set",
				key: editing.definition.key,
				scope: this.scope,
				value: selected.value,
			});
			this.optionEditing = undefined;
			this.afterDraftChange();
		}
	}

	private textEditorRows(editing: EditingState, width: number): string[] {
		const isSecret = editing.definition.editor.kind === "secret";
		const displayValue = isSecret ? maskSecretValue(editing.value) : editing.value;
		const value = displayValue || this.t("settings.value.empty");
		const input = editing.replaceOnType ? `[${value}]` : `${value}█`;
		return [
			this.params.theme.fg("accent", fit(`✎ ${this.t("settings.input")} · ${input}`, width)),
			...(editing.error ? [this.params.theme.fg("error", fit(`! ${editing.error}`, width))] : []),
			this.params.theme.fg("dim", fit(
				editing.replaceOnType
					? isSecret ? this.t("settings.secretEditHelp") : this.t("settings.editorReplaceHelp")
					: this.t("settings.editorHelp"),
				width,
			)),
		];
	}

	private optionEditorRows(
		editing: OptionEditingState,
		width: number,
		rowStart: number,
		columnStart: number,
	): string[] {
		const maxRows = this.optionRowLimit();
		const start = visibleStart(editing.selected, editing.options.length, maxRows);
		const rows = [this.params.theme.bold(fit(this.t("settings.chooseValue"), width))];
		for (let index = start; index < Math.min(editing.options.length, start + maxRows); index++) {
			const option = editing.options[index]!;
			const marker = index === editing.selected ? this.params.theme.fg("accent", "›") : " ";
			const targetId = `option:${editing.providerId}:${editing.definition.key}:${index}`;
			this.mouseTargets.push({
				id: targetId,
				kind: "option",
				index,
				row: rowStart + rows.length,
				startColumn: columnStart,
				endColumn: columnStart + width,
				disabled: option.disabled,
			});
			const line = this.interactiveRow(`${marker} ${option.label}`, width, targetId, index === editing.selected);
			rows.push(option.disabled ? this.params.theme.fg("dim", line) : line);
		}
		if (start + maxRows < editing.options.length) {
			rows.push(this.params.theme.fg("dim", fit(this.t("settings.optionMore", { count: editing.options.length - (start + maxRows) }), width)));
		}
		rows.push(this.params.theme.fg("dim", fit(
			editing.definition.editor.kind === "model" ? this.t("settings.modelPickerHelp") : this.t("settings.optionPickerHelp"),
			width,
		)));
		return rows;
	}

	private isEditing(providerId: string, key: string): boolean {
		return (this.editing?.providerId === providerId && this.editing.definition.key === key)
			|| (this.optionEditing?.providerId === providerId && this.optionEditing.definition.key === key);
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.searching = false;
			this.syncSelection();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace)) this.search = removeLastCodePoint(this.search);
		else {
			const printable = decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : "");
			if (printable) this.search += printable;
		}
		this.groupIndex = 0;
		this.syncSelection();
		this.requestRender();
	}

	private async apply(): Promise<void> {
		if (this.params.coordinator.modifiedProviderIds().length === 0) return;
		this.applying = true;
		this.conflicts = [];
		this.setNotice(this.t("settings.applying"), "dim");
		try {
			const result = await this.params.coordinator.apply(this.context);
			this.showApplyResult(result);
		} catch (error) {
			// A non-provider failure must surface instead of leaving the busy
			// ellipsis up forever (SK-3).
			this.setNotice(
				this.t("settings.applyFailed", { message: error instanceof Error ? error.message : String(error) }),
				"error",
			);
		} finally {
			this.applying = false;
			this.requestRender();
		}
	}

	private showApplyResult(result: SettingsApplyOutcome): void {
		this.conflicts = result.conflicts;
		if (result.status === "committed") {
			const deferred = result.activation.some((entry) => entry.boundary !== "live")
				|| Object.values(result.runtime).some((entry) => entry.deferred.length > 0);
			this.setNotice(this.t(deferred ? "settings.savedDeferred" : "settings.saved"), result.failures.length > 0 ? "warning" : "success");
			return;
		}
		const key = result.status === "conflict" ? "settings.conflict"
			: result.status === "validation-failed" ? "settings.validationFailed"
			: result.status === "prepare-failed" ? "settings.prepareFailed"
			: "settings.commitFailed";
		const detail = result.issues[0]?.messageKey ? ` · ${this.t(result.issues[0].messageKey, result.issues[0].params)}`
			: result.failures[0]?.message ? ` · ${result.failures[0].message}` : "";
		this.setNotice(`${this.t(key)}${detail}`, "error");
	}

	private async toggleLocale(): Promise<void> {
		const next = this.context.locale === "en" ? "zh-CN" : "en";
		const result = this.params.localeState.setLocale(next);
		if (!result.ok) {
			this.setNotice(this.t(result.conflict ? "settings.localeConflict" : "settings.actionFailed", { message: result.error ?? "save failed" }), "error");
			return;
		}
		this.context = { ...this.context, locale: next };
		this.translator.setLocale(next);
		this.setNotice(this.t("settings.localeSaved"), "success");
		await this.reload(true, false);
	}

	private async reload(preserveNotice = false, discardDrafts = true): Promise<void> {
		this.applying = true;
		try {
			const loaded = await this.params.reload();
			this.context = loaded.context;
			this.providers = loaded.providers;
			this.failures = loaded.failures;
			this.translator = this.createTranslator();
			this.conflicts = [];
			this.syncSelection();
			// Discard drafts only after the reload succeeded: a failed reload must
			// not destroy unsaved changes (SK-2).
			if (discardDrafts) this.params.coordinator.discard();
			if (!preserveNotice) this.notice = "";
		} catch (error) {
			this.setNotice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.applying = false;
			this.discardArmed = false;
			this.requestRender();
		}
	}

	private createTranslator(): SettingsTranslator {
		return createSettingsTranslator({
			locale: this.context.locale,
			catalogs: mergeTranslationCatalogs(
				SETTINGS_SHELL_CATALOGS,
				...this.providers.map((provider) => provider.description.catalogs ?? {}),
			),
		});
	}

	private currentValue(providerId: string, definition: SettingDefinition): JsonValue | undefined {
		const change = this.params.coordinator.changes(providerId).find((entry) => entry.key === definition.key && entry.scope === this.scope);
		if (change?.operation === "set") return change.value;
		if (change?.operation === "unset") return this.params.coordinator.baseline(providerId)?.effective.values.find((value) => value.key === definition.key)?.value;
		const configured = this.configuredValue(this.params.coordinator.baseline(providerId), definition.key, this.scope);
		if (configured?.state === "set") return configured.value;
		return this.params.coordinator.baseline(providerId)?.effective.values.find((value) => value.key === definition.key)?.value ?? definition.defaultValue;
	}

	private displayValue(providerId: string, definition: SettingDefinition, scope: SettingsScope): string {
		if (this.editing?.providerId === providerId && this.editing.definition.key === definition.key) {
			const isSecret = definition.editor.kind === "secret";
			const value = (isSecret ? maskSecretValue(this.editing.value) : this.editing.value) || this.t("settings.value.empty");
			return this.editing.replaceOnType ? `[${value}]` : `${value}█`;
		}
		if (this.optionEditing?.providerId === providerId && this.optionEditing.definition.key === definition.key) {
			return this.optionEditing.options[this.optionEditing.selected]?.label ?? "—";
		}
		const change = this.params.coordinator.changes(providerId).find((entry) => entry.key === definition.key && entry.scope === scope);
		if (change?.operation === "unset") return this.t("settings.inherited");
		if (change?.operation === "set") return this.formatValue(definition, change.value);
		return this.displayConfigured(definition, this.configuredValue(this.params.coordinator.baseline(providerId), definition.key, scope));
	}

	private configuredValue(snapshot: SettingsSnapshot | undefined, key: string, scope: SettingsScope) {
		return snapshot?.configured.values.find((value) => value.key === key && value.scope === scope);
	}

	private displayConfigured(definition: SettingDefinition, configured: ConfiguredSettingValue | undefined): string {
		if (!configured || configured.state === "absent") return this.t("settings.state.absent");
		if (configured.state === "invalid") return this.t("settings.state.invalid");
		if (configured.state === "restricted") return this.t("settings.state.restricted");
		return this.formatValue(definition, configured.value);
	}

	private formatValue(definition: SettingDefinition, value: JsonValue | undefined): string {
		if (value === undefined) return "—";
		if (definition.editor.kind === "overview") {
			return Array.isArray(value) ? this.t("settings.overviewCount", { count: value.length }) : this.t("settings.value.empty");
		}
		if (definition.editor.kind === "secret") {
			// Never render secret plaintext: providers return the masked placeholder
			// when set, or null/empty when unset.
			return value === SETTINGS_SECRET_SET_PLACEHOLDER
				? this.t("settings.secretSet")
				: this.t("settings.secretUnset");
		}
		if (definition.editor.kind === "action" || definition.editor.kind === "custom" || definition.editor.kind === "resource") {
			const option = definition.editor.options?.find((entry) => Object.is(entry.value, value));
			return option ? this.t(option.labelKey) : this.t("settings.manage");
		}
		if (definition.editor.kind === "boolean" && typeof value === "boolean") {
			return this.t(value ? "settings.value.true" : "settings.value.false");
		}
		if (definition.editor.kind === "enum") {
			const option = definition.editor.options?.find((entry) => Object.is(entry.value, value));
			if (option) return this.t(option.labelKey);
		}
		if (definition.editor.kind === "string-list" && Array.isArray(value)) {
			const entries = value.filter((entry): entry is string => typeof entry === "string");
			return entries.length > 0 ? entries.join(", ") : this.t("settings.value.empty");
		}
		if (value === null) return this.t("settings.value.null");
		if (typeof value === "string") return value || this.t("settings.value.empty");
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value);
	}

	private handleMouseInput(data: string): boolean {
		const mouse = parseSgrMouseEvent(data);
		if (!mouse) return false;
		const target = this.mouseTargetAt(mouse.x, mouse.y);
		if (mouse.motion) {
			const nextHover = target?.id;
			if (nextHover !== this.hoveredTargetId) {
				this.hoveredTargetId = nextHover;
				this.requestRender();
			}
			return true;
		}
		if (mouse.release) return true;
		if (mouse.button === 64) {
			this.moveSettingByWheel(-1);
			return true;
		}
		if (mouse.button === 65) {
			this.moveSettingByWheel(1);
			return true;
		}
		if ((mouse.button & 3) !== 0 || !target) return true;
		this.hoveredTargetId = target.id;
		// While a text editor is open, every click is inert: the editor owns the
		// keystrokes and the list-field highlight must not diverge from the
		// itemWriteback commit target.
		if (this.editing) {
			this.requestRender();
			return true;
		}
		if (target.kind === "option") {
			const editing = this.optionEditing;
			const option = editing?.options[target.index];
			if (!editing || !option || target.disabled || option.disabled) {
				this.requestRender();
				return true;
			}
			editing.selected = target.index;
			this.params.coordinator.setChange(editing.providerId, {
				operation: "set",
				key: editing.definition.key,
				scope: this.scope,
				value: option.value,
			});
			this.optionEditing = undefined;
			this.afterDraftChange();
			return true;
		}
		if (target.kind === "list-item") {
			const list = this.listCrud;
			if (!list) {
				this.requestRender();
				return true;
			}
			list.selected = target.index;
			this.deleteArmed = false;
			this.requestRender();
			return true;
		}
		if (target.kind === "list-field") {
			const fieldState = this.listCrudField;
			if (!fieldState) {
				this.requestRender();
				return true;
			}
			fieldState.fieldIndex = target.index;
			this.requestRender();
			return true;
		}
		if (target.kind === "group") {
			this.groupIndex = target.index;
			this.openGroup();
			return true;
		}
		if (target.kind === "setting") {
			this.settingIndex = target.index;
			this.syncScope();
			this.afterNavigation(false);
			void this.activateSelected();
			return true;
		}
		if (this.optionEditing || this.searching || this.applying) {
			this.requestRender();
			return true;
		}
		this.requestRender();
		return true;
	}

	private mouseTargetAt(x: number, y: number): MouseTarget | undefined {
		const terminalWidth = this.params.getTerminalColumns?.();
		const terminalHeight = this.params.getTerminalRows?.();
		if (!terminalWidth || !terminalHeight || this.lastRenderedWidth < 1 || this.lastRenderedHeight < 1) return undefined;
		const availableWidth = Math.max(1, terminalWidth - SETTINGS_OVERLAY_MARGIN * 2);
		const availableHeight = Math.max(1, terminalHeight - SETTINGS_OVERLAY_MARGIN * 2);
		const overlayWidth = Math.min(this.lastRenderedWidth, availableWidth);
		const maxHeight = Math.max(1, Math.min(Math.floor(terminalHeight * SETTINGS_OVERLAY_MAX_HEIGHT), availableHeight));
		const overlayHeight = Math.min(this.lastRenderedHeight, maxHeight);
		const left = SETTINGS_OVERLAY_MARGIN + Math.floor((availableWidth - overlayWidth) / 2);
		const top = SETTINGS_OVERLAY_MARGIN + Math.floor((availableHeight - overlayHeight) / 2);
		const localColumn = x - 1 - left;
		const localRow = y - 1 - top;
		return this.mouseTargets.find((entry) => entry.row === localRow
			&& localColumn >= entry.startColumn
			&& localColumn < entry.endColumn);
	}

	private interactiveRow(value: string, width: number, targetId: string, selected: boolean): string {
		const fitted = fit(value, width);
		if (!selected && this.hoveredTargetId !== targetId) return fitted;
		return this.params.theme.bg?.("selectedBg", pad(fitted, width)) ?? fitted;
	}

	private overlayHeightTarget(): number | undefined {
		const terminalHeight = this.params.getTerminalRows?.();
		if (!terminalHeight) return undefined;
		return Math.max(1, Math.min(
			Math.floor(terminalHeight * SETTINGS_OVERLAY_MAX_HEIGHT),
			terminalHeight - SETTINGS_OVERLAY_MARGIN * 2,
		));
	}

	private optionRowLimit(): number {
		const overlayHeight = this.overlayHeightTarget();
		if (!overlayHeight) return 7;
		// Reserve the option chrome, the detail rows and one row for the possible
		// "N more" overflow marker so the trailing help line stays visible.
		return Math.max(1, Math.min(7, overlayHeight - 21));
	}

	private listCrudRowLimit(): number {
		const overlayHeight = this.overlayHeightTarget();
		if (!overlayHeight) return 10;
		// Shell chrome (header+rule, footer rule/help, frame, narrow title) plus the
		// list's own header/rule/rule/help and the possible "N more" marker ≈ 11;
		// a set notice adds one footer row. The TUI clips the frame at maxHeight.
		return Math.max(1, overlayHeight - 11 - (this.notice ? 1 : 0));
	}

	private settingRowLimit(narrow: boolean): number {
		const overlayHeight = this.overlayHeightTarget();
		if (!overlayHeight) return MAX_SETTING_ROWS;
		if (this.optionEditing) return 1;
		const available = Math.max(1, overlayHeight - (narrow ? 17 : 16));
		for (let rows = MAX_SETTING_ROWS; rows > 1; rows--) {
			if (rows + Math.ceil(rows / 3) <= available) return rows;
		}
		return 1;
	}

	private selectedProvider(): DescribedSettingsProvider | undefined {
		if (!this.activeGroup) return undefined;
		return this.providers[this.activeGroup.providerIndex];
	}

	/** Distinct groups across providers (top-level navigation). */
	private groupRows(): { providerIndex: number; group: string; label: string; count: number }[] {
		const query = this.search.trim().toLocaleLowerCase();
		const rows: { providerIndex: number; group: string; label: string; count: number }[] = [];
		for (let providerIndex = 0; providerIndex < this.providers.length; providerIndex++) {
			const provider = this.providers[providerIndex]!;
			const seen = new Set<string>();
			const providerLabel = this.t(provider.description.labelKey);
			for (const definition of provider.description.settings) {
				if (seen.has(definition.group)) continue;
				seen.add(definition.group);
				const count = provider.description.settings.filter((entry) => entry.group === definition.group).length;
				const label = `${providerLabel} · ${this.t(definition.group)}`;
				if (query && !label.toLocaleLowerCase().includes(query)) continue;
				rows.push({ providerIndex, group: definition.group, label, count });
			}
		}
		return rows;
	}

	/** Settings inside the active group (level 1), in provider order. */
	private groupSettings(): readonly { provider: DescribedSettingsProvider; definition: SettingDefinition }[] {
		if (!this.activeGroup) return [];
		const provider = this.providers[this.activeGroup.providerIndex];
		if (!provider) return [];
		const query = this.search.trim().toLocaleLowerCase();
		return provider.description.settings
			.filter((definition) => definition.group === this.activeGroup!.group
				&& (!query
					|| definition.key.toLocaleLowerCase().includes(query)
					|| this.t(definition.labelKey).toLocaleLowerCase().includes(query)))
			.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.key.localeCompare(right.key))
			.map((definition) => ({ provider, definition }));
	}

	private selectedSetting(): SettingDefinition | undefined {
		return this.groupSettings()[this.settingIndex]?.definition;
	}

	private moveGroup(delta: number): void {
		const rows = this.groupRows();
		if (rows.length === 0) return;
		this.groupIndex = (this.groupIndex + delta + rows.length) % rows.length;
		this.afterNavigation();
	}

	private openGroup(): void {
		const rows = this.groupRows();
		const row = rows[clampIndex(this.groupIndex, rows.length)];
		if (!row) return;
		// Opening a group drops the group-search filter so its settings are all visible.
		this.search = "";
		this.searching = false;
		this.activeGroup = { providerIndex: row.providerIndex, group: row.group };
		this.settingIndex = 0;
		this.syncScope();
		this.afterNavigation();
	}

	private closeGroup(): void {
		this.activeGroup = undefined;
		this.afterNavigation();
	}

	private moveSetting(delta: number): void {
		const settings = this.groupSettings();
		if (settings.length === 0) return;
		this.settingIndex = (this.settingIndex + delta + settings.length) % settings.length;
		this.syncScope();
		this.afterNavigation();
	}

	private moveSettingByWheel(delta: number): void {
		// Wheel must not bypass the modal input guards: while applying, navigation
		// is frozen; inside the option editor the wheel moves the option list;
		// while editing text the wheel must not yank the current row away from the
		// editor that still owns the keystrokes; inside list-crud the wheel must
		// not mutate the hidden settings list or clear the delete confirm.
		if (this.applying) return;
		if (this.optionEditing) {
			const editing = this.optionEditing;
			if (delta !== 0) editing.selected = nextEnabledOption(editing.options, editing.selected, delta > 0 ? 1 : -1);
			this.requestRender();
			return;
		}
		if (this.editing || this.listCrud || this.listCrudField) return;
		if (this.activeGroup) this.moveSetting(delta);
		else this.moveGroup(delta);
	}

	private moveScope(delta: number): void {
		const scopes = this.selectedSetting()?.scopes ?? [];
		if (scopes.length === 0) return;
		const index = Math.max(0, scopes.indexOf(this.scope));
		this.scope = scopes[(index + delta + scopes.length) % scopes.length]!;
		this.afterNavigation();
	}

	private syncSelection(): void {
		this.groupIndex = clampIndex(this.groupIndex, this.groupRows().length);
		this.settingIndex = clampIndex(this.settingIndex, this.groupSettings().length);
		this.syncScope();
	}

	private syncScope(): void {
		const scopes = this.selectedSetting()?.scopes ?? [];
		if (scopes.length > 0 && !scopes.includes(this.scope)) this.scope = scopes[0]!;
	}

	private afterDraftChange(): void {
		this.discardArmed = false;
		this.conflicts = [];
		this.notice = "";
		this.requestRender();
	}

	private afterNavigation(clearHover = true): void {
		this.discardArmed = false;
		this.notice = "";
		this.conflicts = [];
		if (clearHover) this.hoveredTargetId = undefined;
		this.requestRender();
	}

	private setNotice(value: string, tone: MaestroSettingsShell["noticeTone"]): void {
		this.notice = value;
		this.noticeTone = tone;
		this.requestRender();
	}

	private paintNotice(value: string, width: number): string {
		return this.params.theme.fg(this.noticeTone, fit(value, width));
	}

	private t(key: string, params?: Readonly<Record<string, string | number | boolean>>): string {
		return this.translator.t(key, params);
	}

	private requestRender(): void {
		this.params.requestRender();
	}
}

export async function showMaestroSettingsShell(
	ctx: ExtensionCommandContext,
	registry: SettingsProviderRegistry,
	localeState: SettingsLocaleState,
): Promise<void> {
	const coordinator = new SettingsCoordinator(registry);
	const load = async (): Promise<SettingsShellLoadResult> => {
		localeState.reload();
		const context: SettingsContextV1 = {
			cwd: ctx.cwd,
			locale: localeState.locale,
		};
		registry.discover(context);
		const providers = await registry.describe(context);
		const failures = await coordinator.load(context);
		return { context, providers, failures };
	};
	let initial = await load();
	while (true) {
		const result = await ctx.ui.custom<
			{ kind: "close" } | { kind: "action"; request: SettingsShellActionRequest }
		>((tui, theme, _keybindings, done) => {
			const disposeMouseReporting = enableSettingsMouseReporting(tui);
			try {
				return new MaestroSettingsShell({
					registry,
					coordinator,
					localeState,
					initial,
					reload: load,
					theme,
					modelOptions: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
					getTerminalRows: () => terminalRows(tui),
					getTerminalColumns: () => terminalColumns(tui),
					disposeMouseReporting,
					requestRender: () => tui.requestRender(),
					requestAction: (request) => done({ kind: "action", request }),
					close: () => done({ kind: "close" }),
				});
			} catch (error) {
				disposeMouseReporting();
				throw error;
			}
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: SETTINGS_OVERLAY_WIDTH_VALUE,
				maxHeight: SETTINGS_OVERLAY_MAX_HEIGHT_VALUE,
				margin: SETTINGS_OVERLAY_MARGIN,
			},
		});
		if (result.kind === "close") return;

		await executeSettingsShellAction(ctx, registry, initial.context, result.request);
		initial = await load();
	}
}

export async function executeSettingsShellAction(
	ctx: Pick<ExtensionCommandContext, "ui">,
	registry: SettingsProviderRegistry,
	context: SettingsContextV1,
	request: SettingsShellActionRequest,
): Promise<void> {
	const registration = registry.get(request.providerId);
	if (!registration?.provider.invokeAction) {
		ctx.ui.notify("This setting action is no longer available.", "warning");
		return;
	}
	try {
		const action = await registration.provider.invokeAction({
			context,
			actionId: request.actionId,
			key: request.key,
		});
		if (!action.handled) ctx.ui.notify("This setting action is not supported by its provider.", "warning");
	} catch (error) {
		ctx.ui.notify(`Could not open setting manager: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

type ParsedEditorValue =
	| { ok: true; value: JsonValue }
	| { ok: false; messageKey: string; params?: Readonly<Record<string, string | number | boolean>> };

function parseEditorValue(definition: SettingDefinition, value: string): ParsedEditorValue {
	if (definition.editor.kind === "integer" || definition.editor.kind === "number") {
		if (!value.trim()) return { ok: false, messageKey: "settings.invalidNumber" };
		const parsed = Number(value);
		const valid = definition.editor.kind === "integer" ? Number.isSafeInteger(parsed) : Number.isFinite(parsed);
		if (!valid) return { ok: false, messageKey: "settings.invalidNumber" };
		if (definition.editor.min !== undefined && parsed < definition.editor.min) {
			return { ok: false, messageKey: "settings.valueTooSmall", params: { min: definition.editor.min } };
		}
		if (definition.editor.max !== undefined && parsed > definition.editor.max) {
			return { ok: false, messageKey: "settings.valueTooLarge", params: { max: definition.editor.max } };
		}
		return { ok: true, value: parsed };
	}
	// Boolean fields toggle in place (activateSelected and toggleListCrudBoolean), so
	// this branch is a defensive fallback for any future entry point that still
	// routes boolean definitions through the raw text editor.
	if (definition.editor.kind === "boolean") {
		const normalized = value.trim().toLocaleLowerCase();
		if (normalized === "true" || normalized === "1" || normalized === "yes") return { ok: true, value: true };
		if (normalized === "false" || normalized === "0" || normalized === "no") return { ok: true, value: false };
		return { ok: false, messageKey: "settings.invalidBoolean" };
	}
	if (definition.editor.kind === "json") {
		try { return { ok: true, value: JSON.parse(value) as JsonValue }; }
		catch { return { ok: false, messageKey: "settings.invalidJson" }; }
	}
	if (definition.editor.kind === "string-list") {
		return { ok: true, value: value.split(",").map((entry) => entry.trim()).filter(Boolean) };
	}
	if (definition.editor.kind === "model") {
		const model = value.trim();
		return model.includes("/") && !model.startsWith("/") && !model.endsWith("/")
			? { ok: true, value: model }
			: { ok: false, messageKey: "settings.invalidModel" };
	}
	return { ok: true, value };
}

function editableValue(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function removeLastCodePoint(value: string): string {
	return [...value].slice(0, -1).join("");
}

function nextEnabledOption(
	options: OptionEditingState["options"],
	current: number,
	delta: -1 | 1,
): number {
	if (options.length === 0) return 0;
	for (let offset = 1; offset <= options.length; offset++) {
		const index = (current + delta * offset + options.length) % options.length;
		if (!options[index]?.disabled) return index;
	}
	return current;
}

/** Page jump that lands on the nearest enabled option around the page target. */
function pageEnabledOption(
	options: OptionEditingState["options"],
	current: number,
	offset: number,
): number {
	if (options.length === 0) return 0;
	const target = Math.max(0, Math.min(options.length - 1, current + offset));
	if (!options[target]?.disabled) return target;
	for (let distance = 1; distance < options.length; distance++) {
		for (const candidate of [target - distance, target + distance]) {
			if (candidate >= 0 && candidate < options.length && !options[candidate]?.disabled) return candidate;
		}
	}
	return current;
}

function visibleStart(selected: number, total: number, maxRows: number): number {
	if (total <= maxRows) return 0;
	return Math.max(0, Math.min(total - maxRows, selected - Math.floor(maxRows / 2)));
}

function clampIndex(index: number, length: number): number {
	return length <= 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function terminalColumns(tui: TUI): number | undefined {
	try {
		const columns = tui.terminal?.columns;
		return typeof columns === "number" && columns > 0 ? columns : undefined;
	} catch {
		return undefined;
	}
}

function enableSettingsMouseReporting(tui: TUI): () => void {
	// Hover reporting is ref-counted with the split-pane drag mode through the
	// shared 1006 SGR extension (CS-4). Release is idempotent.
	const lease = acquireMouseReporting(tui, "hover");
	return () => {
		lease.release();
		flushMouseReportingWrites(tui);
	};
}


