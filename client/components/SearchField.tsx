import { useI18n } from "../lib/i18n";

export function SearchField({
  value,
  onChange,
  label,
  clearLabel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  clearLabel: string;
  placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="relative w-full max-w-md">
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder ?? label}
        aria-label={label}
        className="w-full px-3 py-2 pr-9 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          title={t("pages.systemDetail.clearSearch")}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
