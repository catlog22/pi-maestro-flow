/**
 * Settings provider for the teammate execution backends.
 *
 * Surfaces two things: which dispatch path teammate takes, and each registered
 * backend's own declared configuration. The second half is generic — the fields
 * come from `backend.configFields`, so a newly registered backend appears in
 * the shell without this file learning anything about it.
 *
 * Credential handling follows the runtime's own model rather than inventing
 * one. A `credential-ref` field yields two settings: the variable name, which
 * lives in the committable registration document, and the value, which is
 * written to the backend runtime's own env file outside the repository and is
 * never returned to the shell.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileDurableSync } from "./durable-write.ts";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  SETTINGS_SECRET_SET_PLACEHOLDER,
  type ConfiguredSettingValue,
  type EffectiveSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsAnnounceEventV1,
  type SettingsListOptionsRequestV1,
  type SettingsListOptionsResultV1,
  type SettingsChange,
  type SettingsContextV1,
  type SettingsDiscoverEventV1,
  type SettingsProviderV1,
  type SettingsResource,
  type SettingsResourceRevision,
  type SettingsSnapshot,
  type SupportedSettingsLocale,
  type TranslationCatalogs,
  type SettingsValidationIssue,
  type SettingsValidationResult,
} from "pi-maestro-settings-core/v1";
import type {
  BackendConfigField,
  BackendConfigOption,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import type { TeammateExecutionMode } from "pi-maestro-backend-core/v1/registry";

const PROVIDER_ID = "pi-maestro-teammate-backends";
const PROVIDER_VERSION = "1.0.0";
const DOCUMENT_ID = ".pi/teammate-backends.json";
const MODE_KEY = "teammateBackends.mode";
const DEFAULT_KEY = "teammateBackends.default";
const GROUP_DISPATCH = "teammateBackends.group.dispatch";

const BASE_CATALOGS = {
  en: {
    "teammateBackends.provider": "Teammate backends",
    "teammateBackends.provider.description": "Execution mode, default deployment, and backend configuration",
    "teammateBackends.group.dispatch": "Dispatch",
    "teammateBackends.mode": "Execution mode",
    "teammateBackends.mode.description": "Select the dispatch authority used for the next invocation.",
    "teammateBackends.mode.legacy": "Legacy",
    "teammateBackends.mode.registry": "Backend registry",
    "teammateBackends.mode.modelRegistry": "Model registry",
    "teammateBackends.default": "Default deployment",
    "teammateBackends.default.description": "Deployment used when a task does not select one.",
    "teammateBackends.credentialValue.description": "Credential value stored in the backend runtime's owner-only environment file.",
    "teammateBackends.error.documentMalformed": "The backend registration document at {path} is malformed.",
    "teammateBackends.error.unknownKey": "Unknown teammate backend setting: {key}",
    "teammateBackends.error.invalidMode": "Unsupported teammate execution mode.",
    "teammateBackends.error.unknownBackend": "The selected backend deployment is not registered.",
    "teammateBackends.error.credentialNameInvalid": "The credential variable name for {field} is invalid.",
    "teammateBackends.error.credentialNameMissing": "Set the credential variable name for {field} before its value.",
    "teammateBackends.error.credentialValueInvalid": "The credential value for {field} contains an unsupported control character.",
  },
  "zh-CN": {
    "teammateBackends.provider": "Teammate 后端",
    "teammateBackends.provider.description": "执行模式、默认部署与后端配置",
    "teammateBackends.group.dispatch": "分派",
    "teammateBackends.mode": "执行模式",
    "teammateBackends.mode.description": "选择下一次调用使用的分派来源。",
    "teammateBackends.mode.legacy": "旧版",
    "teammateBackends.mode.registry": "后端注册表",
    "teammateBackends.mode.modelRegistry": "模型注册表",
    "teammateBackends.default": "默认部署",
    "teammateBackends.default.description": "任务未指定部署时使用的默认值。",
    "teammateBackends.credentialValue.description": "凭据值存储在后端运行时仅所有者可读的环境文件中。",
    "teammateBackends.error.documentMalformed": "后端注册文档 {path} 格式错误。",
    "teammateBackends.error.unknownKey": "未知的 Teammate 后端设置：{key}",
    "teammateBackends.error.invalidMode": "不支持的 Teammate 执行模式。",
    "teammateBackends.error.unknownBackend": "所选后端部署尚未注册。",
    "teammateBackends.error.credentialNameInvalid": "{field} 的凭据变量名无效。",
    "teammateBackends.error.credentialNameMissing": "请先设置 {field} 的凭据变量名，再设置其值。",
    "teammateBackends.error.credentialValueInvalid": "{field} 的凭据值包含不支持的控制字符。",
  },
} as const;

/**
 * Registration the document falls back to.
 *
 * A written document must always name a mode and a default: the registry reader
 * rejects one that does not, so committing a document containing only the field
 * the operator edited would make the very next dispatch fail to load it.
 */
