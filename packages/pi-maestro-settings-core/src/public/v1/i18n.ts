export const SUPPORTED_SETTINGS_LOCALES = ["en", "zh-CN"] as const;
export type SupportedSettingsLocale = (typeof SUPPORTED_SETTINGS_LOCALES)[number];

export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationCatalogs = Readonly<
  Partial<Record<SupportedSettingsLocale, TranslationCatalog>>
>;
export type TranslationParams = Readonly<Record<string, string | number | boolean>>;

export interface MissingTranslation {
  key: string;
  locale: SupportedSettingsLocale;
  fallback: "en" | "key";
}

export type MissingTranslationCallback = (missing: MissingTranslation) => void;

export interface SettingsTranslatorOptions {
  locale?: string | null;
  catalogs: TranslationCatalogs;
  onMissing?: MissingTranslationCallback;
}

export interface SystemSettingsLocaleOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  resolvedLocale?: string | null;
}

export interface SettingsTranslator {
  readonly locale: SupportedSettingsLocale;
  setLocale(locale: string | null | undefined): SupportedSettingsLocale;
  translate(key: string, params?: TranslationParams): string;
  t(key: string, params?: TranslationParams): string;
}

export type CatalogCompletenessIssueKind = "missing-catalog" | "missing-key" | "extra-key";

export interface CatalogCompletenessIssue {
  locale: SupportedSettingsLocale;
  kind: CatalogCompletenessIssueKind;
  key?: string;
}

export interface CatalogCompletenessResult {
  complete: boolean;
  referenceLocale: "en";
  issues: readonly CatalogCompletenessIssue[];
}

export function normalizeSettingsLocale(locale: string | null | undefined): SupportedSettingsLocale {
  const normalized = locale?.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "zh" || normalized?.startsWith("zh-") === true) {
    return "zh-CN";
  }
  return "en";
}

export function detectSystemSettingsLocale(
  options: SystemSettingsLocaleOptions = {},
): SupportedSettingsLocale {
  const environment = options.environment ?? systemEnvironment();
  const environmentLocale = [
    environment.LC_ALL,
    environment.LC_MESSAGES,
    environment.LANGUAGE?.split(":", 1)[0],
    environment.LANG,
  ].find((value) => value?.trim());
  if (environmentLocale) return normalizeSettingsLocale(environmentLocale);

  const resolvedLocale = options.resolvedLocale === undefined
    ? systemResolvedLocale()
    : options.resolvedLocale;
  return normalizeSettingsLocale(resolvedLocale);
}

export function resolveSettingsLocale(
  locale: string | null | undefined,
  options: SystemSettingsLocaleOptions = {},
): SupportedSettingsLocale {
  const requested = locale?.trim();
  if (requested && requested.toLowerCase() !== "auto") {
    return normalizeSettingsLocale(requested);
  }
  return detectSystemSettingsLocale(options);
}

function systemEnvironment(): Readonly<Record<string, string | undefined>> {
  const processLike = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return processLike?.env ?? {};
}

function systemResolvedLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

export function interpolateTranslation(template: string, params: TranslationParams = {}): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(params, name)) return placeholder;
    return String(params[name]);
  });
}

export function translateSettings(
  catalogs: TranslationCatalogs,
  locale: string | null | undefined,
  key: string,
  params: TranslationParams = {},
  onMissing?: MissingTranslationCallback,
): string {
  const normalizedLocale = normalizeSettingsLocale(locale);
  const localized = catalogs[normalizedLocale]?.[key];
  if (localized !== undefined) {
    return interpolateTranslation(localized, params);
  }

  const english = catalogs.en?.[key];
  const fallback = normalizedLocale !== "en" && english !== undefined ? "en" : "key";
  onMissing?.({ key, locale: normalizedLocale, fallback });
  return interpolateTranslation(english ?? key, params);
}

export function createSettingsTranslator(options: SettingsTranslatorOptions): SettingsTranslator {
  let locale = normalizeSettingsLocale(options.locale);
  const translate = (key: string, params?: TranslationParams): string =>
    translateSettings(options.catalogs, locale, key, params, options.onMissing);
  return {
    get locale(): SupportedSettingsLocale {
      return locale;
    },
    setLocale(nextLocale: string | null | undefined): SupportedSettingsLocale {
      locale = normalizeSettingsLocale(nextLocale);
      return locale;
    },
    translate,
    t: translate,
  };
}

export function mergeTranslationCatalogs(...sources: readonly TranslationCatalogs[]): TranslationCatalogs {
  const merged: Partial<Record<SupportedSettingsLocale, Record<string, string>>> = {};
  for (const source of sources) {
    for (const locale of SUPPORTED_SETTINGS_LOCALES) {
      const catalog = source[locale];
      if (!catalog) continue;
      merged[locale] = { ...merged[locale], ...catalog };
    }
  }
  return merged;
}

export function checkCatalogCompleteness(
  catalogs: TranslationCatalogs,
  locales: readonly SupportedSettingsLocale[] = SUPPORTED_SETTINGS_LOCALES,
): CatalogCompletenessResult {
  const issues: CatalogCompletenessIssue[] = [];
  const english = catalogs.en;

  if (english === undefined) {
    issues.push({ locale: "en", kind: "missing-catalog" });
  }

  const referenceKeys = Object.keys(english ?? {}).sort();
  const referenceKeySet = new Set(referenceKeys);

  for (const locale of locales) {
    if (locale === "en") continue;
    const catalog = catalogs[locale];
    if (catalog === undefined) {
      issues.push({ locale, kind: "missing-catalog" });
      continue;
    }
    for (const key of referenceKeys) {
      if (!Object.hasOwn(catalog, key)) {
        issues.push({ locale, kind: "missing-key", key });
      }
    }
    for (const key of Object.keys(catalog).sort()) {
      if (!referenceKeySet.has(key)) {
        issues.push({ locale, kind: "extra-key", key });
      }
    }
  }

  return {
    complete: issues.length === 0,
    referenceLocale: "en",
    issues,
  };
}

/**
 * What to call the modifier that terminals deliver as Meta, on this platform.
 *
 * Every `alt+…` shortcut this product registers is delivered by the key macOS
 * labels **option** — there is no key called Alt on a Mac keyboard, so a hint
 * reading `Alt+R` sends a Mac user looking for a key that is not there. The
 * binding is unchanged and stays `alt+…`; only its name differs.
 *
 * Lives beside the locale helpers because it answers the same question they do
 * — what to show this user for a fixed underlying value — and both packages
 * that render shortcut hints already depend on this module. The axis is the
 * platform rather than the locale, so it is a separate function rather than a
 * catalog entry: the label is identical in every language.
 *
 * `⌥` is deliberately not used: U+2325 is East-Asian Ambiguous, so a terminal
 * rendering the zh-CN locale may give it two columns and break hint widths this
 * product computes.
 *
 * @param platform - platform to name the modifier for; defaults to the running one.
 * @returns `Option` on macOS, `Alt` everywhere else.
 */
export function altModifierLabel(platform: string = process.platform): string {
  return platform === "darwin" ? "Option" : "Alt";
}

/**
 * Name one `alt+…` shortcut the way this platform's keyboard labels it.
 *
 * @param key - the rest of the chord, such as `R` or `Shift+P`.
 * @param platform - platform to name it for; defaults to the running one.
 * @returns the hint text, e.g. `Option+R` on macOS and `Alt+R` elsewhere.
 */
export function altKey(key: string, platform?: string): string {
  return `${altModifierLabel(platform ?? process.platform)}+${key}`;
}
