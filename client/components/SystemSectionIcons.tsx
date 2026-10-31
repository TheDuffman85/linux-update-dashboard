export const SYSTEM_SECTION_IDS = {
  availableUpdates: "available-updates",
  installedPackages: "installed-packages",
  activity: "activity",
} as const;

function SectionIcon({ className, d }: { className: string; d: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

export function AvailableUpdatesIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <SectionIcon
      className={className}
      d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
    />
  );
}

export function InstalledPackagesIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <SectionIcon
      className={className}
      d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73zM12 22V12M3.3 7l7.7 4.43a2 2 0 0 0 2 0L20.7 7M7.5 4.27l9 5.15"
    />
  );
}

export function ActivityIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <SectionIcon
      className={className}
      d="M22 12h-4l-3 9L9 3l-3 9H2"
    />
  );
}
