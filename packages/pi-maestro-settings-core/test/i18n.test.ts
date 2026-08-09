import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCatalogCompleteness,
  createSettingsTranslator,
  detectSystemSettingsLocale,
  interpolateTranslation,
  mergeTranslationCatalogs,
  normalizeSettingsLocale,
  resolveSettingsLocale,
  translateSettings,
  type MissingTranslation,
  type TranslationCatalogs,
} from "pi-maestro-settings-core/v1/i18n";

const catalogs: TranslationCatalogs = {
  en: {
    greeting: "Hello, {name}!",
    count: "Count: {count}",
    englishOnly: "English fallback",
  },
  "zh-CN": {
    greeting: "你好，{name}！",
    count: "数量：{count}",
  },
};

test("normalizes English, Chinese, and unsupported locales", () => {
  assert.equal(normalizeSettingsLocale("en"), "en");
  assert.equal(normalizeSettingsLocale("EN-us"), "en");
  assert.equal(normalizeSettingsLocale("zh_CN"), "zh-CN");
  assert.equal(normalizeSettingsLocale("zh-Hant-TW"), "zh-CN");
  assert.equal(normalizeSettingsLocale("fr-FR"), "en");
  assert.equal(normalizeSettingsLocale(undefined), "en");
});

test("detects and resolves supported system locales deterministically", () => {
  assert.equal(detectSystemSettingsLocale({
    environment: { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" },
    resolvedLocale: "en-US",
  }), "zh-CN");
  assert.equal(detectSystemSettingsLocale({
    environment: { LC_MESSAGES: "zh-TW", LANG: "en_US.UTF-8" },
    resolvedLocale: "en-US",
  }), "zh-CN");
  assert.equal(detectSystemSettingsLocale({
    environment: { LANGUAGE: "zh_CN:en_US", LANG: "en_US.UTF-8" },
    resolvedLocale: "en-US",
  }), "zh-CN");
  assert.equal(detectSystemSettingsLocale({
    environment: {},
    resolvedLocale: "zh-Hans-CN",
  }), "zh-CN");
  assert.equal(detectSystemSettingsLocale({
    environment: { LANG: "fr_FR.UTF-8" },
    resolvedLocale: "zh-CN",
  }), "en");
  assert.equal(resolveSettingsLocale("en-GB", {
    environment: { LANG: "zh_CN.UTF-8" },
  }), "en");
  assert.equal(resolveSettingsLocale("auto", {
    environment: { LANG: "zh_CN.UTF-8" },
  }), "zh-CN");
  assert.equal(resolveSettingsLocale(undefined, {
    environment: { LANG: "en_US.UTF-8" },
  }), "en");
});

test("translates and interpolates parameters", () => {
  assert.equal(translateSettings(catalogs, "zh-CN", "greeting", { name: "Maestro" }), "你好，Maestro！");
  assert.equal(interpolateTranslation("{enabled}: {count}", { enabled: true, count: 3 }), "true: 3");
  assert.equal(interpolateTranslation("Keep {missing}", {}), "Keep {missing}");
});

test("falls back to English and then to the key while reporting misses", () => {
  const missing: MissingTranslation[] = [];
  const translator = createSettingsTranslator({
    locale: "zh-CN",
    catalogs,
    onMissing: (entry) => missing.push(entry),
  });

  assert.equal(translator.translate("englishOnly"), "English fallback");
  assert.equal(translator.translate("unknown.key"), "unknown.key");
  assert.deepEqual(missing, [
    { key: "englishOnly", locale: "zh-CN", fallback: "en" },
    { key: "unknown.key", locale: "zh-CN", fallback: "key" },
  ]);

  assert.equal(translator.setLocale("en-GB"), "en");
  assert.equal(translator.locale, "en");
  assert.equal(translator.translate("greeting", { name: "Pi" }), "Hello, Pi!");
  assert.equal(translator.t("count", { count: 2 }), "Count: 2");
});

test("merges independently owned plugin catalogs", () => {
  assert.deepEqual(
    mergeTranslationCatalogs(
      { en: { "core.title": "Settings" }, "zh-CN": { "core.title": "设置" } },
      { en: { "flow.title": "Flow" }, "zh-CN": { "flow.title": "流程" } },
    ),
    {
      en: { "core.title": "Settings", "flow.title": "Flow" },
      "zh-CN": { "core.title": "设置", "flow.title": "流程" },
    },
  );
});

test("catalog completeness reports missing and extra keys", () => {
  const result = checkCatalogCompleteness({
    en: { alpha: "A", beta: "B" },
    "zh-CN": { alpha: "甲", gamma: "丙" },
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { locale: "zh-CN", kind: "missing-key", key: "beta" },
    { locale: "zh-CN", kind: "extra-key", key: "gamma" },
  ]);

  assert.deepEqual(
    checkCatalogCompleteness({ en: { alpha: "A" }, "zh-CN": { alpha: "甲" } }),
    { complete: true, referenceLocale: "en", issues: [] },
  );
});
