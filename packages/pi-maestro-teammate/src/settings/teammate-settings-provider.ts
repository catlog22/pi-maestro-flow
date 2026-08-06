import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
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
import { discoverAgents } from "../agents/agents.ts";
import {
  TEAMMATE_TASK_TYPE_META,
  discoverRoutingTaskTypes,
  getGlobalModelRoutingPath,
  getProjectModelRoutingPath,
  loadModelRoutingStores,
  replaceModelRoutingStores,
  type GlobalModelRoutingStore,
  type ModelRoutingStoreContentPair,
  type ModelRoutingStorePair,
  type ProjectModelRoutingStore,
} from "../models/model-routing.ts";
import { parseTeammateTaskType, type TeammateTaskType } from "../shared/task-types.ts";
import { TEAMMATE_THINKING_LEVELS, parseTeammateThinkingLevel } from "../shared/thinking.ts";

const PROVIDER_ID = "pi-maestro-teammate";
const PROVIDER_VERSION = "1.0.0";

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface TeammateSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface TeammateSettingsProviderOptions {
  getGlobalPath?: () => string;
  getProjectPath?: (cwd: string) => string;
  discoverTaskTypes?: (cwd: string) => readonly TeammateTaskType[];
  discoverRoles?: (cwd: string) => readonly string[];
  discoverRoleSummaries?: (cwd: string) => { name: string; description: string }[];
  openLegacySettings?: () => Promise<void> | void;
}

interface RoutingDocument {
  content: string;
  raw: GlobalModelRoutingStore | ProjectModelRoutingStore;
  error?: string;
}

interface RoutingResourceState {
  scope: "global" | "project";
  path: string;
  document: RoutingDocument;
  revision: SettingsResourceRevision;
}

interface PreparedRoutingChange {
  token: string;
  transactionId: string;
  changedKeys: readonly string[];
  globalPath: string;
  projectPath: string;
  before: ModelRoutingStorePair;
  next: ModelRoutingStorePair;
  beforeContent: ModelRoutingStoreContentPair;
  expectedRevisions: readonly SettingsResourceRevision[];
  committedContent?: ModelRoutingStoreContentPair;
  committedRevisions?: readonly SettingsResourceRevision[];
}

const BASE_CATALOGS = {
  en: {
    "teammate.provider": "Teammate",
    "teammate.provider.description": "Agent model, fallback and thinking routing",
    "teammate.routing.model": "Primary model",
    "teammate.routing.fallbacks": "Fallback models",
    "teammate.routing.thinking": "Thinking level",
    "teammate.roles": "Discovered roles",
    "teammate.roles.description": "Read-only catalog of the discovered teammate roles.",
    "teammate.roles.row": "Role",
    "routing.manage": "Management",
    "teammate.option.off": "Off",
    "teammate.option.minimal": "Minimal",
    "teammate.option.low": "Low",
    "teammate.option.medium": "Medium",
    "teammate.option.high": "High",
    "teammate.option.xhigh": "Extra high",
  },
  "zh-CN": {
    "teammate.provider": "Teammate",
    "teammate.provider.description": "Agent 模型、回退链与思考强度路由",
    "teammate.routing.model": "主模型",
    "teammate.routing.fallbacks": "回退模型",
    "teammate.routing.thinking": "思考强度",
    "teammate.roles": "发现角色",
    "teammate.roles.description": "发现的 teammate 角色只读目录。",
    "teammate.roles.row": "角色",
    "routing.manage": "管理",
    "teammate.option.off": "关闭",
    "teammate.option.minimal": "最小",
    "teammate.option.low": "低",
    "teammate.option.medium": "中",
    "teammate.option.high": "高",
    "teammate.option.xhigh": "超高",
  },
} as const;

