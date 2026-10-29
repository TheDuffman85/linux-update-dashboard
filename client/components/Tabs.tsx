import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** SVG path of a 24x24 outline icon drawn with a 2px stroke. */
  icon?: string;
}

function tabId(idPrefix: string, id: string) {
  return `${idPrefix}-tab-${id}`;
}

function tabPanelId(idPrefix: string, id: string) {
  return `${idPrefix}-panel-${id}`;
}

export function Tabs<T extends string>({
  idPrefix,
  label,
  tabs,
  value,
  onChange,
}: {
  idPrefix: string;
  label: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Arrow keys, Home and End move between tabs, following the WAI-ARIA tabs pattern.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    let nextIndex: number;
    switch (e.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = tabs[nextIndex];
    onChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    // The bottom line is an inset shadow rather than a border, so the active tab's underline can
    // cover it without overflowing the list, which would show a scrollbar. Narrow screens can still
    // scroll the tabs sideways, without a visible scrollbar.
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className="mb-4 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            id={tabId(idPrefix, tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
              selected
                ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
            }`}
          >
            {tab.icon && (
              <svg
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
              </svg>
            )}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  id,
  children,
}: {
  idPrefix: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={tabPanelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)}>
      {children}
    </div>
  );
}
