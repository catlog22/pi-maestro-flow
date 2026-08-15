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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  SETTINGS_SECRET_SET_PLACEHOLDER,
  type ConfiguredSettingValue,
  type EffectiveSettingValue,
  type JsonValue,
  type SettingDefinition,
  type SettingsChange,
  type SettingsContextV1,
  type SettingsProviderV1,
  type SettingsResource,
  type SettingsResourceRevision,
  type SettingsSnapshot,
  type SettingsValidationIssue,
  type SettingsValidationResult,
} from "pi-maestro-settings-core/v1";
import type { BackendConfigField } from "pi-maestro-backend-core/v1/backend";
import type { TeammateExecutionMode } from "pi-maestro-backend-core/v1/registry";

const PROVIDER_ID = "pi-maestro-teammate-backends";
const PROVIDER_VERSION = "1.0.0";
const DOCUMENT_ID = ".pi/teammate-backends.json";
const MODE_KEY = "teammateBackends.mode";
const DEFAULT_KEY = "teammateBackends.default";
const GROUP_DISPATCH = "teammateBackends.group.dispatch";

/** What the provider needs to know about a backend; not the backend itself. */
export interface BackendDescriptor {
  name: string;
  configFields?: readonly BackendConfigField[];
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

/** The registration document as stored on disk. */
interface Document {
  mode?: TeammateExecutionMode;
  default?: string;
  backends?: Record<string, { module?: string; config?: Record<string, JsonValue> }>;
}

/** Setting key for one backend field. */
function fieldKey(backend: string, field: string): string {
  return `teammateBackends.${backend}.${field}`;
}

/** Setting key holding a credential's value rather than its name. */
function secretKey(backend: string, field: string): string {
  return `${fieldKey(backend, field)}.value`;
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
    case "text":
    case "path":
    case "credential-ref":
      return { kind: "text" };
  }
}

/** Read the document, treating an absent or unreadable file as empty. */
function readDocument(path: string): { document: Document; raw: string } {
  if (!existsSync(path)) return { document: {}, raw: "" };
  const raw = readFileSync(path, "utf-8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { document: {}, raw };
    return { document: parsed as Document, raw };
  } catch {
    // A malformed document is reported through validation rather than thrown
    // here; the shell still needs to render so the operator can repair it.
    return { document: {}, raw };
  }
}

/** Content hash used as the resource etag. */
function etagOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Write a file atomically, creating parent directories. */
function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
  renameSync(temporary, path);
}

/** Parse a dotenv-style file into its key/value pairs. */
function readEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    entries.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }
  return entries;
}

/** Serialize env entries back to a dotenv file body. */
function formatEnvFile(entries: ReadonlyMap<string, string>): string {
  return [...entries].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
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
  const staged = new Map<string, { document: Document; secrets: Map<string, Map<string, string>> }>();

  const credentialPath = (backend: string): string => join(credentialRoot, backend, ".env");

  const resource = (): SettingsResource => ({ providerId: PROVIDER_ID, scope: "project", id: DOCUMENT_ID });

  const definitions = (): SettingDefinition[] => {
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
          options: options.backends.map((backend) => ({
            value: backend.name,
            labelKey: `teammateBackends.backend.${backend.name}`,
          })),
        },
      },
    ];

    for (const backend of options.backends) {
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

        if (field.kind !== "credential-ref") continue;
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

    for (const backend of options.backends) {
      const stored = document.backends?.[backend.name]?.config ?? {};
      const envEntries = readEnvFile(credentialPath(backend.name));
      for (const field of backend.configFields ?? []) {
        record(
          fieldKey(backend.name, field.key),
          stored[field.key],
          field.default as JsonValue | undefined,
          "project",
        );
        if (field.kind !== "credential-ref") continue;
        const variable = (stored[field.key] ?? field.default) as string | undefined;
        const key = secretKey(backend.name, field.key);
        // The value itself never leaves the env file; the shell learns only
        // whether one is present.
        if (variable !== undefined && envEntries.has(variable)) {
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
    secrets: Map<string, Map<string, string>>;
    issues: SettingsValidationIssue[];
  } => {
    const { document } = readDocument(documentPath);
    const secrets = new Map<string, Map<string, string>>();
    const issues: SettingsValidationIssue[] = [];
    const known = new Map(definitions().map((definition) => [definition.key, definition]));

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
        else if (change.value === "legacy" || change.value === "backend-registry") document.mode = change.value;
        else {
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
        else if (options.backends.some((backend) => backend.name === change.value)) {
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

      const owner = options.backends.find((backend) =>
        change.key.startsWith(`teammateBackends.${backend.name}.`));
      if (owner === undefined) continue;
      const remainder = change.key.slice(`teammateBackends.${owner.name}.`.length);
      const isSecret = remainder.endsWith(".value");
      const fieldName = isSecret ? remainder.slice(0, -".value".length) : remainder;
      const field = (owner.configFields ?? []).find((candidate) => candidate.key === fieldName);
      if (field === undefined) continue;

      if (!isSecret) {
        document.backends ??= {};
        document.backends[owner.name] ??= { module: owner.name };
        const config = (document.backends[owner.name]!.config ??= {});
        if (change.operation === "unset") delete config[fieldName];
        else config[fieldName] = change.value;
        continue;
      }

      const variable = (document.backends?.[owner.name]?.config?.[fieldName] ?? field.default) as string | undefined;
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
      const entries = secrets.get(owner.name) ?? readEnvFile(credentialPath(owner.name));
      if (change.operation === "unset") entries.delete(variable);
      else if (typeof change.value === "string" && change.value !== SETTINGS_SECRET_SET_PLACEHOLDER) {
        entries.set(variable, change.value);
      }
      secrets.set(owner.name, entries);
    }

    return { document, secrets, issues };
  };

  return {
    describe(_request: { context: SettingsContextV1 }) {
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
        settings: definitions(),
      };
    },

    read,

    validate(request): SettingsValidationResult {
      const { issues } = apply(request.changes);
      return { valid: issues.every((issue) => issue.severity !== "error"), issues };
    },

    prepare(request) {
      const { document, secrets, issues } = apply(request.changes);
      const valid = issues.every((issue) => issue.severity !== "error");
      if (valid) staged.set(request.transactionId, { document, secrets });
      return {
        prepared: valid,
        ...(valid ? { prepareToken: request.transactionId } : {}),
        validation: { valid, issues },
        activation: [{ boundary: "next-invocation" as const, keys: request.changes.map((change) => change.key) }],
      };
    },

    commit(request) {
      const pending = staged.get(request.prepareToken);
      if (pending === undefined) {
        throw new Error(`teammate backends settings: no prepared transaction ${request.prepareToken}`);
      }
      staged.delete(request.prepareToken);

      writeAtomic(documentPath, `${JSON.stringify(pending.document, null, 2)}\n`);
      for (const [backend, entries] of pending.secrets) {
        // Mode 0600 and a path outside the repository: the value is the one
        // thing here that must never become a committable artifact.
        writeAtomic(credentialPath(backend), formatEnvFile(entries), 0o600);
      }

      const snapshot = read();
      return {
        snapshot,
        revisions: snapshot.configured.resources,
        changedKeys: [],
        activation: [{ boundary: "next-invocation" as const, keys: [] }],
      };
    },

    abort(request) {
      staged.delete(request.prepareToken);
    },
  };
}