const BUILTIN_TASK_LABELS: Record<string, { en: string; zh: string }> = {
  explore: { en: "Explore", zh: "探索" },
  analysis: { en: "Analysis", zh: "分析" },
  debug: { en: "Debug", zh: "调试" },
  planning: { en: "Planning", zh: "规划" },
  development: { en: "Development", zh: "开发" },
  review: { en: "Review", zh: "审查" },
  testing: { en: "Testing", zh: "测试" },
};

export function createTeammateSettingsProvider(options: TeammateSettingsProviderOptions = {}): TeammateSettingsProvider {
  const instanceId = randomUUID();
  const getGlobalPath = options.getGlobalPath ?? getGlobalModelRoutingPath;
  const getProjectPath = options.getProjectPath ?? getProjectModelRoutingPath;
  const taskTypes = options.discoverTaskTypes ?? ((cwd: string) => discoverRoutingTaskTypes(cwd));
  const roles = options.discoverRoles ?? ((cwd: string) => discoverAgents(cwd).map((agent) => agent.name));
  const roleSummaries = options.discoverRoleSummaries ?? ((cwd: string) => discoverAgents(cwd).map((agent) => ({ name: agent.name, description: agent.description })));
  const prepared = new Map<string, PreparedRoutingChange>();

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: (request) => {
      const types = taskTypes(request.context.cwd);
      return {
        id: PROVIDER_ID,
        version: PROVIDER_VERSION,
        instanceId,
        labelKey: "teammate.provider",
        descriptionKey: "teammate.provider.description",
        order: 20,
        capabilities: { read: true, write: true, prepareCommit: true, rollback: "compensating", hotUpdate: true },
        settings: definitions(types, roles(request.context.cwd), roleSummaries(request.context.cwd)),
        catalogs: catalogs(types, roles(request.context.cwd)),
      };
    },
    read: (request) => {
      const resources = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      return snapshot(resources, instanceId, taskTypes(request.context.cwd), roles(request.context.cwd), roleSummaries(request.context.cwd));
    },
    validate: (request) => {
      const resources = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      return validateRequest(request.changes, request.expectedRevisions, resources);
    },
    prepare: async (request) => {
      const resources = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      const validation = validateRequest(request.changes, request.expectedRevisions, resources);
      if (!validation.valid) {
        return { prepared: false, validation, conflicts: validation.conflicts };
      }
      const before = storePair(resources);
      const next = applyChanges(before, request.changes);
      const token = randomUUID();
      const state: PreparedRoutingChange = {
        token,
        transactionId: request.transactionId,
        changedKeys: request.changes.map((change) => change.key),
        globalPath: getGlobalPath(),
        projectPath: getProjectPath(request.context.cwd),
        before,
        next,
        beforeContent: contentPair(resources),
        expectedRevisions: resources.map((entry) => entry.revision),
      };
      prepared.set(token, state);
      return {
        prepared: true,
        prepareToken: token,
        validation: { valid: true, issues: [] },
        activation: [{ boundary: "next-invocation", keys: state.changedKeys }],
      };
    },
    commit: async (request) => {
      const state = requirePrepared(prepared, request.prepareToken, request.transactionId);
      const current = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      const validation = validateRequest([], state.expectedRevisions, current);
      if (!validation.valid) throw new Error("Teammate model routing changed after Settings preparation");
      const published = replaceModelRoutingStores(
        state.globalPath,
        state.projectPath,
        state.before,
        state.next,
        state.beforeContent,
      );
      // Record rollback metadata at the publish boundary so a post-publish read failure
      // cannot leave a published-but-unrollable commit.
      state.committedContent = {
        global: `${JSON.stringify(published.global, null, 2)}\n`,
        project: `${JSON.stringify(published.project, null, 2)}\n`,
      };
      let resources: RoutingResourceState[];
      try {
        resources = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      } catch {
        resources = [
          resourceStateFromContent("global", state.globalPath, published.global, state.committedContent.global),
          resourceStateFromContent("project", state.projectPath, published.project, state.committedContent.project),
        ];
      }
      state.committedRevisions = resources.map((entry) => entry.revision);
      return {
        snapshot: snapshot(resources, instanceId, taskTypes(request.context.cwd), roles(request.context.cwd), roleSummaries(request.context.cwd)),
        revisions: resources.map((entry) => entry.revision),
        changedKeys: state.changedKeys,
        activation: [{ boundary: "next-invocation", keys: state.changedKeys }],
      };
    },
    abort: async (request) => {
      prepared.delete(request.prepareToken);
    },
    rollback: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId || !state.committedRevisions || !state.committedContent) {
        return { rolledBack: false };
      }
      const resources = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      const validation = validateRequest([], state.committedRevisions, resources);
      if (!validation.valid) {
        return { rolledBack: false, conflicts: validation.conflicts };
      }
      replaceModelRoutingStores(
        state.globalPath,
        state.projectPath,
        state.next,
        state.before,
        state.committedContent,
      );
      prepared.delete(request.prepareToken);
      const restored = readResources(request.context.cwd, getGlobalPath, getProjectPath);
      return { rolledBack: true, snapshot: snapshot(restored, instanceId, taskTypes(request.context.cwd), roles(request.context.cwd), roleSummaries(request.context.cwd)) };
    },
    applyRuntime: (request) => {
      const state = [...prepared.values()].find((entry) => entry.transactionId === request.transactionId);
      if (state) prepared.delete(state.token);
      return {
        appliedKeys: [],
        deferred: [{ boundary: "next-invocation", keys: request.changes.map((change) => change.key) }],
        failed: [],
      };
    },
    invokeAction: async () => ({ handled: false }),
  };
}

