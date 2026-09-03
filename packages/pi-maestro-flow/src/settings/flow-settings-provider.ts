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
  type SettingsOverviewRow,
} from "pi-maestro-settings-core/v1";
import {
  DEFAULT_NEW_CONTEXT_ENABLED,
  MAX_RESERVE_TOKENS,
  resolveEffectiveCompactionSettings,
  resolveProjectSettingsPath,
  resolveUserSettingsPath,
  validateEffectiveCompactionSettings,
  type CompactionConfigPatch,
  type EffectiveCompactionSettings,
  type SoftCompactionConfigPatch,
} from "../compaction/compaction-settings.ts";
import { DEFAULT_DEDUP_MIN_CHARS, DEFAULT_DEDUP_MIN_LINES } from "../compaction/dedup.ts";
import { lockSettingsResource, lockSettingsResourceSync } from "./resource-lock.ts";
import { fsyncDirectorySync } from "./durable-write.ts";
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
type FlowSettingsAction = (context: SettingsContextV1) => Promise<string | void> | string | void;

export interface PermissionOverview {
  mode: string;
  allow: readonly string[];
  ask: readonly string[];
  deny: readonly string[];
  sources: string;
}

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
  getPermissionOverview?: () => PermissionOverview | undefined;
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
  "responseLanguage.manage",
] as const;

