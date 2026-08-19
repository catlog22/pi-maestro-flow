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

/**
 * Ask a provider for the values an editor's `optionsSource` names.
 *
 * Carries no abort signal: the protocol travels by event and must stay
 * serializable, so a provider that reaches a slow system bounds the wait
 * itself and reports exhaustion as a failed result.
 */
export interface SettingsListOptionsRequestV1 {
  context: SettingsContextV1;
  /** The setting being edited. */
  key: string;
  /** The `optionsSource` its editor declared, so one provider can serve several. */
  optionsSource: string;
}

/**
 * The values an options source published, or why it could not answer.
 *
 * A failure is distinct from an empty list. Empty means the source answered and
 * offers nothing; `failure` means it never answered, which the shell shows to
 * the operator instead of an empty picker they would read as "no choices".
 */
export interface SettingsListOptionsResultV1 {
  options: readonly SettingsSourcedOption[];
  /** Already-localized reason the source could not be read. */
  failure?: string;
}

/**
 * One value an options source published.
 *
 * `label` is raw display text, not a catalogue key: these values come from a
 * system outside this build at runtime, so no translation catalogue can carry
 * them. That is the difference from `SettingsSelectOption`, whose values are
 * declared here and therefore translatable.
 */
export interface SettingsSourcedOption {
  value: string;
  label: string;
  description?: string;
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
  /**
   * Resolve the values an editor's `optionsSource` names.
   *
   * A provider declaring `optionsSource` on any editor must implement this;
   * without it the shell has a picker it can never fill. Unlike `describe`,
   * this may perform I/O and may be slow, so the shell calls it when an
   * operator opens that editor rather than while listing settings.
   */
  listOptions?(request: SettingsListOptionsRequestV1): MaybePromise<SettingsListOptionsResultV1>;
}
