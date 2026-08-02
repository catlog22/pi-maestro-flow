import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_DISCOVER_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type ConfiguredSettingValue,
	type JsonValue,
	type SettingDefinition,
	type SettingsActivationPlan,
	type SettingsAnnounceEventV1,
	type SettingsChange,
	type SettingsContextV1,
	type SettingsDiscoverEventV1,
	type SettingsProviderV1,
	type SettingsResource,
	type SettingsResourceConflict,
	type SettingsResourceRevision,
	type SettingsSnapshot,
	type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
import {
	getConfigPath,
	mergeConfig,
	mergeConfigDocument,
} from "../config.ts";
import { DEFAULT_CONFIG, type CockpitConfig } from "../types.ts";
import type { SettingsEventBus } from "./registry.ts";

const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as {
	lock(path: string, options: {
		realpath: boolean;
		stale: number;
		update: number;
		retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
	}): Promise<() => Promise<void>>;
};

const PROVIDER_ID = "pi-cockpit";
const PROVIDER_VERSION = "1.0.0";
const CONFIG_RESOURCE_ID = "cockpit.json";

const CONFIG_KEYS = [
	"enabled",
	"staticMode",
	"pinEditorBottom",
	"quietMode",
	"quietSymbols",
	"toolPalette",
	"agentsMode",
	"todoMode",
	"todoExpanded",
	"hideNativeAgents",
	"icons.mode",
	"sidebar.mode",
	"sidebar.width",
	"sidebar.density",
] as const;

type CockpitSettingKey = (typeof CONFIG_KEYS)[number];

export interface CockpitSettingsProvider extends SettingsProviderV1 {
	readonly providerId: typeof PROVIDER_ID;
	readonly instanceId: string;
}

export interface CockpitSettingsProviderOptions {
	getConfigPath?: () => string;
	getRuntimeConfig: () => CockpitConfig;
	applyRuntimeConfig: (config: CockpitConfig, changedKeys: readonly string[], context: SettingsContextV1) => Promise<void> | void;
	getThemeName?: () => string | undefined;
	getThinkingFolded?: () => boolean | undefined;
	openLegacySettings?: () => Promise<void> | void;
	openThemeSettings?: () => Promise<void> | void;
	toggleThinkingFold?: () => Promise<void> | void;
}

interface ConfigDocument {
	path: string;
	content: string;
	raw: unknown;
	config: CockpitConfig;
	revision: SettingsResourceRevision;
	error?: string;
}

interface PreparedCockpitChange {
	token: string;
	transactionId: string;
	path: string;
	temporaryPath: string;
	beforeContent: string;
	config: CockpitConfig;
	changedKeys: readonly string[];
	activation: readonly SettingsActivationPlan[];
	release: () => Promise<void>;
	committedRevision?: SettingsResourceRevision;
}

