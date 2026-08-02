import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsActivation,
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
import {
  MAX_RESERVE_TOKENS,
  resolveEffectiveCompactionSettings,
  resolveProjectSettingsPath,
  resolveUserSettingsPath,
  validateEffectiveCompactionSettings,
  type CompactionConfigPatch,
  type SoftCompactionConfigPatch,
} from "../compaction/compaction-settings.ts";
import { lockSettingsResource, lockSettingsResourceSync } from "./resource-lock.ts";
import {
  getGlobalModelFailoverPath,
  getProjectModelFailoverPath,
  type ModelFailoverConfig,
} from "../providers/model-failover.ts";

const PROVIDER_ID = "pi-maestro-flow";
const PROVIDER_VERSION = "1.0.0";
const DEFAULT_PREPARED_TRANSACTION_TTL_MS = 30_000;

type WritableScope = "global" | "project";
type ResourceKind = "compaction" | "failover";
type FlowSettingsAction = (context: SettingsContextV1) => Promise<void> | void;

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface FlowSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface FlowSettingsReplacementOperations {
  platform: NodeJS.Platform;
  renameSync(source: string, destination: string): void;
}

export interface FlowSettingsProviderOptions {
  getGlobalSettingsPath?: () => string;
  getProjectSettingsPath?: (cwd: string) => string;
  getGlobalFailoverPath?: () => string;
  getProjectFailoverPath?: (cwd: string) => string;
  actions?: Readonly<Record<string, FlowSettingsAction>>;
  getAgentResponseLanguage?: () => "default" | "zh-CN";
  replacementOperations?: Partial<FlowSettingsReplacementOperations>;
  preparedTransactionTtlMs?: number;
}

interface JsonDocument {
  content: string;
  raw: Record<string, unknown>;
  error?: string;
}

interface ResourceState {
  kind: ResourceKind;
  scope: WritableScope;
  path: string;
  document: JsonDocument;
  revision: SettingsResourceRevision;
}

interface StagedResource {
  resource: ResourceState;
  temporaryPath: string;
  nextContent: string;
  release: () => Promise<void>;
  committedRevision?: SettingsResourceRevision;
}

interface PreparedFlowChange {
  token: string;
  transactionId: string;
  changedKeys: readonly string[];
  staged: StagedResource[];
  expiry?: NodeJS.Timeout;
}

interface ReplacementJournal {
  version: 1;
  destination: string;
  backup: string;
}

interface ParsedKey {
  kind: ResourceKind;
  path: readonly string[];
}

const ACTION_KEYS = [
  "compaction.manage",
  "failover.manage",
  "responseLanguage.manage",
  "permissions.manage",
  "skills.manage",
  "mcp.manage",
  "hooks.manage",
] as const;

