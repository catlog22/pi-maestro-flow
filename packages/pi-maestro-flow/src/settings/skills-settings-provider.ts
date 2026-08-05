import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type ConfiguredSettingValue,
  type EffectiveSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsAnnounceEventV1,
  type SettingsChange,
  type SettingsContextV1,
  type SettingsDiscoverEventV1,
  type SettingsOverviewRow,
  type SettingsProviderV1,
  type SettingsSnapshot,
  type SettingsValidationIssue,
} from "pi-maestro-settings-core/v1";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SkillManagerStore, type ManagedSkill } from "../skills/skill-manager-store.ts";

const PROVIDER_ID = "pi-maestro-skills";
const PROVIDER_VERSION = "1.0.0";

interface SkillsSettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

export interface SkillsSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface SkillsSettingsProviderOptions {
  /** Project directory used to construct the SkillManagerStore; defaults to the request cwd. */
  getProjectPath?: (context: SettingsContextV1) => string;
  /** Agent directory passed to the SkillManagerStore; defaults to the environment agent dir. */
  getAgentDir?: () => string;
}

function field(
  key: string,
  kind: SettingDefinition["editor"]["kind"],
  labelKey: string,
  extra: Partial<SettingDefinition["editor"]> = {},
  defaultValue?: JsonValue,
): SettingDefinition {
  return {
    key,
    group: "skills.group.management",
    labelKey,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "public",
    reversibility: "full",
    editor: { kind, ...extra },
  };
}

const SKILL_FIELDS: readonly SettingDefinition[] = [
  field("name", "text", "skills.field.name"),
  field("enabled", "boolean", "skills.field.enabled", {}, true),
  field("disableModelInvocation", "boolean", "skills.field.disableModelInvocation", {}, false),
];

const DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "skills.enabled",
    group: "skills.group.management",
    order: 0,
    labelKey: "skills.enabled",
    descriptionKey: "skills.enabled.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "next-invocation",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      itemLabelKey: "skills.item.skill",
      addLabelKey: "skills.action.addSkill",
      itemFields: SKILL_FIELDS,
    },
  },
  {
    key: "skills.overview",
    group: "skills.group.diagnostics",
    order: 10,
    labelKey: "skills.overview",
    descriptionKey: "skills.overview.description",
    scopes: ["global"],
    merge: "provider-defined",
    activation: "live",
    sensitivity: "private",
    reversibility: "none",
    editor: { kind: "overview" },
  },
];

const CATALOGS = {
  en: {
    "skills.provider": "Skills",
    "skills.provider.description": "Skill enablement, model invocation and inventory",
    "skills.group.management": "Skills",
    "skills.group.diagnostics": "Skills overview",
    "skills.enabled": "Skill enablement",
    "skills.enabled.description": "Enable or disable skills and block their invocation by the model",
    "skills.field.name": "Skill name",
    "skills.field.enabled": "Enabled",
    "skills.field.disableModelInvocation": "Block model invocation",
    "skills.item.skill": "{name}",
    "skills.action.addSkill": "Add skill",
    "skills.overview": "Skills overview",
    "skills.overview.description": "Skill inventory, enablement state and config file",
    "skills.overview.total": "Total skills",
    "skills.overview.enabled": "Enabled",
    "skills.overview.package": "Package skills",
    "skills.overview.file": "File skills",
    "skills.overview.configFile": "Skill config file",
    "skills.settings.invalidItems": "Skills must be a list of objects with a non-empty name",
  },
  "zh-CN": {
    "skills.provider": "Skills",
    "skills.provider.description": "Skill 启停、模型调用与清单管理",
    "skills.group.management": "Skills",
    "skills.group.diagnostics": "Skills 概览",
    "skills.enabled": "Skill 启停管理",
    "skills.enabled.description": "启用或停用 Skill，并可阻止模型调用指定 Skill",
    "skills.field.name": "Skill 名称",
    "skills.field.enabled": "启用",
    "skills.field.disableModelInvocation": "阻止模型调用",
    "skills.item.skill": "{name}",
    "skills.action.addSkill": "新增 Skill",
    "skills.overview": "Skills 概览",
    "skills.overview.description": "Skill 清单、启停状态与配置文件",
    "skills.overview.total": "Skill 总数",
    "skills.overview.enabled": "已启用",
    "skills.overview.package": "Package Skill",
    "skills.overview.file": "File Skill",
    "skills.overview.configFile": "Skill 配置文件",
    "skills.settings.invalidItems": "Skills 必须是含非空 name 的对象列表",
  },
} as const;

