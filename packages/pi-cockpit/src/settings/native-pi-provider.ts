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
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
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
	type SettingsResourceConflict,
	type SettingsResourceRevision,
	type SettingsScope,
	type SettingsSnapshot,
	type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
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

/**
 * pi-native settings provider. Reads/writes pi's own `settings.json` files
 * (global `<agentDir>/settings.json`, project `<cwd>/.pi/settings.json`) so the
 * native configuration surface (model, theme, thinking, images, transport, …)
 * is editable from the unified maestro-settings shell instead of falling back to
 * the original `/settings` panel. Writes preserve unknown keys, use the same
 * lockfile pi's settings-manager uses, and take effect after /reload (pi reads
 * settings.json at startup and on reload).
 */

const PROVIDER_ID = "pi-native";
const PROVIDER_VERSION = "1.0.0";
const GLOBAL_RESOURCE_ID = "settings.json";

type NativeSettingKey = (typeof CONFIG_KEYS)[number];

const CONFIG_KEYS = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"hideThinkingBlock",
	"showCacheMissNotices",
	"theme",
	"quietStartup",
	"defaultProjectTrust",
	"collapseChangelog",
	"doubleEscapeAction",
	"treeFilterMode",
	"editorPaddingX",
	"outputPad",
	"autocompleteMaxVisible",
	"showHardwareCursor",
	"terminal.showImages",
	"terminal.imageWidthCells",
	"terminal.clearOnShrink",
	"images.autoResize",
	"images.blockImages",
	"steeringMode",
	"followUpMode",
	"transport",
	"httpIdleTimeoutMs",
	"websocketConnectTimeoutMs",
	"httpProxy",
	"warnings.anthropicExtraUsage",
	"compaction.enabled",
	"compaction.reserveTokens",
	"compaction.keepRecentTokens",
	"retry.enabled",
	"retry.maxRetries",
	"retry.baseDelayMs",
] as const;

/** Only the global settings file may carry these (pi enforces it). */
const GLOBAL_ONLY_KEYS: ReadonlySet<string> = new Set(["defaultProjectTrust", "httpProxy"]);

const DEFAULTS: Readonly<Record<NativeSettingKey, JsonValue>> = {
	defaultProvider: "",
	defaultModel: "",
	defaultThinkingLevel: "medium",
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	theme: "",
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	showHardwareCursor: false,
	"terminal.showImages": true,
	"terminal.imageWidthCells": 60,
	"terminal.clearOnShrink": false,
	"images.autoResize": true,
	"images.blockImages": false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "auto",
	httpIdleTimeoutMs: 300000,
	websocketConnectTimeoutMs: 15000,
	httpProxy: "",
	"warnings.anthropicExtraUsage": true,
	"compaction.enabled": true,
	"compaction.reserveTokens": 16384,
	"compaction.keepRecentTokens": 20000,
	"retry.enabled": true,
	"retry.maxRetries": 3,
	"retry.baseDelayMs": 2000,
};

