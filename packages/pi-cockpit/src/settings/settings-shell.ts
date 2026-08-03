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
	type SettingsResourceConflict,
	type SettingsScope,
	type SettingsSnapshot,
	type SettingsTranslator,
} from "pi-maestro-settings-core/v1";
import { parseSgrMouseEvent } from "../split-pane.ts";
import { terminalRows } from "../stack-widget.ts";
import { SettingsCoordinator, type SettingsApplyOutcome, type SettingsProviderFailure } from "./coordinator.ts";
import { SETTINGS_SHELL_CATALOGS } from "./i18n.ts";
import type { SettingsLocaleState } from "./locale-state.ts";
import type { DescribedSettingsProvider, SettingsProviderRegistry } from "./registry.ts";

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
}

interface OptionEditingState {
	providerId: string;
	definition: SettingDefinition;
	options: readonly { value: JsonValue; label: string; disabled?: boolean }[];
	selected: number;
}

interface MouseTarget {
	id: string;
	kind: "provider" | "setting" | "option";
	index: number;
	row: number;
	startColumn: number;
	endColumn: number;
	disabled?: boolean;
}

const MAX_SETTING_ROWS = 10;
const MAX_PROVIDER_ROWS = 9;
const SETTINGS_OVERLAY_WIDTH = 112;
const SETTINGS_OVERLAY_MAX_HEIGHT = 0.92;
const SETTINGS_OVERLAY_MAX_HEIGHT_VALUE = "92%" as const;
const SETTINGS_OVERLAY_MARGIN = 1;