const CATALOGS = {
	en: {
		"cockpit.provider": "Cockpit",
		"cockpit.provider.description": "Terminal layout, widgets and presentation settings",
		"cockpit.group.general": "General",
		"cockpit.group.layout": "Layout",
		"cockpit.group.panels": "Panels",
		"cockpit.group.sidebar": "Sidebar",
		"cockpit.group.appearance": "Appearance",
		"cockpit.enabled": "Cockpit enabled",
		"cockpit.staticMode": "Static rendering mode",
		"cockpit.pinEditorBottom": "Pin input editor to bottom",
		"cockpit.pinEditorBottom.description": "Experimental: add elastic space above the editor when the conversation is shorter than the terminal",
		"cockpit.quietMode": "Quiet tool rendering",
		"cockpit.quietSymbols": "Quiet symbols",
		"cockpit.toolPalette": "Quiet tool palette",
		"cockpit.agentsMode": "Agent display",
		"cockpit.todoMode": "Todo display",
		"cockpit.todoExpanded": "Todo expanded",
		"cockpit.hideNativeAgents": "Hide native agent widget",
		"cockpit.icons.mode": "Icon mode",
		"cockpit.sidebar.mode": "Sidebar mode",
		"cockpit.sidebar.width": "Sidebar width",
		"cockpit.sidebar.density": "Sidebar density",
		"cockpit.theme": "Theme",
		"cockpit.thinkingFold": "Thinking fold",
		"cockpit.action.legacy": "Open legacy Cockpit settings",
		"cockpit.option.check": "Check marks",
		"cockpit.option.dot": "Dots",
		"cockpit.option.list": "List",
		"cockpit.option.compact": "Compact",
		"cockpit.option.auto": "Automatic",
		"cockpit.option.nerd": "Nerd Font",
		"cockpit.option.ascii": "ASCII",
		"cockpit.option.on": "On",
		"cockpit.option.off": "Off",
		"cockpit.option.comfortable": "Comfortable",
		"cockpit.option.classic": "Classic",
		"cockpit.option.family": "Operation families",
		"cockpit.option.readwrite": "Read / write",
		"cockpit.option.search": "Search focused",
		"cockpit.option.mono": "Monochrome",
		"cockpit.runtime.reloadQuiet": "Turning Quiet off requires /reload to restore native tool renderers",
	},
	"zh-CN": {
		"cockpit.provider": "驾驶舱",
		"cockpit.provider.description": "终端布局、面板与显示设置",
		"cockpit.group.general": "常规",
		"cockpit.group.layout": "布局",
		"cockpit.group.panels": "面板",
		"cockpit.group.sidebar": "侧边栏",
		"cockpit.group.appearance": "外观",
		"cockpit.enabled": "启用 Cockpit",
		"cockpit.staticMode": "静态渲染模式",
		"cockpit.pinEditorBottom": "固定输入框到底部",
		"cockpit.pinEditorBottom.description": "实验功能：当会话内容少于终端高度时，在输入框上方自动填充空间",
		"cockpit.quietMode": "紧凑工具渲染",
		"cockpit.quietSymbols": "紧凑状态符号",
		"cockpit.toolPalette": "紧凑工具配色",
		"cockpit.agentsMode": "Agent 显示",
		"cockpit.todoMode": "Todo 显示",
		"cockpit.todoExpanded": "展开 Todo",
		"cockpit.hideNativeAgents": "隐藏原生 Agent 面板",
		"cockpit.icons.mode": "图标模式",
		"cockpit.sidebar.mode": "侧边栏模式",
		"cockpit.sidebar.width": "侧边栏宽度",
		"cockpit.sidebar.density": "侧边栏密度",
		"cockpit.theme": "主题",
		"cockpit.thinkingFold": "折叠思考过程",
		"cockpit.action.legacy": "打开旧版 Cockpit 设置",
		"cockpit.option.check": "对勾",
		"cockpit.option.dot": "圆点",
		"cockpit.option.list": "列表",
		"cockpit.option.compact": "紧凑",
		"cockpit.option.auto": "自动",
		"cockpit.option.nerd": "Nerd Font",
		"cockpit.option.ascii": "ASCII",
		"cockpit.option.on": "开启",
		"cockpit.option.off": "关闭",
		"cockpit.option.comfortable": "舒适",
		"cockpit.option.classic": "经典",
		"cockpit.option.family": "操作族",
		"cockpit.option.readwrite": "读写区分",
		"cockpit.option.search": "搜索强调",
		"cockpit.option.mono": "单色",
		"cockpit.runtime.reloadQuiet": "关闭紧凑渲染后需执行 /reload 才能恢复原生工具界面",
	},
} as const;