const BASE_CATALOGS = {
  en: {
    "flow.provider": "Flow",
    "flow.provider.description": "Workflow runtime, compaction, failover and plugin-owned configuration",
    "flow.group.compaction": "Compaction",
    "flow.group.compactionSoft": "Soft compaction",
    "flow.group.failover": "Model failover",
    "flow.group.manage": "Flow management",
    "flow.compaction.enabled": "Enable compaction",
    "flow.compaction.reserveTokens": "Reserved tokens",
    "flow.compaction.keepRecentTokens": "Recent tokens to keep",
    "flow.compaction.model": "Summary model",
    "flow.compaction.soft.enabled": "Enable soft compaction",
    "flow.compaction.soft.nudgeRatio": "Nudge ratio",
    "flow.compaction.soft.pruneRatio": "Prune ratio",
    "flow.compaction.soft.pruneTargetRatio": "Prune target ratio",
    "flow.compaction.soft.velocity.enabled": "Enable velocity escalation",
    "flow.compaction.soft.velocity.epochsToCritical": "Epochs to critical",
    "flow.compaction.soft.velocity.minFullness": "Velocity minimum fullness",
    "flow.compaction.soft.cache.enabled": "Protect cached prefixes",
    "flow.failover.enabled": "Enable automatic model failover",
    "flow.failover.fallbackModels": "Fallback chains",
    "flow.action.compaction": "Open compaction control center",
    "flow.action.failover": "Open model failover control center",
    "flow.action.responseLanguage": "Agent response language",
    "flow.action.responseLanguage.description": "Independent from the Maestro Settings interface language; toggles /chinese for this session",
    "flow.option.responseLanguage.default": "Default Agent language",
    "flow.option.responseLanguage.zh-CN": "Chinese replies",
    "flow.action.permissions": "Review permissions",
    "flow.action.skills": "Manage skills",
    "flow.action.mcp": "Manage MCP servers",
    "flow.action.hooks": "Manage hooks",
    "flow.settings.unknownKey": "Unknown Flow setting",
    "flow.settings.invalidScope": "Flow settings support only global and project scopes",
    "flow.settings.invalidValue": "Invalid Flow setting value",
    "flow.settings.malformedResource": "The underlying Flow settings resource is malformed",
    "flow.settings.invalidEffective": "The resulting effective compaction settings are invalid",
  },
  "zh-CN": {
    "flow.provider": "Flow",
    "flow.provider.description": "工作流运行时、压缩、故障转移与插件自有配置",
    "flow.group.compaction": "上下文压缩",
    "flow.group.compactionSoft": "软压缩",
    "flow.group.failover": "模型故障转移",
    "flow.group.manage": "Flow 管理",
    "flow.compaction.enabled": "启用上下文压缩",
    "flow.compaction.reserveTokens": "保留 Token",
    "flow.compaction.keepRecentTokens": "保留最近 Token",
    "flow.compaction.model": "摘要模型",
    "flow.compaction.soft.enabled": "启用软压缩",
    "flow.compaction.soft.nudgeRatio": "提醒阈值",
    "flow.compaction.soft.pruneRatio": "裁剪阈值",
    "flow.compaction.soft.pruneTargetRatio": "裁剪目标阈值",
    "flow.compaction.soft.velocity.enabled": "启用速度升级",
    "flow.compaction.soft.velocity.epochsToCritical": "达到临界的轮数",
    "flow.compaction.soft.velocity.minFullness": "速度检测最小充满度",
    "flow.compaction.soft.cache.enabled": "保护缓存前缀",
    "flow.failover.enabled": "启用模型自动故障转移",
    "flow.failover.fallbackModels": "回退链",
    "flow.action.compaction": "打开压缩控制中心",
    "flow.action.failover": "打开模型故障转移控制中心",
    "flow.action.responseLanguage": "Agent 回复语言",
    "flow.action.responseLanguage.description": "与 Maestro 设置界面语言相互独立；切换本会话的 /chinese 模式",
    "flow.option.responseLanguage.default": "默认 Agent 语言",
    "flow.option.responseLanguage.zh-CN": "中文回复",
    "flow.action.permissions": "查看权限",
    "flow.action.skills": "管理 Skills",
    "flow.action.mcp": "管理 MCP 服务",
    "flow.action.hooks": "管理 Hooks",
    "flow.settings.unknownKey": "未知的 Flow 设置",
    "flow.settings.invalidScope": "Flow 设置仅支持全局和项目作用域",
    "flow.settings.invalidValue": "Flow 设置值无效",
    "flow.settings.malformedResource": "底层 Flow 设置资源格式错误",
    "flow.settings.invalidEffective": "合并后的压缩设置无效",
  },
} as const;