export class MaestroSettingsShell implements Component, Focusable {
	focused = false;
	private context: SettingsContextV1;
	private providers: DescribedSettingsProvider[];
	private failures: SettingsProviderFailure[];
	private providerIndex = 0;
	private settingIndex = 0;
	private scope: SettingsScope = "global";
	private search = "";
	private searching = false;
	private editing: EditingState | undefined;
	private optionEditing: OptionEditingState | undefined;
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
		// A width/wide-narrow switch invalidates hover coordinates even when the
		// target ids are the same: the highlight must not linger at a stale spot
		// until the mouse moves again (SK-7).
		if (safeWidth !== this.lastRenderedWidth) this.hoveredTargetId = undefined;
		this.mouseTargets = [];
		if (safeWidth < 20) {
			const rendered = [truncateToWidth(`${this.t("settings.title")} · Esc`, safeWidth, "…")];
			this.lastRenderedWidth = safeWidth;
			this.lastRenderedHeight = rendered.length;
			return rendered;
		}
		const inner = safeWidth - 2;
		const rows = [this.header(inner), rule(inner)];
		const interactiveRowStart = rows.length + 1;
		if (safeWidth >= 82) rows.push(...this.renderWide(inner, interactiveRowStart));
		else rows.push(...this.renderNarrow(inner, interactiveRowStart));
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
			safeWidth < 70
				? dirty ? this.t("settings.helpNarrowDirty") : this.t("settings.helpNarrow")
				: dirty ? this.t("settings.helpDirty") : this.t("settings.help"),
			inner,
		)));
		const targetHeight = this.overlayHeightTarget();
		const paddingRows = targetHeight ? Math.max(0, targetHeight - 2 - rows.length - footerRows.length) : 0;
		for (let index = 0; index < paddingRows; index++) rows.push("");
		rows.push(...footerRows);
		const rendered = frame(rows, safeWidth, this.params.theme);
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
		if (matchesKey(data, Key.left)) return this.moveProvider(-1);
		if (matchesKey(data, Key.right)) return this.moveProvider(1);
		if (matchesKey(data, Key.up)) return this.moveSetting(-1);
		if (matchesKey(data, Key.down)) return this.moveSetting(1);
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
			void this.activateSelected();
		}
	}

	private renderWide(width: number, rowStart: number): string[] {
		const providerWidth = Math.min(26, Math.max(20, Math.floor(width * 0.24)));
		const contentWidth = Math.max(1, width - providerWidth - 3);
		const providerRows = this.providerRows(providerWidth, rowStart, 1);
		const contentRows = this.contentRows(contentWidth, this.settingRowLimit(false), rowStart, providerWidth + 4);
		const rowCount = Math.max(providerRows.length, contentRows.length, 1);
		return Array.from({ length: rowCount }, (_, index) =>
			`${pad(providerRows[index] ?? "", providerWidth)} │ ${pad(contentRows[index] ?? "", contentWidth)}`
		);
	}

	private renderNarrow(width: number, rowStart: number): string[] {
		const provider = this.selectedProvider();
		const title = provider ? this.params.theme.bold(this.t(provider.description.labelKey)) : this.t("settings.providers");
		return [fit(title, width), ...this.contentRows(width, this.settingRowLimit(true), rowStart + 1, 1)];
	}

	private providerRows(width: number, rowStart: number, columnStart: number): string[] {
		const rows = [this.params.theme.bold(this.t("settings.providers"))];
		if (this.providers.length === 0) return [...rows, this.params.theme.fg("dim", fit(this.t("settings.noProviders"), width))];
		const start = visibleStart(this.providerIndex, this.providers.length, MAX_PROVIDER_ROWS);
		for (let index = start; index < Math.min(this.providers.length, start + MAX_PROVIDER_ROWS); index++) {
			const provider = this.providers[index]!;
			const marker = index === this.providerIndex ? this.params.theme.fg("accent", "›") : " ";
			const dirty = this.params.coordinator.changes(provider.providerId).length > 0 ? "*" : " ";
			const targetId = `provider:${provider.providerId}`;
			this.mouseTargets.push({
				id: targetId,
				kind: "provider",
				index,
				row: rowStart + rows.length,
				startColumn: columnStart,
				endColumn: columnStart + width,
			});
			rows.push(this.interactiveRow(`${marker}${dirty} ${this.t(provider.description.labelKey)}`, width, targetId, index === this.providerIndex));
		}
		return rows;
	}

	private contentRows(width: number, maxSettingRows: number, rowStart: number, columnStart: number): string[] {
		const provider = this.selectedProvider();
		if (!provider) return [this.params.theme.fg("dim", fit(this.t("settings.noProviders"), width))];
		const settings = this.visibleSettings();
		if (settings.length === 0) return [this.params.theme.fg("dim", fit(this.t("settings.noMatches"), width))];
		const rows: string[] = [];
		let start = visibleStart(this.settingIndex, settings.length, maxSettingRows);
		let backtracked = 0;
		while (start > 0 && backtracked < 2 && settings[start - 1]?.group === settings[start]?.group) {
			start--;
			backtracked++;
		}
		const end = Math.min(settings.length, start + maxSettingRows);
		let renderedGroup: string | undefined;
		for (let index = start; index < end; index++) {
			const definition = settings[index]!;
			if (definition.group !== renderedGroup) {
				renderedGroup = definition.group;
				rows.push(this.params.theme.fg("muted", fit(`— ${this.t(definition.group)} —`, width)));
			}
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
				row: rowStart + rows.length,
				startColumn: columnStart,
				endColumn: columnStart + width,
			});
			rows.push(this.interactiveRow(
				`${marker} ${selected ? this.params.theme.bold(this.t(definition.labelKey)) : this.t(definition.labelKey)} · ${value}`,
				width,
				targetId,
				selected,
			));
		}
		rows.push(rule(width));
		rows.push(...this.detailRows(provider, settings[this.settingIndex]!, width, rowStart + rows.length, columnStart));
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
		if (!provider.description.capabilities.write && definition.editor.kind !== "action" && definition.editor.kind !== "custom") {
			this.setNotice(this.t("settings.readOnly"), "warning");
			return;
		}
		if (definition.editor.kind === "action" || definition.editor.kind === "custom" || definition.editor.kind === "resource") {
			await this.invokeAction(provider, definition);
			return;
		}
		if (definition.editor.kind === "secret") {
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
			this.params.coordinator.setChange(editing.providerId, {
				operation: "set",
				key: editing.definition.key,
				scope: this.scope,
				value: parsed.value,
			});
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
		const value = editing.value || this.t("settings.value.empty");
		const input = editing.replaceOnType ? `[${value}]` : `${value}█`;
		return [
			this.params.theme.fg("accent", fit(`✎ ${this.t("settings.input")} · ${input}`, width)),
			...(editing.error ? [this.params.theme.fg("error", fit(`! ${editing.error}`, width))] : []),
			this.params.theme.fg("dim", fit(
				editing.replaceOnType ? this.t("settings.editorReplaceHelp") : this.t("settings.editorHelp"),
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
		this.settingIndex = 0;
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
			const value = this.editing.value || this.t("settings.value.empty");
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
		if (this.editing || this.optionEditing || this.searching || this.applying) {
			this.requestRender();
			return true;
		}
		if (target.kind === "provider") {
			if (target.index !== this.providerIndex) {
				this.providerIndex = target.index;
				this.settingIndex = 0;
				this.syncSelection();
				this.afterNavigation(false);
			} else {
				this.requestRender();
			}
			return true;
		}
		this.settingIndex = target.index;
		this.syncScope();
		this.afterNavigation(false);
		void this.activateSelected();
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
		return Math.max(1, Math.min(7, overlayHeight - 20));
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
		return this.providers[this.providerIndex];
	}

	private visibleSettings(): readonly SettingDefinition[] {
		const settings = this.selectedProvider()?.description.settings ?? [];
		const query = this.search.trim().toLocaleLowerCase();
		const groupOrder = new Map<string, number>();
		for (const definition of settings) {
			if (!groupOrder.has(definition.group)) groupOrder.set(definition.group, groupOrder.size);
		}
		return settings
			.filter((definition) => !query
				|| definition.key.toLocaleLowerCase().includes(query)
				|| this.t(definition.labelKey).toLocaleLowerCase().includes(query)
				|| this.t(definition.group).toLocaleLowerCase().includes(query))
			.sort((left, right) => (groupOrder.get(left.group) ?? Number.MAX_SAFE_INTEGER)
				- (groupOrder.get(right.group) ?? Number.MAX_SAFE_INTEGER)
				|| (left.order ?? 0) - (right.order ?? 0)
				|| left.key.localeCompare(right.key));
	}

	private selectedSetting(): SettingDefinition | undefined {
		return this.visibleSettings()[this.settingIndex];
	}

	private moveProvider(delta: number): void {
		if (this.providers.length === 0) return;
		this.providerIndex = (this.providerIndex + delta + this.providers.length) % this.providers.length;
		this.settingIndex = 0;
		this.syncSelection();
		this.afterNavigation();
	}

	private moveSettingByWheel(delta: number): void {
		// Wheel must not bypass the modal input guards: while applying, navigation
		// is frozen; inside the option editor the wheel moves the option list;
		// while editing text the wheel must not yank the current row away from
		// the editor that still owns the keystrokes.
		if (this.applying) return;
		if (this.optionEditing) {
			const editing = this.optionEditing;
			if (delta !== 0) editing.selected = nextEnabledOption(editing.options, editing.selected, delta > 0 ? 1 : -1);
			this.requestRender();
			return;
		}
		if (this.editing) return;
		this.moveSetting(delta);
	}

	private moveSetting(delta: number): void {
		const settings = this.visibleSettings();
		if (settings.length === 0) return;
		this.settingIndex = (this.settingIndex + delta + settings.length) % settings.length;
		this.syncScope();
		this.afterNavigation();
	}

	private moveScope(delta: number): void {
		const scopes = this.selectedSetting()?.scopes ?? [];
		if (scopes.length === 0) return;
		const index = Math.max(0, scopes.indexOf(this.scope));
		this.scope = scopes[(index + delta + scopes.length) % scopes.length]!;
		this.afterNavigation();
	}

	private syncSelection(): void {
		this.providerIndex = clampIndex(this.providerIndex, this.providers.length);
		this.settingIndex = clampIndex(this.settingIndex, this.visibleSettings().length);
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
				width: SETTINGS_OVERLAY_WIDTH,
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

function visibleStart(selected: number, total: number, maxRows: number): number {
	if (total <= maxRows) return 0;
	return Math.max(0, Math.min(total - maxRows, selected - Math.floor(maxRows / 2)));
}

function clampIndex(index: number, length: number): number {
	return length <= 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "…");
}

function pad(value: string, width: number): string {
	const fitted = fit(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function rule(width: number): string {
	return "─".repeat(Math.max(0, width));
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

function frame(rows: readonly string[], width: number, theme: Theme): string[] {
	if (width < 2) return rows.map((row) => fit(row, width));
	const inner = width - 2;
	const background = (value: string): string => theme.bg?.("customMessageBg", value) ?? value;
	return [
		background(theme.fg("dim", `┌${"─".repeat(inner)}┐`)),
		...rows.map((row) => background(`${theme.fg("dim", "│")}${pad(row, inner)}${theme.fg("dim", "│")}`)),
		background(theme.fg("dim", `└${"─".repeat(inner)}┘`)),
	];
}
