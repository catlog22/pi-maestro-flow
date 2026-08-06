import type { SupportedSettingsLocale, TranslationCatalogs } from "./i18n.ts";
import type {
  SettingDefinition,
  SettingsActivationPlan,
  SettingsChange,
  SettingsResourceConflict,
  SettingsResourceRevision,
  SettingsScope,
  SettingsSnapshot,
  SettingsValidationResult,
} from "./schema.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface SettingsContextV1 {
  cwd: string;
  locale: SupportedSettingsLocale;
  sessionGeneration?: string;
  sessionId?: string;
  projectTrusted?: boolean;
}

export interface SettingsProviderCapabilitiesV1 {
  read: true;
  write: boolean;
  prepareCommit: boolean;
  rollback: "full" | "compensating" | "none";
  hotUpdate: boolean;
}

export interface SettingsProviderDescriptionV1 {
  id: string;
  version: string;
  instanceId: string;
  labelKey: string;
  descriptionKey?: string;
  order?: number;
  capabilities: SettingsProviderCapabilitiesV1;
  settings: readonly SettingDefinition[];
  catalogs?: TranslationCatalogs;
}

export interface SettingsDescribeRequestV1 {
  context: SettingsContextV1;
}

export interface SettingsReadRequestV1 {
  context: SettingsContextV1;
  scopes?: readonly SettingsScope[];
  keys?: readonly string[];
}

export interface SettingsValidateRequestV1 {
  context: SettingsContextV1;
  transactionId: string;
  changes: readonly SettingsChange[];
  expectedRevisions?: readonly SettingsResourceRevision[];
}

export interface SettingsPrepareRequestV1 extends SettingsValidateRequestV1 {}

export interface SettingsPrepareResultV1 {
  prepared: boolean;
  /** Opaque token identifying provider-owned staged state. */
  prepareToken?: string;
  validation: SettingsValidationResult;
  conflicts?: readonly SettingsResourceConflict[];
  activation?: readonly SettingsActivationPlan[];
}

export interface SettingsCommitRequestV1 {
  context: SettingsContextV1;
  transactionId: string;
  prepareToken: string;
}

export interface SettingsCommitResultV1 {
  snapshot: SettingsSnapshot;
  revisions: readonly SettingsResourceRevision[];
  changedKeys: readonly string[];
  activation: readonly SettingsActivationPlan[];
}

export interface SettingsAbortRequestV1 {
  context: SettingsContextV1;
  transactionId: string;
  prepareToken: string;
  reason?: string;
}

export interface SettingsRollbackRequestV1 {
  context: SettingsContextV1;
  transactionId: string;
  prepareToken: string;
  committedRevisions: readonly SettingsResourceRevision[];
}

export interface SettingsRollbackResultV1 {
  rolledBack: boolean;
  snapshot?: SettingsSnapshot;
  conflicts?: readonly SettingsResourceConflict[];
}

export interface SettingsApplyRuntimeRequestV1 {
  context: SettingsContextV1;
  transactionId: string;
  changes: readonly SettingsChange[];
  snapshot: SettingsSnapshot;
}

export interface SettingsInvokeActionRequestV1 {
  context: SettingsContextV1;
  actionId: string;
  key?: string;
}

export interface SettingsInvokeActionResultV1 {
  handled: boolean;
  refresh?: boolean;
  messageKey?: string;
  params?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Raw, already-localized text the action wants surfaced in the settings
   * shell (e.g. a diagnostic dump or confirmation). Rendered directly,
   * bypassing catalog lookup.
   */
  message?: string;
}

export interface SettingsRuntimeFailureV1 {
  key: string;
  messageKey: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export interface SettingsApplyRuntimeResultV1 {
  appliedKeys: readonly string[];
  deferred: readonly SettingsActivationPlan[];
  failed: readonly SettingsRuntimeFailureV1[];
}

/**
 * A provider participates in discovery, reads, and collect-validate-commit
 * transactions. Hosts must validate every provider before preparing or
 * committing any provider. Optional mutation methods allow read-only providers.
 */
export interface SettingsProviderV1 {
  describe(request: SettingsDescribeRequestV1): MaybePromise<SettingsProviderDescriptionV1>;
  read(request: SettingsReadRequestV1): MaybePromise<SettingsSnapshot>;
  validate(request: SettingsValidateRequestV1): MaybePromise<SettingsValidationResult>;
  prepare?(request: SettingsPrepareRequestV1): MaybePromise<SettingsPrepareResultV1>;
  commit?(request: SettingsCommitRequestV1): MaybePromise<SettingsCommitResultV1>;
  abort?(request: SettingsAbortRequestV1): MaybePromise<void>;
  rollback?(request: SettingsRollbackRequestV1): MaybePromise<SettingsRollbackResultV1>;
  applyRuntime?(request: SettingsApplyRuntimeRequestV1): MaybePromise<SettingsApplyRuntimeResultV1>;
  invokeAction?(request: SettingsInvokeActionRequestV1): MaybePromise<SettingsInvokeActionResultV1>;
}