export function createFlowSettingsProvider(options: FlowSettingsProviderOptions = {}): FlowSettingsProvider {
  const instanceId = randomUUID();
  const getGlobalSettingsPath = options.getGlobalSettingsPath ?? resolveUserSettingsPath;
  const getProjectSettingsPath = options.getProjectSettingsPath ?? resolveProjectSettingsPath;
  const getGlobalFailoverPath = options.getGlobalFailoverPath ?? getGlobalModelFailoverPath;
  const getProjectFailoverPath = options.getProjectFailoverPath ?? getProjectModelFailoverPath;
  const replacementOperations: FlowSettingsReplacementOperations = {
    platform: options.replacementOperations?.platform ?? process.platform,
    renameSync: options.replacementOperations?.renameSync ?? fs.renameSync,
  };
  const preparedTransactionTtlMs = options.preparedTransactionTtlMs ?? DEFAULT_PREPARED_TRANSACTION_TTL_MS;
  const prepared = new Map<string, PreparedFlowChange>();

  const readAllResources = (cwd: string): ResourceState[] => {
    const read = (kind: ResourceKind, scope: WritableScope, filePath: string): ResourceState =>
      readResourceLocked(kind, scope, filePath, replacementOperations);
    return [
      read("compaction", "global", getGlobalSettingsPath()),
      read("compaction", "project", getProjectSettingsPath(cwd)),
      read("failover", "global", getGlobalFailoverPath()),
      read("failover", "project", getProjectFailoverPath(cwd)),
    ];
  };

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "flow.provider",
      descriptionKey: "flow.provider.description",
      order: 10,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: definitions(),
      catalogs: BASE_CATALOGS,
    }),
    read: (request) => snapshot(readAllResources(request.context.cwd), instanceId, options),
    validate: (request) => validateRequest(request.changes, request.expectedRevisions, readAllResources(request.context.cwd)),
    prepare: async (request) => {
      const resources = readAllResources(request.context.cwd);
      const touched = resources
        .filter((resource) => request.changes.some((change) => change.scope === resource.scope && parseSettingKey(change.key)?.kind === resource.kind))
        .sort((left, right) => left.path.localeCompare(right.path));
      const staged: StagedResource[] = [];
      try {
        for (const resource of touched) {
          const release = await lockSettingsResource(resource.path);
          const current = readResourceUnlocked(resource.kind, resource.scope, resource.path, replacementOperations);
          const changes = request.changes.filter((change) => change.scope === resource.scope && parseSettingKey(change.key)?.kind === resource.kind);
          const validation = validateRequest(changes, request.expectedRevisions, [current]);
          if (!validation.valid) {
            await release();
            await releaseStaged(staged);
            return { prepared: false, validation, conflicts: validation.conflicts };
          }
          const nextRaw = applyChanges(current.kind, current.document.raw, changes);
          const nextContent = `${JSON.stringify(nextRaw, null, 2)}\n`;
          const temporaryPath = `${resource.path}.${process.pid}.${randomUUID()}.tmp`;
          writeSyncedFile(temporaryPath, nextContent);
          staged.push({ resource: current, temporaryPath, nextContent, release });
        }
        const token = randomUUID();
        const changedKeys = request.changes.map((change) => change.key);
        const state: PreparedFlowChange = { token, transactionId: request.transactionId, changedKeys, staged };
        prepared.set(token, state);
        const expiry = setTimeout(() => {
          if (prepared.get(token) !== state || state.expiry !== expiry) return;
          state.expiry = undefined;
          prepared.delete(token);
          void releaseStaged(state.staged);
        }, preparedTransactionTtlMs);
        expiry.unref();
        state.expiry = expiry;
        return {
          prepared: true,
          prepareToken: token,
          validation: { valid: true, issues: [] },
          activation: activationPlans(changedKeys),
        };
      } catch (error) {
        await releaseStaged(staged);
        throw error;
      }
    },
    commit: async (request) => {
      const state = requirePrepared(prepared, request.prepareToken, request.transactionId);
      cancelPreparedExpiry(state);
      const replacementStarted: StagedResource[] = [];
      try {
        for (const staged of state.staged) {
          const current = readResourceUnlocked(staged.resource.kind, staged.resource.scope, staged.resource.path, replacementOperations);
          if (current.revision.etag !== staged.resource.revision.etag) {
            throw new Error(`Flow settings resource changed after prepare: ${staged.resource.revision.resource.id}`);
          }
        }
        for (const staged of state.staged) {
          replacementStarted.push(staged);
          replaceFile(staged.temporaryPath, staged.resource.path, replacementOperations);
          staged.committedRevision = revision(staged.resource.kind, staged.resource.scope, staged.resource.path, staged.nextContent);
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const staged of [...replacementStarted].reverse()) {
          try {
            restoreResource(staged.resource, replacementOperations);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const staged of state.staged) {
          try { fs.rmSync(staged.temporaryPath, { force: true }); } catch { /* best effort */ }
        }
        prepared.delete(request.prepareToken);
        if (rollbackErrors.length) {
          throw new AggregateError([error, ...rollbackErrors], "Flow settings commit failed and rollback was incomplete");
        }
        throw error;
      } finally {
        await Promise.all(state.staged.map((entry) => entry.release().catch(() => undefined)));
      }
      const resources = readAllResources(request.context.cwd);
      return {
        snapshot: snapshot(resources, instanceId, options),
        revisions: resources.map((entry) => entry.revision),
        changedKeys: state.changedKeys,
        activation: activationPlans(state.changedKeys),
      };
    },
    abort: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state) return;
      if (state.transactionId !== request.transactionId) {
        throw new Error("prepared Flow settings transaction is unavailable");
      }
      cancelPreparedExpiry(state);
      prepared.delete(request.prepareToken);
      await releaseStaged(state.staged);
    },
    rollback: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId) return { rolledBack: false };
      cancelPreparedExpiry(state);
      // A transaction that never committed successfully has no committedRevision, so restoring
      // staged resources would overwrite any external write made after prepare. Consume it without
      // touching the destination files.
      if (!state.staged.every((entry) => entry.committedRevision)) {
        prepared.delete(request.prepareToken);
        await releaseStaged(state.staged);
        return { rolledBack: false };
      }
      const locked: Array<{ staged: StagedResource; release: () => Promise<void> }> = [];
      try {
        for (const staged of [...state.staged].sort((left, right) => left.resource.path.localeCompare(right.resource.path))) {
          const release = await lockSettingsResource(staged.resource.path);
          locked.push({ staged, release });
          const current = readResourceUnlocked(staged.resource.kind, staged.resource.scope, staged.resource.path, replacementOperations);
          if (staged.committedRevision && current.revision.etag !== staged.committedRevision.etag) {
            return { rolledBack: false, conflicts: [resourceConflict(current.revision, staged.committedRevision.etag)] };
          }
        }
        for (const { staged } of locked) restoreResource(staged.resource, replacementOperations);
        prepared.delete(request.prepareToken);
        await Promise.all(locked.map((entry) => entry.release()));
        locked.length = 0;
        const resources = readAllResources(request.context.cwd);
        return { rolledBack: true, snapshot: snapshot(resources, instanceId, options) };
      } finally {
        await Promise.all(locked.map((entry) => entry.release().catch(() => undefined)));
      }
    },
    applyRuntime: (request) => {
      const state = [...prepared.values()].find((entry) => entry.transactionId === request.transactionId);
      if (state) {
        cancelPreparedExpiry(state);
        prepared.delete(state.token);
        if (!state.staged.every((entry) => entry.committedRevision)) void releaseStaged(state.staged);
      }
      return { appliedKeys: [], deferred: activationPlans(request.changes.map((change) => change.key)), failed: [] };
    },
    invokeAction: async (request) => {
      const action = options.actions?.[request.actionId];
      if (!action) return { handled: false };
      await action(request.context);
      return {
        handled: true,
        refresh: request.actionId === "compaction.manage"
          || request.actionId === "failover.manage"
          || request.actionId === "responseLanguage.manage",
      };
    },
  };
}

