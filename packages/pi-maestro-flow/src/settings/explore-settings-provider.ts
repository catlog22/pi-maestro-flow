import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type JsonValue,
  type SettingDefinition,
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
import { SETTINGS_SECRET_SET_PLACEHOLDER } from "pi-maestro-settings-core/v1/schema";
import type { ExploreApiFormat } from "../providers/explore-config-manager.ts";

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
 * pi-maestro-flow-explore provider. Exposes the /explore-manager config
 * (~/.maestro/api.json with a legacy api-explore.json fallback) in the unified
 * maestro-settings shell: the endpoint table as a list-crud editor, global
 * maxTurns/concurrency/treeDepth as integers, and an action that opens the
 * original /explore-manager command for the full experience.
 */

const PROVIDER_ID = "pi-maestro-flow-explore";
const PROVIDER_VERSION = "1.0.0";
const RESOURCE_ID = "api.json";

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

const FORMATS: readonly { value: ExploreApiFormat; labelKey: string }[] = [
  { value: "openai", labelKey: "explore.format.openai" },
  { value: "anthropic", labelKey: "explore.format.anthropic" },
  { value: "openai-responses", labelKey: "explore.format.openaiResponses" },
];

const DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "explore.endpoints",
    group: "explore.group.endpoints",
    order: 0,
    labelKey: "explore.endpoints",
    descriptionKey: "explore.endpoints.description",
    scopes: ["global"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      addLabelKey: "explore.endpoints.add",
      itemLabelKey: "explore.endpoints.item",
      itemFields: [
        { key: "name", group: "explore.group.field", order: 0, labelKey: "explore.field.name", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
        { key: "baseUrl", group: "explore.group.field", order: 1, labelKey: "explore.field.baseUrl", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
        { key: "apiKey", group: "explore.group.field", order: 2, labelKey: "explore.field.apiKey", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "secret", reversibility: "full", editor: { kind: "secret", writeOnly: true } },
        { key: "model", group: "explore.group.field", order: 3, labelKey: "explore.field.model", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
        { key: "format", group: "explore.group.field", order: 4, labelKey: "explore.field.format", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "enum", options: FORMATS } },
        { key: "concurrency", group: "explore.group.field", order: 5, labelKey: "explore.field.concurrency", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "integer", min: 1, max: 64 } },
        { key: "maxTurns", group: "explore.group.field", order: 6, labelKey: "explore.field.maxTurns", scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "integer", min: 1, max: 1000 } },
      ],
    },
  },
  intDefinition("explore.maxTurns", "explore.group.global", 0, "explore.maxTurns", 1, 1000),
  intDefinition("explore.concurrency", "explore.group.global", 1, "explore.concurrency", 1, 64),
  intDefinition("explore.treeDepth", "explore.group.global", 2, "explore.treeDepth", 1, 32),
  {
    key: "explore.manage",
    group: "explore.group.manage",
    order: 3,
    labelKey: "explore.manage",
    descriptionKey: "explore.manage.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "action", actionId: "explore.manage", options: [{ value: "open", labelKey: "explore.manage.open" }] },
  },
];