export function registerTeammateSettingsProvider(events: SettingsEventBus, provider: TeammateSettingsProvider): () => void {
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

function definitions(taskTypes: readonly TeammateTaskType[], roles: readonly string[], summaries: readonly { name: string; description: string }[]): SettingDefinition[] {
  const settings = taskTypes.flatMap((taskType, index): SettingDefinition[] => [
    {
      key: settingKey(taskType, "model"),
      group: `routing.${taskType}`,
      order: index * 3,
      labelKey: "teammate.routing.model",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "model", optionsSource: "teammate.available-models" },
    },
    {
      key: settingKey(taskType, "fallbacks"),
      group: `routing.${taskType}`,
      order: index * 3 + 1,
      labelKey: "teammate.routing.fallbacks",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "string-list" },
    },
    {
      key: settingKey(taskType, "thinking"),
      group: `routing.${taskType}`,
      order: index * 3 + 2,
      labelKey: "teammate.routing.thinking",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: {
        kind: "enum",
        options: TEAMMATE_THINKING_LEVELS.map((value) => ({ value, labelKey: `teammate.option.${value}` })),
      },
    },
  ]);
  settings.push(...roles.flatMap((role, index): SettingDefinition[] => [
    {
      key: roleSettingKey(role, "model"),
      group: `role.${role}`,
      order: 10_000 + index * 3,
      labelKey: "teammate.routing.model",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "model", optionsSource: "teammate.available-models" },
    },
    {
      key: roleSettingKey(role, "fallbacks"),
      group: `role.${role}`,
      order: 10_000 + index * 3 + 1,
      labelKey: "teammate.routing.fallbacks",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "string-list" },
    },
    {
      key: roleSettingKey(role, "thinking"),
      group: `role.${role}`,
      order: 10_000 + index * 3 + 2,
      labelKey: "teammate.routing.thinking",
      scopes: ["global", "project"],
      merge: "override",
      activation: "next-invocation",
      sensitivity: "public",
      reversibility: "full",
      editor: {
        kind: "enum",
        options: TEAMMATE_THINKING_LEVELS.map((value) => ({ value, labelKey: `teammate.option.${value}` })),
      },
    },
  ]));
  settings.push({
    key: "teammate.roles",
    group: "routing.manage",
    order: Number.MAX_SAFE_INTEGER,
    labelKey: "teammate.roles",
    descriptionKey: "teammate.roles.description",
    scopes: ["project"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  });
  return settings;
}