const CATALOGS = {
	en: {
		"native.provider": "Pi native",
		"native.provider.description": "Pi's own settings (settings.json): model, theme, thinking, terminal, network",
		"native.group.model": "Model & Thinking",
		"native.group.ui": "UI & Display",
		"native.group.terminal": "Terminal & Images",
		"native.group.delivery": "Message Delivery",
		"native.group.network": "Network",
		"native.group.warnings": "Warnings",
		"native.group.compaction": "Compaction",
		"native.group.retry": "Retry",
		"native.group.manage": "Manage",
		"native.defaultProvider": "Default provider",
		"native.defaultProvider.description": "Default model provider (e.g. openai, anthropic, opencode). Applies to new sessions.",
		"native.defaultModel": "Default model",
		"native.defaultModel.description": "Default model ID used when none is picked for the session.",
		"native.defaultThinkingLevel": "Default thinking level",
		"native.defaultThinkingLevel.description": "Reasoning effort used for new sessions.",
		"native.hideThinkingBlock": "Hide thinking blocks",
		"native.hideThinkingBlock.description": "Hide thinking blocks in output.",
		"native.showCacheMissNotices": "Show cache-miss notices",
		"native.theme": "Theme",
		"native.theme.description": "Theme name (e.g. dark, light, or a custom theme). Applies on reload.",
		"native.quietStartup": "Quiet startup",
		"native.quietStartup.description": "Hide the startup header.",
		"native.defaultProjectTrust": "Default project trust",
		"native.defaultProjectTrust.description": "Fallback trust behavior for new projects (global only).",
		"native.collapseChangelog": "Collapse changelog",
		"native.doubleEscapeAction": "Double-Escape action",
		"native.doubleEscapeAction.description": "What a double Escape on an empty draft does.",
		"native.treeFilterMode": "Tree filter mode",
		"native.treeFilterMode.description": "Default filter shown by /tree.",
		"native.editorPaddingX": "Editor padding",
		"native.editorPaddingX.description": "Horizontal padding of the input editor (0-3).",
		"native.outputPad": "Output padding",
		"native.outputPad.description": "Horizontal padding of messages (0 or 1).",
		"native.autocompleteMaxVisible": "Autocomplete max visible",
		"native.autocompleteMaxVisible.description": "Max visible items in the autocomplete dropdown (3-20).",
		"native.showHardwareCursor": "Show hardware cursor",
		"native.terminal.showImages": "Show images in terminal",
		"native.terminal.imageWidthCells": "Inline image width",
		"native.terminal.imageWidthCells.description": "Preferred inline image width in terminal cells.",
		"native.terminal.clearOnShrink": "Clear on shrink",
		"native.terminal.clearOnShrink.description": "Clear empty rows when content shrinks (can cause flicker).",
		"native.images.autoResize": "Auto-resize images",
		"native.images.blockImages": "Block images",
		"native.images.blockImages.description": "Block all images from being sent to the LLM.",
		"native.steeringMode": "Steering mode",
		"native.followUpMode": "Follow-up mode",
		"native.transport": "Transport",
		"native.httpIdleTimeoutMs": "HTTP idle timeout (ms)",
		"native.websocketConnectTimeoutMs": "WebSocket connect timeout (ms)",
		"native.httpProxy": "HTTP proxy",
		"native.httpProxy.description": "Proxy URL applied as HTTP_PROXY/HTTPS_PROXY (global only).",
		"native.warnings.anthropicExtraUsage": "Anthropic extra-usage warning",
		"native.compaction.enabled": "Auto-compaction",
		"native.compaction.reserveTokens": "Compaction reserve tokens",
		"native.compaction.keepRecentTokens": "Compaction keep-recent tokens",
		"native.retry.enabled": "Agent retry",
		"native.retry.maxRetries": "Retry max attempts",
		"native.retry.baseDelayMs": "Retry base delay (ms)",
		"native.keybindings": "Keybindings",
		"native.keybindings.description": "Edit keybindings.json directly, then /reload.",
		"native.action.keybindings": "Open keybindings.json",
		"native.runtime.reload": "Pi reads settings.json on /reload — run /reload (or start a new session) for changes to take effect",
		"native.settings.globalOnly": "This setting is global-only (pi enforces it)",
		"native.settings.unknownKey": "Unknown Pi setting",
		"native.settings.invalidValue": "Invalid value for this Pi setting",
	},
	"zh-CN": {
		"native.provider": "Pi 原生",
		"native.provider.description": "Pi 自身设置（settings.json）：模型、主题、思考、终端、网络",
		"native.group.model": "模型与思考",
		"native.group.ui": "界面与显示",
		"native.group.terminal": "终端与图像",
		"native.group.delivery": "消息投递",
		"native.group.network": "网络",
		"native.group.warnings": "警告",
		"native.group.compaction": "压缩",
		"native.group.retry": "重试",
		"native.group.manage": "管理",
		"native.defaultProvider": "默认 Provider",
		"native.defaultProvider.description": "默认模型供应商（如 openai、anthropic、opencode）。对新会话生效。",
		"native.defaultModel": "默认模型",
		"native.defaultModel.description": "未选择模型时使用的默认模型 ID。",
		"native.defaultThinkingLevel": "默认思考级别",
		"native.defaultThinkingLevel.description": "新会话使用的推理强度。",
		"native.hideThinkingBlock": "隐藏思考块",
		"native.hideThinkingBlock.description": "在输出中隐藏思考块。",
		"native.showCacheMissNotices": "显示缓存未命中提示",
		"native.theme": "主题",
		"native.theme.description": "主题名称（如 dark、light 或自定义主题）。重载后生效。",
		"native.quietStartup": "安静启动",
		"native.quietStartup.description": "隐藏启动头部信息。",
		"native.defaultProjectTrust": "默认项目信任",
		"native.defaultProjectTrust.description": "新项目的默认信任行为（仅全局）。",
		"native.collapseChangelog": "折叠更新日志",
		"native.doubleEscapeAction": "双击 Esc 动作",
		"native.doubleEscapeAction.description": "空输入框双击 Esc 触发的动作。",
		"native.treeFilterMode": "Tree 过滤模式",
		"native.treeFilterMode.description": "/tree 默认显示的过滤器。",
		"native.editorPaddingX": "输入框内边距",
		"native.editorPaddingX.description": "输入编辑器的水平内边距（0-3）。",
		"native.outputPad": "输出内边距",
		"native.outputPad.description": "消息的水平内边距（0 或 1）。",
		"native.autocompleteMaxVisible": "自动补全最大可见项",
		"native.autocompleteMaxVisible.description": "自动补全下拉的最大可见项数（3-20）。",
		"native.showHardwareCursor": "显示硬件光标",
		"native.terminal.showImages": "终端显示图片",
		"native.terminal.imageWidthCells": "行内图片宽度",
		"native.terminal.imageWidthCells.description": "终端中行内图片的推荐宽度（单元格数）。",
		"native.terminal.clearOnShrink": "收缩时清屏",
		"native.terminal.clearOnShrink.description": "内容收缩时清除空行（可能引起闪烁）。",
		"native.images.autoResize": "自动缩放图片",
		"native.images.blockImages": "阻止图片",
		"native.images.blockImages.description": "阻止所有图片发送给 LLM。",
		"native.steeringMode": "引导消息模式",
		"native.followUpMode": "追问模式",
		"native.transport": "传输方式",
		"native.httpIdleTimeoutMs": "HTTP 空闲超时（毫秒）",
		"native.websocketConnectTimeoutMs": "WebSocket 连接超时（毫秒）",
		"native.httpProxy": "HTTP 代理",
		"native.httpProxy.description": "作为 HTTP_PROXY/HTTPS_PROXY 使用的代理 URL（仅全局）。",
		"native.warnings.anthropicExtraUsage": "Anthropic 额外用量警告",
		"native.compaction.enabled": "自动压缩",
		"native.compaction.reserveTokens": "压缩预留 token",
		"native.compaction.keepRecentTokens": "压缩保留最近 token",
		"native.retry.enabled": "Agent 重试",
		"native.retry.maxRetries": "重试最大次数",
		"native.retry.baseDelayMs": "重试基础延迟（毫秒）",
		"native.keybindings": "快捷键",
		"native.keybindings.description": "直接编辑 keybindings.json 后执行 /reload。",
		"native.action.keybindings": "打开 keybindings.json",
		"native.runtime.reload": "Pi 在 /reload 时读取 settings.json —— 请执行 /reload（或开新会话）使改动生效",
		"native.settings.globalOnly": "该设置仅支持全局作用域（pi 强制）",
		"native.settings.unknownKey": "未知的 Pi 设置",
		"native.settings.invalidValue": "该 Pi 设置的取值无效",
	},
} as const;

