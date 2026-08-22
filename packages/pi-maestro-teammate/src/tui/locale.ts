import {
  SETTINGS_LOCALE_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  SUPPORTED_SETTINGS_LOCALES,
  checkCatalogCompleteness,
  detectSystemSettingsLocale,
  mergeTranslationCatalogs,
  resolveSettingsLocale,
  translateSettings,
  type SettingsLocaleEventV1,
  type SupportedSettingsLocale,
  type SystemSettingsLocaleOptions,
  type TranslationParams,
} from "pi-maestro-settings-core/v1";
import { CORE_TUI_CATALOGS } from "./locale-catalog-core.ts";
import { MODELS_CLI_CATALOGS } from "../models/cli-i18n.ts";
import { MODEL_TUI_CATALOGS } from "./locale-catalog-model.ts";
import { PROFILE_TUI_CATALOGS } from "./locale-catalog-profiles.ts";
import { SESSION_TUI_CATALOGS } from "./locale-catalog-sessions.ts";

export const TUI_TRANSLATION_CATALOGS = mergeTranslationCatalogs(
  CORE_TUI_CATALOGS,
  SESSION_TUI_CATALOGS,
  MODEL_TUI_CATALOGS,
  PROFILE_TUI_CATALOGS,
  MODELS_CLI_CATALOGS,
);

type CoreKey = keyof (typeof CORE_TUI_CATALOGS)["en"];
type SessionKey = keyof (typeof SESSION_TUI_CATALOGS)["en"];
type ModelKey = keyof (typeof MODEL_TUI_CATALOGS)["en"];
type ProfileKey = keyof (typeof PROFILE_TUI_CATALOGS)["en"];
type ModelsCliKey = keyof (typeof MODELS_CLI_CATALOGS)["en"];
export type TuiTranslationKey = CoreKey | SessionKey | ModelKey | ProfileKey | ModelsCliKey;
export type TuiTranslator = (key: TuiTranslationKey, params?: TranslationParams) => string;

let runtimeLocale = detectSystemSettingsLocale();
const localeListeners = new Set<(locale: SupportedSettingsLocale) => void>();

export function getTuiLocale(): SupportedSettingsLocale {
  return runtimeLocale;
}

export function initializeTuiLocale(
  locale: string | null | undefined = "auto",
  options: SystemSettingsLocaleOptions = {},
): SupportedSettingsLocale {
  return updateRuntimeLocale(resolveSettingsLocale(locale, options));
}

export function applySettingsLocaleEvent(payload: unknown): payload is SettingsLocaleEventV1 {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = payload as Partial<Record<keyof SettingsLocaleEventV1, unknown>>;
  if (event.version !== SETTINGS_PROTOCOL_VERSION) return false;
  if (typeof event.locale !== "string" || !SUPPORTED_SETTINGS_LOCALES.includes(event.locale as SupportedSettingsLocale)) {
    return false;
  }
  if (typeof event.generation !== "string" || event.generation.trim() === "") return false;
  updateRuntimeLocale(event.locale as SupportedSettingsLocale);
  return true;
}

export function onTuiLocaleChange(listener: (locale: SupportedSettingsLocale) => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

export function tuiT(
  key: TuiTranslationKey,
  params?: TranslationParams,
  locale: SupportedSettingsLocale = runtimeLocale,
): string {
  return translateSettings(TUI_TRANSLATION_CATALOGS, locale, key, params);
}

/** Omitted locale follows runtime events; an explicit locale stays fixed. */
export function createTuiTranslator(locale?: SupportedSettingsLocale): TuiTranslator {
  const fixedLocale = locale === undefined ? undefined : resolveSettingsLocale(locale);
  return (key, params) => tuiT(key, params, fixedLocale ?? runtimeLocale);
}

export function translateStatusText(text: string, translator: TuiTranslator = tuiT): string {
  switch (text) {
    case "running · starting": return translator("status.pending");
    case "running": return translator("status.running");
    case "running · retrying": return translator("status.retrying");
    case "sleeping": return translator("status.sleeping");
    case "sleeping · completed": return translator("status.completed");
    case "sleeping · failed": return translator("status.failed");
    case "sleeping · terminated": return translator("status.terminated");
    case "result ready": return translator("status.resultReady");
    default: return text;
  }
}

export function translateStatusIdentifier(status: string, translator: TuiTranslator = tuiT): string {
  switch (status) {
    case "pending": return translator("common.pending");
    case "running": return translator("common.running");
    case "retrying": return translator("common.retrying");
    case "sleeping": return translator("common.sleeping");
    case "completed": return translator("common.completed");
    case "failed": return translator("common.failed");
    case "terminated": return translator("common.terminated");
    case "idle": return translator("status.idle");
    default: return status;
  }
}

export function checkTuiCatalogCompleteness() {
  return checkCatalogCompleteness(TUI_TRANSLATION_CATALOGS);
}

export { SETTINGS_LOCALE_EVENT };
export type { SupportedSettingsLocale };

function updateRuntimeLocale(locale: SupportedSettingsLocale): SupportedSettingsLocale {
  if (runtimeLocale === locale) return runtimeLocale;
  runtimeLocale = locale;
  for (const listener of localeListeners) listener(locale);
  return runtimeLocale;
}
