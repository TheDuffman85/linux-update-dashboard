import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "./i18n";
import { useSettingsResponse } from "./settings";

export const TIME_FORMAT_SETTING_KEY = "time_format";
export const BROWSER_TIME_FORMAT_SETTING = "browser";

export type TimeFormat = "12h" | "24h";
export type TimeFormatPreference =
  | TimeFormat
  | typeof BROWSER_TIME_FORMAT_SETTING;

type DateTimeSettings = {
  timeZone: string | null;
  timeFormat: TimeFormatPreference;
};

type DateTimeContextValue = DateTimeSettings & {
  browserTimeFormat: TimeFormat;
  formatDate: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatDateTime: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
};

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function normalizeTimeFormatPreference(
  preference: string | null | undefined,
): TimeFormatPreference {
  return preference === "12h" || preference === "24h"
    ? preference
    : BROWSER_TIME_FORMAT_SETTING;
}

export function getBrowserTimeFormat(): TimeFormat {
  const options = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
  }).resolvedOptions();
  return options.hour12 === true ? "12h" : "24h";
}

export function resolveTimeFormatPreference(
  preference: TimeFormatPreference,
  browserTimeFormat = getBrowserTimeFormat(),
): TimeFormat {
  return preference === BROWSER_TIME_FORMAT_SETTING
    ? browserTimeFormat
    : preference;
}

function withDateTimeSettings(
  settings: DateTimeSettings,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  const timeFormat = resolveTimeFormatPreference(settings.timeFormat);
  return {
    ...options,
    ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
    hour12: timeFormat === "12h",
  };
}

export function formatDateValue(
  value: Date | string | number,
  locale: string | undefined,
  settings: DateTimeSettings,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = toDate(value);
  return date
    ? date.toLocaleDateString(locale, withDateTimeSettings(settings, options))
    : String(value);
}

export function formatDateTimeValue(
  value: Date | string | number,
  locale: string | undefined,
  settings: DateTimeSettings,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = toDate(value);
  return date
    ? date.toLocaleString(locale, withDateTimeSettings(settings, options))
    : String(value);
}

const fallbackSettings: DateTimeSettings = {
  timeZone: null,
  timeFormat: BROWSER_TIME_FORMAT_SETTING,
};

const DateTimeContext = createContext<DateTimeContextValue | null>(null);

export function DateTimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { language } = useI18n();
  const { data } = useSettingsResponse(Boolean(user));
  const settings = useMemo<DateTimeSettings>(
    () => ({
      timeZone: data?.timeZone ?? null,
      timeFormat: normalizeTimeFormatPreference(
        data?.settings[TIME_FORMAT_SETTING_KEY],
      ),
    }),
    [data],
  );
  const value = useMemo<DateTimeContextValue>(
    () => ({
      ...settings,
      browserTimeFormat: getBrowserTimeFormat(),
      formatDate: (date, options) =>
        formatDateValue(date, language, settings, options),
      formatDateTime: (date, options) =>
        formatDateTimeValue(date, language, settings, options),
    }),
    [language, settings],
  );

  return (
    <DateTimeContext.Provider value={value}>
      {children}
    </DateTimeContext.Provider>
  );
}

export function useDateTime(): DateTimeContextValue {
  const context = useContext(DateTimeContext);
  if (context) return context;

  return {
    ...fallbackSettings,
    browserTimeFormat: getBrowserTimeFormat(),
    formatDate: (date, options) =>
      formatDateValue(date, undefined, fallbackSettings, options),
    formatDateTime: (date, options) =>
      formatDateTimeValue(date, undefined, fallbackSettings, options),
  };
}