const DEFAULT_MODE: TeammateExecutionMode = "legacy";
const DEFAULT_BACKEND = "pi-subprocess";

/**
 * How long a prepared-but-unresolved transaction may hold a secret in memory.
 *
 * Generous relative to a settings dialog and short relative to a session: the
 * point is that an abandoned prepare stops being a resident credential, not
 * that a slow operator loses their edit.
 */
const STAGED_TRANSACTION_TTL_MS = 10 * 60 * 1000;
/** Editor `optionsSource` for every backend field whose values a probe reads. */
const DYNAMIC_OPTIONS_SOURCE = "teammateBackends.backend-options";
/**
 * How long a probe may take before the shell is told the source did not answer.
 *
 * The protocol carries no abort signal, so the bound lives here. Generous
 * because a probe launches a process and completes a protocol handshake, and an
 * operator who opened the picker is waiting on purpose.
 */
const DYNAMIC_OPTIONS_TIMEOUT_MS = 90_000;

/** What the provider needs to know about a backend; not the backend itself. */
export interface BackendDescriptor {
  name: string;
  /**
   * Module specifier the registry loader resolves for this backend.
   *
   * Required because the registration name and the module are different things:
   * writing the name here produced documents naming `"dsh"` as a module, which
   * no loader can resolve, so every document this provider wrote for a
   * non-built-in backend failed at load.
   */
  module: string;
  configFields?: readonly BackendConfigField[];
  /**
   * Reads the values a `dynamic-enum` field can take, by asking the system that
   * owns them. Carried on the descriptor because the shell renders from
   * descriptors, not from loaded backends: a registration's picker must fill
   * even before the registry has resolved that registration.
   */
  listConfigOptions?: (
    field: string,
    config: Record<string, ConfigValue>,
    signal: AbortSignal,
  ) => Promise<readonly BackendConfigOption[]>;
  /**
   * Display text for this backend's `labelKey` / `descriptionKey` values.
   *
   * The keys belong to the backend that declares the fields, so their text does
   * too: this provider stays ignorant of what any backend's settings mean, and
   * a backend that adds a field brings its own wording. A descriptor with no
   * catalog renders its keys verbatim — a defect the shell shows but nothing
   * else reports.
   */
  catalogs?: TranslationCatalogs;
}

/** Everything the provider needs from its host. */
export interface TeammateBackendsSettingsOptions {
  /** Directory holding `.pi/`. */
  workspaceRoot: string;
  /** Backends whose fields the shell should render. */
  backends: readonly BackendDescriptor[];
  /** Root for per-backend credential files; defaults to `~/.dsh`. */
  credentialRoot?: string;
}

/** One deployment registration as stored on disk. Unknown fields are retained. */
interface RegistrationDocument extends Record<string, unknown> {
  module?: unknown;
  config?: Record<string, JsonValue>;
}

/** The registration document as stored on disk. Unknown fields are retained. */
interface Document extends Record<string, unknown> {
  version?: unknown;
  mode?: TeammateExecutionMode;
  default?: string;
  defaultModel?: unknown;
  backends?: Record<string, RegistrationDocument>;
  models?: unknown;
  compatibility?: unknown;
}

interface DeploymentDescriptor extends BackendDescriptor {
  /** Exact key of this deployment in the registration document. */
  name: string;
}

/** Setting key for one backend field. */
function fieldKey(backend: string, field: string): string {
  return `teammateBackends.${backend}.${field}`;
}

/** Setting key holding a credential's value rather than its name. */
function secretKey(backend: string, field: string): string {
  return `${fieldKey(backend, field)}.value`;
}

/**
 * Whether this provider can store the secret a field asks for.
 *
 * One home for the rule, because `describe`, `read`, and `apply` each act on it
 * and any two of them disagreeing is a defect: declaring a setting nobody can
 * write, reporting a value for a setting nobody declared, or accepting a write
 * the shell never offered.
 *
 * @param field - the backend's declared field.
 * @returns true when the value belongs in the runtime's own env file.
 */
function servesCredential(field: BackendConfigField): boolean {
  // This provider writes a key into the runtime's own env file and nothing
  // else. `env-var` would need the host to construct the child's environment
  // around a provider credential, which is the custody this design refuses.
  return field.kind === "credential-ref" && field.credentialLocation !== "env-var";
}