const DEFINITIONS: readonly SettingDefinition[] = [
	booleanDefinition("enabled", "cockpit.group.general", 0, "cockpit.enabled", "live"),
	booleanDefinition("staticMode", "cockpit.group.general", 1, "cockpit.staticMode", "live"),
	booleanDefinition(
		"pinEditorBottom",
		"cockpit.group.layout",
		0,
		"cockpit.pinEditorBottom",
		"live",
		"cockpit.pinEditorBottom.description",
	),
	booleanDefinition("quietMode", "cockpit.group.general", 2, "cockpit.quietMode", "extension-reload"),
	enumDefinition("quietSymbols", "cockpit.group.general", 3, "cockpit.quietSymbols", ["check", "dot"], "live"),
	enumDefinition("toolPalette", "cockpit.group.general", 4, "cockpit.toolPalette", ["classic", "family", "readwrite", "search", "mono"], "live"),
	enumDefinition("agentsMode", "cockpit.group.panels", 0, "cockpit.agentsMode", ["list", "compact"], "live"),
	enumDefinition("todoMode", "cockpit.group.panels", 1, "cockpit.todoMode", ["list", "compact"], "live"),
	booleanDefinition("todoExpanded", "cockpit.group.panels", 2, "cockpit.todoExpanded", "live"),
	booleanDefinition("hideNativeAgents", "cockpit.group.panels", 3, "cockpit.hideNativeAgents", "live"),
	enumDefinition("sidebar.mode", "cockpit.group.sidebar", 0, "cockpit.sidebar.mode", ["auto", "on", "off"], "live"),
	{
		key: "sidebar.width",
		group: "cockpit.group.sidebar",
		order: 1,
		labelKey: "cockpit.sidebar.width",
		defaultValue: DEFAULT_CONFIG.sidebar.width,
		scopes: ["global"],
		merge: "override",
		activation: "live",
		sensitivity: "public",
		reversibility: "full",
		editor: { kind: "integer", min: 32, max: 56, step: 1 },
	},
	enumDefinition("sidebar.density", "cockpit.group.sidebar", 2, "cockpit.sidebar.density", ["comfortable", "compact"], "live"),
	enumDefinition("icons.mode", "cockpit.group.appearance", 0, "cockpit.icons.mode", ["auto", "nerd", "ascii"], "live"),
	actionDefinition("theme", "cockpit.group.appearance", 1, "cockpit.theme", "cockpit.theme"),
	actionDefinition("thinkingFold", "cockpit.group.appearance", 2, "cockpit.thinkingFold", "cockpit.thinkingFold"),
	actionDefinition("legacy", "cockpit.group.appearance", 3, "cockpit.action.legacy", "cockpit.legacy"),
];

