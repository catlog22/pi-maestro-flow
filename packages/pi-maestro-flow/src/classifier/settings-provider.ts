/**
 * Classifier settings provider — surfaces `.pi/classifier.json` in the Pi
 * settings shell (same pattern as hooks-settings-provider: single project
 * resource, prepare→commit→rollback with lockfile + tmp-file publish).
 *
 * Exposed settings:
 *   classifier.enabled               boolean
 *   classifier.endpoint              enum auto|typesafe|openrouter
 *   classifier.model                 text
 *   classifier.timeoutMs             integer
 *   classifier.maxCallsPerSession    integer
 *   classifier.domains.<name>        enum off|shadow|jev — one per registered
 *                                    domain; options are clamped to the
 *                                    domain's supportedModes (retry-error is
 *                                    shadow-only — the sync retry boundary
 *                                    cannot await an HTTP call).
 *
 * `applyRuntime` pushes the normalized config into the classifier engine
 * immediately via the injected `apply` callback (activation: live).
 */

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsAnnounceEventV1,
  type SettingsChange,
  type SettingsDiscoverEventV1,
  type SettingsProviderV1,
  type SettingsResourceConflict,
  type SettingsResourceRevision,
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
import type { ClassifierDomainMode } from "pi-maestro-teammate/v1/classify";
import {
  applyClassifierEnvOverrides,
  assertClassifierConfigTarget,
  classifierConfigPath,
  classifierEnvOverrides,
  CLASSIFIER_ENV_FLAG,
  CLASSIFIER_ENDPOINT_ENV,
  CLASSIFIER_MODEL_ENV,
  DEFAULT_CLASSIFIER_CONFIG,
  normalizeClassifierConfig,
  type FlowClassifierConfig,
} from "./config.ts";

const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as {
  lock(path: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
  }): Promise<() => Promise<void>>;
};

const PROVIDER_ID = "pi-maestro-flow-classifier";
const PROVIDER_VERSION = "1.0.0";
const RESOURCE_ID = "classifier.json";
const DOMAIN_KEY_PREFIX = "classifier.domains.";
const DOMAIN_MODES: readonly ClassifierDomainMode[] = ["off", "shadow", "jev"];

const SCALAR_KEYS = [
  "classifier.enabled",
  "classifier.endpoint",
  "classifier.model",
  "classifier.timeoutMs",
  "classifier.maxCallsPerSession",
] as const;

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface ClassifierDomainInfo {
  name: string;
  modes: readonly ClassifierDomainMode[];
}

export interface ClassifierSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface ClassifierSettingsProviderOptions {
  getConfigPath?: (cwd: string) => string;
  /** Live domain registry — called per describe/read so new domains appear. */
  getDomains?: () => readonly ClassifierDomainInfo[];
  /** Hot-apply effective config; configured values remain separate for persistence. */
  apply?: (config: FlowClassifierConfig, configured: FlowClassifierConfig) => void;
}

interface ClassifierDocument {
  path: string;
  exists: boolean;
  content: string;
  raw?: Record<string, unknown>;
  config: FlowClassifierConfig;
  revision: SettingsResourceRevision;
  error?: string;
}

interface PreparedClassifierChange {
  token: string;
  transactionId: string;
  path: string;
  temporaryPath: string;
  beforeContent: string;
  beforeExists: boolean;
  changedKeys: readonly string[];
  release: () => Promise<void>;
  committedRevision?: SettingsResourceRevision;
}

const ENDPOINT_OPTIONS = [
  { value: "auto", labelKey: "classifier.option.auto" },
  { value: "typesafe", labelKey: "classifier.option.typesafe" },
  { value: "openrouter", labelKey: "classifier.option.openrouter" },
] as const;