const CATALOGS = {
  en: {
    "explore.provider": "Explore",
    "explore.provider.description": "Explore agent endpoints and defaults (~/.maestro/api.json)",
    "explore.group.endpoints": "Endpoints",
    "explore.group.global": "Defaults",
    "explore.group.field": "Endpoint",
    "explore.group.manage": "Manage",
    "explore.endpoints": "Explore endpoints",
    "explore.endpoints.description": "API endpoints the Explore agent uses (baseUrl, key, model).",
    "explore.endpoints.add": "Add endpoint",
    "explore.endpoints.item": "{name}",
    "explore.field.name": "Name",
    "explore.field.baseUrl": "Base URL",
    "explore.field.apiKey": "API key",
    "explore.field.model": "Model",
    "explore.field.format": "API format",
    "explore.field.concurrency": "Concurrency",
    "explore.field.maxTurns": "Max turns",
    "explore.maxTurns": "Default max turns",
    "explore.concurrency": "Default concurrency",
    "explore.treeDepth": "Tree depth",
    "explore.manage": "Open Explore manager",
    "explore.manage.description": "Full endpoint editor via the /explore-manager command.",
    "explore.manage.open": "Open manager",
    "explore.format.openai": "OpenAI Chat Completions",
    "explore.format.anthropic": "Anthropic Messages",
    "explore.format.openaiResponses": "OpenAI Responses",
    "explore.settings.unknownKey": "Unknown Explore setting",
    "explore.settings.invalidValue": "Invalid value for this Explore setting",
    "explore.settings.globalOnly": "Explore settings are global-only",
  },
  "zh-CN": {
    "explore.provider": "探索",
    "explore.provider.description": "探索 Agent 端点与默认值（~/.maestro/api.json）",
    "explore.group.endpoints": "端点",
    "explore.group.global": "默认值",
    "explore.group.field": "端点",
    "explore.group.manage": "管理",
    "explore.endpoints": "探索端点",
    "explore.endpoints.description": "探索 Agent 使用的 API 端点（baseUrl、key、model）。",
    "explore.endpoints.add": "添加端点",
    "explore.endpoints.item": "{name}",
    "explore.field.name": "名称",
    "explore.field.baseUrl": "Base URL",
    "explore.field.apiKey": "API 密钥",
    "explore.field.model": "模型",
    "explore.field.format": "API 格式",
    "explore.field.concurrency": "并发数",
    "explore.field.maxTurns": "最大轮数",
    "explore.maxTurns": "默认最大轮数",
    "explore.concurrency": "默认并发数",
    "explore.treeDepth": "树深度",
    "explore.manage": "打开探索管理器",
    "explore.manage.description": "通过 /explore-manager 命令编辑完整端点。",
    "explore.manage.open": "打开管理器",
    "explore.format.openai": "OpenAI Chat Completions",
    "explore.format.anthropic": "Anthropic Messages",
    "explore.format.openaiResponses": "OpenAI Responses",
    "explore.settings.unknownKey": "未知的探索设置",
    "explore.settings.invalidValue": "该探索设置的取值无效",
    "explore.settings.globalOnly": "探索设置仅支持全局作用域",
  },
} as const;

export interface ExploreSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface ExploreSettingsProviderOptions {
  getConfigPath?: () => string;
  getLegacyPath?: () => string;
  onError?(error: unknown): void;
}

interface ExploreDocument {
  path: string;
  content: string;
  raw: Record<string, unknown>;
  revision: SettingsResourceRevision;
  error?: string;
}

interface PreparedExploreChange {
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

export function createExploreSettingsProvider(options: ExploreSettingsProviderOptions = {}): ExploreSettingsProvider {
  const instanceId = randomUUID();
  const getConfigPath = options.getConfigPath ?? (() => join(homedir(), ".maestro", "api.json"));
  const getLegacyPath = options.getLegacyPath ?? (() => join(homedir(), ".maestro", "api-explore.json"));
  const prepared = new Map<string, PreparedExploreChange>();

  const activePath = (): { path: string; legacy: boolean } => {
    const canonical = getConfigPath();
    return existsSync(canonical) ? { path: canonical, legacy: false } : { path: getLegacyPath(), legacy: true };
  };

  const readDocument = (): ExploreDocument => {
    const { path } = activePath();
    if (!existsSync(path)) return { path, content: "", raw: {}, revision: revision(path, "") };
    const content = readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      return { path, content, raw, revision: revision(path, content) };
    } catch (error) {
      return { path, content, raw: {}, revision: revision(path, content), error: error instanceof Error ? error.message : String(error) };
    }
  };