/** Read-only diagnostic views rendered by the settings shell. */
const OVERVIEW_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "compaction.derived",
    group: "flow.group.compaction",
    order: 60,
    labelKey: "flow.compaction.derived",
    descriptionKey: "flow.compaction.derived.description",
    scopes: ["global", "project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "public",
    reversibility: "none",
    editor: { kind: "overview" },
  },
  {
    key: "failover.overview",
    group: "flow.group.failover",
    order: 61,
    labelKey: "flow.failover.overview",
    descriptionKey: "flow.failover.overview.description",
    scopes: ["global", "project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "public",
    reversibility: "none",
    editor: { kind: "overview" },
  },
  {
    key: "flow.permissions",
    group: "flow.group.permissions",
    order: 62,
    labelKey: "flow.permissions",
    descriptionKey: "flow.permissions.description",
    scopes: ["project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  },
];

const BASE_CATALOGS = {
  en: {
    "flow.provider": "Flow",
    "flow.provider.description": "Workflow runtime, compaction, failover and plugin-owned configuration",
    "flow.group.compaction": "Compaction",
    "flow.group.compactionSoft": "Soft compaction",
    "flow.group.failover": "Model failover",
    "flow.group.manage": "Flow management",
    "flow.compaction.enabled": "Enable compaction",
    "flow.compaction.newContext.enabled": "New Context",
    "flow.compaction.newContext.enabled.description": "Enabled by default. At a completed Todo checkpoint, Space toggles the global or project override; Ctrl+S applies it for the next Agent turn.",
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
    "flow.compaction.soft.cache.minRatioRange": "Cache savings gate range",
    "flow.compaction.soft.timeBased.enabled": "Enable time-based gate bypass",
    "flow.compaction.soft.timeBased.gapThresholdMinutes": "Cache-cold gap threshold (minutes)",
    "flow.compaction.soft.relevance.enabled": "Enable relevance ordering",
    "flow.compaction.soft.relevance.mode": "Relevance mode",
    "flow.compaction.soft.crossTurnDedup.enabled": "Enable cross-turn deduplication",
    "flow.compaction.soft.crossTurnDedup.minLines": "Dedup minimum lines",
    "flow.compaction.soft.crossTurnDedup.minChars": "Dedup minimum characters",
    "flow.compaction.soft.lossless.enabled": "Enable lossless folding",
    "flow.option.relevanceMode.bm25": "BM25 lexical ranking",
    "flow.option.relevanceMode.keyword": "Keyword scoring",
    "flow.failover.enabled": "Enable automatic model failover",
    "flow.failover.fallbackModels": "Fallback chains",
    "flow.failover.fallbackModels.add": "Add chain",
    "flow.failover.fallbackModels.item": "{model}",
    "flow.failover.field.model": "Model",
    "flow.failover.field.fallbacks": "Fallback models",
    "flow.action.compaction": "Open compaction settings",
    "flow.action.compaction.description": "Opens the full compaction control center; changes save to global or project settings",
    "flow.action.failover": "Open model failover settings",
    "flow.action.failover.description": "Opens the two-pane failover chain editor; changes apply to the next invocation",
    "flow.action.responseLanguage": "Agent response language",
    "flow.action.responseLanguage.description": "Independent from the Maestro Settings interface language; toggles /chinese for this session",
    "flow.option.responseLanguage.default": "Default Agent language",
    "flow.option.responseLanguage.zh-CN": "Chinese replies",
    "flow.group.permissions": "Permissions",
    "flow.permissions": "Permission rules",
    "flow.permissions.description": "Read-only view of the current permission mode, rules and config sources",
    "flow.permissions.mode": "Mode",
    "flow.permissions.allow": "Allow",
    "flow.permissions.ask": "Ask",
    "flow.permissions.deny": "Deny",
    "flow.permissions.sources": "Sources",
    "flow.action.skills": "Manage skills",
    "flow.action.skills.description": "Enables or disables skills and model-invocation rights; changes apply after the extension reloads",
    "flow.action.mcp": "Manage MCP servers",
    "flow.action.mcp.description": "Adds, edits, toggles or deletes MCP servers, or edits the full JSON configuration",
    "flow.action.hooks": "Manage hooks",
    "flow.action.hooks.description": "Reviews and manages the codex hooks configuration",
    "flow.compaction.derived": "Derived threshold preview",
    "flow.compaction.derived.description": "Read-only view of the effective thresholds and soft-stage reachability",
    "flow.failover.overview": "Failover chains",
    "flow.failover.overview.description": "Read-only view of the enabled failover chains",
    "flow.overview.enabled": "Enabled",
    "flow.overview.reserve": "Reserved tokens",
    "flow.overview.keep": "Recent tokens kept",
    "flow.overview.model": "Compaction model",
    "flow.overview.newContext": "Explicit new-context mode",
    "flow.overview.soft": "Soft stage",
    "flow.overview.chains": "Fallback chains",
    "flow.overview.noChains": "No fallback chains configured",
    "flow.overview.followsSession": "follows the session model",
    "flow.overview.off": "Off",
    "flow.overview.on": "On",
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
    "flow.compaction.newContext.enabled": "New Context",
    "flow.compaction.newContext.enabled.description": "默认开启。在已完成的 Todo 检查点，可用空格切换全局或项目覆盖，Ctrl+S 保存并在下一 Agent turn 生效。",
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
    "flow.compaction.soft.cache.minRatioRange": "缓存节省门限区间",
    "flow.compaction.soft.timeBased.enabled": "启用基于时间的门限绕过",
    "flow.compaction.soft.timeBased.gapThresholdMinutes": "缓存冷门限（分钟）",
    "flow.compaction.soft.relevance.enabled": "启用相关性排序",
    "flow.compaction.soft.relevance.mode": "相关性模式",
    "flow.compaction.soft.crossTurnDedup.enabled": "启用跨轮去重",
    "flow.compaction.soft.crossTurnDedup.minLines": "去重最小行数",
    "flow.compaction.soft.crossTurnDedup.minChars": "去重最小字符数",
    "flow.compaction.soft.lossless.enabled": "启用无损折叠",
    "flow.option.relevanceMode.bm25": "BM25 词法排序",
    "flow.option.relevanceMode.keyword": "关键词评分",
    "flow.failover.enabled": "启用模型自动故障转移",
    "flow.failover.fallbackModels": "回退链",
    "flow.failover.fallbackModels.add": "添加链",
    "flow.failover.fallbackModels.item": "{model}",
    "flow.failover.field.model": "模型",
    "flow.failover.field.fallbacks": "回退模型",
    "flow.action.compaction": "打开压缩设置",
    "flow.action.compaction.description": "打开完整压缩控制中心；更改保存到全局或项目设置",
    "flow.action.failover": "打开模型故障转移设置",
    "flow.action.failover.description": "打开主备故障转移链编辑器；更改在下一次调用时生效",
    "flow.action.responseLanguage": "Agent 回复语言",
    "flow.action.responseLanguage.description": "与 Maestro 设置界面语言相互独立；切换本会话的 /chinese 模式",
    "flow.option.responseLanguage.default": "默认 Agent 语言",
    "flow.option.responseLanguage.zh-CN": "中文回复",
    "flow.group.permissions": "权限",
    "flow.permissions": "权限规则",
    "flow.permissions.description": "只读展示当前权限模式、规则与配置来源",
    "flow.permissions.mode": "模式",
    "flow.permissions.allow": "允许",
    "flow.permissions.ask": "询问",
    "flow.permissions.deny": "拒绝",
    "flow.permissions.sources": "来源",
    "flow.action.skills": "管理 Skills",
    "flow.action.skills.description": "启用/停用 Skill 与模型主动调用权限；更改在扩展重载后生效",
    "flow.action.mcp": "管理 MCP 服务",
    "flow.action.mcp.description": "新增、编辑、启停或删除 MCP 服务，或编辑完整 JSON 配置",
    "flow.action.hooks": "管理 Hooks",
    "flow.action.hooks.description": "查看并管理 codex hooks 配置",
    "flow.compaction.derived": "派生阈值预览",
    "flow.compaction.derived.description": "只读展示生效阈值与软阶段可达性",
    "flow.failover.overview": "故障转移链",
    "flow.failover.overview.description": "只读展示已启用的故障转移链",
    "flow.overview.enabled": "启用",
    "flow.overview.reserve": "预留 Token",
    "flow.overview.keep": "保留最近 Token",
    "flow.overview.model": "压缩模型",
    "flow.overview.newContext": "显式新上下文模式",
    "flow.overview.soft": "软阶段",
    "flow.overview.chains": "回退链",
    "flow.overview.noChains": "尚未配置回退链",
    "flow.overview.followsSession": "跟随会话模型",
    "flow.overview.off": "关闭",
    "flow.overview.on": "开启",
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
      const message = await action(request.context);
      return {
        handled: true,
        refresh: request.actionId === "compaction.manage"
          || request.actionId === "failover.manage"
          || request.actionId === "responseLanguage.manage",
        ...(typeof message === "string" && message ? { message } : {}),
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
    setting("compaction.newContext.enabled", "flow.group.compaction", "flow.compaction.newContext.enabled", "boolean", DEFAULT_NEW_CONTEXT_ENABLED, "next-turn", {}, "override", "flow.compaction.newContext.enabled.description"),
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
    setting("compaction.soft.cache.minRatioRange", "flow.group.compactionSoft", "flow.compaction.soft.cache.minRatioRange", "json", [0.1, 0.5], "next-turn", { multiline: true }),
    setting("compaction.soft.timeBased.enabled", "flow.group.compactionSoft", "flow.compaction.soft.timeBased.enabled", "boolean", false, "next-turn"),
    setting("compaction.soft.timeBased.gapThresholdMinutes", "flow.group.compactionSoft", "flow.compaction.soft.timeBased.gapThresholdMinutes", "integer", 60, "next-turn", { min: 1, step: 1 }),
    setting("compaction.soft.relevance.enabled", "flow.group.compactionSoft", "flow.compaction.soft.relevance.enabled", "boolean", false, "next-turn"),
    setting("compaction.soft.relevance.mode", "flow.group.compactionSoft", "flow.compaction.soft.relevance.mode", "enum", "bm25", "next-turn", { options: [
      { value: "bm25", labelKey: "flow.option.relevanceMode.bm25" },
      { value: "keyword", labelKey: "flow.option.relevanceMode.keyword" },
    ] }),
    setting("compaction.soft.crossTurnDedup.enabled", "flow.group.compactionSoft", "flow.compaction.soft.crossTurnDedup.enabled", "boolean", false, "next-turn"),
    setting("compaction.soft.crossTurnDedup.minLines", "flow.group.compactionSoft", "flow.compaction.soft.crossTurnDedup.minLines", "integer", DEFAULT_DEDUP_MIN_LINES, "next-turn", { min: 1, step: 1 }),
    setting("compaction.soft.crossTurnDedup.minChars", "flow.group.compactionSoft", "flow.compaction.soft.crossTurnDedup.minChars", "integer", DEFAULT_DEDUP_MIN_CHARS, "next-turn", { min: 1, step: 1 }),
    setting("compaction.soft.lossless.enabled", "flow.group.compactionSoft", "flow.compaction.soft.lossless.enabled", "boolean", true, "next-turn"),
    setting("failover.enabled", "flow.group.failover", "flow.failover.enabled", "boolean", false, "next-invocation"),
    setting("failover.fallbackModels", "flow.group.failover", "flow.failover.fallbackModels", "list-crud", [], "next-invocation", {
      addLabelKey: "flow.failover.fallbackModels.add",
      itemLabelKey: "flow.failover.fallbackModels.item",
      itemFields: [
        { key: "model", group: "flow.group.failover", order: 0, labelKey: "flow.failover.field.model", scopes: ["global", "project"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
        { key: "fallbacks", group: "flow.group.failover", order: 1, labelKey: "flow.failover.field.fallbacks", scopes: ["global", "project"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "string-list" } },
      ],
    }, "deep-merge"),
  ];
  return [...writable, ...OVERVIEW_DEFINITIONS, ...ACTION_KEYS.map((key, index): SettingDefinition => ({
    key,
    group: "flow.group.manage",
    order: 100 + index,
    labelKey: `flow.action.${key.split(".")[0]}`,
    descriptionKey: `flow.action.${key.split(".")[0]}.description`,
    scopes: ["project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
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
  kind: SettingDefinition["editor"]["kind"],
  defaultValue: JsonValue,
  activation: SettingsActivation,
  editor: Omit<SettingDefinition["editor"], "kind"> = {},
  merge: SettingDefinition["merge"] = "override",
  descriptionKey?: string,
): SettingDefinition {
  return {
    key,
    group,
    labelKey,
    ...(descriptionKey ? { descriptionKey } : {}),
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
  options: Pick<FlowSettingsProviderOptions, "getAgentResponseLanguage" | "getPermissionOverview"> = {},
): SettingsSnapshot {
  const configured: ConfiguredSettingValue[] = [];
  const effective: SettingsSnapshot["effective"]["values"][number][] = [];
  const compaction = resources.filter((entry) => entry.kind === "compaction");
  const failover = resources.filter((entry) => entry.kind === "failover");
  const compactionPatches = new Map(compaction.map((entry) => [entry.scope, readCompactionPatch(entry.document.raw)]));
  const effectiveCompaction = resolveEffectiveCompactionSettings(compactionPatches.get("global") ?? {}, compactionPatches.get("project") ?? {});

  for (const definition of definitions()) {
    if (definition.key === "compaction.derived" || definition.key === "failover.overview" || definition.key === "flow.permissions") {
      configured.push({ key: definition.key, scope: "project", state: "absent" });
      effective.push({
        key: definition.key,
        value: definition.key === "compaction.derived"
          ? compactionDerivedRows(effectiveCompaction) as unknown as JsonValue
          : definition.key === "failover.overview"
            ? failoverOverviewRows(failover.map((entry) => entry.document.raw)) as unknown as JsonValue
            : permissionOverviewRows(options.getPermissionOverview?.()) as unknown as JsonValue,
        source: "runtime",
      });
      continue;
    }
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
      const display = parsed.path[0] === "fallbackModels" ? fallbackMapToItems(value.value) : value.value;
      configured.push({
        key: definition.key,
        scope: resource.scope,
        state: resource.document.error ? "invalid" : value.present ? "set" : "absent",
        ...(value.present ? { value: display } : {}),
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
        value: parsed.path[0] === "fallbackModels" ? fallbackMapToItems(selected?.value) : (selected?.value ?? definition.defaultValue ?? null),
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
  if (key === "compaction.newContext.enabled") return { kind: "compaction", path: ["newContext", "enabled"] };
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
  if (key === "compaction.model") return value === null || (typeof value === "string" && value.trim() !== "" && value.includes("/"));
  if (key.endsWith("Ratio") || key.endsWith("minFullness")) return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
  if (key === "compaction.soft.cache.minRatioRange") return isRatioRange(value);
  if (key === "compaction.soft.timeBased.gapThresholdMinutes"
    || key === "compaction.soft.crossTurnDedup.minLines"
    || key === "compaction.soft.crossTurnDedup.minChars") {
    return positiveInt(value) !== undefined;
  }
  if (key === "compaction.soft.relevance.mode") return value === "bm25" || value === "keyword";
  if (key === "failover.fallbackModels") {
    return Array.isArray(value)
      ? value.every((item) => isRecord(item)
        && typeof (item as Record<string, unknown>).model === "string"
        && Array.isArray((item as Record<string, unknown>).fallbacks)
        && ((item as Record<string, unknown>).fallbacks as unknown[]).every((entry) => typeof entry === "string"))
      : isFallbackMap(value);
  }
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
  const reserve = positiveInt(hard.reserveTokens) ?? positiveInt(raw.reserveTokens);
  if (reserve !== undefined && reserve <= MAX_RESERVE_TOKENS) patch.reserveTokens = reserve;
  const keepRecent = positiveInt(hard.keepRecentTokens) ?? positiveInt(raw.keepRecentTokens);
  if (keepRecent !== undefined) patch.keepRecentTokens = keepRecent;
  if (typeof raw.model === "string" && raw.model.trim()) patch.model = raw.model.trim();
  const newContextRaw = isRecord(raw.newContext) ? raw.newContext : {};
  if (typeof newContextRaw.enabled === "boolean") patch.newContext = { enabled: newContextRaw.enabled };
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
  const cache: NonNullable<SoftCompactionConfigPatch["cache"]> = {};
  if (typeof cacheRaw.enabled === "boolean") cache.enabled = cacheRaw.enabled;
  if (isRatioRange(cacheRaw.minRatioRange)) cache.minRatioRange = cacheRaw.minRatioRange as [number, number];
  if (Object.keys(cache).length) soft.cache = cache;
  const timeBasedRaw = isRecord(softRaw.timeBased) ? softRaw.timeBased : {};
  const timeBased: NonNullable<SoftCompactionConfigPatch["timeBased"]> = {};
  if (typeof timeBasedRaw.enabled === "boolean") timeBased.enabled = timeBasedRaw.enabled;
  const gapThresholdMinutes = positiveInt(timeBasedRaw.gapThresholdMinutes);
  if (gapThresholdMinutes !== undefined) timeBased.gapThresholdMinutes = gapThresholdMinutes;
  if (Object.keys(timeBased).length) soft.timeBased = timeBased;
  const relevanceRaw = isRecord(softRaw.relevance) ? softRaw.relevance : {};
  const relevance: NonNullable<SoftCompactionConfigPatch["relevance"]> = {};
  if (typeof relevanceRaw.enabled === "boolean") relevance.enabled = relevanceRaw.enabled;
  if (relevanceRaw.mode === "bm25" || relevanceRaw.mode === "keyword") relevance.mode = relevanceRaw.mode;
  if (Object.keys(relevance).length) soft.relevance = relevance;
  const dedupRaw = isRecord(softRaw.crossTurnDedup) ? softRaw.crossTurnDedup : {};
  const dedup: NonNullable<SoftCompactionConfigPatch["crossTurnDedup"]> = {};
  if (typeof dedupRaw.enabled === "boolean") dedup.enabled = dedupRaw.enabled;
  const dedupMinLines = positiveInt(dedupRaw.minLines);
  if (dedupMinLines !== undefined) dedup.minLines = dedupMinLines;
  const dedupMinChars = positiveInt(dedupRaw.minChars);
  if (dedupMinChars !== undefined) dedup.minChars = dedupMinChars;
  if (Object.keys(dedup).length) soft.crossTurnDedup = dedup;
  const losslessRaw = isRecord(softRaw.lossless) ? softRaw.lossless : {};
  if (typeof losslessRaw.enabled === "boolean") soft.lossless = { enabled: losslessRaw.enabled };
  if (Object.keys(soft).length) patch.soft = soft;
  return patch;
}

function applyChanges(kind: ResourceKind, raw: Record<string, unknown>, changes: readonly SettingsChange[]): Record<string, unknown> {
  const root = structuredClone(raw);
  if (kind === "failover") {
    for (const change of changes) {
      const parsed = parseSettingKey(change.key);
      if (!parsed) continue;
      if (parsed.path[0] === "fallbackModels" && change.operation === "set" && Array.isArray(change.value)) {
        setOrUnsetPath(root, parsed.path, { ...change, value: fallbackItemsToMap(change.value) });
      } else {
        setOrUnsetPath(root, parsed.path, change);
      }
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
    } else if (parsed.path[0] === "soft" || parsed.path[0] === "newContext") {
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

function fallbackMapToItems(map: unknown): JsonValue {
  const source = isRecord(map) ? map : {};
  return Object.entries(source).map(([model, fallbacks]) => ({
    model,
    fallbacks: Array.isArray(fallbacks) ? fallbacks.filter((entry): entry is string => typeof entry === "string") : [],
  }));
}

function fallbackItemsToMap(items: JsonValue): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.model === "string" && record.model && Array.isArray(record.fallbacks)) {
      result[record.model] = record.fallbacks.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return result;
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
    fsyncDirectorySync(path.dirname(destination));
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
    fsyncDirectorySync(path.dirname(destination));
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

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRatioRange(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === "number" && Number.isFinite(part))
    && (value[0] as number) >= 0
    && (value[0] as number) < (value[1] as number)
    && (value[1] as number) <= 1;
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

function compactionDerivedRows(effective: EffectiveCompactionSettings): SettingsOverviewRow[] {
  return [
    { labelKey: "flow.overview.enabled", value: effective.enabled ? "on" : "off", status: effective.enabled ? "ok" : "dim" },
    { labelKey: "flow.overview.reserve", value: String(effective.reserveTokens) },
    { labelKey: "flow.overview.keep", value: String(effective.keepRecentTokens) },
    { labelKey: "flow.overview.model", value: effective.model ?? "—" },
    {
      labelKey: "flow.overview.newContext",
      value: effective.newContext.enabled ? "on" : "off",
      status: effective.newContext.enabled ? "ok" : "dim",
    },
    {
      labelKey: "flow.overview.soft",
      value: effective.soft.enabled
        ? `nudge ${effective.soft.nudgeRatio} · prune ${effective.soft.pruneRatio}`
        : "off",
      status: effective.soft.enabled ? "ok" : "dim",
    },
  ];
}

function permissionOverviewRows(overview: PermissionOverview | undefined): SettingsOverviewRow[] {
  if (!overview) {
    return [{ labelKey: "flow.permissions.mode", value: "—", status: "dim" }];
  }
  const rows: SettingsOverviewRow[] = [
    { labelKey: "flow.permissions.mode", value: overview.mode, status: "ok" },
  ];
  for (const [key, rules] of [["allow", overview.allow], ["ask", overview.ask], ["deny", overview.deny]] as const) {
    if (rules.length === 0) {
      rows.push({ labelKey: `flow.permissions.${key}`, value: "—", status: "dim" });
    } else {
      for (const rule of rules) {
        rows.push({ labelKey: `flow.permissions.${key}`, value: rule, status: key === "allow" ? "ok" : "dim" });
      }
    }
  }
  rows.push({ labelKey: "flow.permissions.sources", value: overview.sources || "—", status: "dim" });
  return rows;
}

function failoverOverviewRows(records: readonly Record<string, unknown>[]): SettingsOverviewRow[] {
  const merged = Object.assign({}, ...records) as { enabled?: boolean; fallbackModels?: unknown };
  const enabled = merged.enabled === true;
  const chains = merged.fallbackModels && typeof merged.fallbackModels === "object"
    ? Object.entries(merged.fallbackModels as Record<string, unknown>)
    : [];
  const rows: SettingsOverviewRow[] = [
    { labelKey: "flow.overview.enabled", value: enabled ? "on" : "off", status: enabled ? "ok" : "dim" },
  ];
  if (chains.length === 0) {
    rows.push({ labelKey: "flow.overview.chains", value: "—", status: "dim" });
  } else {
    for (const [model, fallbacks] of chains) {
      rows.push({
        label: model,
        value: Array.isArray(fallbacks) ? fallbacks.join(" → ") : "—",
        status: enabled ? "ok" : "dim",
      });
    }
  }
  return rows;
}