const DEFINITIONS: readonly SettingDefinition[] = [
	textDefinition("defaultProvider", "native.group.model", 0, "native.defaultProvider", "next-session", "native.defaultProvider.description"),
	modelDefinition("defaultModel", "native.group.model", 1, "native.defaultModel", "next-session", "native.defaultModel.description"),
	enumDefinition("defaultThinkingLevel", "native.group.model", 2, "native.defaultThinkingLevel", ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "next-session", "native.defaultThinkingLevel.description"),
	booleanDefinition("hideThinkingBlock", "native.group.model", 3, "native.hideThinkingBlock", "extension-reload", "native.hideThinkingBlock.description"),
	booleanDefinition("showCacheMissNotices", "native.group.model", 4, "native.showCacheMissNotices", "extension-reload"),
	textDefinition("theme", "native.group.ui", 0, "native.theme", "extension-reload", "native.theme.description"),
	booleanDefinition("quietStartup", "native.group.ui", 1, "native.quietStartup", "extension-reload", "native.quietStartup.description"),
	enumDefinition("defaultProjectTrust", "native.group.ui", 2, "native.defaultProjectTrust", ["ask", "always", "never"], "extension-reload", "native.defaultProjectTrust.description", true),
	booleanDefinition("collapseChangelog", "native.group.ui", 3, "native.collapseChangelog", "extension-reload"),
	enumDefinition("doubleEscapeAction", "native.group.ui", 4, "native.doubleEscapeAction", ["tree", "fork", "none"], "extension-reload", "native.doubleEscapeAction.description"),
	enumDefinition("treeFilterMode", "native.group.ui", 5, "native.treeFilterMode", ["default", "no-tools", "user-only", "labeled-only", "all"], "extension-reload", "native.treeFilterMode.description"),
	intDefinition("editorPaddingX", "native.group.ui", 6, "native.editorPaddingX", 0, 3, "extension-reload", "native.editorPaddingX.description"),
	intDefinition("outputPad", "native.group.ui", 7, "native.outputPad", 0, 1, "extension-reload", "native.outputPad.description"),
	intDefinition("autocompleteMaxVisible", "native.group.ui", 8, "native.autocompleteMaxVisible", 3, 20, "extension-reload", "native.autocompleteMaxVisible.description"),
	booleanDefinition("showHardwareCursor", "native.group.ui", 9, "native.showHardwareCursor", "extension-reload"),
	booleanDefinition("terminal.showImages", "native.group.terminal", 0, "native.terminal.showImages", "extension-reload"),
	intDefinition("terminal.imageWidthCells", "native.group.terminal", 1, "native.terminal.imageWidthCells", 1, 240, "extension-reload", "native.terminal.imageWidthCells.description"),
	booleanDefinition("terminal.clearOnShrink", "native.group.terminal", 2, "native.terminal.clearOnShrink", "extension-reload", "native.terminal.clearOnShrink.description"),
	booleanDefinition("images.autoResize", "native.group.terminal", 3, "native.images.autoResize", "extension-reload"),
	booleanDefinition("images.blockImages", "native.group.terminal", 4, "native.images.blockImages", "extension-reload", "native.images.blockImages.description"),
	enumDefinition("steeringMode", "native.group.delivery", 0, "native.steeringMode", ["all", "one-at-a-time"], "extension-reload"),
	enumDefinition("followUpMode", "native.group.delivery", 1, "native.followUpMode", ["all", "one-at-a-time"], "extension-reload"),
	enumDefinition("transport", "native.group.delivery", 2, "native.transport", ["sse", "websocket", "websocket-cached", "auto"], "extension-reload"),
	intDefinition("httpIdleTimeoutMs", "native.group.delivery", 3, "native.httpIdleTimeoutMs", 0, 3600000, "extension-reload"),
	intDefinition("websocketConnectTimeoutMs", "native.group.delivery", 4, "native.websocketConnectTimeoutMs", 0, 600000, "extension-reload"),
	textDefinition("httpProxy", "native.group.network", 0, "native.httpProxy", "extension-reload", "native.httpProxy.description", true),
	booleanDefinition("warnings.anthropicExtraUsage", "native.group.warnings", 0, "native.warnings.anthropicExtraUsage", "extension-reload"),
	booleanDefinition("compaction.enabled", "native.group.compaction", 0, "native.compaction.enabled", "extension-reload"),
	intDefinition("compaction.reserveTokens", "native.group.compaction", 1, "native.compaction.reserveTokens", 0, 10000000, "extension-reload"),
	intDefinition("compaction.keepRecentTokens", "native.group.compaction", 2, "native.compaction.keepRecentTokens", 0, 10000000, "extension-reload"),
	booleanDefinition("retry.enabled", "native.group.retry", 0, "native.retry.enabled", "extension-reload"),
	intDefinition("retry.maxRetries", "native.group.retry", 1, "native.retry.maxRetries", 0, 100, "extension-reload"),
	intDefinition("retry.baseDelayMs", "native.group.retry", 2, "native.retry.baseDelayMs", 0, 600000, "extension-reload"),
	actionDefinition("keybindings", "native.group.manage", 0, "native.keybindings", "native.keybindings", "native.action.keybindings", "native.keybindings.description"),
];