export function registerFlowSettingsProvider(events: SettingsEventBus, provider: FlowSettingsProvider): () => void {
  const announce = (requestId?: string): void => {
    events.emit(SETTINGS_ANNOUNCE_EVENT, {
      version: SETTINGS_PROTOCOL_VERSION,
      requestId,
      providerId: provider.providerId,
      instanceId: provider.instanceId,
      provider,
    } satisfies SettingsAnnounceEventV1);
  };
  const result = events.on(SETTINGS_DISCOVER_EVENT, (payload) => {
    if (isDiscover(payload)) announce(payload.requestId);
  });
  announce();
  return () => { if (typeof result === "function") result(); };
}

function definitions(): SettingDefinition[] {
  const writable: SettingDefinition[] = [
    setting("compaction.enabled", "flow.group.compaction", "flow.compaction.enabled", "boolean", true, "next-turn"),
    setting("compaction.reserveTokens", "flow.group.compaction", "flow.compaction.reserveTokens", "integer", 16_384, "next-turn", { min: 1, max: MAX_RESERVE_TOKENS, step: 1024 }),
    setting("compaction.keepRecentTokens", "flow.group.compaction", "flow.compaction.keepRecentTokens", "integer", 20_000, "next-turn", { min: 1, max: MAX_RESERVE_TOKENS, step: 1024 }),
    setting("compaction.model", "flow.group.compaction", "flow.compaction.model", "model", null, "next-turn", { optionsSource: "flow.available-models" }),
    setting("compaction.soft.enabled", "flow.group.compactionSoft", "flow.compaction.soft.enabled", "boolean", true, "next-turn"),
    setting("compaction.soft.nudgeRatio", "flow.group.compactionSoft", "flow.compaction.soft.nudgeRatio", "number", 0.7, "next-turn", { min: 0.01, max: 0.99, step: 0.01 }),
    setting("compaction.soft.pruneRatio", "flow.group.compactionSoft", "flow.compaction.soft.pruneRatio", "number", 0.8, "next-turn", { min: 0.01, max: 0.99, step: 0.01 }),
    setting("compaction.soft.pruneTargetRatio", "flow.group.compactionSoft", "flow.compaction.soft.pruneTargetRatio", "number", 0.7, "next-turn", { min: 0.01, max: 0.99, step: 0.01 }),
    setting("compaction.soft.velocity.enabled", "flow.group.compactionSoft", "flow.compaction.soft.velocity.enabled", "boolean", false, "next-turn"),
    setting("compaction.soft.velocity.epochsToCritical", "flow.group.compactionSoft", "flow.compaction.soft.velocity.epochsToCritical", "integer", 3, "next-turn", { min: 1, step: 1 }),
    setting("compaction.soft.velocity.minFullness", "flow.group.compactionSoft", "flow.compaction.soft.velocity.minFullness", "number", 0.7, "next-turn", { min: 0.01, max: 0.99, step: 0.01 }),
    setting("compaction.soft.cache.enabled", "flow.group.compactionSoft", "flow.compaction.soft.cache.enabled", "boolean", true, "next-turn"),
    setting("failover.enabled", "flow.group.failover", "flow.failover.enabled", "boolean", false, "next-invocation"),
    setting("failover.fallbackModels", "flow.group.failover", "flow.failover.fallbackModels", "json", {}, "next-invocation", { multiline: true }, "deep-merge"),
  ];
  return [...writable, ...ACTION_KEYS.map((key, index): SettingDefinition => ({
    key,
    group: "flow.group.manage",
    order: 100 + index,
    labelKey: `flow.action.${key.split(".")[0]}`,
    ...(key === "responseLanguage.manage" ? { descriptionKey: "flow.action.responseLanguage.description" } : {}),
    scopes: ["project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "action",
      actionId: key,
      ...(key === "responseLanguage.manage" ? {
        options: [
          { value: "default", labelKey: "flow.option.responseLanguage.default" },
          { value: "zh-CN", labelKey: "flow.option.responseLanguage.zh-CN" },
        ],
      } : {}),
    },
  }))];
}