/** Map a backend field kind onto a shell editor. */
function editorFor(field: BackendConfigField): SettingDefinition["editor"] {
  switch (field.kind) {
    case "boolean":
      return { kind: "boolean" };
    case "integer":
      return { kind: "integer" };
    case "number":
      return { kind: "number" };
    case "string-list":
      return { kind: "string-list" };
    case "enum":
      return {
        kind: "enum",
        options: (field.options ?? []).map((option) => ({
          value: option.value,
          labelKey: option.labelKey,
        })),
      };
    // The values are the executing system's to publish, so the editor names a
    // source the shell resolves when the operator opens it rather than a list
    // this description could carry.
    case "dynamic-enum":
      return { kind: "enum", optionsSource: DYNAMIC_OPTIONS_SOURCE };
    case "text":
    case "path":
    case "credential-ref":
      return { kind: "text" };
  }
}

/**
 * Read the document, treating an absent file as empty.
 *
 * A malformed file yields empty values plus `malformed: true` rather than
 * throwing: the shell still has to render so the operator can see the settings
 * and the reason. Writing is what must not proceed — a commit rebuilt from the
 * empty parse would replace the operator's broken file with a plausible one,
 * destroying the content they were about to repair.
 */
function readDocument(path: string): { document: Document; raw: string; malformed: boolean } {
  if (!existsSync(path)) return { document: {}, raw: "", malformed: false };
  const raw = readFileSync(path, "utf-8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { document: {}, raw, malformed: true };
    }
    return { document: parsed as Document, raw, malformed: false };
  } catch {
    return { document: {}, raw, malformed: true };
  }
}

/** Narrow an unknown JSON value without changing it. */
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read an exact deployment registration without accepting prototype keys. */
function registrationOf(document: Document, deploymentId: string): RegistrationDocument | undefined {
  const backends = jsonObject(document.backends);
  if (backends === undefined || !Object.hasOwn(backends, deploymentId)) return undefined;
  return jsonObject(backends[deploymentId]) as RegistrationDocument | undefined;
}

/** Read a deployment's config when it is an object. */
function registrationConfig(registration: RegistrationDocument | undefined): Record<string, JsonValue> {
  return (jsonObject(registration?.config) ?? {}) as Record<string, JsonValue>;
}

/** Content hash used as the resource etag. */
function etagOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Environment variable names a credential reference may take.
 *
 * Enforced here rather than left to each backend: the name is interpolated into
 * a dotenv file this provider writes, so a value containing a newline or an `=`
 * would inject an unrelated variable into the runtime's environment. The rule
 * is the POSIX portable name set, which every backend that reads an env var
 * needs anyway.
 */
const ENV_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Values are written as one dotenv assignment, so line/control injection fails closed. */
const UNSAFE_CREDENTIAL_VALUE = /[\r\n\0]/;

/**
 * Write a credential file, creating its directory owner-only.
 *
 * `mkdir` inside the durable writer uses the process umask, which commonly
 * yields a world-readable directory. The file is 0600 either way, but a
 * traversable parent still tells everyone on the host which backends have
 * credentials configured.
 */
function writeCredentialFile(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir applies the umask to `mode`, and does nothing at all when the
  // directory already exists from an earlier release.
  try {
    chmodSync(directory, 0o700);
  } catch {
    // A directory owned by another user cannot be tightened from here; the
    // 0600 file mode below is the guarantee that does not depend on this.
  }
  writeFileDurableSync(path, content);
  // Atomic replacement inherits the temporary file's mode on POSIX, but some
  // hosts normalize it during rename. Reapply both custody boundaries after
  // the final path exists.
  try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX hosts */ }
  try { chmodSync(directory, 0o700); } catch { /* see directory note above */ }
}

/**
 * A dotenv file as its original lines plus the assignments found in them.
 *
 * The lines are kept because this provider owns only the variables the backends
 * declare. The same file routinely holds an operator's comments and unrelated
 * variables, and rewriting it from the parsed assignments alone would delete
 * both — a settings edit must not silently rewrite a file it shares.
 */
interface EnvDocument {
  lines: string[];
  /** Assignment key to the index in `lines` that sets it; last assignment wins. */
  index: Map<string, number>;
}

/** Split one dotenv line into its key and value, or undefined when it sets nothing. */
function envAssignment(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return undefined;
  return { key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1) };
}

/** Read a dotenv file, keeping every line so unrelated content survives a write. */
function readEnvDocument(path: string): EnvDocument {
  const index = new Map<string, number>();
  if (!existsSync(path)) return { lines: [], index };
  const body = readFileSync(path, "utf-8");
  // A trailing newline yields a final empty element; dropping it keeps a
  // round-trip from growing the file by one blank line per write.
  const lines = body.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const [position, line] of lines.entries()) {
    const assignment = envAssignment(line);
    if (assignment !== undefined) index.set(assignment.key, position);
  }
  return { lines, index };
}