function catalogs(taskTypes: readonly TeammateTaskType[], roles: readonly string[]) {
  const en = { ...BASE_CATALOGS.en } as Record<string, string>;
  const zh = { ...BASE_CATALOGS["zh-CN"] } as Record<string, string>;
  for (const taskType of taskTypes) {
    const labels = BUILTIN_TASK_LABELS[taskType];
    const fallback = TEAMMATE_TASK_TYPE_META[taskType]?.label ?? taskType;
    en[`routing.${taskType}`] = labels?.en ?? fallback;
    zh[`routing.${taskType}`] = labels?.zh ?? fallback;
  }
  for (const role of roles) {
    en[`role.${role}`] = `Role @${role}`;
    zh[`role.${role}`] = `角色 @${role}`;
  }
  return { en, "zh-CN": zh };
}

function snapshot(
  resources: readonly RoutingResourceState[],
  instanceId: string,
  taskTypes: readonly TeammateTaskType[],
  roles: readonly string[],
  summaries: readonly { name: string; description: string }[],
): SettingsSnapshot {
  const configured: ConfiguredSettingValue[] = [];
  const effective: SettingsSnapshot["effective"]["values"][number][] = [];
  const stores = storePair(resources);
  const requestedProfile = stores.project.activeProfile ?? stores.global.defaultProfile;
  const profileId = Object.hasOwn(stores.global.profiles, requestedProfile)
    ? requestedProfile
    : stores.global.defaultProfile;
  const profile = stores.global.profiles[profileId];
  const globalResource = resources.find((entry) => entry.scope === "global")!;
  const projectResource = resources.find((entry) => entry.scope === "project")!;
  for (const taskType of taskTypes) {
    for (const field of ["model", "fallbacks", "thinking"] as const) {
      const key = settingKey(taskType, field);
      const globalValue = rawValue(profile, taskType, field);
      const projectValue = rawValue(stores.project.overrides, taskType, field);
      configured.push({
        key,
        scope: "global",
        state: globalResource.document.error ? "invalid" : globalValue.present ? "set" : "absent",
        ...(globalValue.present ? { value: globalValue.value } : {}),
        resource: globalResource.revision.resource,
        ...(globalResource.document.error ? { messageKey: globalResource.document.error } : {}),
      });
      configured.push({
        key,
        scope: "project",
        state: projectResource.document.error ? "invalid" : projectValue.present ? "set" : "absent",
        ...(projectValue.present ? { value: projectValue.value } : {}),
        resource: projectResource.revision.resource,
        ...(projectResource.document.error ? { messageKey: projectResource.document.error } : {}),
      });
      const selected = stores.project.applyOverrides && projectValue.present
        ? { value: projectValue.value, scope: "project" as const, resource: projectResource.revision.resource }
        : globalValue.present
          ? { value: globalValue.value, scope: "global" as const, resource: globalResource.revision.resource }
          : undefined;
      effective.push({
        key,
        value: selected?.value ?? null,
        source: selected ? "configured" : "default",
        ...(selected ? { scope: selected.scope, resource: selected.resource } : {}),
      });
    }
  }
  for (const role of roles) {
    for (const field of ["model", "fallbacks", "thinking"] as const) {
      const key = roleSettingKey(role, field);
      const globalValue = rawRoleValue(profile, role, field);
      const projectValue = rawRoleValue(stores.project.overrides, role, field);
      configured.push({
        key,
        scope: "global",
        state: globalResource.document.error ? "invalid" : globalValue.present ? "set" : "absent",
        ...(globalValue.present ? { value: globalValue.value } : {}),
        resource: globalResource.revision.resource,
        ...(globalResource.document.error ? { messageKey: globalResource.document.error } : {}),
      });
      configured.push({
        key,
        scope: "project",
        state: projectResource.document.error ? "invalid" : projectValue.present ? "set" : "absent",
        ...(projectValue.present ? { value: projectValue.value } : {}),
        resource: projectResource.revision.resource,
        ...(projectResource.document.error ? { messageKey: projectResource.document.error } : {}),
      });
      const selected = stores.project.applyOverrides && projectValue.present
        ? { value: projectValue.value, scope: "project" as const, resource: projectResource.revision.resource }
        : globalValue.present
          ? { value: globalValue.value, scope: "global" as const, resource: globalResource.revision.resource }
          : undefined;
      effective.push({
        key,
        value: selected?.value ?? null,
        source: selected ? "configured" : "default",
        ...(selected ? { scope: selected.scope, resource: selected.resource } : {}),
      });
    }
  }

  const roleRows = summaries.map((summary) => ({
    labelKey: "teammate.roles.row",
    value: summary.description || summary.name,
    status: "dim" as const,
  }));
  effective.push({ key: "teammate.roles", value: roleRows, source: "runtime" });
  return {
    providerId: PROVIDER_ID,
    providerInstanceId: instanceId,
    configured: { values: configured, resources: resources.map((entry) => entry.revision) },
    effective: { values: effective },
  };
}