export interface NativePiSettingsProvider extends SettingsProviderV1 {
	readonly providerId: typeof PROVIDER_ID;
	readonly instanceId: string;
}

export interface NativePiSettingsProviderOptions {
	getGlobalPath?: () => string;
	getProjectPath?: (cwd: string) => string;
	onError?(error: unknown): void;
}

interface NativeDocument {
	scope: SettingsScope;
	path: string;
	content: string;
	raw: Record<string, unknown>;
	revision: SettingsResourceRevision;
	error?: string;
}

type NativeDocs = { global: NativeDocument; project: NativeDocument };

interface PreparedNativeChange {
	token: string;
	transactionId: string;
	scope: SettingsScope;
	path: string;
	temporaryPath: string;
	beforeContent: string;
	raw: Record<string, unknown>;
	changedKeys: readonly string[];
	release: () => Promise<void>;
	committedRevision?: SettingsResourceRevision;
}

export function createNativePiSettingsProvider(options: NativePiSettingsProviderOptions = {}): NativePiSettingsProvider {
	const instanceId = randomUUID();
	const getGlobalPath = options.getGlobalPath ?? (() => join(getAgentDir(), "settings.json"));
	const getProjectPath = options.getProjectPath ?? ((cwd: string) => join(cwd, CONFIG_DIR_NAME, "settings.json"));
	const prepared = new Map<string, PreparedNativeChange>();

	const readDocument = (scope: SettingsScope, path: string): NativeDocument => {
		if (!existsSync(path)) {
			return {
				scope,
				path,
				content: "",
				raw: {},
				revision: revision(scope, path, ""),
			};
		}
		const content = readFileSync(path, "utf8");
		try {
			const parsed = JSON.parse(content) as unknown;
			const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: {};
			return { scope, path, content, raw, revision: revision(scope, path, content) };
		} catch (error) {
			return {
				scope,
				path,
				content,
				raw: {},
				revision: revision(scope, path, content),
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	const load = (context: SettingsContextV1): NativeDocs => {
		const global = readDocument("global", getGlobalPath());
		const project = readDocument("project", getProjectPath(context.cwd));
		return { global, project };
	};

	return {
		providerId: PROVIDER_ID,
		instanceId,
		describe: () => ({
			id: PROVIDER_ID,
			version: PROVIDER_VERSION,
			instanceId,
			labelKey: "native.provider",
			descriptionKey: "native.provider.description",
			order: 5,
			capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
			settings: DEFINITIONS,
			catalogs: CATALOGS,
		}),
		read: (request) => snapshot(load(request.context), instanceId),
		validate: (request) => {
			const docs = load(request.context);
			return validateRequest(docs, request.changes, request.expectedRevisions);
		},
		prepare: async (request) => {
			const docs = load(request.context);
			const validation = validateRequest(docs, request.changes, request.expectedRevisions);
			if (!validation.valid) return { prepared: false, validation, conflicts: validation.conflicts };
			const grouped = new Map<SettingsScope, SettingsChange[]>();
			for (const change of request.changes) {
				const list = grouped.get(change.scope) ?? [];
				list.push(change);
				grouped.set(change.scope, list);
			}
			// Prepare per-scope; a single prepareToken covers all files.
			const states: PreparedNativeChange[] = [];
			try {
				for (const [scope, changes] of grouped) {
					const doc = docs[scope as "global" | "project"];
					if (!doc) continue;
					const release = await properLockfile.lock(doc.path, {
						realpath: false,
						stale: 10_000,
						update: 2_000,
						retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
					});
					const nextRaw = applyChanges(doc.raw, changes);
					const content = `${JSON.stringify(nextRaw, null, 2)}\n`;
					const token = randomUUID();
					const temporaryPath = `${doc.path}.${process.pid}.${token}.tmp`;
					writeSyncedFile(temporaryPath, content);
					states.push({
						token,
						transactionId: request.transactionId,
						scope,
						path: doc.path,
						temporaryPath,
						beforeContent: doc.content,
						raw: nextRaw,
						changedKeys: changes.map((change) => change.key),
						release,
					});
				}
				prepared.set(states[0]?.token ?? "", states[0]);
				for (const state of states) prepared.set(state.token, state);
				const activation = [...grouped.keys()].length > 0
					? [{ boundary: "extension-reload" as const, keys: [...grouped.values()].flat().map((change) => change.key), messageKey: "native.runtime.reload" }]
					: [];
				return { prepared: true, prepareToken: states[0]?.token ?? "", validation, activation };
			} catch (error) {
				await Promise.all(states.map((state) => state.release().catch(() => undefined)));
				throw error;
			}
		},
		commit: async (request) => {
			const state = prepared.get(request.prepareToken);
			if (!state || state.transactionId !== request.transactionId) throw new Error("prepared Pi settings transaction is unavailable");
			let published = false;
			try {
				renameSync(state.temporaryPath, state.path);
				published = true;
				const doc = readDocument(state.scope as "global" | "project", state.path);
				state.committedRevision = doc.revision;
				return {
					snapshot: snapshot(load(request.context), instanceId),
					revisions: [doc.revision],
					changedKeys: state.changedKeys,
					activation: [{ boundary: "extension-reload" as const, keys: state.changedKeys, messageKey: "native.runtime.reload" }],
				};
			} catch (error) {
				if (published) {
					try { atomicWrite(state.path, state.beforeContent); }
					catch (restoreError) {
						throw new AggregateError([error, restoreError], "Pi settings were published but their restore failed");
					}
				}
				throw error;
			} finally {
				await state.release().catch(() => undefined);
				for (const [token, entry] of [...prepared.entries()]) {
					if (entry.transactionId === request.transactionId && entry.path === state.path && entry.token !== state.token) {
						prepared.delete(token);
						await entry.release().catch(() => undefined);
					}
				}
			}
		},
		abort: async (request) => {
			for (const [token, entry] of [...prepared.entries()]) {
				if (entry.transactionId !== request.transactionId) continue;
				prepared.delete(token);
				try { if (existsSync(entry.temporaryPath)) rmSync(entry.temporaryPath); } finally {
					await entry.release().catch(() => undefined);
				}
			}
		},
		rollback: async (request) => {
			let rolledBack = false;
			let snapshotResult: SettingsSnapshot | undefined;
			for (const [token, entry] of [...prepared.entries()]) {
				if (entry.transactionId !== request.transactionId) continue;
				const release = await properLockfile.lock(entry.path, {
					realpath: false,
					stale: 10_000,
					update: 2_000,
					retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
				});
				try {
					const current = readDocument(entry.scope, entry.path);
					if (entry.committedRevision && current.revision.etag !== entry.committedRevision.etag) continue;
					atomicWrite(entry.path, entry.beforeContent);
					rolledBack = true;
					prepared.delete(token);
				} finally {
					await release();
				}
			}
			snapshotResult = snapshot(load(request.context), instanceId);
			return { rolledBack, ...(snapshotResult ? { snapshot: snapshotResult } : {}) };
		},
		applyRuntime: (request) => {
			const changedKeys = request.changes.map((change) => change.key);
			for (const [token, entry] of [...prepared.entries()]) {
				if (entry.transactionId === request.transactionId) {
					prepared.delete(token);
					void entry.release();
				}
			}
			return {
				appliedKeys: [],
				deferred: [{ boundary: "extension-reload", keys: changedKeys, messageKey: "native.runtime.reload" }],
				failed: [],
			};
		},
		invokeAction: async (request) => {
			if (request.actionId === "native.keybindings") {
				const path = join(getAgentDir(), "keybindings.json");
				options.onError?.(
					new Error(`Edit ${path} and run /reload to apply keybindings.`),
				);
				return { handled: true, messageKey: "native.runtime.keybindings", params: { path } };
			}
			return { handled: false };
		},
	};
}

export function registerNativePiSettingsProvider(
	events: SettingsEventBus,
	provider: NativePiSettingsProvider,
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

function snapshot(docs: NativeDocs, instanceId: string): SettingsSnapshot {
	const configured: ConfiguredSettingValue[] = [];
	for (const key of CONFIG_KEYS) {
		const scope: SettingsScope = GLOBAL_ONLY_KEYS.has(key) ? "global" : "global";
		const doc = docs[scope];
		configured.push({
			key,
			scope,
			state: doc.error ? "invalid" : "set",
			...(doc.error ? { messageKey: doc.error } : { value: getValue(doc.raw, key) }),
			resource: doc.revision.resource,
		});
	}
	const project = docs.project;
	for (const key of CONFIG_KEYS) {
		if (GLOBAL_ONLY_KEYS.has(key)) continue;
		configured.push({
			key,
			scope: "project",
			state: project.error ? "invalid" : "set",
			...(project.error ? { messageKey: project.error } : { value: getValue(project.raw, key) }),
			resource: project.revision.resource,
		});
	}
	const effective = CONFIG_KEYS.map((key) => {
		const value = GLOBAL_ONLY_KEYS.has(key)
			? (getValue(docs.global.raw, key) ?? DEFAULTS[key])
			: (getValue(docs.project.raw, key) ?? getValue(docs.global.raw, key) ?? DEFAULTS[key]);
		const scope: SettingsScope = getValue(docs.project.raw, key) !== undefined ? "project" : "global";
		const source: "default" | "configured" = value === DEFAULTS[key] ? "default" : "configured";
		return {
			key,
			value,
			source,
			scope: GLOBAL_ONLY_KEYS.has(key) ? "global" : scope,
			resource: (GLOBAL_ONLY_KEYS.has(key) ? docs.global : scope === "project" ? docs.project : docs.global).revision.resource,
		};
	});
	return {
		providerId: PROVIDER_ID,
		providerInstanceId: instanceId,
		configured: {
			values: configured,
			resources: [docs.global.revision, docs.project.revision],
		},
		effective: { values: effective },
	};
}

function validateRequest(
	docs: NativeDocs,
	changes: readonly SettingsChange[],
	expectedRevisions: readonly SettingsResourceRevision[] | undefined,
) {
	const issues: SettingsValidationIssue[] = [];
	const conflicts: SettingsResourceConflict[] = [];
	for (const change of changes) {
		if (!isConfigKey(change.key)) {
			issues.push(issue(change, "native.settings.unknownKey"));
			continue;
		}
		if (GLOBAL_ONLY_KEYS.has(change.key) && change.scope !== "global") {
			issues.push(issue(change, "native.settings.globalOnly"));
			continue;
		}
		if (change.scope !== "global" && change.scope !== "project") {
			issues.push(issue(change, "native.settings.globalOnly"));
			continue;
		}
		if (change.operation === "set" && !validValue(change.key, change.value)) {
			issues.push(issue(change, "native.settings.invalidValue"));
		}
		const doc = docs[change.scope as "global" | "project"];
		if (doc.error) issues.push({ severity: "error", messageKey: doc.error, key: change.key, scope: change.scope });
	}
	const expected = expectedRevisions;
	if (expected) {
		for (const revision of expected) {
			if (revision.resource.providerId !== PROVIDER_ID) continue;
			const doc = docs[revision.resource.scope as "global" | "project"];
			if (!doc) continue;
			if (doc.revision.etag !== revision.etag) {
				conflicts.push({
					resource: doc.revision.resource,
					expectedEtag: revision.etag,
					actualEtag: doc.revision.etag,
					messageKey: "settings.conflict",
				});
			}
		}
	}
	return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
}

function revision(scope: SettingsScope, path: string, content: string): SettingsResourceRevision {
	return {
		resource: { providerId: PROVIDER_ID, scope, id: GLOBAL_RESOURCE_ID },
		etag: createHash("sha256").update(content || "<missing>").digest("hex"),
		size: Buffer.byteLength(content),
	};
}

function applyChanges(raw: Record<string, unknown>, changes: readonly SettingsChange[]): Record<string, unknown> {
	const next: Record<string, unknown> = { ...raw };
	for (const change of changes) {
		if (change.operation === "unset") delete next[change.key];
		else setNested(next, change.key, change.value);
	}
	return next;
}

function setNested(target: Record<string, unknown>, dottedKey: string, value: JsonValue): void {
	const segments = dottedKey.split(".");
	let cursor = target;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index]!;
		const existing = cursor[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			const created: Record<string, unknown> = {};
			cursor[segment] = created;
			cursor = created;
		} else {
			cursor = existing as Record<string, unknown>;
		}
	}
	cursor[segments[segments.length - 1]!] = value;
}

function getValue(raw: Record<string, unknown>, dottedKey: string): JsonValue | undefined {
	let cursor: unknown = raw;
	for (const segment of dottedKey.split(".")) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor as JsonValue | undefined;
}

function validValue(key: NativeSettingKey, value: JsonValue): boolean {
	switch (key) {
		case "defaultProvider":
		case "defaultModel":
		case "theme":
		case "httpProxy":
			return typeof value === "string";
		case "defaultThinkingLevel":
			return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value));
		case "defaultProjectTrust":
			return ["ask", "always", "never"].includes(String(value));
		case "doubleEscapeAction":
			return ["tree", "fork", "none"].includes(String(value));
		case "treeFilterMode":
			return ["default", "no-tools", "user-only", "labeled-only", "all"].includes(String(value));
		case "steeringMode":
		case "followUpMode":
			return ["all", "one-at-a-time"].includes(String(value));
		case "transport":
			return ["sse", "websocket", "websocket-cached", "auto"].includes(String(value));
		case "editorPaddingX":
			return typeof value === "number" && value >= 0 && value <= 3;
		case "outputPad":
			return value === 0 || value === 1;
		case "autocompleteMaxVisible":
			return typeof value === "number" && value >= 3 && value <= 20;
		case "terminal.imageWidthCells":
			return typeof value === "number" && value >= 1 && value <= 240;
		case "httpIdleTimeoutMs":
		case "websocketConnectTimeoutMs":
		case "compaction.reserveTokens":
		case "compaction.keepRecentTokens":
		case "retry.maxRetries":
		case "retry.baseDelayMs":
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		default:
			return typeof value === "boolean";
	}
}

