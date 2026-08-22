import { type ProjectionIdentity } from "../public/v1/backends.ts";
import { type ModelsCliTranslator } from "./cli-i18n.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { type EditFlowIO } from "./cli-edit.ts";
/**
 * Static model listing for the pi-teammate-models CLI.
 *
 * Rows are built purely from `parseModelRegistryManifest` +
 * `compileModelRegistryManifest` (both re-exported by public/v1/backends.ts).
 * No backend module is imported, no process is spawned, and no network probe
 * is made: topology comes from the runtime descriptor that the compiler
 * derives statically via `deriveModelRuntimeDescriptor`, and health is the
 * static resolvability gate rather than live circuit-breaker state. Session
 * availability depends on root-monitor authority, which a CLI process does not
 * hold, so it is reported as "n/a".
 */
/** One diagnostic row per registered model route, sorted by registration id. */
export interface ModelCliRow {
    registrationId: string;
    modelId: string;
    deploymentId: string;
    deploymentDefault: boolean;
    /** Statically derived harness (pi | dsh | acp | adapter-owned). */
    harness: string;
    transportKind: string;
    protocol: string;
    modelSelection: string;
    registered: true;
    resolvable: boolean;
    /** Static health: without a session there is no live breaker state to consult. */
    healthyStatic: boolean;
    sessionAvailable: "n/a";
}
export type ModelListResult = {
    kind: "registry";
    identity: ProjectionIdentity;
    defaultModel: string;
    rows: readonly ModelCliRow[];
    diagnostics: readonly string[];
} | {
    kind: "legacy";
    documentPath: string;
    parsed: unknown;
};
/**
 * D14 hook invoked when `list` meets a legacy/backend-registry document.
 *
 * The shipped implementation renders the computed v2 upgrade skeleton plus
 * the hard-refusal statement; it never writes anything by itself. The
 * interactive `[E]xplicitly write upgraded copy / [A]bort` offer lives in
 * {@link runLegacyPreviewFlow}, which the CLI awaits after listing.
 */
export type LegacyPreviewHook = (documentPath: string, parsed: unknown) => void;
export declare const LEGACY_PREVIEW_HOOK: LegacyPreviewHook;
export interface ModelListOptions {
    /** Defaults to {@link LEGACY_PREVIEW_HOOK}; tests may pass a spy. */
    legacyPreviewHook?: LegacyPreviewHook;
}
export declare function buildModelList(raw: string, documentPath?: string, options?: ModelListOptions): ModelListResult;
/**
 * Compute the v2 upgrade skeleton a legacy document would become.
 *
 * The backends section carries over verbatim — deployment ids and module
 * bindings survive migration unchanged — while `models`, `defaultModel`, and
 * the explicit `version`/`mode` pair are placeholders the operator (or the
 * add wizard) completes. Placeholder strings keep the copy valid JSON but
 * deliberately NOT a dispatchable manifest: an empty `models` map can never
 * satisfy `defaultModel`, so a half-migrated file cannot be loaded by
 * accident.
 */
export declare function buildUpgradedCopyDocument(parsed: unknown): Record<string, unknown>;
/**
 * Render the computed v2 upgrade skeleton for a legacy document.
 *
 * This is the preview text only — it states on its own that nothing has been
 * written and that writes to the legacy document itself are refused.
 */
export declare function renderLegacyUpgradeSkeleton(parsed: unknown, documentPath: string): string;
/** Exit codes for the legacy preview offer. */
export declare const LEGACY_PREVIEW_EXIT_CODES: {
    /** The operator explicitly chose the upgraded copy, which was written. */
    readonly wroteUpgradedCopy: 0;
    /** Abort (the default), declined overwrite of an existing copy, or end of input. Nothing was written. */
    readonly refused: 1;
};
export interface LegacyPreviewOptions {
    /** Absolute legacy document path. */
    file: string;
    /** Parsed legacy document from {@link buildModelList}. */
    parsed: unknown;
    locale?: SupportedSettingsLocale;
    io: EditFlowIO;
}
/**
 * The interactive half of the legacy preview: the hard refusal to write the
 * legacy document, plus the explicit `[E]` escape hatch that writes the
 * computed v2 skeleton to `<file>.upgraded.json` — a NEW sibling path, never
 * the legacy document itself.
 */
export declare function runLegacyPreviewFlow(options: LegacyPreviewOptions): Promise<number>;
export declare function renderModelList(result: ModelListResult, translator?: ModelsCliTranslator): string;
