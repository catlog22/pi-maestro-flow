import type { BackendConfigField, ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { type TuiTranslator } from "./locale.ts";
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
export type ConfigFormResult = {
    ok: true;
    values: Record<string, ConfigValue>;
} | {
    ok: false;
    cancelled: true;
};
export interface PromptConfigFieldsOptions {
    locale?: SupportedSettingsLocale;
}
/**
 * Walk the declared fields in order, collecting one validated value each.
 *
 * Empty input resolves the field default; `undefined` from {@link ConnectionFormUi.input}
 * aborts the whole form with the cancelled variant — later fields are never
 * prompted. Credential-ref prompts accept a variable name only and never echo
 * stored values back.
 */
export declare function promptConfigFields(ui: ConnectionFormUi, fields: readonly BackendConfigField[], current?: Readonly<Record<string, ConfigValue>>, options?: PromptConfigFieldsOptions): Promise<ConfigFormResult>;
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
export declare function promptNumberedErrorRetry(ui: ConnectionFormUi, errors: readonly string[], retryBlock: () => Promise<ErrorRetryOutcome>): Promise<boolean>;