function isConfigKey(key: string): key is NativeSettingKey {
	return (CONFIG_KEYS as readonly string[]).includes(key);
}

function issue(change: SettingsChange, messageKey: string): SettingsValidationIssue {
	return { severity: "error", messageKey, key: change.key, scope: change.scope };
}

function booleanDefinition(
	key: NativeSettingKey,
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
		defaultValue: DEFAULTS[key],
		scopes: GLOBAL_ONLY_KEYS.has(key) ? ["global"] : ["global", "project"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "reload-required",
		editor: { kind: "boolean" },
	};
}

function enumDefinition(
	key: NativeSettingKey,
	group: string,
	order: number,
	labelKey: string,
	values: readonly string[],
	activation: SettingDefinition["activation"],
	descriptionKey?: string,
	globalOnly = false,
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		...(descriptionKey ? { descriptionKey } : {}),
		defaultValue: DEFAULTS[key],
		scopes: globalOnly || GLOBAL_ONLY_KEYS.has(key) ? ["global"] : ["global", "project"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "reload-required",
		editor: { kind: "enum", options: values.map((value) => ({ value, labelKey: `native.option.${value}` })) },
	};
}

function intDefinition(
	key: NativeSettingKey,
	group: string,
	order: number,
	labelKey: string,
	min: number,
	max: number,
	activation: SettingDefinition["activation"],
	descriptionKey?: string,
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		...(descriptionKey ? { descriptionKey } : {}),
		defaultValue: DEFAULTS[key],
		scopes: ["global", "project"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "reload-required",
		editor: { kind: "integer", min, max },
	};
}