const CATALOGS = {
  en: {
    "classifier.provider": "Classifier",
    "classifier.provider.description": "Unified rules + JEV semantic classification",
    "classifier.group.general": "General",
    "classifier.group.domains": "Domains",
    "classifier.enabled": "Enabled",
    "classifier.enabled.description": "Master switch for JEV semantic classification. Domains still obey their per-domain mode.",
    "classifier.endpoint": "JEV endpoint",
    "classifier.endpoint.description": "auto picks by which API key env exists (TYPESAFE_API_KEY, then OPENROUTER_API_KEY).",
    "classifier.model": "JEV model",
    "classifier.model.description": "Model id sent to the endpoint (e.g. jev-latest or typesafe/jev-1.13). Empty uses the endpoint default.",
    "classifier.timeoutMs": "Timeout (ms)",
    "classifier.timeoutMs.description": "Per-call JEV timeout. JEV is a low-latency decision model; default 4000.",
    "classifier.maxCallsPerSession": "Max calls per session",
    "classifier.maxCallsPerSession.description": "Session budget for JEV calls across all domains; default 30.",
    "classifier.domain.mode": "Mode",
    "classifier.domain.description": "off: rules only · shadow: rules decide, JEV judges in background · jev: JEV adjudicates non-terminal results.",
    "classifier.option.auto": "Auto",
    "classifier.option.typesafe": "TypeSafe",
    "classifier.option.openrouter": "OpenRouter",
    "classifier.option.off": "Off",
    "classifier.option.shadow": "Shadow",
    "classifier.option.jev": "JEV",
    "classifier.settings.envOverride": "Overridden by a classifier environment variable; saving changes the file, not the effective value.",
    "classifier.settings.unknownKey": "Unknown classifier setting",
    "classifier.settings.invalidValue": "Invalid value for this classifier setting",
    "classifier.settings.unsupportedMode": "Mode not supported by this domain",
    "settings.conflict": "classifier.json changed on disk",
  },
  "zh-CN": {
    "classifier.provider": "分类器",
    "classifier.provider.description": "统一规则 + JEV 语义分类",
    "classifier.group.general": "常规",
    "classifier.group.domains": "域",
    "classifier.enabled": "启用",
    "classifier.enabled.description": "JEV 语义分类总开关；各域仍受各自模式约束。",
    "classifier.endpoint": "JEV 端点",
    "classifier.endpoint.description": "auto 按存在的 API key 环境变量自动选择（先 TYPESAFE_API_KEY，再 OPENROUTER_API_KEY）。",
    "classifier.model": "JEV 模型",
    "classifier.model.description": "发送到端点的模型 ID（如 jev-latest 或 typesafe/jev-1.13）；留空使用端点默认。",
    "classifier.timeoutMs": "超时（毫秒）",
    "classifier.timeoutMs.description": "单次 JEV 调用超时；JEV 是低延迟决策模型，默认 4000。",
    "classifier.maxCallsPerSession": "每 Session 最大调用数",
    "classifier.maxCallsPerSession.description": "所有域共享的 JEV 会话预算；默认 30。",
    "classifier.domain.mode": "模式",
    "classifier.domain.description": "off：仅规则 · shadow：规则裁决，JEV 后台对照 · jev：JEV 裁决非终局结果。",
    "classifier.option.auto": "自动",
    "classifier.option.typesafe": "TypeSafe",
    "classifier.option.openrouter": "OpenRouter",
    "classifier.option.off": "关闭",
    "classifier.option.shadow": "Shadow",
    "classifier.option.jev": "JEV",
    "classifier.settings.envOverride": "分类器环境变量覆盖此设置；保存仅改变文件，不改变实际值。",
    "classifier.settings.unknownKey": "未知的分类器设置",
    "classifier.settings.invalidValue": "该分类器设置的取值无效",
    "classifier.settings.unsupportedMode": "该域不支持此模式",
    "settings.conflict": "classifier.json 已在磁盘上被修改",
  },
} as const;