  const endpointsArray = (raw: Record<string, unknown>): Array<Record<string, unknown>> => {
    const endpoints = raw.endpoints;
    if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) return [];
    return Object.entries(endpoints).map(([name, value]) => {
      const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { name, ...entry, apiKey: entry.apiKey ? SETTINGS_SECRET_SET_PLACEHOLDER : null };
    });
  };

  const endpointsToRaw = (items: Array<Record<string, unknown>>): Record<string, unknown> => {
    const endpoints: Record<string, unknown> = {};
    for (const item of items) {
      const { name, apiKey, ...rest } = item;
      if (typeof name === "string" && name) {
        endpoints[name] = { ...rest, ...(apiKey && apiKey !== SETTINGS_SECRET_SET_PLACEHOLDER ? { apiKey } : {}) };
      }
    }
    return endpoints;
  };

  const numberValue = (doc: ExploreDocument, key: string, fallback: number): JsonValue => {
    const value = doc.raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };

  const snapshot = (doc: ExploreDocument): SettingsSnapshot => {
    const endpoints: JsonValue = endpointsArray(doc.raw) as unknown as JsonValue;
    const configured: ConfiguredSettingValue[] = [
      {
        key: "explore.endpoints",
        scope: "global",
        state: doc.error ? "invalid" : "set",
        ...(doc.error ? { messageKey: doc.error } : { value: endpoints }),
        resource: doc.revision.resource,
      },
      { key: "explore.maxTurns", scope: "global", state: "set", value: numberValue(doc, "maxTurns", 10), resource: doc.revision.resource },
      { key: "explore.concurrency", scope: "global", state: "set", value: numberValue(doc, "concurrency", 4), resource: doc.revision.resource },
      { key: "explore.treeDepth", scope: "global", state: "set", value: numberValue(doc, "treeDepth", 3), resource: doc.revision.resource },
      { key: "explore.manage", scope: "global", state: "absent", resource: doc.revision.resource },
    ];
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [doc.revision] },
      effective: {
        values: [
          { key: "explore.endpoints", value: endpoints, source: "configured", scope: "global", resource: doc.revision.resource },
          { key: "explore.maxTurns", value: numberValue(doc, "maxTurns", 10), source: "configured", scope: "global", resource: doc.revision.resource },
          { key: "explore.concurrency", value: numberValue(doc, "concurrency", 4), source: "configured", scope: "global", resource: doc.revision.resource },
          { key: "explore.treeDepth", value: numberValue(doc, "treeDepth", 3), source: "configured", scope: "global", resource: doc.revision.resource },
          { key: "explore.manage", value: "open", source: "runtime", scope: "global", resource: doc.revision.resource },
        ],
      },
    };
  };

  const applyChanges = (raw: Record<string, unknown>, changes: readonly SettingsChange[]): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...raw };
    for (const change of changes) {
      if (change.operation === "unset") {
        if (change.key === "explore.endpoints") delete next.endpoints;
        else delete next[change.key.replace("explore.", "")];
        continue;
      }
      if (change.key === "explore.endpoints") {
        const items = Array.isArray(change.value) ? change.value as Array<Record<string, unknown>> : [];
        next.endpoints = endpointsToRaw(items);
      } else {
        next[change.key.replace("explore.", "")] = change.value;
      }
    }
    return next;
  };

  const validateChanges = (changes: readonly SettingsChange[], doc: ExploreDocument, expectedRevisions: readonly SettingsResourceRevision[] | undefined): { issues: SettingsValidationIssue[]; conflicts: SettingsResourceConflict[] } => {
    const issues: SettingsValidationIssue[] = [];
    for (const change of changes) {
      if (!["explore.endpoints", "explore.maxTurns", "explore.concurrency", "explore.treeDepth"].includes(change.key)) {
        issues.push({ severity: "error", messageKey: "explore.settings.unknownKey", key: change.key, scope: change.scope });
        continue;
      }
      if (change.scope !== "global") issues.push({ severity: "error", messageKey: "explore.settings.globalOnly", key: change.key, scope: change.scope });
      if (change.operation === "set") {
        if (change.key === "explore.endpoints") {
          if (!Array.isArray(change.value)) issues.push({ severity: "error", messageKey: "explore.settings.invalidValue", key: change.key, scope: change.scope });
        } else if (!(typeof change.value === "number" && Number.isInteger(change.value) && change.value >= 1)) {
          issues.push({ severity: "error", messageKey: "explore.settings.invalidValue", key: change.key, scope: change.scope });
        }
      }
    }
    const conflicts: SettingsResourceConflict[] = [];
    for (const expected of expectedRevisions ?? []) {
      if (expected.resource.providerId !== PROVIDER_ID) continue;
      if (doc.revision.etag !== expected.etag) {
        conflicts.push({ resource: doc.revision.resource, expectedEtag: expected.etag, actualEtag: doc.revision.etag, messageKey: "settings.conflict" });
      }
    }
    return { issues, conflicts };
  };

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "explore.provider",
      descriptionKey: "explore.provider.description",
      order: 13,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: () => snapshot(readDocument()),
    validate: (request) => {
      const { issues, conflicts } = validateChanges(request.changes, readDocument(), request.expectedRevisions);
      return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
    },
    prepare: async (request) => {
      const { path } = activePath();
      const doc = readDocument();
      const { issues, conflicts } = validateChanges(request.changes, doc, request.expectedRevisions);
      if (issues.length > 0 || conflicts.length > 0) {
        return { prepared: false, validation: { valid: false, issues, conflicts } };
      }
      const release = await properLockfile.lock(path, {
        realpath: false, stale: 10_000, update: 2_000,
        retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      try {
        const current = readDocument();
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
          activation: [{ boundary: "next-invocation", keys: request.changes.map((change) => change.key) }],
        };
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    },
    commit: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId) throw new Error("prepared Explore settings transaction is unavailable");
      let published = false;
      try {
        renameSync(state.temporaryPath, state.path);
        published = true;
        const doc = readDocument();
        state.committedRevision = doc.revision;
        return { snapshot: snapshot(doc), revisions: [doc.revision], changedKeys: state.changedKeys, activation: [{ boundary: "next-invocation", keys: state.changedKeys }] };
      } catch (error) {
        if (published) { try { writeFileSync(state.path, state.beforeContent); } catch { /* best effort */ } }
        throw error;
      } finally {
        await state.release().catch(() => undefined);
      }
    },
    abort: async (request) => {
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId !== request.transactionId) continue;
        prepared.delete(token);
        try { if (existsSync(entry.temporaryPath)) rmSync(entry.temporaryPath); } finally { await entry.release().catch(() => undefined); }
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
          const current = readDocument();
          if (entry.committedRevision && current.revision.etag !== entry.committedRevision.etag) continue;
          writeFileSync(entry.path, entry.beforeContent);
          rolledBack = true;
          prepared.delete(token);
        } finally { await release(); }
      }
      const doc = readDocument();
      return { rolledBack, snapshot: snapshot(doc) };
    },
    applyRuntime: (request) => {
      const changedKeys = request.changes.map((change) => change.key);
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId === request.transactionId) { prepared.delete(token); void entry.release(); }
      }
      return { appliedKeys: [], deferred: [{ boundary: "next-invocation", keys: changedKeys }], failed: [] };
    },
    invokeAction: async (request) => {
      if (request.actionId === "explore.manage") {
        options.onError?.(new Error("Open /explore-manager from the command palette for the full Explore manager."));
        return { handled: true, messageKey: "explore.manage.open" };
      }
      return { handled: false };
    },
  };
}

export function registerExploreSettingsProvider(events: SettingsEventBus, provider: ExploreSettingsProvider): () => void {
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

function intDefinition(key: string, group: string, order: number, labelKey: string, min: number, max: number): SettingDefinition {
  return { key, group, order, labelKey, scopes: ["global"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "integer", min, max } };
}

function revision(path: string, content: string): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope: "global", id: RESOURCE_ID },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