interface SkillItem {
  name: string;
  enabled: boolean;
  disableModelInvocation: boolean;
}

function parseSkillItem(value: unknown): SkillItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || item.name.trim().length === 0) return undefined;
  return {
    name: item.name,
    enabled: item.enabled !== false,
    disableModelInvocation: item.disableModelInvocation === true,
  };
}

export function createSkillsSettingsProvider(
  options: SkillsSettingsProviderOptions = {},
): SkillsSettingsProvider {
  const instanceId = randomUUID();
  const getProjectPath = options.getProjectPath ?? ((context: SettingsContextV1) => context.cwd);
  const getAgentDirectory = options.getAgentDir ?? getAgentDir;
  const originals = new Map<string, { content: string; exists: boolean }>();
  const preparedChanges = new Map<string, readonly SettingsChange[]>();

  const projectConfigPath = async (context: SettingsContextV1): Promise<string> =>
    join(getProjectPath(context), ".pi", "skill-config.json");

  const load = async (context: SettingsContextV1): Promise<{
    skills: ManagedSkill[];
    projectConfigPath: string;
  }> => {
    const store = new SkillManagerStore(getProjectPath(context), getAgentDirectory());
    const snapshot = await store.load();
    return { skills: snapshot.skills, projectConfigPath: snapshot.projectConfigPath };
  };

  const snapshotFor = (
    instanceId: string,
    data: Awaited<ReturnType<typeof load>>,
    definitions: readonly SettingDefinition[],
  ): SettingsSnapshot => {
    const configured: ConfiguredSettingValue[] = [];
    const effective: EffectiveSettingValue[] = [];
    const items = data.skills.map((skill) => ({
      name: skill.name,
      enabled: skill.enabled,
      disableModelInvocation: skill.disableModelInvocation,
    }));
    const enabledCount = data.skills.filter((skill) => skill.enabled).length;
    const packageCount = data.skills.filter((skill) => skill.origin === "package").length;
    const fileCount = data.skills.length - packageCount;
    for (const definition of definitions) {
      if (definition.key === "skills.enabled") {
        configured.push({ key: definition.key, scope: "global", state: "set", value: items as unknown as JsonValue });
        effective.push({ key: definition.key, value: items as unknown as JsonValue, source: "configured", scope: "global" });
      } else if (definition.key === "skills.overview") {
        const rows: SettingsOverviewRow[] = [
          { labelKey: "skills.overview.total", value: String(data.skills.length), status: "dim" },
          {
            labelKey: "skills.overview.enabled",
            value: `${enabledCount}/${data.skills.length}`,
            status: enabledCount === 0 ? "dim" : enabledCount === data.skills.length ? "ok" : "warn",
          },
          { labelKey: "skills.overview.package", value: String(packageCount), status: packageCount > 0 ? "ok" : "dim" },
          { labelKey: "skills.overview.file", value: String(fileCount), status: fileCount > 0 ? "ok" : "dim" },
          { labelKey: "skills.overview.configFile", value: data.projectConfigPath, status: "dim" },
        ];
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({ key: definition.key, value: rows as unknown as JsonValue, source: "runtime" });
      } else {
        configured.push({ key: definition.key, scope: "global", state: "absent" });
        effective.push({ key: definition.key, value: "open", source: "runtime" });
      }
    }
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [] },
      effective: { values: effective },
    };
  };

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "skills.provider",
      descriptionKey: "skills.provider.description",
      order: 20,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: async (request) => snapshotFor(instanceId, await load(request.context), DEFINITIONS),
    validate: (request) => {
      const issues: SettingsValidationIssue[] = [];
      for (const change of request.changes) {
        if (change.key === "skills.enabled" && change.operation === "set") {
          if (!Array.isArray(change.value) || !change.value.every((item) => parseSkillItem(item))) {
            issues.push({
              severity: "error",
              key: change.key,
              scope: change.scope,
              code: "invalid-skill-items",
              messageKey: "skills.settings.invalidItems",
            });
          }
        }
      }
      return { valid: issues.length === 0, issues, conflicts: [] };
    },
    prepare: async (request) => {
      const changedKeys = request.changes.map((change) => change.key);
      if (changedKeys.includes("skills.enabled")) {
        for (const transactionId of originals.keys()) {
          if (transactionId !== request.transactionId) originals.delete(transactionId);
        }
        originals.set(request.transactionId, await readOriginal(await projectConfigPath(request.context)));
      }
      preparedChanges.set(request.transactionId, request.changes);
      return {
        prepared: true,
        prepareToken: request.transactionId,
        validation: { valid: true, issues: [], conflicts: [] },
        activation: [{ boundary: "next-invocation", keys: changedKeys }],
      };
    },
    commit: async (request) => {
      const configPath = await projectConfigPath(request.context);
      const changes = preparedChanges.get(request.transactionId) ?? [];
      const skillsChange = changes.find((change) => change.key === "skills.enabled");
      if (skillsChange?.operation === "set" && Array.isArray(skillsChange.value)) {
        const root = await readConfigJson(configPath);
        const existingSkills = isRecord(root.skills) ? root.skills : {};
        const nextSkills: Record<string, unknown> = {};
        for (const item of skillsChange.value) {
          const entry = parseSkillItem(item);
          if (!entry) continue;
          const currentValue = existingSkills[entry.name];
          const previous = isRecord(currentValue) ? currentValue : {};
          nextSkills[entry.name] = {
            ...previous,
            enabled: entry.enabled,
            "disable-model-invocation": entry.disableModelInvocation,
          };
        }
        const nextRoot = { version: typeof root.version === "string" ? root.version : "1.0.0", ...root, skills: nextSkills };
        await atomicWriteJson(configPath, nextRoot);
      }
      preparedChanges.delete(request.transactionId);
      const snapshot = snapshotFor(instanceId, await load(request.context), DEFINITIONS);
      return {
        snapshot,
        revisions: [{
          resource: { providerId: PROVIDER_ID, scope: "global", id: configPath },
          etag: `skills-${Date.now()}`,
        }],
        changedKeys: changes.map((change) => change.key),
        activation: [{ boundary: "next-invocation", keys: changes.map((change) => change.key) }],
      };
    },
    abort: (request) => {
      originals.delete(request.transactionId);
      preparedChanges.delete(request.transactionId);
    },
    rollback: async (request) => {
      const original = originals.get(request.transactionId);
      originals.delete(request.transactionId);
      if (!original) return { rolledBack: false };
      const configPath = await projectConfigPath(request.context);
      try {
        if (original.exists) {
          await atomicWriteJson(configPath, JSON.parse(original.content) as Record<string, unknown>);
        } else {
          await unlink(configPath).catch(() => undefined);
        }
      } catch {
        return { rolledBack: false };
      }
      return { rolledBack: true };
    },
  };
}

async function readOriginal(path: string): Promise<{ content: string; exists: boolean }> {
  try {
    return { content: await readFile(path, "utf8"), exists: true };
  } catch {
    return { content: "", exists: false };
  }
}

async function readConfigJson(path: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch {
    await unlink(path).catch(() => undefined);
    await rename(temporaryPath, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerSkillsSettingsProvider(
  events: SkillsSettingsEventBus,
  provider: SkillsSettingsProvider,
): () => void {
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

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<SettingsDiscoverEventV1>;
  return candidate.version === SETTINGS_PROTOCOL_VERSION
    && typeof candidate.requestId === "string"
    && Boolean(candidate.context)
    && typeof candidate.context?.cwd === "string";
}
