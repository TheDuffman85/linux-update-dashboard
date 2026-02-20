import { type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";
import { useToast } from "../context/ToastContext";

export function Layout({ children, title, actions }: {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  const { toasts, removeToast } = useToast();

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-0 md:ml-60">
        <header className="sticky top-0 z-10 bg-white/80 dark:bg-slate-800/80 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">{title}</h1>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
        <div className="p-6 max-w-[1200px]">{children}</div>
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
