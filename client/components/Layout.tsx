import { type ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";

export function Layout({ children, title, actions }: {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  const { toasts, removeToast } = useToast();
  const { upgradingCount } = useUpgrade();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
      <main className="flex-1 ml-0 md:ml-60 min-w-0 overflow-x-hidden">
        {/* Desktop: single-row header */}
        <header className="sticky top-0 z-10 bg-white/80 dark:bg-slate-800/80 backdrop-blur border-b border-border px-4 md:px-6 py-3">
          <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="md:hidden p-1.5 -ml-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {sidebarOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
            <h1 className="text-lg font-semibold truncate">{title}</h1>
            {upgradingCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs font-medium pulse-upgrade shrink-0">
                <span className="spinner spinner-sm !w-3 !h-3 !border-blue-600 dark:!border-blue-400 !border-t-transparent" />
                <span className="hidden sm:inline">Upgrading {upgradingCount} system{upgradingCount !== 1 ? "s" : ""}...</span>
                <span className="sm:hidden">Upgrading...</span>
              </div>
            )}
            {actions && <div className="flex items-center gap-2 flex-wrap ml-auto shrink-0">{actions}</div>}
          </div>
        </header>
        <div className="p-4 md:p-6 max-w-[1200px]">{children}</div>
      </main>

      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            message={t.message}
            type={t.type}
            onClose={() => removeToast(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