/** Read one variable's value, or undefined when the file does not set it. */
function envValue(document: EnvDocument, key: string): string | undefined {
  const position = document.index.get(key);
  if (position === undefined) return undefined;
  return envAssignment(document.lines[position]!)?.value;
}

/** Set or replace one variable in place, appending when it is new. */
function setEnvValue(document: EnvDocument, key: string, value: string): void {
  const position = document.index.get(key);
  if (position === undefined) {
    document.index.set(key, document.lines.length);
    document.lines.push(`${key}=${value}`);
    return;
  }
  document.lines[position] = `${key}=${value}`;
}

/** Remove one variable, leaving every other line untouched. */
function deleteEnvValue(document: EnvDocument, key: string): void {
  const position = document.index.get(key);
  if (position === undefined) return;
  document.lines.splice(position, 1);
  document.index.delete(key);
  for (const [other, at] of document.index) {
    if (at > position) document.index.set(other, at - 1);
  }
}

/** Serialize a dotenv document back to a file body. */
function formatEnvDocument(document: EnvDocument): string {
  return document.lines.length === 0 ? "" : `${document.lines.join("\n")}\n`;
}

/**
 * Build the settings provider for teammate execution backends.
 *
 * @param options - workspace root, the backends to render, and the credential root.
 * @returns the provider, ready to register with the settings shell.
 */
