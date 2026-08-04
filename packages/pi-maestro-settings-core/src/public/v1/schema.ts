export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export const SETTINGS_SCOPES = ["global", "project", "local", "session"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/**
 * Masked placeholder providers return for a set secret value. The shell renders
 * this as "set" and never echoes the provider's actual value back.
 */
export const SETTINGS_SECRET_SET_PLACEHOLDER = "__set__";

export const SETTINGS_ACTIVATIONS = [
  "live",
  "next-invocation",
  "next-turn",
  "extension-reload",
  "next-session",
] as const;
export type SettingsActivation = (typeof SETTINGS_ACTIVATIONS)[number];

export const SETTINGS_SENSITIVITIES = ["public", "private", "secret"] as const;
export type SettingsSensitivity = (typeof SETTINGS_SENSITIVITIES)[number];

export const SETTINGS_REVERSIBILITIES = ["full", "reload-required", "none"] as const;
export type SettingsReversibility = (typeof SETTINGS_REVERSIBILITIES)[number];

export const SETTINGS_MERGE_STRATEGIES = ["override", "deep-merge", "append-unique", "provider-defined"] as const;
export type SettingsMergeStrategy = (typeof SETTINGS_MERGE_STRATEGIES)[number];

export const SETTINGS_PROJECT_TRUST_POLICIES = ["normal", "tighten-only", "forbidden"] as const;
export type SettingsProjectTrustPolicy = (typeof SETTINGS_PROJECT_TRUST_POLICIES)[number];

export const SETTINGS_EDITOR_KINDS = [
  "boolean",
  "integer",
  "number",
  "text",
  "enum",
  "multiselect",
  "model",
  "string-list",
  "json",
  "secret",
  "resource",
  "action",
  "custom",
  "list-crud",
  "overview",
] as const;
export type SettingsEditorKind = (typeof SETTINGS_EDITOR_KINDS)[number];

export interface SettingsSelectOption {
  value: JsonPrimitive;
  labelKey: string;
  descriptionKey?: string;
  disabled?: boolean;
  disabledReasonKey?: string;
}

export interface SettingsEditor {
  kind: SettingsEditorKind;
  placeholderKey?: string;
  options?: readonly SettingsSelectOption[];
  optionsSource?: string;
  /**
   * `action`/`custom`/`resource` editors delegate to the provider's
   * `invokeAction` and close the shell first (Pi custom UI sessions are not
   * re-entrant). `custom` is a forward-compatible alias of `action` for
   * external surfaces; set `surfaceId` when the action id differs from the
   * setting key. In-shell structured editing is provided by `list-crud` and
   * read-only diagnostics by `overview` instead of embedding components.
   */
  actionId?: string;
  surfaceId?: string;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
  /** secret: allow entering a new value (input is masked; value is written once on commit). */
  writeOnly?: boolean;
  /** list-crud: per-item field definitions rendered as a sub-form for the selected item. */
  itemFields?: readonly SettingDefinition[];
  /** list-crud: catalog key for the add-item affordance label. */
  addLabelKey?: string;
  /** list-crud: catalog key used to display each item (defaults to the item's first text field). */
  itemLabelKey?: string;
}

export const SETTINGS_OVERVIEW_STATUSES = ["ok", "warn", "error", "dim"] as const;
export type SettingsOverviewStatus = (typeof SETTINGS_OVERVIEW_STATUSES)[number];

/**
 * Read-only diagnostic row rendered by an `overview` editor. Providers return an
 * array of these as the setting's effective value.
 */
export interface SettingsOverviewRow {
  /** Catalog key for the row label; falls back to `label` when absent. */
  labelKey?: string;
  /** Literal row label used when `labelKey` is absent. */
  label?: string;
  value: string;
  status?: SettingsOverviewStatus;
}

export interface SettingDefinition {
  key: string;
  group: string;
  order?: number;
  labelKey: string;
  descriptionKey?: string;
  defaultValue?: JsonValue;
  scopes: readonly SettingsScope[];
  merge: SettingsMergeStrategy;
  activation: SettingsActivation;
  sensitivity: SettingsSensitivity;
  reversibility: SettingsReversibility;
  projectTrust?: SettingsProjectTrustPolicy;
  editor: SettingsEditor;
}

export interface SettingsResource {
  providerId: string;
  scope: SettingsScope;
  /** Provider-defined stable identity, such as a file URI or session store id. */
  id: string;
}

export interface SettingsResourceRevision {
  resource: SettingsResource;
  /** Usually a content hash. It must change whenever the authoritative bytes change. */
  etag: string;
  size?: number;
  modifiedAt?: number;
}

export interface SettingsResourceConflict {
  resource: SettingsResource;
  expectedEtag?: string;
  actualEtag?: string;
  changedKeys?: readonly string[];
  messageKey?: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export type ConfiguredSettingState = "absent" | "set" | "invalid" | "restricted";

export interface ConfiguredSettingValue {
  key: string;
  scope: SettingsScope;
  state: ConfiguredSettingState;
  value?: JsonValue;
  resource?: SettingsResource;
  messageKey?: string;
}

export interface EffectiveSettingValue {
  key: string;
  value: JsonValue;
  source: "default" | "configured" | "runtime";
  scope?: SettingsScope;
  resource?: SettingsResource;
}

export interface ConfiguredSettingsSnapshot {
  values: readonly ConfiguredSettingValue[];
  resources: readonly SettingsResourceRevision[];
}

export interface EffectiveSettingsSnapshot {
  values: readonly EffectiveSettingValue[];
}

export interface SettingsSnapshot {
  providerId: string;
  providerInstanceId: string;
  configured: ConfiguredSettingsSnapshot;
  effective: EffectiveSettingsSnapshot;
}

export interface SettingsSetChange {
  operation: "set";
  key: string;
  scope: SettingsScope;
  value: JsonValue;
}

export interface SettingsUnsetChange {
  operation: "unset";
  key: string;
  scope: SettingsScope;
}

export type SettingsChange = SettingsSetChange | SettingsUnsetChange;

export interface SettingsValidationIssue {
  severity: "error" | "warning";
  code?: string;
  messageKey: string;
  params?: Readonly<Record<string, string | number | boolean>>;
  key?: string;
  scope?: SettingsScope;
}

export interface SettingsValidationResult {
  valid: boolean;
  issues: readonly SettingsValidationIssue[];
  conflicts?: readonly SettingsResourceConflict[];
}

export interface SettingsActivationPlan {
  boundary: SettingsActivation;
  keys: readonly string[];
  messageKey?: string;
}