function setting(
  key: string,
  group: string,
  labelKey: string,
  kind: "boolean" | "integer" | "number" | "model" | "json",
  defaultValue: JsonValue,
  activation: SettingsActivation,
  editor: Omit<SettingDefinition["editor"], "kind"> = {},
  merge: SettingDefinition["merge"] = "override",
): SettingDefinition {
  return {
    key,
    group,
    labelKey,
    defaultValue,
    scopes: ["global", "project"],
    merge,
    activation,
    sensitivity: "public",
    reversibility: "full",
    editor: { kind, ...editor },
  };
}

function snapshot(
  resources: readonly ResourceState[],
  instanceId: string,
  options: Pick<FlowSettingsProviderOptions, "getAgentResponseLanguage"> = {},
): SettingsSnapshot {
  const configured: ConfiguredSettingValue[] = [];
  const effective: SettingsSnapshot["effective"]["values"][number][] = [];
  const compaction = resources.filter((entry) => entry.kind === "compaction");
  const failover = resources.filter((entry) => entry.kind === "failover");
  const compactionPatches = new Map(compaction.map((entry) => [entry.scope, readCompactionPatch(entry.document.raw)]));
  const effectiveCompaction = resolveEffectiveCompactionSettings(compactionPatches.get("global") ?? {}, compactionPatches.get("project") ?? {});

  for (const definition of definitions()) {
    const parsed = parseSettingKey(definition.key);
    if (!parsed) {
      configured.push({ key: definition.key, scope: "project", state: "absent" });
      effective.push({
        key: definition.key,
        value: definition.key === "responseLanguage.manage" ? options.getAgentResponseLanguage?.() ?? "default" : "open",
        source: "runtime",
      });
      continue;
    }
    const relevant = parsed.kind === "compaction" ? compaction : failover;
    for (const resource of relevant) {
      const value = readConfiguredValue(resource.document.raw, parsed);
      configured.push({
        key: definition.key,
        scope: resource.scope,
        state: resource.document.error ? "invalid" : value.present ? "set" : "absent",
        ...(value.present ? { value: value.value } : {}),
        resource: resource.revision.resource,
        ...(resource.document.error ? { messageKey: "flow.settings.malformedResource" } : {}),
      });
    }
    if (parsed.kind === "compaction") {
      const value = readPath(effectiveCompaction as unknown as Record<string, unknown>, parsed.path);
      const projectValue = readPath(compactionPatches.get("project") as unknown as Record<string, unknown> ?? {}, parsed.path);
      const globalValue = readPath(compactionPatches.get("global") as unknown as Record<string, unknown> ?? {}, parsed.path);
      const source: WritableScope | undefined = projectValue !== undefined ? "project" : globalValue !== undefined ? "global" : undefined;
      const resource = source ? relevant.find((entry) => entry.scope === source) : undefined;
      effective.push({
        key: definition.key,
        value: toJsonValue(value),
        source: source ? "configured" : "default",
        ...(source ? { scope: source, resource: resource?.revision.resource } : {}),
      });
    } else {
      const globalValue = readConfiguredValue(failover.find((entry) => entry.scope === "global")?.document.raw ?? {}, parsed);
      const projectValue = readConfiguredValue(failover.find((entry) => entry.scope === "project")?.document.raw ?? {}, parsed);
      const selected = parsed.path[0] === "fallbackModels"
        ? mergedFallbackValue(globalValue, projectValue)
        : projectValue.present ? { ...projectValue, scope: "project" as const } : globalValue.present ? { ...globalValue, scope: "global" as const } : undefined;
      const resource = selected?.scope ? failover.find((entry) => entry.scope === selected.scope) : undefined;
      effective.push({
        key: definition.key,
        value: selected?.value ?? definition.defaultValue ?? null,
        source: selected ? "configured" : "default",
        ...(selected?.scope ? { scope: selected.scope, resource: resource?.revision.resource } : {}),
      });
    }
  }
  return {
    providerId: PROVIDER_ID,
    providerInstanceId: instanceId,
    configured: { values: configured, resources: resources.map((entry) => entry.revision) },
    effective: { values: effective },
  };
}

