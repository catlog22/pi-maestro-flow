import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { CODEX_HOOK_EVENTS, type CodexHooksFile } from "../hooks/schema.ts";

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
 * Aggregating hooks provider. Reads/writes `.pi/hooks.json` (codex hooks format)
 * and surfaces each event's matcher group as a list-crud row
 * (event / matcher / command). The underlying /hooks installer logic is not
 * touched — this is a read/write adapter so hooks are configurable in-shell.
 */

const PROVIDER_ID = "pi-maestro-flow-hooks";
const PROVIDER_VERSION = "1.0.0";
const RESOURCE_ID = "hooks.json";

interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

const EVENT_OPTIONS = CODEX_HOOK_EVENTS.map((value) => ({ value, labelKey: `hooks.event.${value}` }));

const DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "hooks.entries",
    group: "hooks.group.entries",
    order: 0,
    labelKey: "hooks.entries",
    descriptionKey: "hooks.entries.description",
    scopes: ["project"],
    merge: "override",
    activation: "next-invocation",
    sensitivity: "private",
    reversibility: "full",
    editor: {
      kind: "list-crud",
      addLabelKey: "hooks.entries.add",
      itemLabelKey: "hooks.entries.item",
      itemFields: [
        { key: "event", group: "hooks.group.field", order: 0, labelKey: "hooks.field.event", scopes: ["project"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "enum", options: EVENT_OPTIONS } },
        { key: "matcher", group: "hooks.group.field", order: 1, labelKey: "hooks.field.matcher", scopes: ["project"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
        { key: "command", group: "hooks.group.field", order: 2, labelKey: "hooks.field.command", scopes: ["project"], merge: "override", activation: "next-invocation", sensitivity: "public", reversibility: "full", editor: { kind: "text" } },
      ],
    },
  },
];

const CATALOGS = {
  en: {
    "hooks.provider": "Hooks",
    "hooks.provider.description": "Codex hooks installed in .pi/hooks.json",
    "hooks.group.entries": "Installed hooks",
    "hooks.group.field": "Hook",
    "hooks.entries": "Installed hooks",
    "hooks.entries.description": "Per-event hook commands. Advanced editing (timeouts, trust) stays in /hooks.",
    "hooks.entries.add": "Add hook",
    "hooks.entries.item": "{event} {matcher}",
    "hooks.field.event": "Event",
    "hooks.field.matcher": "Matcher",
    "hooks.field.command": "Command",
    "hooks.event.SessionStart": "SessionStart",
    "hooks.event.SubagentStart": "SubagentStart",
    "hooks.event.PreToolUse": "PreToolUse",
    "hooks.event.PermissionRequest": "PermissionRequest",
    "hooks.event.PostToolUse": "PostToolUse",
    "hooks.event.PreCompact": "PreCompact",
    "hooks.event.PostCompact": "PostCompact",
    "hooks.event.UserPromptSubmit": "UserPromptSubmit",
    "hooks.event.SubagentStop": "SubagentStop",
    "hooks.event.Stop": "Stop",
    "hooks.settings.unknownKey": "Unknown hooks setting",
    "hooks.settings.invalidValue": "Invalid value for this hooks setting",
  },
  "zh-CN": {
    "hooks.provider": "Hooks",
    "hooks.provider.description": "安装于 .pi/hooks.json 的 Codex hooks",
    "hooks.group.entries": "已安装 hooks",
    "hooks.group.field": "Hook",
    "hooks.entries": "已安装 hooks",
    "hooks.entries.description": "每个事件的 hook 命令。高级编辑（超时、信任）保留在 /hooks。",
    "hooks.entries.add": "添加 hook",
    "hooks.entries.item": "{event} {matcher}",
    "hooks.field.event": "事件",
    "hooks.field.matcher": "匹配器",
    "hooks.field.command": "命令",
    "hooks.event.SessionStart": "SessionStart",
    "hooks.event.SubagentStart": "SubagentStart",
    "hooks.event.PreToolUse": "PreToolUse",
    "hooks.event.PermissionRequest": "PermissionRequest",
    "hooks.event.PostToolUse": "PostToolUse",
    "hooks.event.PreCompact": "PreCompact",
    "hooks.event.PostCompact": "PostCompact",
    "hooks.event.UserPromptSubmit": "UserPromptSubmit",
    "hooks.event.SubagentStop": "SubagentStop",
    "hooks.event.Stop": "Stop",
    "hooks.settings.unknownKey": "未知的 hooks 设置",
    "hooks.settings.invalidValue": "该 hooks 设置的取值无效",
  },
} as const;