function readResources(
  cwd: string,
  getGlobalPath: () => string,
  getProjectPath: (cwd: string) => string,
): RoutingResourceState[] {
  const globalPath = getGlobalPath();
  const projectPath = getProjectPath(cwd);
  try {
    const stores = loadModelRoutingStores(globalPath, projectPath);
    return [
      resourceState("global", globalPath, stores.global),
      resourceState("project", projectPath, stores.project),
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      invalidResourceState("global", globalPath, defaultGlobalStore(), message),
      invalidResourceState("project", projectPath, defaultProjectStore(), message),
    ];
  }
}

function resourceState(
  scope: "global" | "project",
  filePath: string,
  raw: GlobalModelRoutingStore | ProjectModelRoutingStore,
): RoutingResourceState {
  const content = readContent(filePath);
  return { scope, path: filePath, document: { content, raw }, revision: revision(scope, filePath, content) };
}

function resourceStateFromContent(
  scope: "global" | "project",
  filePath: string,
  raw: GlobalModelRoutingStore | ProjectModelRoutingStore,
  content: string,
): RoutingResourceState {
  return { scope, path: filePath, document: { content, raw }, revision: revision(scope, filePath, content) };
}

function invalidResourceState(
  scope: "global" | "project",
  filePath: string,
  raw: GlobalModelRoutingStore | ProjectModelRoutingStore,
  error: string,
): RoutingResourceState {
  const content = readContent(filePath);
  return { scope, path: filePath, document: { content, raw, error }, revision: revision(scope, filePath, content) };
}

function readContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function revision(scope: "global" | "project", filePath: string, content: string): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope, id: `${scope}:teammate-models.json` },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function validateRequest(
  changes: readonly SettingsChange[],
  expectedRevisions: readonly SettingsResourceRevision[] | undefined,
  resources: readonly RoutingResourceState[],
) {
  const issues: SettingsValidationIssue[] = [];
  const conflicts: SettingsResourceConflict[] = [];
  for (const resource of resources) {
    const expected = expectedRevisions?.find((entry) => entry.resource.id === resource.revision.resource.id);
    if (expected && expected.etag !== resource.revision.etag) conflicts.push(resourceConflict(resource.revision, expected.etag));
    if (resource.document.error) {
      issues.push({
        severity: "error",
        messageKey: "teammate.settings.invalidDocument",
        key: changes[0]?.key ?? "routing.manage",
        scope: resource.scope,
      });
    }
  }
  for (const change of changes) {
    const parsed = parseSettingKey(change.key);
    if (!parsed) {
      issues.push(issue(change, "teammate.settings.unknownKey"));
      continue;
    }
    if (change.scope !== "global" && change.scope !== "project") {
      issues.push(issue(change, "teammate.settings.invalidScope"));
      continue;
    }
    if (change.operation === "set" && !validValue(parsed.field, change.value)) {
      issues.push(issue(change, "teammate.settings.invalidValue"));
    }
  }
  return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
}

