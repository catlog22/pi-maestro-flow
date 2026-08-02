export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export const SETTINGS_SCOPES = ["global", "project", "local", "session"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

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
  actionId?: string;
  surfaceId?: string;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
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
