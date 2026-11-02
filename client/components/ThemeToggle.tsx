import { useTheme, type ThemePreference } from "../hooks/useTheme";
import { useI18n } from "../lib/i18n";

const options: Array<{ value: ThemePreference; label: string; icon: string }> = [
  { value: "light", label: "components.themeToggle.light", icon: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" },
  { value: "dark", label: "components.themeToggle.dark", icon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" },
  { value: "system", label: "components.themeToggle.system", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();

  return (
    <div className="flex items-center">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => setPreference(option.value)}
          aria-label={t(option.label)}
          aria-pressed={preference === option.value}
          title={t(option.label)}
          className={`p-1.5 rounded transition-colors hover:bg-sidebar-hover hover:text-slate-900 dark:hover:text-white ${
            preference === option.value
              ? "bg-sidebar-hover text-slate-900 dark:text-white"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={option.icon} />
          </svg>
        </button>
      ))}
    </div>
  );
}