function definitions(domains: readonly ClassifierDomainInfo[]): SettingDefinition[] {
  const settings: SettingDefinition[] = [
    {
      key: "classifier.enabled",
      group: "classifier.group.general",
      order: 0,
      labelKey: "classifier.enabled",
      descriptionKey: "classifier.enabled.description",
      defaultValue: false,
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "boolean" },
    },
    {
      key: "classifier.endpoint",
      group: "classifier.group.general",
      order: 1,
      labelKey: "classifier.endpoint",
      descriptionKey: "classifier.endpoint.description",
      defaultValue: "auto",
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "enum", options: ENDPOINT_OPTIONS },
    },
    {
      key: "classifier.model",
      group: "classifier.group.general",
      order: 2,
      labelKey: "classifier.model",
      descriptionKey: "classifier.model.description",
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "text", placeholderKey: "classifier.option.auto" },
    },
    {
      key: "classifier.timeoutMs",
      group: "classifier.group.general",
      order: 3,
      labelKey: "classifier.timeoutMs",
      descriptionKey: "classifier.timeoutMs.description",
      defaultValue: 4000,
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "integer", min: 500, max: 30_000, step: 500 },
    },
    {
      key: "classifier.maxCallsPerSession",
      group: "classifier.group.general",
      order: 4,
      labelKey: "classifier.maxCallsPerSession",
      descriptionKey: "classifier.maxCallsPerSession.description",
      defaultValue: 30,
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "integer", min: 1, max: 500 },
    },
  ];
  domains.forEach((domain, index) => {
    settings.push({
      key: `${DOMAIN_KEY_PREFIX}${domain.name}`,
      group: "classifier.group.domains",
      order: 100 + index,
      labelKey: `classifier.domain.${domain.name}`,
      descriptionKey: "classifier.domain.description",
      defaultValue: "off",
      scopes: ["project"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: {
        kind: "enum",
        options: DOMAIN_MODES
          .filter((mode) => domain.modes.includes(mode))
          .map((mode) => ({ value: mode, labelKey: `classifier.option.${mode}` })),
      },
    });
  });
  return settings;
}

function catalogs(domains: readonly ClassifierDomainInfo[]) {
  const en = { ...CATALOGS.en } as Record<string, string>;
  const zh = { ...CATALOGS["zh-CN"] } as Record<string, string>;
  for (const domain of domains) {
    en[`classifier.domain.${domain.name}`] = domain.name;
    zh[`classifier.domain.${domain.name}`] = domain.name;
  }
  return { en, "zh-CN": zh };
}