function validateRequest(
  changes: readonly SettingsChange[],
  expectedRevisions: readonly SettingsResourceRevision[] | undefined,
  resources: readonly ResourceState[],
): { valid: boolean; issues: SettingsValidationIssue[]; conflicts: SettingsResourceConflict[] } {
  const issues: SettingsValidationIssue[] = [];
  const conflicts: SettingsResourceConflict[] = [];
  for (const resource of resources) {
    const expected = expectedRevisions?.find((entry) => entry.resource.id === resource.revision.resource.id);
    if (expected && expected.etag !== resource.revision.etag) conflicts.push(resourceConflict(resource.revision, expected.etag));
    if (resource.document.error && changes.some((change) => change.scope === resource.scope && parseSettingKey(change.key)?.kind === resource.kind)) {
      issues.push({ severity: "error", messageKey: "flow.settings.malformedResource", scope: resource.scope });
    }
  }
  for (const change of changes) {
    const parsed = parseSettingKey(change.key);
    if (!parsed) {
      issues.push(issue(change, "flow.settings.unknownKey"));
      continue;
    }
    if (change.scope !== "global" && change.scope !== "project") {
      issues.push(issue(change, "flow.settings.invalidScope"));
      continue;
    }
    if (change.operation === "set" && !validValue(change.key, change.value)) issues.push(issue(change, "flow.settings.invalidValue"));
  }
  const compactionResources = resources.filter((entry) => entry.kind === "compaction");
  const patches = new Map(compactionResources.map((entry) => [entry.scope, readCompactionPatch(entry.document.raw)]));
  for (const scope of ["global", "project"] as const) {
    const scoped = changes.filter((change) => change.scope === scope && parseSettingKey(change.key)?.kind === "compaction");
    if (scoped.length) patches.set(scope, readCompactionPatch(applyChanges("compaction", compactionResources.find((entry) => entry.scope === scope)?.document.raw ?? {}, scoped)));
  }
  const effectiveValidation = validateEffectiveCompactionSettings(resolveEffectiveCompactionSettings(patches.get("global") ?? {}, patches.get("project") ?? {}));
  for (const error of effectiveValidation.errors) {
    issues.push({ severity: "error", messageKey: "flow.settings.invalidEffective", params: { reason: error } });
  }
  return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
}

function parseSettingKey(key: string): ParsedKey | undefined {
  if (key === "compaction.enabled") return { kind: "compaction", path: ["enabled"] };
  if (key === "compaction.reserveTokens") return { kind: "compaction", path: ["reserveTokens"] };
  if (key === "compaction.keepRecentTokens") return { kind: "compaction", path: ["keepRecentTokens"] };
  if (key === "compaction.model") return { kind: "compaction", path: ["model"] };
  if (key.startsWith("compaction.soft.")) return { kind: "compaction", path: key.slice("compaction.".length).split(".") };
  if (key === "failover.enabled") return { kind: "failover", path: ["enabled"] };
  if (key === "failover.fallbackModels") return { kind: "failover", path: ["fallbackModels"] };
  return undefined;
}

function validValue(key: string, value: JsonValue): boolean {
  if (key === "compaction.enabled" || key.endsWith(".enabled") || key === "failover.enabled") return typeof value === "boolean";
  if (key === "compaction.reserveTokens" || key === "compaction.keepRecentTokens") {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_RESERVE_TOKENS;
  }
  if (key.endsWith("epochsToCritical")) return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (key === "compaction.model") return value === null || (typeof value === "string" && (value.trim() === "" || value.includes("/")));
  if (key.endsWith("Ratio") || key.endsWith("minFullness")) return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
  if (key === "failover.fallbackModels") return isFallbackMap(value);
  return false;
}

function readResourceUnlocked(
  kind: ResourceKind,
  scope: WritableScope,
  filePath: string,
  operations: FlowSettingsReplacementOperations,
): ResourceState {
  if (operations.platform === "win32") recoverInterruptedReplacement(filePath, operations);
  const document = readJsonDocument(filePath);
  return { kind, scope, path: filePath, document, revision: revision(kind, scope, filePath, document.content) };
}

function readResourceLocked(
  kind: ResourceKind,
  scope: WritableScope,
  filePath: string,
  operations: FlowSettingsReplacementOperations,
): ResourceState {
  const release = lockSettingsResourceSync(filePath);
  try {
    return readResourceUnlocked(kind, scope, filePath, operations);
  } finally {
    release();
  }
}