export function createCockpitSettingsProvider(options: CockpitSettingsProviderOptions): CockpitSettingsProvider {
	const instanceId = randomUUID();
	const configPath = options.getConfigPath ?? getConfigPath;
	const prepared = new Map<string, PreparedCockpitChange>();

	return {
		providerId: PROVIDER_ID,
		instanceId,
		describe: () => ({
			id: PROVIDER_ID,
			version: PROVIDER_VERSION,
			instanceId,
			labelKey: "cockpit.provider",
			descriptionKey: "cockpit.provider.description",
			order: 10,
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			settings: DEFINITIONS,
			catalogs: CATALOGS,
		}),
		read: () => {
			const path = configPath();
			ensureConfigDocument(path);
			return snapshot(readDocument(path), instanceId, options);
		},
		validate: (request) => validateRequest(configPath(), request.changes, request.expectedRevisions),
		prepare: async (request) => {
			const path = configPath();
			ensureConfigDocument(path);
			const release = await properLockfile.lock(path, {
				realpath: false,
				stale: 10_000,
				update: 2_000,
				retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
			});
			try {
				const current = readDocument(path);
				const validation = validateRequest(path, request.changes, request.expectedRevisions, current);
				if (!validation.valid) {
					await release();
					return { prepared: false, validation, conflicts: validation.conflicts };
				}
				const nextConfig = applyConfigChanges(current.config, request.changes);
				const document = mergeConfigDocument(current.raw, nextConfig);
				const content = `${JSON.stringify(document, null, 2)}\n`;
				const token = randomUUID();
				const temporaryPath = `${path}.${process.pid}.${token}.tmp`;
				writeSyncedFile(temporaryPath, content);
				const changedKeys = request.changes.map((change) => change.key);
				const activation = activationFor(request.changes, current.config, nextConfig);
				prepared.set(token, {
					token,
					transactionId: request.transactionId,
					path,
					temporaryPath,
					beforeContent: current.content,
					config: nextConfig,
					changedKeys,
					activation,
					release,
				});
				return {
					prepared: true,
					prepareToken: token,
					validation,
					activation,
				};
			} catch (error) {
				await release().catch(() => undefined);
				throw error;
			}
		},
		commit: async (request) => {
			const state = requirePrepared(prepared, request.prepareToken, request.transactionId);
			let published = false;
			try {
				renameSync(state.temporaryPath, state.path);
				published = true;
				const document = readDocument(state.path);
				state.committedRevision = document.revision;
				return {
					snapshot: snapshot(document, instanceId, options),
					revisions: [document.revision],
					changedKeys: state.changedKeys,
					activation: state.activation,
				};
			} catch (error) {
				// Rename already happened: restore the previous bytes while still holding the lock
				// so a post-publish read/release failure cannot leave a half-applied config.
				if (published) {
					try {
						atomicWrite(state.path, state.beforeContent);
					} catch (restoreError) {
						throw new AggregateError(
							[error, restoreError],
							"Cockpit config was published but its restore failed",
						);
					}
				}
				throw error;
			} finally {
				// Lock release failure must not turn an already-published commit into a reported failure.
				await state.release().catch(() => undefined);
			}
		},
		abort: async (request) => {
			const state = prepared.get(request.prepareToken);
			if (!state) return;
			try { if (existsSync(state.temporaryPath)) rmSync(state.temporaryPath); } finally {
				prepared.delete(request.prepareToken);
				await state.release().catch(() => undefined);
			}
		},
		rollback: async (request) => {
			const state = prepared.get(request.prepareToken);
			if (!state || state.transactionId !== request.transactionId) return { rolledBack: false };
			const release = await properLockfile.lock(state.path, {
				realpath: false,
				stale: 10_000,
				update: 2_000,
				retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
			});
			try {
				const current = readDocument(state.path);
				if (state.committedRevision && current.revision.etag !== state.committedRevision.etag) {
					return { rolledBack: false, conflicts: [conflict(current.revision, state.committedRevision.etag)] };
				}
				atomicWrite(state.path, state.beforeContent);
				const restored = readDocument(state.path);
				prepared.delete(request.prepareToken);
				return { rolledBack: true, snapshot: snapshot(restored, instanceId, options) };
			} finally {
				await release();
			}
		},
		applyRuntime: async (request) => {
			const state = [...prepared.values()].find((entry) => entry.transactionId === request.transactionId);
			const config = state?.config ?? readDocument(configPath()).config;
			const changedKeys = request.changes.map((change) => change.key);
			await options.applyRuntimeConfig(config, changedKeys, request.context);
			if (state) prepared.delete(state.token);
			const deferred = (state?.activation ?? activationFor(request.changes, options.getRuntimeConfig(), config))
				.filter((entry) => entry.boundary !== "live");
			return {
				appliedKeys: changedKeys.filter((key) => !deferred.some((entry) => entry.keys.includes(key))),
				deferred,
				failed: [],
			};
		},
		invokeAction: async (request) => {
			if (request.actionId === "cockpit.legacy" && options.openLegacySettings) await options.openLegacySettings();
			else if (request.actionId === "cockpit.theme" && options.openThemeSettings) await options.openThemeSettings();
			else if (request.actionId === "cockpit.thinkingFold" && options.toggleThinkingFold) await options.toggleThinkingFold();
			else return { handled: false };
			return { handled: true, refresh: true };
		},
	};
}

export function registerCockpitSettingsProvider(
	events: SettingsEventBus,
	provider: CockpitSettingsProvider,
): () => void {
	const announce = (requestId?: string): void => {
		const payload: SettingsAnnounceEventV1 = {
			version: SETTINGS_PROTOCOL_VERSION,
			requestId,
			providerId: provider.providerId,
			instanceId: provider.instanceId,
			provider,
		};
		events.emit(SETTINGS_ANNOUNCE_EVENT, payload);
	};
	const result = events.on(SETTINGS_DISCOVER_EVENT, (payload) => {
		if (isDiscover(payload)) announce(payload.requestId);
	});
	announce();
	return () => { if (typeof result === "function") result(); };
}

