import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVisionDelegationConfigPath } from "../providers/vision-assist.ts";
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
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";

const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as {
  lock(path: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
  }): Promise<() => Promise<void>>;
};

const PROVIDER_ID = "pi-maestro-flow-vision";
const PROVIDER_VERSION = "1.0.0";
const RESOURCE_ID = "vision-delegation.json";

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

const CONFIG_KEYS = [
  "enabled",
  "visionModel",
  "customPrompt",
  "cache.enabled",
  "cache.maxEntries",
  "fallbackModels",
  "maxRetries",
  "retryBackoffMs",
  "timeoutMs",
  "maxImageBytes",
] as const;

type VisionSettingKey = (typeof CONFIG_KEYS)[number];

const DEFAULTS: Readonly<Record<VisionSettingKey, JsonValue>> = {
  enabled: true,
  visionModel: "",
  customPrompt: "",
  "cache.enabled": true,
  "cache.maxEntries": 50,
  fallbackModels: [],
  maxRetries: 0,
  retryBackoffMs: 500,
  timeoutMs: 60_000,
  maxImageBytes: 20 * 1024 * 1024,
};

const CATALOGS = {
  en: {
    "vision.provider": "Vision delegation",
    "vision.provider.description": "Image understanding delegation (vision-delegation.json)",
    "vision.group.general": "General",
    "vision.group.cache": "Cache",
    "vision.group.retry": "Retry & limits",
    "vision.enabled": "Vision delegation enabled",
    "vision.enabled.description": "Delegate image understanding to a dedicated vision model when the main model has no vision.",
    "vision.visionModel": "Vision model",
    "vision.visionModel.description": "Model used to describe images (provider/model). Empty falls back to the main model.",
    "vision.customPrompt": "Custom analysis prompt",
    "vision.customPrompt.description": "Override the default 'describe this image' prompt.",
    "vision.cache.enabled": "Result cache",
    "vision.cache.maxEntries": "Cache max entries",
    "vision.fallbackModels": "Fallback models",
    "vision.fallbackModels.description": "Comma-separated fallback models tried in order.",
    "vision.maxRetries": "Max retries",
    "vision.retryBackoffMs": "Retry backoff (ms)",
    "vision.timeoutMs": "Delegation timeout (ms)",
    "vision.maxImageBytes": "Max image bytes",
    "vision.runtime.reload": "Vision delegation is read on use — start a new turn for changes to take effect",
  },
  "zh-CN": {
    "vision.provider": "视觉委托",
    "vision.provider.description": "图片理解委托（vision-delegation.json）",
    "vision.group.general": "常规",
    "vision.group.cache": "缓存",
    "vision.group.retry": "重试与限制",
    "vision.enabled": "启用视觉委托",
    "vision.enabled.description": "当主模型不支持视觉时，将图片理解委托给专门的视觉模型。",
    "vision.visionModel": "视觉模型",
    "vision.visionModel.description": "用于描述图片的模型（provider/model）。留空则回退到主模型。",
    "vision.customPrompt": "自定义分析提示",
    "vision.customPrompt.description": "覆盖默认的『描述这张图片』提示词。",
    "vision.cache.enabled": "结果缓存",
    "vision.cache.maxEntries": "缓存最大条目",
    "vision.fallbackModels": "回退模型",
    "vision.fallbackModels.description": "按顺序尝试的逗号分隔回退模型列表。",
    "vision.maxRetries": "最大重试次数",
    "vision.retryBackoffMs": "重试退避（毫秒）",
    "vision.timeoutMs": "委托超时（毫秒）",
    "vision.maxImageBytes": "最大图片字节数",
    "vision.runtime.reload": "视觉委托在使用时读取 —— 开启新的一轮使改动生效",
  },
} as const;

const DEFINITIONS: readonly SettingDefinition[] = [
  booleanDefinition("enabled", "vision.group.general", 0, "vision.enabled", "vision.enabled.description"),
  modelDefinition("visionModel", "vision.group.general", 1, "vision.visionModel", "vision.visionModel.description"),
  {
    key: "customPrompt",
    group: "vision.group.general",
    order: 2,
    labelKey: "vision.customPrompt",
    descriptionKey: "vision.customPrompt.description",
    defaultValue: DEFAULTS.customPrompt,
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "text", multiline: true },
  },
  booleanDefinition("cache.enabled", "vision.group.cache", 0, "vision.cache.enabled"),
  intDefinition("cache.maxEntries", "vision.group.cache", 1, "vision.cache.maxEntries", 1, 1000),
  {
    key: "fallbackModels",
    group: "vision.group.general",
    order: 3,
    labelKey: "vision.fallbackModels",
    descriptionKey: "vision.fallbackModels.description",
    defaultValue: DEFAULTS.fallbackModels,
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "string-list" },
  },
  intDefinition("maxRetries", "vision.group.retry", 0, "vision.maxRetries", 0, 10),
  intDefinition("retryBackoffMs", "vision.group.retry", 1, "vision.retryBackoffMs", 0, 8000),
  intDefinition("timeoutMs", "vision.group.retry", 2, "vision.timeoutMs", 1000, 300000),
  intDefinition("maxImageBytes", "vision.group.retry", 3, "vision.maxImageBytes", 1024, 64 * 1024 * 1024),
];