export function createTeammateBackendsSettingsProvider(
  options: TeammateBackendsSettingsOptions,
): SettingsProviderV1 {
  const documentPath = join(options.workspaceRoot, ".pi", "teammate-backends.json");
  const credentialRoot = options.credentialRoot ?? join(homedir(), ".dsh");
  const staged = new Map<string, {
    document: Document;
    secrets: Map<string, EnvDocument>;
    changedKeys: readonly string[];
    /** Etag of the document this transaction was prepared against. */
    etag: string;
    /** When this transaction was prepared, for expiry. */
    preparedAt: number;
  }>();

  /**
   * Drop transactions the shell prepared and never resolved.
   *
   * A staged transaction holds credential values in plaintext. Commit and abort
   * both clear it, but neither is guaranteed to arrive — a shell that crashes
   * or a dialog the operator walks away from leaves the secret resident for the
   * rest of the process's life.
   */
  const expireStaged = (): void => {
    const deadline = Date.now() - STAGED_TRANSACTION_TTL_MS;
    for (const [token, pending] of staged) {
      if (pending.preparedAt < deadline) staged.delete(token);
    }
  };

  const credentialDirectory = (deploymentId: string): string => {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deploymentId)
      && deploymentId !== "." && deploymentId !== "..") return deploymentId;
    return `_deployment-${createHash("sha256").update(deploymentId).digest("hex").slice(0, 16)}`;
  };

  const credentialPath = (backend: string): string =>
    join(credentialRoot, credentialDirectory(backend), ".env");

  /**
   * Bind stored deployment ids to shipped descriptors by exact module.
   *
   * A descriptor name is only offered as a new registration when the document
   * does not already occupy that exact key. This prevents a third-party
   * deployment called `dsh` from being edited with DSH's field declaration.
   */
  const deploymentDescriptors = (document: Document): DeploymentDescriptor[] => {
    const deployments = new Map<string, DeploymentDescriptor>();
    const backends = jsonObject(document.backends) ?? {};
    for (const [deploymentId, rawRegistration] of Object.entries(backends)) {
      const registration = jsonObject(rawRegistration);
      const module = registration?.module;
      if (typeof module !== "string") continue;
      const descriptor = options.backends.find((candidate) => candidate.module === module);
      if (descriptor !== undefined) deployments.set(deploymentId, { ...descriptor, name: deploymentId });
    }
    for (const descriptor of options.backends) {
      if (!Object.hasOwn(backends, descriptor.name)) deployments.set(descriptor.name, descriptor);
    }
    return [...deployments.values()];
  };

  const availableDeploymentIds = (document: Document): string[] => {
    const ids = new Set(deploymentDescriptors(document).map((deployment) => deployment.name));
    for (const id of Object.keys(jsonObject(document.backends) ?? {})) ids.add(id);
    return [...ids];
  };

  const deploymentField = (
    document: Document,
    key: string,
  ): { deployment: DeploymentDescriptor; field: BackendConfigField; secret: boolean } | undefined => {
    for (const deployment of deploymentDescriptors(document)) {
      for (const field of deployment.configFields ?? []) {
        if (key === fieldKey(deployment.name, field.key)) {
          return { deployment, field, secret: false };
        }
        if (servesCredential(field) && key === secretKey(deployment.name, field.key)) {
          return { deployment, field, secret: true };
        }
      }
    }
    return undefined;
  };

  /**
   * Merge this provider's own text with each deployment's catalog.
   *
   * Three sources, in one place because the shell takes one catalog per
   * provider: the dispatch settings this file owns, the per-deployment keys
   * it composes (`teammateBackends.backend.<name>` and `.group.<name>`, rendered
   * rather than translated because the registration name is the operator's
   * own label), and whatever a descriptor supplies for its own fields. A
   * deployment without a catalog still gets its name and group rendered; only
   * its field labels fall back to their raw keys — which the settings catalog
   * gate surfaces as a failure rather than silently rendering identifiers.
   *
   * The deployments come from {@link deploymentDescriptors} so a model-registry
   * document that enables a subset of the registered backends still publishes
   * exactly those.
   */
  const catalogs = (document: Document): TranslationCatalogs => {
    const locales = new Set<SupportedSettingsLocale>(["en", "zh-CN"]);
    for (const deployment of deploymentDescriptors(document)) {
      for (const locale of Object.keys(deployment.catalogs ?? {})) {
        locales.add(locale as SupportedSettingsLocale);
      }
    }
    const merged: Partial<Record<SupportedSettingsLocale, Record<string, string>>> = {};
    for (const locale of locales) {
      const entries: Record<string, string> = { ...(BASE_CATALOGS[locale] ?? BASE_CATALOGS.en ?? {}) };
      for (const deployment of deploymentDescriptors(document)) {
        // The registration name is the operator's own label for it, so it is
        // rendered rather than translated.
        entries[`teammateBackends.backend.${deployment.name}`] = deployment.name;
        entries[`teammateBackends.group.${deployment.name}`] = deployment.name;
        for (const field of deployment.configFields ?? []) {
          if (!servesCredential(field)) continue;
          const label = deployment.catalogs?.[locale]?.[field.labelKey]
            ?? deployment.catalogs?.en?.[field.labelKey];
          if (label !== undefined) entries[`${field.labelKey}.value`] = label;
        }
        Object.assign(entries, deployment.catalogs?.[locale] ?? {});
      }
      merged[locale] = entries;
    }
    return merged;
  };

  const resource = (): SettingsResource => ({ providerId: PROVIDER_ID, scope: "project", id: DOCUMENT_ID });

  const definitions = (document = readDocument(documentPath).document): SettingDefinition[] => {
    const deployments = deploymentDescriptors(document);
    const list: SettingDefinition[] = [
      {
        key: MODE_KEY,
        group: GROUP_DISPATCH,
        order: 0,
        labelKey: "teammateBackends.mode",
        descriptionKey: "teammateBackends.mode.description",
        defaultValue: "legacy",
        scopes: ["project"],
        merge: "override",
        // A running dispatch keeps the path it started on; switching mid-turn
        // would leave one graph half-routed.
        activation: "next-invocation",
        sensitivity: "public",
        reversibility: "full",
        editor: {
          kind: "enum",
          options: [
            { value: "legacy", labelKey: "teammateBackends.mode.legacy" },
            { value: "backend-registry", labelKey: "teammateBackends.mode.registry" },
            { value: "model-registry", labelKey: "teammateBackends.mode.modelRegistry" },
          ],
        },
      },
      {
        key: DEFAULT_KEY,
        group: GROUP_DISPATCH,
        order: 1,
        labelKey: "teammateBackends.default",
        descriptionKey: "teammateBackends.default.description",
        defaultValue: "pi-subprocess",
        scopes: ["project"],
        merge: "override",
        activation: "next-invocation",
        sensitivity: "public",
        reversibility: "full",
        editor: {
          kind: "enum",
          options: availableDeploymentIds(document).map((deploymentId) => ({
            value: deploymentId,
            labelKey: `teammateBackends.backend.${deploymentId}`,
          })),
        },
      },
    ];

    for (const backend of deployments) {
      let order = 0;
      for (const field of backend.configFields ?? []) {
        order += 1;
        list.push({
          key: fieldKey(backend.name, field.key),
          group: `teammateBackends.group.${backend.name}`,
          order,
          labelKey: field.labelKey,
          ...(field.descriptionKey === undefined ? {} : { descriptionKey: field.descriptionKey }),
          ...(field.default === undefined ? {} : { defaultValue: field.default as JsonValue }),
          scopes: ["project"],
          merge: "override",
          activation: "next-invocation",
          // A credential *reference* is public: it names a lookup, and hiding
          // the name helps nobody diagnose a missing variable.
          sensitivity: "public",
          reversibility: "full",
          editor: editorFor(field),
        });

        if (!servesCredential(field)) continue;
        order += 1;
        list.push({
          key: secretKey(backend.name, field.key),
          group: `teammateBackends.group.${backend.name}`,
          order,
          labelKey: `${field.labelKey}.value`,
          descriptionKey: "teammateBackends.credentialValue.description",
          scopes: ["global"],
          merge: "override",
          activation: "next-invocation",
          sensitivity: "secret",
          // The value leaves this process only into the runtime's own env file;
          // clearing the setting removes the entry, which is the whole undo.
          reversibility: "full",
          editor: { kind: "secret" },
        });
      }
    }
    return list;
  };

  const read = (): SettingsSnapshot => {
    const { document, raw } = readDocument(documentPath);
    const configured: ConfiguredSettingValue[] = [];
    const effective: EffectiveSettingValue[] = [];

    const record = (key: string, value: JsonValue | undefined, fallback: JsonValue | undefined, scope: "project" | "global"): void => {
      if (value === undefined) {
        configured.push({ key, scope, state: "absent" });
        if (fallback !== undefined) effective.push({ key, value: fallback, source: "default" });
        return;
      }
      configured.push({ key, scope, state: "set", value, resource: resource() });
      effective.push({ key, value, source: "configured", scope, resource: resource() });
    };

    record(MODE_KEY, document.mode, "legacy", "project");
    record(DEFAULT_KEY, document.default, "pi-subprocess", "project");

    for (const backend of deploymentDescriptors(document)) {
      const stored = registrationConfig(registrationOf(document, backend.name));
      const envDocument = readEnvDocument(credentialPath(backend.name));
      for (const field of backend.configFields ?? []) {
        record(
          fieldKey(backend.name, field.key),
          stored[field.key],
          field.default as JsonValue | undefined,
          "project",
        );
        if (!servesCredential(field)) continue;
        const variable = (stored[field.key] ?? field.default) as string | undefined;
        const key = secretKey(backend.name, field.key);
        // The value itself never leaves the env file; the shell learns only
        // whether one is present.
        if (variable !== undefined && envValue(envDocument, variable) !== undefined) {
          configured.push({ key, scope: "global", state: "set", value: SETTINGS_SECRET_SET_PLACEHOLDER });
          effective.push({ key, value: SETTINGS_SECRET_SET_PLACEHOLDER, source: "configured", scope: "global" });
        } else {
          configured.push({ key, scope: "global", state: "absent" });
        }
      }
    }

    const revisions: SettingsResourceRevision[] = [{
      resource: resource(),
      etag: etagOf(raw),
      size: raw.length,
      ...(existsSync(documentPath) ? { modifiedAt: statSync(documentPath).mtimeMs } : {}),
    }];

    return {
      providerId: PROVIDER_ID,
      providerInstanceId: PROVIDER_ID,
      configured: { values: configured, resources: revisions },
      effective: { values: effective },
    };
  };

  /** Apply changes onto an in-memory document plus per-backend secret files. */
  const apply = (changes: readonly SettingsChange[]): {
    document: Document;
    secrets: Map<string, EnvDocument>;
    issues: SettingsValidationIssue[];
    etag: string;
  } => {
    const { document, raw, malformed } = readDocument(documentPath);
    const etag = etagOf(raw);
    const secrets = new Map<string, EnvDocument>();
    const issues: SettingsValidationIssue[] = [];
    if (malformed || (document.backends !== undefined && jsonObject(document.backends) === undefined)) {
      issues.push({
        severity: "error",
        code: "document-malformed",
        messageKey: "teammateBackends.error.documentMalformed",
        params: { path: DOCUMENT_ID },
      });
      return { document, secrets, issues, etag };
    }
    const known = new Map(definitions(document).map((definition) => [definition.key, definition]));

    for (const change of changes) {
      const definition = known.get(change.key);
      if (definition === undefined) {
        issues.push({
          severity: "error",
          code: "unknown-key",
          messageKey: "teammateBackends.error.unknownKey",
          params: { key: change.key },
          key: change.key,
        });
        continue;
      }

      if (change.key === MODE_KEY) {
        if (change.operation === "unset") delete document.mode;
        else if (change.value === "legacy" || change.value === "backend-registry" || change.value === "model-registry") {
          document.mode = change.value;
        } else {
          issues.push({
            severity: "error",
            code: "invalid-mode",
            messageKey: "teammateBackends.error.invalidMode",
            params: { value: String(change.value) },
            key: change.key,
          });
        }
        continue;
      }

      if (change.key === DEFAULT_KEY) {
        if (change.operation === "unset") delete document.default;
        else if (availableDeploymentIds(document).includes(String(change.value))) {
          document.default = String(change.value);
        } else {
          issues.push({
            severity: "error",
            code: "unknown-backend",
            messageKey: "teammateBackends.error.unknownBackend",
            params: { value: String(change.value) },
            key: change.key,
          });
        }
        continue;
      }

      const selected = deploymentField(document, change.key);
      if (selected === undefined) continue;
      const { deployment: owner, field, secret: isSecret } = selected;
      const fieldName = field.key;

      if (!isSecret) {
        // A credential reference names a lookup. Rejecting anything that is not
        // a variable name is what keeps a pasted secret out of the committable
        // document, and it belongs here rather than in each backend: this is the
        // code that writes the name into a dotenv file.
        if (field.kind === "credential-ref" && change.operation !== "unset") {
          if (typeof change.value !== "string" || !ENV_VARIABLE_NAME.test(change.value)) {
            issues.push({
              severity: "error",
              code: "credential-name-invalid",
              messageKey: "teammateBackends.error.credentialNameInvalid",
              // The rejected value is deliberately absent from the message: the
              // most likely reason it was rejected is that it is the key.
              params: { field: fieldName },
              key: change.key,
            });
            continue;
          }
        }
        document.backends ??= {};
        const registration = (document.backends[owner.name] ??= { module: owner.module });
        // Existing deployments reached this branch only through an exact
        // module match. Never rewrite their module or any sibling field.
        const config = (registration.config ??= {});
        // The default when the document never recorded one: that is the name a
        // stored value is actually under, so a rename away from it must carry.
        const previous = config[fieldName] ?? (field.default as JsonValue | undefined);
        const renamed = change.operation === "unset" ? undefined : change.value;
        if (change.operation === "unset") delete config[fieldName];
        else config[fieldName] = change.value;
        // Renaming the variable moves its value. Leaving it under the old name
        // would strand a live credential in the runtime's env file while the
        // shell reports the new name as unset.
        // Only for a credential this provider actually stores; renaming a
        // reference it never wrote has no value to carry and no file to touch.
        if (servesCredential(field) && typeof previous === "string" && previous !== renamed) {
          const entries = secrets.get(owner.name) ?? readEnvDocument(credentialPath(owner.name));
          const carried = envValue(entries, previous);
          deleteEnvValue(entries, previous);
          if (carried !== undefined && typeof renamed === "string") {
            setEnvValue(entries, renamed, carried);
          }
          secrets.set(owner.name, entries);
        }
        continue;
      }

      const variable = (registrationConfig(registrationOf(document, owner.name))[fieldName]
        ?? field.default) as string | undefined;
      if (variable === undefined) {
        issues.push({
          severity: "error",
          code: "credential-name-missing",
          messageKey: "teammateBackends.error.credentialNameMissing",
          params: { field: fieldName },
          key: change.key,
        });
        continue;
      }
      if (!ENV_VARIABLE_NAME.test(variable)) {
        issues.push({
          severity: "error",
          code: "credential-name-invalid",
          messageKey: "teammateBackends.error.credentialNameInvalid",
          params: { field: fieldName },
          key: change.key,
        });
        continue;
      }
      const entries = secrets.get(owner.name) ?? readEnvDocument(credentialPath(owner.name));
      if (change.operation === "unset") deleteEnvValue(entries, variable);
      else if (typeof change.value !== "string" || UNSAFE_CREDENTIAL_VALUE.test(change.value)) {
        issues.push({
          severity: "error",
          code: "credential-value-invalid",
          messageKey: "teammateBackends.error.credentialValueInvalid",
          // Never include the rejected value: this is a write-only secret.
          params: { field: fieldName },
          key: change.key,
        });
        continue;
      } else if (change.value !== SETTINGS_SECRET_SET_PLACEHOLDER) {
        setEnvValue(entries, variable, change.value);
      }
      secrets.set(owner.name, entries);
    }

    // The reader rejects a document without a mode and a default, so completing
    // it here is what makes a partial edit produce a loadable file.
    document.mode ??= DEFAULT_MODE;
    document.default ??= DEFAULT_BACKEND;

    return { document, secrets, issues, etag };
  };

  return {
    describe(_request: { context: SettingsContextV1 }) {
      const { document } = readDocument(documentPath);
      return {
        id: PROVIDER_ID,
        version: PROVIDER_VERSION,
        instanceId: PROVIDER_ID,
        labelKey: "teammateBackends.provider",
        descriptionKey: "teammateBackends.provider.description",
        capabilities: {
          read: true as const,
          write: true,
          prepareCommit: true,
          rollback: "none" as const,
          hotUpdate: false,
        },
        settings: definitions(document),
        catalogs: catalogs(document),
      };
    },

    read,

    async listOptions(request: SettingsListOptionsRequestV1): Promise<SettingsListOptionsResultV1> {
      if (request.optionsSource !== DYNAMIC_OPTIONS_SOURCE) {
        return { options: [], failure: `Unknown options source "${request.optionsSource}"` };
      }
      // Resolve the exact generated key back to its deployment. Deployment ids
      // may contain dots or prefix one another, so splitting/startsWith would
      // let one registration's editor probe another registration.
      const { document } = readDocument(documentPath);
      const selected = deploymentField(document, request.key);
      const backendName = selected?.deployment.name;
      const fieldName = selected?.field.key;
      const descriptor = selected?.secret === false ? selected.deployment : undefined;
      if (descriptor?.listConfigOptions === undefined) {
        return { options: [], failure: `Backend "${backendName ?? request.key}" publishes no dynamic settings` };
      }

      // The probe launches whatever the document currently configures, so an
      // operator editing an unsaved command still probes the saved one. Saying
      // which values were used beats silently probing a different launch.
      const config = registrationConfig(registrationOf(document, backendName!)) as Record<string, ConfigValue>;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DYNAMIC_OPTIONS_TIMEOUT_MS);
      try {
        const published = await descriptor.listConfigOptions(fieldName!, config, controller.signal);
        return {
          options: published.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        };
      } catch (error) {
        // Surfaced rather than swallowed: an unreachable or unauthenticated
        // executor is a state the operator must act on, and an empty picker
        // would read as "this backend offers no models".
        return { options: [], failure: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    },

    validate(request): SettingsValidationResult {
      const { issues } = apply(request.changes);
      return { valid: issues.every((issue) => issue.severity !== "error"), issues };
    },

    prepare(request) {
      expireStaged();
      const { document, secrets, issues, etag } = apply(request.changes);
      const valid = issues.every((issue) => issue.severity !== "error");
      if (valid) {
        staged.set(request.transactionId, {
          document,
          secrets,
          changedKeys: request.changes.map((change) => change.key),
          etag,
          preparedAt: Date.now(),
        });
      }
      return {
        prepared: valid,
        ...(valid ? { prepareToken: request.transactionId } : {}),
        validation: { valid, issues },
        activation: [{ boundary: "next-invocation" as const, keys: request.changes.map((change) => change.key) }],
      };
    },

    commit(request) {
      expireStaged();
      const pending = staged.get(request.prepareToken);
      if (pending === undefined) {
        throw new Error(`teammate backends settings: no prepared transaction ${request.prepareToken}`);
      }
      staged.delete(request.prepareToken);

      // The document is read at prepare and rewritten whole at commit, so an
      // edit made between the two would be erased. Refusing is the only honest
      // answer: this provider cannot merge two concurrent edits.
      const current = etagOf(readDocument(documentPath).raw);
      if (current !== pending.etag) {
        throw new Error(
          `teammate backends settings: ${DOCUMENT_ID} changed since this transaction was prepared; `
          + "re-read the settings and apply the change again",
        );
      }

      writeFileDurableSync(documentPath, `${JSON.stringify(pending.document, null, 2)}\n`);
      for (const [backend, entries] of pending.secrets) {
        // Mode 0600 in an owner-only directory outside the repository: the value
        // is the one thing here that must never become a committable artifact.
        writeCredentialFile(credentialPath(backend), formatEnvDocument(entries));
      }

      const snapshot = read();
      return {
        snapshot,
        revisions: snapshot.configured.resources,
        changedKeys: pending.changedKeys,
        activation: [{ boundary: "next-invocation" as const, keys: pending.changedKeys }],
      };
    },

    abort(request) {
      staged.delete(request.prepareToken);
    },
  };
}

/** The subset of the host event bus this provider announces itself on. */
interface SettingsEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
  emit(event: string, payload: unknown): void;
}

/** Whether a payload is a well-formed discovery request. */
function isDiscover(payload: unknown): payload is SettingsDiscoverEventV1 {
  return Boolean(payload && typeof payload === "object"
    && (payload as Partial<SettingsDiscoverEventV1>).version === SETTINGS_PROTOCOL_VERSION
    && typeof (payload as Partial<SettingsDiscoverEventV1>).requestId === "string");
}

/**
 * Announce this provider to the settings shell.
 *
 * Without this the provider is complete and unreachable: nothing emits it, so
 * the execution-mode toggle and every backend field exist only in tests.
 *
 * @param events - the host event bus.
 * @param provider - the provider to announce.
 * @returns a disposer that stops answering discovery.
 */
export function registerTeammateBackendsSettingsProvider(
  events: SettingsEventBus,
  provider: SettingsProviderV1,
): () => void {
  const announce = (requestId?: string): void => {
    const payload: SettingsAnnounceEventV1 = {
      version: SETTINGS_PROTOCOL_VERSION,
      requestId,
      providerId: PROVIDER_ID,
      instanceId: PROVIDER_ID,
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