export function createClassifierSettingsProvider(
  options: ClassifierSettingsProviderOptions = {},
): ClassifierSettingsProvider {
  const instanceId = randomUUID();
  const getPath = options.getConfigPath ?? classifierConfigPath;
  const getDomains = options.getDomains ?? (() => []);
  const prepared = new Map<string, PreparedClassifierChange>();

  const readDocument = (cwd: string): ClassifierDocument => {
    const path = getPath(cwd);
    if (!existsSync(path)) {
      return { path, exists: false, content: "", config: normalizeClassifierConfig(undefined), revision: revision(path, "", false) };
    }
    const content = readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
      const config = normalizeClassifierConfig(raw);
      return { path, exists: true, content, raw, config, revision: revision(path, content) };
    } catch (error) {
      return {
        path,
        exists: true,
        content,
        config: normalizeClassifierConfig(undefined),
        revision: revision(path, content),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /** Map a settings key to its current normalized value. */
  const valueFor = (config: FlowClassifierConfig, key: string): JsonValue => {
    if (key === "classifier.enabled") return config.enabled;
    if (key === "classifier.endpoint") return config.endpoint ?? "auto";
    if (key === "classifier.model") return config.model ?? "";
    if (key === "classifier.timeoutMs") return config.timeoutMs ?? 4000;
    if (key === "classifier.maxCallsPerSession") return config.maxCallsPerSession ?? 30;
    if (key.startsWith(DOMAIN_KEY_PREFIX)) return config.domains[key.slice(DOMAIN_KEY_PREFIX.length)] ?? "off";
    return null;
  };

  /** Apply a change set onto a normalized config (mutation on a clone). */
  const applyChanges = (base: FlowClassifierConfig, changes: readonly SettingsChange[]): FlowClassifierConfig => {
    const next: FlowClassifierConfig = { ...base, domains: { ...base.domains } };
    for (const change of changes) {
      if (change.key === "classifier.enabled") {
        next.enabled = change.operation === "set" ? change.value === true : DEFAULT_CLASSIFIER_CONFIG.enabled;
      } else if (change.key === "classifier.endpoint") {
        const value = change.operation === "set" ? change.value : "auto";
        if (value === "typesafe" || value === "openrouter") next.endpoint = value;
        else delete next.endpoint;
      } else if (change.key === "classifier.model") {
        const value = change.operation === "set" && typeof change.value === "string" ? change.value.trim() : "";
        if (value) next.model = value;
        else delete next.model;
      } else if (change.key === "classifier.timeoutMs") {
        const value = change.operation === "set" && typeof change.value === "number" ? Math.floor(change.value) : undefined;
        if (value !== undefined) next.timeoutMs = value;
        else delete next.timeoutMs;
      } else if (change.key === "classifier.maxCallsPerSession") {
        const value = change.operation === "set" && typeof change.value === "number" ? Math.floor(change.value) : undefined;
        if (value !== undefined) next.maxCallsPerSession = value;
        else delete next.maxCallsPerSession;
      } else if (change.key.startsWith(DOMAIN_KEY_PREFIX)) {
        const name = change.key.slice(DOMAIN_KEY_PREFIX.length);
        const mode = change.operation === "set" ? change.value : "off";
        if (typeof mode === "string" && (DOMAIN_MODES as readonly string[]).includes(mode)) {
          next.domains[name] = mode as ClassifierDomainMode;
        }
      }
    }
    return next;
  };

  const snapshot = (doc: ClassifierDocument): SettingsSnapshot => {
    const domains = getDomains();
    const env = classifierEnvOverrides();
    const effectiveConfig = applyClassifierEnvOverrides(doc.config);
    const envSources: Record<string, string | undefined> = {
      "classifier.enabled": env.enabled === undefined ? undefined : CLASSIFIER_ENV_FLAG,
      "classifier.endpoint": env.endpoint === undefined ? undefined : CLASSIFIER_ENDPOINT_ENV,
      "classifier.model": env.model === undefined ? undefined : CLASSIFIER_MODEL_ENV,
    };
    const configured: ConfiguredSettingValue[] = [];
    const effective: SettingsSnapshot["effective"]["values"][number][] = [];
    for (const key of SCALAR_KEYS) {
      const value = valueFor(doc.config, key);
      const configuredValue = configuredValueFor(doc, key);
      configured.push({
        key,
        scope: "project",
        state: doc.error ? "invalid" : configuredValue === undefined ? "absent" : "set",
        ...(doc.error ? { messageKey: doc.error } : configuredValue === undefined ? {} : { value }),
        resource: doc.revision.resource,
        ...(!doc.error && envSources[key] ? { messageKey: "classifier.settings.envOverride" } : {}),
      });
      const envSource = envSources[key];
      effective.push(envSource
        ? { key, value: valueFor(effectiveConfig, key), source: "runtime", scope: "session", resource: { providerId: PROVIDER_ID, scope: "session", id: `env:${envSource}` } }
        : { key, value, source: configuredValue === undefined ? "default" : "configured", scope: "project", resource: doc.revision.resource });
    }
    for (const domain of domains) {
      const key = `${DOMAIN_KEY_PREFIX}${domain.name}`;
      const configuredValue = configuredValueFor(doc, key);
      configured.push({
        key,
        scope: "project",
        state: doc.error ? "invalid" : configuredValue === undefined ? "absent" : "set",
        ...(doc.error ? { messageKey: doc.error } : configuredValue === undefined ? {} : { value: configuredValue }),
        resource: doc.revision.resource,
      });
      effective.push({ key, value: valueFor(doc.config, key), source: configuredValue === undefined ? "default" : "configured", scope: "project", resource: doc.revision.resource });
    }
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [doc.revision] },
      effective: { values: effective },
    };
  };

  /** Whether the raw file actually carries the key (vs normalization defaults). */
  const configuredValueFor = (doc: ClassifierDocument, key: string): JsonValue | undefined => {
    if (doc.error) return undefined;
    const raw = doc.raw;
    if (!raw) return undefined;
    if (key === "classifier.enabled") return typeof raw.enabled === "boolean" ? raw.enabled : undefined;
    if (key === "classifier.endpoint") return raw.endpoint === "typesafe" || raw.endpoint === "openrouter" ? raw.endpoint : undefined;
    if (key === "classifier.model") return typeof raw.model === "string" && raw.model ? raw.model : undefined;
    if (key === "classifier.timeoutMs") return typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined;
    if (key === "classifier.maxCallsPerSession") return typeof raw.maxCallsPerSession === "number" ? raw.maxCallsPerSession : undefined;
    if (key.startsWith(DOMAIN_KEY_PREFIX)) {
      const name = key.slice(DOMAIN_KEY_PREFIX.length);
      const domains = raw.domains;
      if (!domains || typeof domains !== "object" || Array.isArray(domains)) return undefined;
      const mode = (domains as Record<string, unknown>)[name];
      return typeof mode === "string" && (DOMAIN_MODES as readonly string[]).includes(mode) ? mode as JsonValue : undefined;
    }
    return undefined;
  };

  const applyDocument = (doc: ClassifierDocument): void => {
    options.apply?.(applyClassifierEnvOverrides(doc.config), doc.config);
  };

  const restoreDocument = (entry: PreparedClassifierChange, cwd: string): ClassifierDocument => {
    assertClassifierConfigTarget(entry.path);
    if (entry.beforeExists) {
      const temporaryPath = `${entry.path}.${randomUUID()}.restore.tmp`;
      try {
        writeFileSync(temporaryPath, entry.beforeContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
        assertClassifierConfigTarget(entry.path);
        renameSync(temporaryPath, entry.path);
        entry.committedRevision = revision(entry.path, entry.beforeContent, true);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    } else {
      rmSync(entry.path, { force: true });
      entry.committedRevision = revision(entry.path, entry.beforeContent, false);
    }
    // Retry ownership is recorded before cleanup, reading or live application.
    return readDocument(cwd);
  };

  const validateChanges = (
    changes: readonly SettingsChange[],
    doc: ClassifierDocument,
    expectedRevisions?: readonly SettingsResourceRevision[],
  ): { issues: SettingsValidationIssue[]; conflicts: SettingsResourceConflict[] } => {
    const issues: SettingsValidationIssue[] = [];
    const domainInfo = new Map(getDomains().map((domain) => [domain.name, domain.modes]));
    for (const change of changes) {
      if (change.scope !== "project") {
        issues.push({ severity: "error", messageKey: "classifier.settings.invalidValue", key: change.key, scope: change.scope });
        continue;
      }
      if ((SCALAR_KEYS as readonly string[]).includes(change.key)) {
        if (change.operation === "set") {
          const bad =
            (change.key === "classifier.enabled" && typeof change.value !== "boolean")
            || (change.key === "classifier.endpoint" && !(change.value === "auto" || change.value === "typesafe" || change.value === "openrouter"))
            || (change.key === "classifier.model" && typeof change.value !== "string")
            || ((change.key === "classifier.timeoutMs" || change.key === "classifier.maxCallsPerSession")
              && (typeof change.value !== "number" || !Number.isFinite(change.value) || change.value <= 0));
          if (bad) issues.push({ severity: "error", messageKey: "classifier.settings.invalidValue", key: change.key, scope: change.scope });
        }
        continue;
      }
      if (change.key.startsWith(DOMAIN_KEY_PREFIX)) {
        const name = change.key.slice(DOMAIN_KEY_PREFIX.length);
        const modes = domainInfo.get(name);
        if (!modes) {
          issues.push({ severity: "error", messageKey: "classifier.settings.unknownKey", key: change.key, scope: change.scope });
          continue;
        }
        if (change.operation === "set") {
          const mode = change.value;
          if (typeof mode !== "string" || !(DOMAIN_MODES as readonly string[]).includes(mode)) {
            issues.push({ severity: "error", messageKey: "classifier.settings.invalidValue", key: change.key, scope: change.scope });
          } else if (!modes.includes(mode as ClassifierDomainMode)) {
            issues.push({ severity: "error", messageKey: "classifier.settings.unsupportedMode", key: change.key, scope: change.scope });
          }
        }
        continue;
      }
      issues.push({ severity: "error", messageKey: "classifier.settings.unknownKey", key: change.key, scope: change.scope });
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
      labelKey: "classifier.provider",
      descriptionKey: "classifier.provider.description",
      order: 15,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: definitions(getDomains()),
      catalogs: catalogs(getDomains()),
    }),
    read: (request) => snapshot(readDocument(request.context.cwd)),
    validate: (request) => {
      const { issues, conflicts } = validateChanges(request.changes, readDocument(request.context.cwd), request.expectedRevisions);
      return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
    },
    prepare: async (request) => {
      const cwd = request.context.cwd;
      const doc = readDocument(cwd);
      const { issues, conflicts } = validateChanges(request.changes, doc, request.expectedRevisions);
      if (issues.length > 0 || conflicts.length > 0) {
        return { prepared: false, validation: { valid: false, issues, conflicts } };
      }
      const path = getPath(cwd);
      assertClassifierConfigTarget(path);
      mkdirSync(dirname(path), { recursive: true });
      const release = await properLockfile.lock(path, {
        realpath: false, stale: 10_000, update: 2_000,
        retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      try {
        // Revalidate CAS and merge from a locked read after any lock contention.
        assertClassifierConfigTarget(path);
        const current = readDocument(cwd);
        const validation = validateChanges(request.changes, current, request.expectedRevisions);
        if (validation.issues.length > 0 || validation.conflicts.length > 0) {
          await release();
          return { prepared: false, validation: { valid: false, ...validation } };
        }
        const next = applyChanges(current.config, request.changes);
        const content = `${JSON.stringify(next, null, 2)}\n`;
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
          beforeExists: current.exists,
          changedKeys: request.changes.map((change) => change.key),
          release,
        });
        return {
          prepared: true,
          prepareToken: token,
          validation: { valid: true, issues: [] },
          activation: [{ boundary: "live", keys: request.changes.map((change) => change.key) }],
        };
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    },
    commit: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId) {
        throw new Error("prepared classifier transaction is unavailable");
      }
      let published = false;
      try {
        assertClassifierConfigTarget(state.path);
        renameSync(state.temporaryPath, state.path);
        published = true;
        const doc = readDocument(request.context.cwd);
        state.committedRevision = doc.revision;
        applyDocument(doc);
        return {
          snapshot: snapshot(doc),
          revisions: [doc.revision],
          changedKeys: state.changedKeys,
          activation: [{ boundary: "live", keys: state.changedKeys }],
        };
      } catch (error) {
        if (published) {
          try {
            const restored = restoreDocument(state, request.context.cwd);
            state.committedRevision = restored.revision;
            applyDocument(restored);
            prepared.delete(state.token);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], "classifier commit and restoration failed");
          }
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
        try { if (existsSync(entry.temporaryPath)) rmSync(entry.temporaryPath); } finally { await entry.release().catch(() => undefined); }
      }
    },
    rollback: async (request) => {
      let rolledBack = false;
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId !== request.transactionId) continue;
        // Uncommitted entries only own a staged file/lock, not the destination.
        if (!entry.committedRevision) {
          prepared.delete(token);
          try { rmSync(entry.temporaryPath, { force: true }); } finally { await entry.release().catch(() => undefined); }
          continue;
        }
        const release = await properLockfile.lock(entry.path, {
          realpath: false, stale: 10_000, update: 2_000,
          retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
        });
        try {
          const current = readDocument(request.context.cwd);
          if (entry.committedRevision && current.revision.etag !== entry.committedRevision.etag) continue;
          const restored = restoreDocument(entry, request.context.cwd);
          entry.committedRevision = restored.revision;
          applyDocument(restored);
          rolledBack = true;
          prepared.delete(token);
        } finally {
          await release();
        }
      }
      return { rolledBack, snapshot: snapshot(readDocument(request.context.cwd)) };
    },
    applyRuntime: (request) => {
      const keys = request.changes.map((change) => change.key);
      const doc = readDocument(request.context.cwd);
      // Retain rollback state if runtime publication fails.
      applyDocument(doc);
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId === request.transactionId) {
          prepared.delete(token);
          void entry.release().catch(() => undefined);
        }
      }
      return { appliedKeys: keys, deferred: [], failed: [] };
    },
    invokeAction: async () => ({ handled: false }),
  };
}

export function registerClassifierSettingsProvider(
  events: SettingsEventBus,
  provider: ClassifierSettingsProvider,
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

function revision(path: string, content: string, exists = true): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope: "project", id: RESOURCE_ID },
    etag: createHash("sha256").update(exists ? `file:${content}` : "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