export interface VisionDelegationSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface VisionDelegationSettingsProviderOptions {
  getConfigPath?: () => string;
}

interface VisionDocument {
  path: string;
  content: string;
  raw: Record<string, unknown>;
  revision: SettingsResourceRevision;
  error?: string;
}

interface PreparedVisionChange {
  token: string;
  transactionId: string;
  path: string;
  temporaryPath: string;
  beforeContent: string;
  raw: Record<string, unknown>;
  changedKeys: readonly string[];
  release: () => Promise<void>;
  committedRevision?: SettingsResourceRevision;
}

export function createVisionDelegationSettingsProvider(
  options: VisionDelegationSettingsProviderOptions = {},
): VisionDelegationSettingsProvider {
  const instanceId = randomUUID();
  const getPath = options.getConfigPath ?? getVisionDelegationConfigPath;
  const prepared = new Map<string, PreparedVisionChange>();

  const readDocument = (path: string): VisionDocument => {
    if (!existsSync(path)) return { path, content: "", raw: {}, revision: revision(path, "") };
    const content = readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      return { path, content, raw, revision: revision(path, content) };
    } catch (error) {
      return {
        path,
        content,
        raw: {},
        revision: revision(path, content),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "vision.provider",
      descriptionKey: "vision.provider.description",
      order: 12,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: () => {
      const doc = readDocument(getPath());
      const configured: ConfiguredSettingValue[] = CONFIG_KEYS.map((key) => ({
        key,
        scope: "global",
        state: doc.error ? "invalid" : "set",
        ...(doc.error ? { messageKey: doc.error } : { value: getValue(doc.raw, key) ?? DEFAULTS[key] }),
        resource: doc.revision.resource,
      }));
      return {
        providerId: PROVIDER_ID,
        providerInstanceId: instanceId,
        configured: { values: configured, resources: [doc.revision] },
        effective: {
          values: CONFIG_KEYS.map((key) => ({
            key,
            value: getValue(doc.raw, key) ?? DEFAULTS[key],
            source: getValue(doc.raw, key) === undefined ? "default" : "configured",
            scope: "global",
            resource: doc.revision.resource,
          })),
        },
      };
    },
    validate: (request) => {
      const doc = readDocument(getPath());
      const issues: SettingsValidationIssue[] = [];
      const conflicts: SettingsResourceConflict[] = [];
      for (const change of request.changes) {
        if (!isConfigKey(change.key)) issues.push(issue(change, "vision.settings.unknownKey"));
        else if (change.scope !== "global") issues.push(issue(change, "vision.settings.globalOnly"));
        else if (change.operation === "set" && !validValue(change.key, change.value)) issues.push(issue(change, "vision.settings.invalidValue"));
      }
      for (const revision of request.expectedRevisions ?? []) {
        if (revision.resource.providerId !== PROVIDER_ID) continue;
        if (revision.etag !== doc.revision.etag) {
          conflicts.push({ resource: doc.revision.resource, expectedEtag: revision.etag, actualEtag: doc.revision.etag, messageKey: "settings.conflict" });
        }
      }
      return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
    },
    prepare: async (request) => {
      const path = getPath();
      const doc = readDocument(path);
      const issues: SettingsValidationIssue[] = [];
      const conflicts: SettingsResourceConflict[] = [];
      for (const change of request.changes) {
        if (!isConfigKey(change.key)) issues.push(issue(change, "vision.settings.unknownKey"));
        else if (change.scope !== "global") issues.push(issue(change, "vision.settings.globalOnly"));
        else if (change.operation === "set" && !validValue(change.key, change.value)) issues.push(issue(change, "vision.settings.invalidValue"));
      }
      for (const revision of request.expectedRevisions ?? []) {
        if (revision.resource.providerId !== PROVIDER_ID) continue;
        if (revision.etag !== doc.revision.etag) {
          conflicts.push({ resource: doc.revision.resource, expectedEtag: revision.etag, actualEtag: doc.revision.etag, messageKey: "settings.conflict" });
        }
      }
      if (issues.length > 0 || conflicts.length > 0) {
        return { prepared: false, validation: { valid: false, issues, conflicts } };
      }
      const release = await properLockfile.lock(path, {
        realpath: false, stale: 10_000, update: 2_000,
        retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      try {
        const current = readDocument(path);
        const nextRaw = applyChanges(current.raw, request.changes);
        const content = `${JSON.stringify(nextRaw, null, 2)}\n`;
        const token = randomUUID();
        const temporaryPath = `${path}.${process.pid}.${token}.tmp`;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        prepared.set(token, {
          token,
          transactionId: request.transactionId,
          path,
          temporaryPath,
          beforeContent: current.content,
          raw: nextRaw,
          changedKeys: request.changes.map((change) => change.key),
          release,
        });
        return {
          prepared: true,
          prepareToken: token,
          validation: { valid: true, issues: [] },
          activation: [{ boundary: "next-invocation", keys: request.changes.map((change) => change.key), messageKey: "vision.runtime.reload" }],
        };
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    },
    commit: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId) throw new Error("prepared vision settings transaction is unavailable");
      let published = false;
      try {
        renameSync(state.temporaryPath, state.path);
        published = true;
        const doc = readDocument(state.path);
        state.committedRevision = doc.revision;
        return {
          snapshot: snapshot(doc, instanceId),
          revisions: [doc.revision],
          changedKeys: state.changedKeys,
          activation: [{ boundary: "next-invocation", keys: state.changedKeys, messageKey: "vision.runtime.reload" }],
        };
      } catch (error) {
        if (published) {
          try { writeFileSync(state.path, state.beforeContent); } catch { /* best effort */ }
        }
        throw error;
      } finally {
        await state.release().catch(() => undefined);
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
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId !== request.transactionId) continue;
        const release = await properLockfile.lock(entry.path, {
          realpath: false, stale: 10_000, update: 2_000,
          retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
        });
        try {
          const current = readDocument(entry.path);
          if (entry.committedRevision && current.revision.etag !== entry.committedRevision.etag) continue;
          writeFileSync(entry.path, entry.beforeContent);
          rolledBack = true;
          prepared.delete(token);
        } finally {
          await release();
        }
      }
      const doc = readDocument(getPath());
      return { rolledBack, snapshot: snapshot(doc, instanceId) };
    },
    applyRuntime: (request) => {
      const changedKeys = request.changes.map((change) => change.key);
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId === request.transactionId) {
          prepared.delete(token);
          void entry.release();
        }
      }
      return { appliedKeys: [], deferred: [{ boundary: "next-invocation", keys: changedKeys, messageKey: "vision.runtime.reload" }], failed: [] };
    },
  };
}