function snapshot(document: ConfigDocument, instanceId: string, options: CockpitSettingsProviderOptions): SettingsSnapshot {
	const resource = document.revision.resource;
	const configured: ConfiguredSettingValue[] = CONFIG_KEYS.map((key) => ({
		key,
		scope: "global" as const,
		state: document.error ? "invalid" as const : "set" as const,
		...(!document.error ? { value: getConfigValue(document.config, key) } : {}),
		resource,
		...(document.error ? { messageKey: document.error } : {}),
	}));
	configured.push(
		{ key: "theme", scope: "global", state: "absent" },
		{ key: "thinkingFold", scope: "global", state: "absent" },
		{ key: "legacy", scope: "global", state: "absent" },
	);
	return {
		providerId: PROVIDER_ID,
		providerInstanceId: instanceId,
		configured: { values: configured, resources: [document.revision] },
		effective: {
			values: [
				...CONFIG_KEYS.map((key) => ({ key, value: getConfigValue(document.config, key), source: "configured" as const, scope: "global" as const, resource })),
				{ key: "theme", value: options.getThemeName?.() ?? "Pi settings", source: "runtime" as const },
				{ key: "thinkingFold", value: options.getThinkingFolded?.() ?? false, source: "runtime" as const },
				{ key: "legacy", value: "open", source: "runtime" as const },
			],
		},
	};
}

function validateRequest(
	path: string,
	changes: readonly SettingsChange[],
	expectedRevisions: readonly SettingsResourceRevision[] | undefined,
	current = readDocument(path),
) {
	const issues: SettingsValidationIssue[] = [];
	const expected = expectedRevisions?.find((revision) => revision.resource.id === CONFIG_RESOURCE_ID);
	const conflicts = expected && expected.etag !== current.revision.etag
		? [conflict(current.revision, expected.etag)]
		: [];
	for (const change of changes) {
		if (change.scope !== "global") issues.push(issue(change, "cockpit.settings.globalOnly"));
		if (!isConfigKey(change.key)) issues.push(issue(change, "cockpit.settings.unknownKey"));
		else if (change.operation === "set" && !validValue(change.key, change.value)) {
			issues.push(issue(change, "cockpit.settings.invalidValue"));
		}
	}
	return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
}