function applyChanges(before: ModelRoutingStorePair, changes: readonly SettingsChange[]): ModelRoutingStorePair {
  const next = structuredClone(before);
  const requestedProfile = next.project.activeProfile ?? next.global.defaultProfile;
  const profileId = Object.hasOwn(next.global.profiles, requestedProfile)
    ? requestedProfile
    : next.global.defaultProfile;
  for (const change of changes) {
    const parsed = parseSettingKey(change.key);
    if (!parsed) continue;
    const rules = change.scope === "global"
      ? next.global.profiles[profileId]
      : next.project.overrides;
    if (parsed.kind === "role") {
      rules.roleMappings ??= {};
      const roleRules = rules.roleMappings[parsed.role] ?? {};
      const roleField = parsed.field === "fallbacks" ? "fallbackModels" : parsed.field;
      if (change.operation === "unset") {
        delete roleRules[roleField];
        if (Object.keys(roleRules).length === 0) delete rules.roleMappings[parsed.role];
      } else if (parsed.field === "fallbacks" && Array.isArray(change.value)) {
        roleRules.fallbackModels = [...new Set(change.value
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean))];
        rules.roleMappings[parsed.role] = roleRules;
      } else {
        roleRules[roleField] = change.value as never;
        rules.roleMappings[parsed.role] = roleRules;
      }
    } else {
      const section = sectionFor(parsed.field);
      const values = rules[section] ?? {};
      if (change.operation === "unset") {
        delete values[parsed.taskType];
      } else if (parsed.field === "fallbacks" && Array.isArray(change.value)) {
        values[parsed.taskType] = [...new Set(change.value
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean))];
      } else if (parsed.field === "model" && typeof change.value === "string") {
        values[parsed.taskType] = change.value.trim();
      } else {
        values[parsed.taskType] = change.value as never;
      }
      if (section === "fallbackMappings") {
        rules.fallbackMappings = values as NonNullable<typeof rules.fallbackMappings>;
      }
    }
    if (change.scope === "project" && change.operation === "set") next.project.applyOverrides = true;
  }
  if (!hasRoutingRules(next.project.overrides)) next.project.applyOverrides = false;
  return next;
}

function rawRoleValue(
  raw: { roleMappings?: Record<string, { model?: string | null; fallbackModels?: string[] | null; thinking?: string | null } | null> },
  role: string,
  field: "model" | "fallbacks" | "thinking",
): { present: boolean; value?: JsonValue } {
  const rules = raw.roleMappings?.[role];
  if (!rules || !Object.hasOwn(rules, field === "model" ? "model" : field === "fallbacks" ? "fallbackModels" : "thinking")) {
    return { present: false };
  }
  const value = field === "model" ? rules.model : field === "fallbacks" ? rules.fallbackModels : rules.thinking;
  if (field === "model") return { present: true, value: typeof value === "string" ? value : null };
  if (field === "fallbacks") return { present: true, value: Array.isArray(value) ? [...value] : null };
  return { present: true, value: parseTeammateThinkingLevel(value) ?? null };
}

function rawValue(
  raw: { mappings: Record<string, unknown> | object; fallbackMappings?: Record<string, unknown> | object; thinkingLevels: Record<string, unknown> | object },
  taskType: TeammateTaskType,
  field: "model" | "fallbacks" | "thinking",
): { present: boolean; value?: JsonValue } {
  const section = isRecord(raw[sectionFor(field)]) ? raw[sectionFor(field)] as Record<string, unknown> : {};
  if (!Object.hasOwn(section, taskType)) return { present: false };
  const value = section[taskType];
  if (field === "model") return { present: true, value: typeof value === "string" ? value.trim() : null };
  if (field === "fallbacks") {
    return {
      present: true,
      value: Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
        : null,
    };
  }
  return { present: true, value: parseTeammateThinkingLevel(value) ?? null };
}