export function registerVisionDelegationSettingsProvider(
  events: SettingsEventBus,
  provider: VisionDelegationSettingsProvider,
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

function snapshot(doc: VisionDocument, instanceId: string): SettingsSnapshot {
  const configured: ConfiguredSettingValue[] = CONFIG_KEYS.map((key) => ({
    key,
    scope: "global",
    state: doc.error ? "invalid" : "set",
    ...(doc.error ? { messageKey: doc.error } : { value: getValue(doc.raw, key) ?? DEFAULTS[key] }),
    resource: doc.revision.resource,
  }));
  return {
    providerId: PROVIDER_ID,
    providerInstanceId: instanceId,
    configured: { values: configured, resources: [doc.revision] },
    effective: {
      values: CONFIG_KEYS.map((key) => ({
        key,
        value: getValue(doc.raw, key) ?? DEFAULTS[key],
        source: getValue(doc.raw, key) === undefined ? "default" : "configured",
        scope: "global",
        resource: doc.revision.resource,
      })),
    },
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

function validValue(key: VisionSettingKey, value: JsonValue): boolean {
  switch (key) {
    case "visionModel":
    case "customPrompt":
      return typeof value === "string";
    case "cache.maxEntries":
    case "maxRetries":
    case "retryBackoffMs":
    case "timeoutMs":
    case "maxImageBytes":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "fallbackModels":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    default:
      return typeof value === "boolean";
  }
}

function isConfigKey(key: string): key is VisionSettingKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function issue(change: SettingsChange, messageKey: string): SettingsValidationIssue {
  return { severity: "error", messageKey, key: change.key, scope: change.scope };
}

function revision(path: string, content: string): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope: "global", id: RESOURCE_ID },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function booleanDefinition(
  key: VisionSettingKey,
  group: string,
  order: number,
  labelKey: string,
  descriptionKey?: string,
): SettingDefinition {
  return {
    key,
    group,
    order,
    labelKey,
    ...(descriptionKey ? { descriptionKey } : {}),
    defaultValue: DEFAULTS[key],
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "boolean" },
  };
}

function intDefinition(
  key: VisionSettingKey,
  group: string,
  order: number,
  labelKey: string,
  min: number,
  max: number,
): SettingDefinition {
  return {
    key,
    group,
    order,
    labelKey,
    defaultValue: DEFAULTS[key],
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "integer", min, max },
  };
}

function modelDefinition(
  key: VisionSettingKey,
  group: string,
  order: number,
  labelKey: string,
  descriptionKey?: string,
): SettingDefinition {
  return {
    key,
    group,
    order,
    labelKey,
    ...(descriptionKey ? { descriptionKey } : {}),
    defaultValue: DEFAULTS[key],
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind: "model" },
  };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
