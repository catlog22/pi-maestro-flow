import type { ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { type ModelRegistrationV2, type ModelSelectorV2 } from "./model-registry.ts";
import { type EditFlowIO } from "./cli-edit.ts";
/** Exit codes used by the add command. */
export declare const ADD_EXIT_CODES: {
    /** External change present and the operator declined. */
    readonly declinedExternalChange: 1;
    /** Explicit EOF mid-flow; nothing was written. */
    readonly eof: 2;
    /** A legacy document cannot be extended by this flow; nothing was written. */
    readonly legacyDocument: 2;
    /** Second Ctrl-C; nothing was written. */
    readonly interrupted: 130;
};
export interface AddFlowOptions {
    /** Absolute registry document path. Created when it does not exist yet. */
    file: string;
    /** Pre-confirm external-change overwrite (--yes). */
    yes?: boolean;
    locale?: SupportedSettingsLocale;
    /** Defaults to a stdio-bound readline interface. */
    io?: EditFlowIO;
    /** Test seam over dynamic module loading. */
    importModule?: (specifier: string) => Promise<unknown>;
}
/** Same shape rule the strict parser applies to ids. */
export declare function isValidId(value: string): boolean;
export declare function selectorSummary(selector: ModelSelectorV2): string;
/**
 * Conflicts the compiler will reject, collected before the authoritative
 * parse so an operator sees every reason at once instead of one per attempt.
 */
export declare function candidateConflicts(models: Readonly<Record<string, ModelRegistrationV2>>, backends: Readonly<Record<string, {
    module: string;
    config?: Record<string, ConfigValue>;
}>>, newRegistrationId: string): string[];
/**
 * Run the full add flow. Returns a process exit code; structural errors
 * (invalid baseline document, failed publish) propagate to the caller, while
 * interactive aborts report through the IO seam and return non-zero without
 * ever writing.
 */
export declare function runAddFlow(options: AddFlowOptions): Promise<number>;