export interface HooksSettingsProvider extends SettingsProviderV1 {
  readonly providerId: typeof PROVIDER_ID;
  readonly instanceId: string;
}

export interface HooksSettingsProviderOptions {
  getConfigPath?: (cwd: string) => string;
}

interface HooksDocument {
  path: string;
  content: string;
  raw: CodexHooksFile;
  revision: SettingsResourceRevision;
  error?: string;
}

interface PreparedHooksChange {
  token: string;
  transactionId: string;
  path: string;
  temporaryPath: string;
  beforeContent: string;
  items: JsonValue;
  release: () => Promise<void>;
  committedRevision?: SettingsResourceRevision;
}

export function createHooksSettingsProvider(options: HooksSettingsProviderOptions = {}): HooksSettingsProvider {
  const instanceId = randomUUID();
  const getPath = options.getConfigPath ?? ((cwd: string) => join(cwd, ".pi", "hooks.json"));
  const prepared = new Map<string, PreparedHooksChange>();

  const readDocument = (cwd: string): HooksDocument => {
    const path = getPath(cwd);
    if (!existsSync(path)) return { path, content: "", raw: { hooks: {} }, revision: revision(path, "") };
    const content = readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CodexHooksFile : { hooks: {} };
      return { path, content, raw, revision: revision(path, content) };
    } catch (error) {
      return { path, content, raw: { hooks: {} }, revision: revision(path, content), error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Flatten hooks[event] matcher groups into [{event, matcher, command}]. */
  const flatten = (raw: CodexHooksFile): JsonValue => {
    const items: Array<Record<string, unknown>> = [];
    const hooks = raw.hooks ?? {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
        const command = group.hooks.find((h) => Boolean(h && typeof h === "object" && (h as Record<string, unknown>).type === "command"));
        items.push({
          event,
          matcher: typeof group.matcher === "string" ? group.matcher : "",
          command: command && typeof (command as Record<string, unknown>).command === "string" ? (command as Record<string, unknown>).command : "",
        });
      }
    }
    return items as unknown as JsonValue;
  };

  /** Rebuild hooks[event] matcher groups from [{event, matcher, command}], preserving $schema. */
  const unflatten = (items: JsonValue, previous: CodexHooksFile): CodexHooksFile => {
    const hooks: CodexHooksFile["hooks"] = {};
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.event !== "string" || typeof record.command !== "string" || !record.command) continue;
        const event = record.event as keyof CodexHooksFile["hooks"];
        const matcher = typeof record.matcher === "string" && record.matcher ? record.matcher : undefined;
        const group: CodexHooksFile["hooks"][keyof CodexHooksFile["hooks"]] extends readonly (infer G)[] ? G : never = {
          ...(matcher ? { matcher } : {}),
          hooks: [{ type: "command", command: record.command, timeout: 600 }],
        } as CodexHooksFile["hooks"][keyof CodexHooksFile["hooks"]] extends readonly (infer G)[] ? G : never;
        const list = hooks[event] ?? [];
        list.push(group);
        hooks[event] = list;
      }
    }
    const result: Partial<CodexHooksFile> = { ...(typeof previous.$schema === "string" ? { $schema: previous.$schema } : {}), hooks };
    if (Object.keys(hooks).length === 0) delete result.hooks;
    return result as CodexHooksFile;
  };

  const snapshot = (doc: HooksDocument, cwd: string): SettingsSnapshot => {
    const value = flatten(doc.raw);
    const configured: ConfiguredSettingValue[] = [{
      key: "hooks.entries",
      scope: "project",
      state: doc.error ? "invalid" : "set",
      ...(doc.error ? { messageKey: doc.error } : { value }),
      resource: doc.revision.resource,
    }];
    return {
      providerId: PROVIDER_ID,
      providerInstanceId: instanceId,
      configured: { values: configured, resources: [doc.revision] },
      effective: { values: [{ key: "hooks.entries", value, source: doc.error ? "default" : "configured", scope: "project", resource: doc.revision.resource }] },
    };
  };

  const validateChanges = (changes: readonly SettingsChange[], doc: HooksDocument): { issues: SettingsValidationIssue[]; conflicts: SettingsResourceConflict[] } => {
    const issues: SettingsValidationIssue[] = [];
    for (const change of changes) {
      if (change.key !== "hooks.entries") issues.push({ severity: "error", messageKey: "hooks.settings.unknownKey", key: change.key, scope: change.scope });
      else if (change.scope !== "project") issues.push({ severity: "error", messageKey: "hooks.settings.invalidValue", key: change.key, scope: change.scope });
      else if (change.operation === "set" && !Array.isArray(change.value)) issues.push({ severity: "error", messageKey: "hooks.settings.invalidValue", key: change.key, scope: change.scope });
    }
    const conflicts: SettingsResourceConflict[] = [];
    for (const expected of requestRevisions ?? []) {
      if (expected.resource.providerId !== PROVIDER_ID) continue;
      if (doc.revision.etag !== expected.etag) conflicts.push({ resource: doc.revision.resource, expectedEtag: expected.etag, actualEtag: doc.revision.etag, messageKey: "settings.conflict" });
    }
    return { issues, conflicts };
  };
  let requestRevisions: readonly SettingsResourceRevision[] | undefined;

  return {
    providerId: PROVIDER_ID,
    instanceId,
    describe: () => ({
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      instanceId,
      labelKey: "hooks.provider",
      descriptionKey: "hooks.provider.description",
      order: 14,
      capabilities: { read: true, write: true, prepareCommit: true, rollback: "full", hotUpdate: true },
      settings: DEFINITIONS,
      catalogs: CATALOGS,
    }),
    read: (request) => snapshot(readDocument(request.context.cwd), request.context.cwd),
    validate: (request) => {
      requestRevisions = request.expectedRevisions;
      const { issues, conflicts } = validateChanges(request.changes, readDocument(request.context.cwd));
      return { valid: issues.length === 0 && conflicts.length === 0, issues, conflicts };
    },
    prepare: async (request) => {
      requestRevisions = request.expectedRevisions;
      const cwd = request.context.cwd;
      const doc = readDocument(cwd);
      const { issues, conflicts } = validateChanges(request.changes, doc);
      if (issues.length > 0 || conflicts.length > 0) return { prepared: false, validation: { valid: false, issues, conflicts } };
      const path = getPath(cwd);
      const release = await properLockfile.lock(path, {
        realpath: false, stale: 10_000, update: 2_000,
        retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      try {
        const current = readDocument(cwd);
        const change = request.changes.find((entry) => entry.key === "hooks.entries");
        const nextRaw = change?.operation === "set" ? unflatten(change.value as JsonValue, current.raw) : current.raw;
        const content = `${JSON.stringify(nextRaw, null, 2)}\n`;
        const token = randomUUID();
        const temporaryPath = `${path}.${process.pid}.${token}.tmp`;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        prepared.set(token, {
          token, transactionId: request.transactionId, path, temporaryPath,
          beforeContent: current.content, items: change?.operation === "set" ? change.value as JsonValue : [],
          release,
        });
        return { prepared: true, prepareToken: token, validation: { valid: true, issues: [] }, activation: [{ boundary: "next-invocation", keys: ["hooks.entries"] }] };
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    },
    commit: async (request) => {
      const state = prepared.get(request.prepareToken);
      if (!state || state.transactionId !== request.transactionId) throw new Error("prepared hooks transaction is unavailable");
      let published = false;
      try {
        renameSync(state.temporaryPath, state.path);
        published = true;
        const doc = readDocument(request.context.cwd);
        state.committedRevision = doc.revision;
        return { snapshot: snapshot(doc, request.context.cwd), revisions: [doc.revision], changedKeys: ["hooks.entries"], activation: [{ boundary: "next-invocation", keys: ["hooks.entries"] }] };
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
          const current = readDocument(request.context.cwd);
          if (entry.committedRevision && current.revision.etag !== entry.committedRevision.etag) continue;
          writeFileSync(entry.path, entry.beforeContent);
          rolledBack = true;
          prepared.delete(token);
        } finally { await release(); }
      }
      const doc = readDocument(request.context.cwd);
      return { rolledBack, snapshot: snapshot(doc, request.context.cwd) };
    },
    applyRuntime: (request) => {
      for (const [token, entry] of [...prepared.entries()]) {
        if (entry.transactionId === request.transactionId) { prepared.delete(token); void entry.release(); }
      }
      return { appliedKeys: [], deferred: [{ boundary: "next-invocation", keys: ["hooks.entries"] }], failed: [] };
    },
  };
}

export function registerHooksSettingsProvider(events: SettingsEventBus, provider: HooksSettingsProvider): () => void {
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

function revision(path: string, content: string): SettingsResourceRevision {
  return {
    resource: { providerId: PROVIDER_ID, scope: "project", id: RESOURCE_ID },
    etag: createHash("sha256").update(content || "<missing>").digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}
