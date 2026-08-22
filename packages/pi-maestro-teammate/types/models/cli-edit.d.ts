import type { BackendConfigField, ConfigValue } from "pi-maestro-backend-core/v1/backend";
import { type ModelsCliTranslator } from "./cli-i18n.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { type WriteConfirmIO } from "./cli-write.ts";
/**
 * The `[E]dit` flow for the pi-teammate-models CLI.
 *
 * Shape of the interaction, in order:
 *
 * 1. list the registered deployments (statically, from the parsed manifest);
 * 2. after the operator commits to one deployment, resolve its configuration
 *    fields — the three builtin families come from in-package constants and
 *    are never imported; any other deployment's backend module is dynamically
 *    imported exactly here and nowhere earlier;
 * 3. run a readline form loop over the fields with per-kind validators,
 *    echoing current values and defaults; credential-ref prompts take a
 *    variable NAME only;
 * 4. hand the resulting candidate to {@link publishModelRegistryDocument}.
 *
 * Abnormal endings never write: an explicit EOF aborts with a partial-progress
 * message and a non-zero exit, the first Ctrl-C cancels the current prompt,
 * the second leaves the flow entirely, and piped (non-TTY) input drives the
 * same loop one line per prompt. Raw mode is never enabled — the interface is
 * created with `terminal: false`, so ^C arrives through the terminal driver's
 * SIGINT rather than readline's raw-mode path.
 */
/** End of input reached mid-flow. Never leads to a write. */
export declare class EditAborted extends Error {
    constructor();
}
/** The current prompt was cancelled (first Ctrl-C). */
export declare class EditCancelled extends Error {
    constructor();
}
/** A second Ctrl-C ended the flow. Never leads to a write. */
export declare class EditInterrupted extends Error {
    constructor();
}
/**
 * Input/output seam of the edit flow. Tests substitute a scripted
 * implementation; the default binds readline over stdio.
 */
export interface EditFlowIO {
    /** Write one chunk of output (terminate lines yourself). */
    write(text: string): void;
    /**
     * Ask one question. `registerCancel` receives the function that cancels the
     * pending prompt (rejecting with {@link EditCancelled}); rejecting with
     * {@link EditAborted} signals end of input.
     */
    prompt(promptText: string, registerCancel: (cancel: () => void) => void): Promise<string>;
    /** Register a Ctrl-C handler for the lifetime of the flow. */
    onInterrupt(handler: () => void): void;
    /** Release the input/output resources. */
    close(): void;
}
/**
 * Default stdio binding.
 *
 * `terminal: false` keeps raw mode off unconditionally: piped input works one
 * line per prompt, and an interactive ^C surfaces as the terminal driver's
 * process-level SIGINT, which is bridged into the flow's interrupt handlers.
 */
export declare function createReadlineEditIO(options?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
}): EditFlowIO;
/** Adapt an edit flow's IO into the write pipeline's confirmation seam. */
export declare function editIoAsWriteIo(io: EditFlowIO): WriteConfirmIO;
/**
 * Resolve a deployment module's configuration fields.
 *
 * Builtin families return immediately from constants. Anything else is
 * dynamically imported — the caller must only reach this after the operator
 * committed to editing the deployment — and the module's backend-shaped
 * export must carry a non-empty `configFields`.
 *
 * @throws when a non-builtin module cannot be loaded or declares no fields.
 */
export declare function resolveConfigFieldsForModule(moduleId: string, importModule?: (specifier: string) => Promise<unknown>): Promise<readonly BackendConfigField[]>;
export type FieldParseResult = {
    ok: true;
    value: ConfigValue;
} | {
    ok: false;
    reason: string;
    secretWarning?: boolean;
};
/**
 * Validate one entered line against its declared field kind.
 *
 * Empty input never reaches here: the form loop treats it as "keep the
 * current value".
 */
export declare function parseConfigFieldInput(field: BackendConfigField, input: string): FieldParseResult;
export declare function kindLabel(field: BackendConfigField): string;
export declare function displayValue(translator: ModelsCliTranslator, value: ConfigValue | undefined): string;
export interface EditFlowOptions {
    /** Absolute registry document path. */
    file: string;
    /** Pre-confirm external-change overwrite (--yes). */
    yes?: boolean;
    locale?: SupportedSettingsLocale;
    /** Defaults to a stdio-bound readline interface. */
    io?: EditFlowIO;
    /** Test seam over dynamic module loading. */
    importModule?: (specifier: string) => Promise<unknown>;
}
/**
 * Shared interrupt-aware prompting loop for the interactive flows.
 *
 * The first Ctrl-C cancels the active prompt (the caller simply asks again);
 * the second marks the flow dead, and the pending prompt unwinds through
 * cancellation so {@link runEditFlow}-style callers observe
 * {@link EditInterrupted} on their next ask.
 */
export declare function createLinePrompter(io: EditFlowIO): {
    ask(promptText: string): Promise<string>;
};
/** Exit codes used by the edit command. */
export declare const EDIT_EXIT_CODES: {
    /** External change present and the operator declined. */
    readonly declinedExternalChange: 1;
    /** Explicit EOF mid-flow; nothing was written. */
    readonly eof: 2;
    /** A legacy document cannot be edited by this flow; nothing was written. */
    readonly legacyDocument: 2;
    /** Second Ctrl-C; nothing was written. */
    readonly interrupted: 130;
};
/**
 * Apply accepted edits onto a parsed document, preserving every untouched key
 * and value plus the enumeration order of all objects. Existing config keys
 * keep their positions (values replaced in place); newly-set keys append in
 * field declaration order.
 */
export declare function applyConfigEdits(document: Record<string, unknown>, deploymentId: string, edits: ReadonlyMap<string, ConfigValue>): Record<string, unknown>;
/**
 * Run the full edit flow. Returns a process exit code; structural errors
 * (unreadable file, invalid manifest, failed publish) propagate to the
 * caller, while interactive aborts (EOF, double Ctrl-C, declined overwrite)
 * report through the IO seam and return non-zero without ever writing.
 */
export declare function runEditFlow(options: EditFlowOptions): Promise<number>;