function textDefinition(
	key: NativeSettingKey,
	group: string,
	order: number,
	labelKey: string,
	activation: SettingDefinition["activation"],
	descriptionKey?: string,
	globalOnly = false,
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		...(descriptionKey ? { descriptionKey } : {}),
		defaultValue: DEFAULTS[key],
		scopes: globalOnly || GLOBAL_ONLY_KEYS.has(key) ? ["global"] : ["global", "project"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "reload-required",
		editor: { kind: "text" },
	};
}

function modelDefinition(
	key: NativeSettingKey,
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
		defaultValue: DEFAULTS[key],
		scopes: ["global", "project"],
		merge: "override",
		activation,
		sensitivity: "public",
		reversibility: "reload-required",
		editor: { kind: "model" },
	};
}

function actionDefinition(
	key: string,
	group: string,
	order: number,
	labelKey: string,
	actionId: string,
	actionLabelKey: string,
	descriptionKey?: string,
): SettingDefinition {
	return {
		key,
		group,
		order,
		labelKey,
		...(descriptionKey ? { descriptionKey } : {}),
		scopes: ["global"],
		merge: "provider-defined",
		activation: "live",
		sensitivity: "private",
		reversibility: "full",
		editor: { kind: "action", actionId, options: [{ value: "open", labelKey: actionLabelKey }] },
	};
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
