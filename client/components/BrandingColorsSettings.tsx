import { useState, type CSSProperties } from "react";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BRANDING_THEME,
  DEFAULT_NEUTRAL_TONE,
  MIN_ACCENT_CONTRAST,
  NEUTRAL_TONES,
  THEME_MODES,
  THEME_SHADES,
  getAccentContrast,
  getResolvedThemeModeVariables,
  isDefaultBrandingTheme,
  normalizeHexColor,
  resolveThemeMode,
  type BrandingTheme,
  type NeutralTone,
  type ThemeModeColors,
  type ThemeModeName,
} from "../../shared/branding-theme";
import { useI18n } from "../lib/i18n";

const secondaryButtonClass =
  "px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50";

/**
 * Previews a mode with explicit (non-`dark:`) classes and every color variable
 * set inline, so it shows the draft regardless of the theme currently active.
 */
function ThemePreview({ theme, mode }: { theme: BrandingTheme; mode: ThemeModeName }) {
  const { t } = useI18n();
  const style = getResolvedThemeModeVariables(theme, mode) as CSSProperties;
  const dark = mode === "dark";

  return (
    <div
      style={style}
      data-testid={`settings-theme-preview-${mode}`}
      className={`space-y-3 rounded-lg border p-3 ${dark ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-slate-50"}`}
    >
      <div
        className={`rounded-md border p-3 ${dark ? "border-slate-700 bg-slate-800" : "border-slate-200 bg-white"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={`text-sm font-semibold ${dark ? "text-slate-100" : "text-slate-900"}`}
          >
            {t("pages.settings.themePreviewTitle")}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${dark ? "bg-blue-900/40 text-blue-300" : "bg-blue-50 text-blue-700"}`}
          >
            {t("pages.settings.themePreviewBadge")}
          </span>
        </div>
        <p className={`mt-1 text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>
          {t("pages.settings.themePreviewText")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="inline-flex h-8 items-center rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
            {t("pages.settings.themePreviewButton")}
          </span>
          <span className={`text-xs font-medium ${dark ? "text-blue-400" : "text-blue-600"}`}>
            {t("pages.settings.themePreviewLink")}
          </span>
        </div>
      </div>
      <div className="flex overflow-hidden rounded-md" aria-hidden="true">
        {THEME_SHADES.map((shade) => (
          <span
            key={shade}
            className="h-4 flex-1"
            style={{ backgroundColor: `var(--color-blue-${shade})` }}
          />
        ))}
      </div>
    </div>
  );
}

// Edits the theme draft; the Settings page saves it together with the other branding settings.
export function BrandingColorsSettings({
  theme,
  onChange,
  disabled,
  inputClass,
  labelClass,
}: {
  theme: BrandingTheme;
  onChange: (theme: BrandingTheme) => void;
  disabled: boolean;
  inputClass: string;
  labelClass: string;
}) {
  const { t } = useI18n();
  const [hexDrafts, setHexDrafts] = useState<Partial<Record<ThemeModeName, string>>>({});

  const modeLabel = (mode: ThemeModeName) =>
    t(mode === "light" ? "pages.settings.lightMode" : "pages.settings.darkMode");

  const updateMode = (mode: ThemeModeName, colors: Partial<ThemeModeColors>) => {
    onChange({ ...theme, [mode]: { ...theme[mode], ...colors } });
  };

  const handleHexChange = (mode: ThemeModeName, value: string) => {
    setHexDrafts((drafts) => ({ ...drafts, [mode]: value }));
    if (!value.trim()) {
      updateMode(mode, { accent: null });
      return;
    }
    const accent = normalizeHexColor(value);
    if (accent) updateMode(mode, { accent });
  };

  const clearHexDraft = (mode: ThemeModeName) => {
    setHexDrafts((drafts) => {
      const next = { ...drafts };
      delete next[mode];
      return next;
    });
  };

  const handleRestoreDefaults = () => {
    onChange(DEFAULT_BRANDING_THEME);
    setHexDrafts({});
  };

  return (
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="text-sm font-semibold">{t("pages.settings.colors")}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {t("pages.settings.colorsDescription")}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {THEME_MODES.map((mode) => {
          const colors = theme[mode];
          const resolved = resolveThemeMode(theme, mode);
          const pickerValue = colors.accent ?? resolved.accent ?? DEFAULT_ACCENT_COLOR;
          const inheritsLight = mode === "dark";
          const contrast = getAccentContrast(theme, mode);
          const minContrast = contrast
            ? Math.min(contrast.buttonText, contrast.accentText)
            : null;
          const accentId = `settings-theme-${mode}-accent`;
          const neutralId = `settings-theme-${mode}-neutral`;
          const resetAccentLabel = t(
            inheritsLight
              ? "pages.settings.useLightModeAccent"
              : "pages.settings.useDefaultAccent",
          );

          return (
            <div key={mode} className="space-y-4" data-testid={`settings-theme-${mode}`}>
              <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {modeLabel(mode)}
              </h4>

              <div>
                <label htmlFor={accentId} className={labelClass}>
                  {t("pages.settings.accentColor")}
                </label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={pickerValue}
                    onChange={(e) => {
                      clearHexDraft(mode);
                      updateMode(mode, { accent: e.target.value.toLowerCase() });
                    }}
                    disabled={disabled}
                    aria-label={t("pages.settings.accentColorPicker", {
                      mode: modeLabel(mode),
                    })}
                    className="h-[38px] w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-white p-1 disabled:cursor-not-allowed dark:bg-slate-900"
                  />
                  <input
                    id={accentId}
                    type="text"
                    value={hexDrafts[mode] ?? colors.accent ?? ""}
                    placeholder={
                      inheritsLight && theme.light.accent
                        ? t("pages.settings.sameAsLightMode")
                        : t("pages.settings.defaultColor", { color: DEFAULT_ACCENT_COLOR })
                    }
                    maxLength={7}
                    spellCheck={false}
                    onChange={(e) => handleHexChange(mode, e.target.value)}
                    onBlur={() => clearHexDraft(mode)}
                    disabled={disabled}
                    className={`${inputClass} font-mono`}
                  />
                  {colors.accent && (
                    <button
                      type="button"
                      onClick={() => {
                        clearHexDraft(mode);
                        updateMode(mode, { accent: null });
                      }}
                      disabled={disabled}
                      aria-label={resetAccentLabel}
                      title={resetAccentLabel}
                      className={`${secondaryButtonClass} shrink-0`}
                    >
                      {t("pages.settings.resetAccent")}
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t(
                    inheritsLight
                      ? "pages.settings.darkAccentHelp"
                      : "pages.settings.accentHelp",
                  )}
                </p>
              </div>

              <div>
                <label htmlFor={neutralId} className={labelClass}>
                  {t("pages.settings.neutralTone")}
                </label>
                <select
                  id={neutralId}
                  value={colors.neutral ?? ""}
                  onChange={(e) =>
                    updateMode(mode, {
                      neutral: (e.target.value || null) as NeutralTone | null,
                    })
                  }
                  disabled={disabled}
                  className={inputClass}
                >
                  <option value="">
                    {inheritsLight
                      ? t("pages.settings.sameAsLightMode")
                      : t("pages.settings.defaultNeutralTone", {
                          tone: t(`pages.settings.neutralTones.${DEFAULT_NEUTRAL_TONE}`),
                        })}
                  </option>
                  {NEUTRAL_TONES.map((tone) => (
                    <option key={tone} value={tone}>
                      {t(`pages.settings.neutralTones.${tone}`)}
                    </option>
                  ))}
                </select>
              </div>

              <ThemePreview theme={theme} mode={mode} />

              {minContrast !== null && minContrast < MIN_ACCENT_CONTRAST && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                  {t("pages.settings.lowAccentContrast", { ratio: minContrast.toFixed(1) })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleRestoreDefaults}
          disabled={disabled || isDefaultBrandingTheme(theme)}
          className={secondaryButtonClass}
        >
          {t("pages.settings.restoreDefaultColors")}
        </button>
      </div>
    </div>
  );
}
