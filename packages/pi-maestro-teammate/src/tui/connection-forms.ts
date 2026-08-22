import type {
  BackendConfigField,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import { createModelsCliTranslator } from "../models/cli-i18n.ts";
import {
  displayValue,
  kindLabel,
  parseConfigFieldInput,
} from "../models/cli-edit.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  createTuiTranslator,
  type TuiTranslationKey,
  type TuiTranslator,
} from "./locale.ts";

/**
 * Shared field-form infrastructure for the connections tab.
 *
 * The overlays ask a backend's declared {@link BackendConfigField}s one
 * question at a time through this module instead of hand-rolling their own
 * prompt loops: validation (`parseConfigFieldInput`), kind labels
 * (`kindLabel`), and value rendering (`displayValue`) all come from
 * `models/cli-edit.ts` so the TUI and the CLI never drift apart.
 *
 * No backend module is loaded here — callers resolve the field list
 * themselves (builtins statically, anything else via the edit flow's loader).
 */

/**
 * Input/output seam of the connection forms. Tests substitute a scripted
 * implementation; overlays adapt whatever prompting context they already own.
 */
export interface ConnectionFormUi {
  /** Optional translator for TUI-owned prompt chrome. */
  t?: TuiTranslator;
  /** Ask one free-form question; `undefined` cancels the whole form. */
  input(prompt: string, initial?: string): Promise<string | undefined>;
  /**
   * Ask a yes/no question. Implementations should treat empty input as
   * decline — every confirm in this module defaults to false.
   */
  confirm(prompt: string): Promise<boolean>;
  /** Optional single-choice seam for enum fields with few options. */
  select?(prompt: string, options: readonly string[]): Promise<string | undefined>;
}

/** Result of a completed field form. */
export type ConfigFormResult =
  | { ok: true; values: Record<string, ConfigValue> }
  | { ok: false; cancelled: true };

export interface PromptConfigFieldsOptions {
  locale?: SupportedSettingsLocale;
}

function connectionText(
  ui: ConnectionFormUi,
  key: TuiTranslationKey,
  params?: Record<string, string | number>,
): string {
  return (ui.t ?? createTuiTranslator("en"))(key, params);
}

/**
 * Render one prompt header line for a field.
 *
 * Credential-ref fields never echo their stored value back into the prompt:
 * the value names a credential location and re-displaying it invites pasting
 * the referenced secret into the wrong place.
 */
function fieldPromptText(
  ui: ConnectionFormUi,
  field: BackendConfigField,
  current: Record<string, ConfigValue>,
  translate: ReturnType<typeof createModelsCliTranslator>,
): string {
  const parts = [`${field.key} [${kindLabel(field)}]`];
  if (field.kind !== "credential-ref") {
    parts.push(connectionText(ui, "connections.currentValue", {
      value: displayValue(translate, current[field.key]),
    }));
    if (field.default !== undefined) {
      parts.push(connectionText(ui, "connections.defaultValue", {
        value: displayValue(translate, field.default),
      }));
    }
  }
  return `${parts.join(" · ")}\n> `;
}

/** Per-field loop outcome: an entered value, the default, or a cancel. */
type FieldOutcome =
  | { kind: "value"; value: ConfigValue | undefined }
  | { kind: "cancelled" };

/**
 * Run one field's prompt loop until it yields a value or the operator
 * cancels. Invalid input re-prompts the same field in place with the rejection
 * reason shown first; empty input resolves to `field.default`, which may be
 * `undefined`.
 */
async function promptOneField(
  ui: ConnectionFormUi,
  field: BackendConfigField,
  current: Readonly<Record<string, ConfigValue>>,
  translate: ReturnType<typeof createModelsCliTranslator>,
): Promise<FieldOutcome> {
  let errorPrefix = "";
  while (true) {
    const answer = await ui.input(`${errorPrefix}${fieldPromptText(ui, field, current, translate)}`);
    if (answer === undefined) return { kind: "cancelled" };
    if (answer.trim().length === 0) return { kind: "value", value: field.default };
    const result = parseConfigFieldInput(field, answer);
    if (result.ok) return { kind: "value", value: result.value };
    // Show the reason at the top of the next prompt so the rejected entry is
    // still the last thing on screen when the operator retypes.
    errorPrefix = `${result.reason}\n`;
  }
}

/**
 * Walk the declared fields in order, collecting one validated value each.
 *
 * Empty input resolves the field default; `undefined` from {@link ConnectionFormUi.input}
 * aborts the whole form with the cancelled variant — later fields are never
 * prompted. Credential-ref prompts accept a variable name only and never echo
 * stored values back.
 */
export async function promptConfigFields(
  ui: ConnectionFormUi,
  fields: readonly BackendConfigField[],
  current: Readonly<Record<string, ConfigValue>> = {},
  options: PromptConfigFieldsOptions = {},
): Promise<ConfigFormResult> {
  const translate = ui.t ?? createModelsCliTranslator(options.locale ?? "en");
  const values: Record<string, ConfigValue> = {};
  for (const field of fields) {
    const outcome = await promptOneField(ui, field, current, translate);
    if (outcome.kind === "cancelled") return { ok: false, cancelled: true };
    if (outcome.value !== undefined) values[field.key] = outcome.value;
  }
  return { ok: true, values };
}

/** What one retry attempt reported back to the retry loop. */
export interface ErrorRetryOutcome {
  /** Whether the retried operation succeeded. */
  readonly success: boolean;
  /** Fresh errors replacing the previous list on failure. */
  readonly errors?: readonly string[];
}

/**
 * Render errors numbered (one per line) and gate each retry behind a confirm
 * that declines by default. Loops: render → confirm → retryBlock, returning
 * true as soon as a retry succeeds and false the moment the operator declines.
 */
export async function promptNumberedErrorRetry(
  ui: ConnectionFormUi,
  errors: readonly string[],
  retryBlock: () => Promise<ErrorRetryOutcome>,
): Promise<boolean> {
  let currentErrors = [...errors];
  while (true) {
    const rendered = currentErrors.map((error, index) => `${index + 1}. ${error}`).join("\n");
    const proceed = await ui.confirm(`${rendered}\n${connectionText(ui, "connections.retryPrompt")}`);
    if (!proceed) return false;
    const outcome = await retryBlock();
    if (outcome.success) return true;
    if (outcome.errors !== undefined) currentErrors = [...outcome.errors];
  }
}
