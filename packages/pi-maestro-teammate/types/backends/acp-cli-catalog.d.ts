/**
 * Display text for the ACP-CLI backend's declared configuration fields.
 *
 * `configFields` carries `labelKey` / `descriptionKey`, not text: the settings
 * shell owns presentation and localization. Those keys need a definition or the
 * shell renders the key itself, so a field declared without an entry here
 * reaches an operator as `acpCli.command` rather than as a label — visible only
 * by looking at the shell, since nothing about it fails to compile or test.
 *
 * The wording matches `docs/backend-and-mcp-configuration.md`. Both describe the
 * same fields to the same reader, and an operator who consults one and then the
 * other must not find two different accounts of what a field does.
 */
import type { TranslationCatalogs } from "pi-maestro-settings-core/v1";
/** Catalog entries for every `acpCli.*` key the backend declares. */
export declare const ACP_CLI_SETTINGS_CATALOGS: TranslationCatalogs;
