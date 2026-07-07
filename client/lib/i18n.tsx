import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { usePublicSettingsResponse, useSettingsResponse } from "./settings";
import ar from "../locales/ar.json";
import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import hi from "../locales/hi.json";
import ja from "../locales/ja.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

export const LANGUAGE_SETTING_KEY = "language";
export const BROWSER_LANGUAGE_SETTING = "browser";

export const SUPPORTED_LANGUAGES = [
  { code: "ar", label: "العربية" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "hi", label: "हिन्दी" },
  { code: "ja", label: "日本語" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "zh", label: "中文" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];
export type LanguagePreference = SupportedLanguage | typeof BROWSER_LANGUAGE_SETTING;

export type TranslationValues = Record<string, string | number | boolean | null | undefined>;

export const i18nResources = {
  ar: {
    translation: ar,
  },
  de: {
    translation: de,
  },
  en: {
    translation: en,
  },
  es: {
    translation: es,
  },
  fr: {
    translation: fr,
  },
  hi: {
    translation: hi,
  },
  ja: {
    translation: ja,
  },
  pt: {
    translation: pt,
  },
  ru: {
    translation: ru,
  },
  zh: {
    translation: zh,
  },
} as const;

const supportedLanguageCodes = new Set<string>(
  SUPPORTED_LANGUAGES.map((language) => language.code),
);

if (!i18next.isInitialized) {
  void i18next
    .use(initReactI18next)
    .init({
      resources: i18nResources,
      lng: "en",
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
      interpolation: {
        escapeValue: false,
        prefix: "{",
        suffix: "}",
      },
      returnNull: false,
      react: {
        useSuspense: false,
      },
    });
}

function normalizeLanguageCode(language: string | null | undefined): SupportedLanguage | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase().replace("_", "-");
  const exact = normalized as SupportedLanguage;
  if (supportedLanguageCodes.has(exact)) return exact;

  const base = normalized.split("-")[0] as SupportedLanguage;
  return supportedLanguageCodes.has(base) ? base : null;
}

export function normalizeLanguagePreference(
  preference: string | null | undefined,
): LanguagePreference {
  if (!preference || preference === BROWSER_LANGUAGE_SETTING) return BROWSER_LANGUAGE_SETTING;
  return normalizeLanguageCode(preference) ?? BROWSER_LANGUAGE_SETTING;
}

export function getBrowserLanguage(): SupportedLanguage {
  if (typeof navigator === "undefined") return "en";

  const languages =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];

  for (const language of languages) {
    const supportedLanguage = normalizeLanguageCode(language);
    if (supportedLanguage) return supportedLanguage;
  }

  return "en";
}

export function resolveLanguagePreference(
  preference: LanguagePreference,
): SupportedLanguage {
  return preference === BROWSER_LANGUAGE_SETTING ? getBrowserLanguage() : preference;
}

export function getLanguageLabel(language: SupportedLanguage): string {
  return (
    SUPPORTED_LANGUAGES.find((candidate) => candidate.code === language)?.label ??
    language
  );
}

export function translateForLanguage(
  language: SupportedLanguage,
  key: string,
  values?: TranslationValues,
): string {
  return i18next.getFixedT(language)(key, values);
}

type I18nContextValue = {
  language: SupportedLanguage;
  preference: LanguagePreference;
  browserLanguage: SupportedLanguage;
  t: (key: string, values?: TranslationValues) => string;
};

const fallbackI18n: I18nContextValue = {
  language: "en",
  preference: BROWSER_LANGUAGE_SETTING,
  browserLanguage: "en",
  t: (key, values) => i18next.t(key, values),
};

const I18nContext = createContext<I18nContextValue>(fallbackI18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const { data: settingsResponse } = useSettingsResponse(Boolean(user));
  const { data: publicSettingsResponse } = usePublicSettingsResponse(!loading && !user);
  const { t: translate, i18n } = useTranslation();
  const preference = normalizeLanguagePreference(
    settingsResponse?.settings[LANGUAGE_SETTING_KEY] ??
      publicSettingsResponse?.settings[LANGUAGE_SETTING_KEY],
  );
  const browserLanguage = getBrowserLanguage();
  const language = resolveLanguagePreference(preference);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language]);

  const t = useCallback(
    (key: string, values?: TranslationValues) => translate(key, values),
    [translate],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, preference, browserLanguage, t }),
    [browserLanguage, language, preference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
