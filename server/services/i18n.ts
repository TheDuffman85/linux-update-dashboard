import { eq } from "drizzle-orm";
import ar from "../../client/locales/ar.json";
import de from "../../client/locales/de.json";
import en from "../../client/locales/en.json";
import es from "../../client/locales/es.json";
import fr from "../../client/locales/fr.json";
import hi from "../../client/locales/hi.json";
import ru from "../../client/locales/ru.json";
import zh from "../../client/locales/zh.json";
import { getDb } from "../db";
import { settings } from "../db/schema";

export const LANGUAGE_SETTING_KEY = "language";
export const BROWSER_LANGUAGE_SETTING = "browser";

export const SUPPORTED_LANGUAGES = ["ar", "en", "de", "fr", "hi", "es", "ru", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;
export type Translator = (key: string, values?: TranslationValues) => string;

const resources: Record<SupportedLanguage, Record<string, string>> = {
  ar,
  de,
  en,
  es,
  fr,
  hi,
  ru,
  zh,
};

const supportedLanguageCodes = new Set<string>(SUPPORTED_LANGUAGES);

function normalizeLanguageCode(language: string | null | undefined): SupportedLanguage | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase().replace("_", "-");
  if (supportedLanguageCodes.has(normalized)) return normalized as SupportedLanguage;

  const base = normalized.split("-")[0];
  return supportedLanguageCodes.has(base) ? base as SupportedLanguage : null;
}

export function getServerLanguage(): SupportedLanguage {
  let row: { value: string } | undefined;
  try {
    row = getDb()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, LANGUAGE_SETTING_KEY))
      .get();
  } catch {
    return "en";
  }

  if (!row?.value || row.value === BROWSER_LANGUAGE_SETTING) return "en";
  return normalizeLanguageCode(row.value) ?? "en";
}

export function createTranslator(language: SupportedLanguage): Translator {
  const resource = resources[language] ?? resources.en;
  return (key, values = {}) => {
    let template = resource[key] ?? resources.en[key] ?? key;
    for (const [name, value] of Object.entries(values)) {
      template = template.replaceAll(`{${name}}`, String(value ?? ""));
    }
    return template;
  };
}

export function getServerTranslator(): Translator {
  return createTranslator(getServerLanguage());
}
