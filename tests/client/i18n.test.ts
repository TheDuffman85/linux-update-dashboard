import { afterEach, describe, expect, test, vi } from "vitest";
import i18next from "i18next";
import {
  BROWSER_LANGUAGE_SETTING,
  getBrowserLanguage,
  i18nResources,
  normalizeLanguagePreference,
  resolveLanguagePreference,
  translateForLanguage,
} from "../../client/lib/i18n";

describe("i18n language resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses browser preference when no explicit language is saved", () => {
    vi.stubGlobal("navigator", {
      languages: ["de-DE", "en-US"],
      language: "de-DE",
    });

    expect(normalizeLanguagePreference(undefined)).toBe(BROWSER_LANGUAGE_SETTING);
    expect(resolveLanguagePreference(BROWSER_LANGUAGE_SETTING)).toBe("de");
  });

  test("normalizes explicit language variants", () => {
    expect(normalizeLanguagePreference("en-US")).toBe("en");
    expect(normalizeLanguagePreference("EN_gb")).toBe("en");
    expect(normalizeLanguagePreference("ar-EG")).toBe("ar");
    expect(normalizeLanguagePreference("fr-FR")).toBe("fr");
    expect(normalizeLanguagePreference("hi-IN")).toBe("hi");
    expect(normalizeLanguagePreference("zh_CN")).toBe("zh");
  });

  test("falls back to English for unsupported browser languages", () => {
    vi.stubGlobal("navigator", {
      languages: ["nl-NL", "sv-SE"],
      language: "nl-NL",
    });

    expect(getBrowserLanguage()).toBe("en");
  });

  test("loads translations from the i18next JSON resources", () => {
    expect(i18nResources.ar.translation["pages.settings.settings"]).toBe("الإعدادات");
    expect(i18nResources.en.translation["pages.settings.settings"]).toBe("Settings");
    expect(i18nResources.de.translation["pages.settings.settings"]).toBe("Einstellungen");
    expect(i18nResources.fr.translation["pages.settings.settings"]).toBe("Paramètres");
    expect(i18nResources.hi.translation["pages.settings.settings"]).toBe("सेटिंग्स");
    expect(i18nResources.es.translation["pages.settings.settings"]).toBe("Ajustes");
    expect(i18nResources.ru.translation["pages.settings.settings"]).toBe("Настройки");
    expect(i18nResources.zh.translation["pages.settings.settings"]).toBe("设置");
    expect(i18next.t("pages.settings.browserDefaultLanguage", { language: "English" }))
      .toBe("Browser default (English)");
  });

  test("translates for an explicit language without changing the active language", async () => {
    await i18next.changeLanguage("en");

    expect(translateForLanguage("de", "pages.settings.settingsSaved"))
      .toBe("Einstellungen gespeichert");
    expect(i18next.language).toBe("en");
  });

  test("keeps every locale aligned with English keys", () => {
    const englishKeys = Object.keys(i18nResources.en.translation).sort();

    for (const [language, resource] of Object.entries(i18nResources)) {
      expect(Object.keys(resource.translation).sort(), language).toEqual(englishKeys);
    }
  });

  test("keeps interpolation placeholders aligned with English", () => {
    const getPlaceholders = (value: unknown) =>
      Array.from(String(value ?? "").matchAll(/\{([^}]+)\}/g))
        .map((match) => match[1])
        .sort();

    for (const [language, resource] of Object.entries(i18nResources)) {
      for (const [key, englishValue] of Object.entries(i18nResources.en.translation)) {
        expect(getPlaceholders(resource.translation[key]), `${language}:${key}`)
          .toEqual(getPlaceholders(englishValue));
      }
    }
  });
});