function settingKey(taskType: TeammateTaskType, field: "model" | "fallbacks" | "thinking"): string {
  return `routing.${taskType}.${field}`;
}

type ParsedSetting =
  | { kind: "task"; taskType: TeammateTaskType; field: "model" | "fallbacks" | "thinking" }
  | { kind: "role"; role: string; field: "model" | "fallbacks" | "thinking" };

function roleSettingKey(role: string, field: "model" | "fallbacks" | "thinking"): string {
  return `role.${role}.${field}`;
}

function parseSettingKey(key: string): ParsedSetting | undefined {
  const taskMatch = /^routing\.([a-z][a-z0-9._-]*)\.(model|fallbacks|thinking)$/.exec(key);
  if (taskMatch) {
    const taskType = parseTeammateTaskType(taskMatch[1]);
    if (!taskType) return undefined;
    return { kind: "task", taskType, field: taskMatch[2] as ParsedSetting["field"] };
  }
  const roleMatch = /^role\.([a-z][a-z0-9._-]*)\.(model|fallbacks|thinking)$/.exec(key);
  if (!roleMatch) return undefined;
  return { kind: "role", role: roleMatch[1], field: roleMatch[2] as ParsedSetting["field"] };
}

function sectionFor(field: "model" | "fallbacks" | "thinking"): "mappings" | "fallbackMappings" | "thinkingLevels" {
  if (field === "model") return "mappings";
  if (field === "fallbacks") return "fallbackMappings";
  return "thinkingLevels";
}

function validValue(field: "model" | "fallbacks" | "thinking", value: JsonValue): boolean {
  if (field === "model") return value === null || (typeof value === "string" && value.trim().length > 0);
  if (field === "fallbacks") return value === null || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0));
  return value === null || parseTeammateThinkingLevel(value) !== undefined;
}

function storePair(resources: readonly RoutingResourceState[]): ModelRoutingStorePair {
  return {
    global: structuredClone(resources.find((entry) => entry.scope === "global")!.document.raw as GlobalModelRoutingStore),
    project: structuredClone(resources.find((entry) => entry.scope === "project")!.document.raw as ProjectModelRoutingStore),
  };
}

function contentPair(resources: readonly RoutingResourceState[]): ModelRoutingStoreContentPair {
  return {
    global: resources.find((entry) => entry.scope === "global")!.document.content,
    project: resources.find((entry) => entry.scope === "project")!.document.content,
  };
}

function defaultGlobalStore(): GlobalModelRoutingStore {
  return {
    version: 3,
    defaultProfile: "default",
    profiles: {
      default: { name: "Default", mappings: {}, thinkingLevels: {} },
    },
  };
}

function defaultProjectStore(): ProjectModelRoutingStore {
  return {
    version: 3,
    applyOverrides: false,
    overrides: { mappings: {}, thinkingLevels: {} },
  };
}

function hasRoutingRules(rules: ProjectModelRoutingStore["overrides"]): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.thinkingLevels).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.roleMappings ?? {}).length > 0;
}

function resourceConflict(actual: SettingsResourceRevision, expectedEtag: string): SettingsResourceConflict {
  return { resource: actual.resource, expectedEtag, actualEtag: actual.etag, messageKey: "settings.conflict" };
}

function issue(change: SettingsChange, messageKey: string): SettingsValidationIssue {
  return { severity: "error", messageKey, key: change.key, scope: change.scope };
}

function requirePrepared(
  prepared: Map<string, PreparedRoutingChange>,
  token: string,
  transactionId: string,
): PreparedRoutingChange {
  const state = prepared.get(token);
  if (!state || state.transactionId !== transactionId) throw new Error("prepared Teammate settings transaction is unavailable");
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