function readDocument(path: string): ConfigDocument {
	if (!existsSync(path)) {
		return {
			path,
			content: "",
			raw: {},
			config: structuredClone(DEFAULT_CONFIG),
			revision: revision(path, ""),
		};
	}
	const content = readFileSync(path, "utf8");
	try {
		const raw = JSON.parse(content) as unknown;
		return { path, content, raw, config: mergeConfig(DEFAULT_CONFIG, raw), revision: revision(path, content) };
	} catch (error) {
		return {
			path,
			content,
			raw: {},
			config: structuredClone(DEFAULT_CONFIG),
			revision: revision(path, content),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function revision(path: string, content: string): SettingsResourceRevision {
	return {
		resource: { providerId: PROVIDER_ID, scope: "global", id: CONFIG_RESOURCE_ID },
		etag: createHash("sha256").update(content || "<missing>").digest("hex"),
		size: Buffer.byteLength(content),
	};
}

function conflict(actual: SettingsResourceRevision, expectedEtag: string): SettingsResourceConflict {
	return {
		resource: actual.resource,
		expectedEtag,
		actualEtag: actual.etag,
		messageKey: "settings.conflict",
	};
}

function applyConfigChanges(config: CockpitConfig, changes: readonly SettingsChange[]): CockpitConfig {
	let next = structuredClone(config);
	for (const change of changes) {
		if (!isConfigKey(change.key)) continue;
		const value = change.operation === "unset" ? getConfigValue(DEFAULT_CONFIG, change.key) : change.value;
		next = setConfigValue(next, change.key, value);
	}
	return next;
}

function getConfigValue(config: CockpitConfig, key: CockpitSettingKey): JsonValue {
	if (key === "icons.mode") return config.icons.mode;
	if (key === "sidebar.mode") return config.sidebar.mode;
	if (key === "sidebar.width") return config.sidebar.width;
	if (key === "sidebar.density") return config.sidebar.density;
	return config[key];
}

function setConfigValue(config: CockpitConfig, key: CockpitSettingKey, value: JsonValue): CockpitConfig {
	if (key === "icons.mode") return { ...config, icons: { mode: value as CockpitConfig["icons"]["mode"] } };
	if (key === "sidebar.mode") return { ...config, sidebar: { ...config.sidebar, mode: value as CockpitConfig["sidebar"]["mode"] } };
	if (key === "sidebar.width") return { ...config, sidebar: { ...config.sidebar, width: value as number } };
	if (key === "sidebar.density") return { ...config, sidebar: { ...config.sidebar, density: value as CockpitConfig["sidebar"]["density"] } };
	return { ...config, [key]: value } as CockpitConfig;
}

function validValue(key: CockpitSettingKey, value: JsonValue): boolean {
	if (["enabled", "staticMode", "pinEditorBottom", "quietMode", "todoExpanded", "hideNativeAgents"].includes(key)) return typeof value === "boolean";
	if (key === "sidebar.width") return typeof value === "number" && Number.isSafeInteger(value) && value >= 32 && value <= 56;
	if (key === "quietSymbols") return value === "check" || value === "dot";
	if (key === "toolPalette") return value === "classic" || value === "family" || value === "readwrite" || value === "search" || value === "mono";
	if (key === "agentsMode" || key === "todoMode") return value === "list" || value === "compact";
	if (key === "icons.mode") return value === "auto" || value === "nerd" || value === "ascii";
	if (key === "sidebar.mode") return value === "auto" || value === "on" || value === "off";
	return value === "comfortable" || value === "compact";
}

function activationFor(
	changes: readonly SettingsChange[],
	before: CockpitConfig,
	after: CockpitConfig,
): SettingsActivationPlan[] {
	const live: string[] = [];
	const reload: string[] = [];
	for (const change of changes) {
		if (change.key === "quietMode" && before.quietMode && !after.quietMode) reload.push(change.key);
		else live.push(change.key);
	}
	return [
		...(live.length > 0 ? [{ boundary: "live" as const, keys: live }] : []),
		...(reload.length > 0 ? [{ boundary: "extension-reload" as const, keys: reload, messageKey: "cockpit.runtime.reloadQuiet" }] : []),
	];
}

function isConfigKey(key: string): key is CockpitSettingKey {
	return (CONFIG_KEYS as readonly string[]).includes(key);
}

function issue(change: SettingsChange, messageKey: string): SettingsValidationIssue {
	return { severity: "error", messageKey, key: change.key, scope: change.scope };
}

function booleanDefinition(
	key: CockpitSettingKey,
	group: string,
	order: number,
	labelKey: string,
	activation: SettingDefinition["activation"],
	descriptionKey?: string,
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		...(descriptionKey ? { descriptionKey } : {}),
		defaultValue: getConfigValue(DEFAULT_CONFIG, key),
		scopes: ["global"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: activation === "extension-reload" ? "reload-required" : "full",
		editor: { kind: "boolean" },
	};
}

function enumDefinition(
	key: CockpitSettingKey,
	group: string,
	order: number,
	labelKey: string,
	values: readonly string[],
	activation: SettingDefinition["activation"],
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		defaultValue: getConfigValue(DEFAULT_CONFIG, key),
		scopes: ["global"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "full",
		editor: {
			kind: "enum",
			options: values.map((value) => ({ value, labelKey: `cockpit.option.${value}` })),
		},
	};
}

function actionDefinition(key: string, group: string, order: number, labelKey: string, actionId: string): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		scopes: ["global"],
		merge: "provider-defined",
		activation: "live",
		sensitivity: "private",
		reversibility: "full",
		editor: { kind: "action", actionId },
	};
}

function requirePrepared(
	prepared: Map<string, PreparedCockpitChange>,
	token: string,
	transactionId: string,
): PreparedCockpitChange {
	const state = prepared.get(token);
	if (!state || state.transactionId !== transactionId) throw new Error("prepared Cockpit settings transaction is unavailable");
	return state;
}

function ensureConfigDocument(path: string): void {
	if (existsSync(path)) return;
	atomicWrite(path, `${JSON.stringify(mergeConfigDocument({}, DEFAULT_CONFIG), null, 2)}\n`);
}

function atomicWrite(path: string, content: string): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeSyncedFile(temporaryPath, content);
		renameSync(temporaryPath, path);
	} catch (error) {
		try { if (existsSync(temporaryPath)) rmSync(temporaryPath); } catch { /* best effort */ }
		throw error;
	}
}

function writeSyncedFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeFileSync(descriptor, content, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
	return Boolean(payload && typeof payload === "object"
		&& (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
		&& typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