function readJsonDocument(filePath: string): JsonDocument {
  if (!fs.existsSync(filePath)) return { content: "", raw: {} };
  const content = fs.readFileSync(filePath, "utf8");
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return { content, raw: {}, error: "expected a JSON object" };
    return { content, raw: parsed };
  } catch (error) {
    return { content, raw: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function revision(kind: ResourceKind, scope: WritableScope, filePath: string, content: string): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope, id: `${scope}:${kind}:${path.basename(filePath)}` },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function readConfiguredValue(raw: Record<string, unknown>, parsed: ParsedKey): { present: boolean; value?: JsonValue } {
  if (parsed.kind === "compaction") {
    const patch = readCompactionPatch(raw);
    const value = readPath(patch as unknown as Record<string, unknown>, parsed.path);
    return value === undefined ? { present: false } : { present: true, value: toJsonValue(value) };
  }
  const value = readPath(raw, parsed.path);
  if (value === undefined) return { present: false };
  if (parsed.path[0] === "fallbackModels") return { present: true, value: isFallbackMap(value) ? value : null };
  return { present: true, value: toJsonValue(value) };
}

function readCompactionPatch(root: Record<string, unknown>): CompactionConfigPatch {
  const raw = isRecord(root.compaction) ? root.compaction : {};
  const hard = isRecord(raw.hard) ? raw.hard : {};
  const softRaw = isRecord(raw.soft) ? raw.soft : {};
  const velocityRaw = isRecord(softRaw.velocity) ? softRaw.velocity : {};
  const cacheRaw = isRecord(softRaw.cache) ? softRaw.cache : {};
  const patch: CompactionConfigPatch = {};
  if (typeof raw.enabled === "boolean") patch.enabled = raw.enabled;
  const reserve = positiveNumber(hard.reserveTokens) ?? positiveNumber(raw.reserveTokens);
  if (reserve !== undefined && reserve <= MAX_RESERVE_TOKENS) patch.reserveTokens = reserve;
  const keepRecent = positiveNumber(hard.keepRecentTokens) ?? positiveNumber(raw.keepRecentTokens);
  if (keepRecent !== undefined) patch.keepRecentTokens = keepRecent;
  if (typeof raw.model === "string" && raw.model.trim()) patch.model = raw.model.trim();
  const soft: SoftCompactionConfigPatch = {};
  if (typeof softRaw.enabled === "boolean") soft.enabled = softRaw.enabled;
  for (const field of ["nudgeRatio", "pruneRatio", "pruneTargetRatio"] as const) {
    if (ratio(softRaw[field]) !== undefined) soft[field] = softRaw[field] as number;
  }
  const velocity: NonNullable<SoftCompactionConfigPatch["velocity"]> = {};
  if (typeof velocityRaw.enabled === "boolean") velocity.enabled = velocityRaw.enabled;
  if (Number.isSafeInteger(velocityRaw.epochsToCritical) && (velocityRaw.epochsToCritical as number) > 0) velocity.epochsToCritical = velocityRaw.epochsToCritical as number;
  if (ratio(velocityRaw.minFullness) !== undefined) velocity.minFullness = velocityRaw.minFullness as number;
  if (Object.keys(velocity).length) soft.velocity = velocity;
  if (typeof cacheRaw.enabled === "boolean") soft.cache = { enabled: cacheRaw.enabled };
  if (Object.keys(soft).length) patch.soft = soft;
  return patch;
}

function applyChanges(kind: ResourceKind, raw: Record<string, unknown>, changes: readonly SettingsChange[]): Record<string, unknown> {
  const root = structuredClone(raw);
  if (kind === "failover") {
    for (const change of changes) {
      const parsed = parseSettingKey(change.key);
      if (!parsed) continue;
      setOrUnsetPath(root, parsed.path, change);
    }
    return root;
  }
  const compaction = isRecord(root.compaction) ? structuredClone(root.compaction) : {};
  for (const change of changes) {
    const parsed = parseSettingKey(change.key);
    if (!parsed) continue;
    if (parsed.path[0] === "reserveTokens" || parsed.path[0] === "keepRecentTokens") {
      const hard = isRecord(compaction.hard) ? structuredClone(compaction.hard) : {};
      if (change.operation === "unset") {
        delete hard[parsed.path[0]];
        delete compaction[parsed.path[0]];
      } else hard[parsed.path[0]] = change.value;
      if (Object.keys(hard).length) compaction.hard = hard;
      else delete compaction.hard;
    } else if (parsed.path[0] === "soft") {
      setOrUnsetPath(compaction, parsed.path, change);
    } else if (change.operation === "unset" || (parsed.path[0] === "model" && change.value === null)) {
      delete compaction[parsed.path[0]];
    } else compaction[parsed.path[0]] = change.value;
  }
  if (Object.keys(compaction).length) root.compaction = compaction;
  else delete root.compaction;
  return root;
}

function setOrUnsetPath(root: Record<string, unknown>, segments: readonly string[], change: SettingsChange): void {
  const parents: Record<string, unknown>[] = [root];
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next = isRecord(cursor[segment]) ? structuredClone(cursor[segment] as Record<string, unknown>) : {};
    cursor[segment] = next;
    cursor = next;
    parents.push(cursor);
  }
  const leaf = segments.at(-1)!;
  if (change.operation === "unset") {
    delete cursor[leaf];
    for (let index = parents.length - 1; index > 0; index -= 1) {
      if (Object.keys(parents[index]).length) break;
      delete parents[index - 1][segments[index - 1]];
    }
  } else cursor[leaf] = change.value;
}

function mergedFallbackValue(
  globalValue: { present: boolean; value?: JsonValue },
  projectValue: { present: boolean; value?: JsonValue },
): { present: boolean; value: JsonValue; scope: WritableScope } | undefined {
  if (!globalValue.present && !projectValue.present) return undefined;
  const globalMap = isRecord(globalValue.value) ? globalValue.value : {};
  const projectMap = isRecord(projectValue.value) ? projectValue.value : {};
  return { present: true, value: { ...globalMap, ...projectMap } as JsonValue, scope: projectValue.present ? "project" : "global" };
}

function activationPlans(keys: readonly string[]): SettingsActivationPlan[] {
  const compaction = [...new Set(keys.filter((key) => key.startsWith("compaction.")))];
  const failover = [...new Set(keys.filter((key) => key.startsWith("failover.")))];
  return [
    ...(compaction.length ? [{ boundary: "next-turn" as const, keys: compaction }] : []),
    ...(failover.length ? [{ boundary: "next-invocation" as const, keys: failover }] : []),
  ];
}

function writeSyncedFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreResource(resource: ResourceState, operations: FlowSettingsReplacementOperations): void {
  if (resource.document.content === "") {
    fs.rmSync(resource.path, { force: true });
    return;
  }
  const temporaryPath = `${resource.path}.${process.pid}.${randomUUID()}.rollback`;
  try {
    writeSyncedFile(temporaryPath, resource.document.content);
    replaceFile(temporaryPath, resource.path, operations);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
  }
}

function replaceFile(
  source: string,
  destination: string,
  operations: FlowSettingsReplacementOperations,
): void {
  if (operations.platform === "win32") recoverInterruptedReplacement(destination, operations);
  try {
    operations.renameSync(source, destination);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (operations.platform === "win32" && ["EEXIST", "EPERM", "ENOTEMPTY"].includes(code)) {
      replaceFileOnWindows(source, destination, operations);
      return;
    }
    throw error;
  }
}

function replaceFileOnWindows(
  source: string,
  destination: string,
  operations: FlowSettingsReplacementOperations,
): void {
  const journalPath = replacementJournalPath(destination);
  const backupPath = `${destination}.${process.pid}.${randomUUID()}.backup`;
  const journal: ReplacementJournal = { version: 1, destination, backup: backupPath };
  writeSyncedFile(journalPath, `${JSON.stringify(journal)}\n`);
  let backupCreated = false;
  try {
    operations.renameSync(destination, backupPath);
    backupCreated = true;
    try {
      operations.renameSync(source, destination);
    } catch (installError) {
      try {
        operations.renameSync(backupPath, destination);
        backupCreated = false;
        fs.rmSync(journalPath, { force: true });
      } catch (restoreError) {
        throw new AggregateError(
          [installError, restoreError],
          `Could not install or restore Flow settings resource ${destination}`,
        );
      }
      throw installError;
    }
    fs.rmSync(backupPath, { force: true });
    backupCreated = false;
    fs.rmSync(journalPath, { force: true });
  } catch (error) {
    if (!backupCreated) {
      try { fs.rmSync(journalPath, { force: true }); } catch { /* best effort */ }
    }
    throw error;
  }
}

function recoverInterruptedReplacement(
  destination: string,
  operations: FlowSettingsReplacementOperations,
): void {
  const journalPath = replacementJournalPath(destination);
  if (!fs.existsSync(journalPath)) return;
  const journal = readReplacementJournal(journalPath, destination);
  if (fs.existsSync(destination)) {
    fs.rmSync(journal.backup, { force: true });
  } else if (fs.existsSync(journal.backup)) {
    operations.renameSync(journal.backup, destination);
  } else {
    throw new Error(`Cannot recover interrupted Flow settings replacement for ${destination}`);
  }
  fs.rmSync(journalPath, { force: true });
}

function readReplacementJournal(journalPath: string, destination: string): ReplacementJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Flow settings replacement journal ${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)
    || parsed.version !== 1
    || parsed.destination !== destination
    || typeof parsed.backup !== "string"
    || path.dirname(parsed.backup) !== path.dirname(destination)
    || !path.basename(parsed.backup).startsWith(`${path.basename(destination)}.`)
    || !parsed.backup.endsWith(".backup")) {
    throw new Error(`Invalid Flow settings replacement journal ${journalPath}`);
  }
  return parsed as unknown as ReplacementJournal;
}

function replacementJournalPath(destination: string): string {
  return `${destination}.replace-journal`;
}

async function releaseStaged(staged: readonly StagedResource[]): Promise<void> {
  for (const entry of [...staged].reverse()) {
    try { fs.rmSync(entry.temporaryPath, { force: true }); } catch { /* best effort */ }
    await entry.release().catch(() => undefined);
  }
}

function resourceConflict(actual: SettingsResourceRevision, expectedEtag: string): SettingsResourceConflict {
  return { resource: actual.resource, expectedEtag, actualEtag: actual.etag, messageKey: "settings.conflict" };
}

function issue(change: SettingsChange, messageKey: string): SettingsValidationIssue {
  return { severity: "error", messageKey, key: change.key, scope: change.scope };
}

function cancelPreparedExpiry(state: PreparedFlowChange): void {
  if (!state.expiry) return;
  clearTimeout(state.expiry);
  state.expiry = undefined;
}

function requirePrepared(prepared: Map<string, PreparedFlowChange>, token: string, transactionId: string): PreparedFlowChange {
  const state = prepared.get(token);
  if (!state || state.transactionId !== transactionId) throw new Error("prepared Flow settings transaction is unavailable");
  return state;
}

function readPath(root: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function ratio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function isFallbackMap(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.entries(value).every(([model, fallbacks]) =>
    model.includes("/") && Array.isArray(fallbacks) && fallbacks.every((entry) => typeof entry === "string" && entry.includes("/") && entry !== model));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
