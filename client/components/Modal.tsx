import { useEffect, type ReactNode } from "react";

export function Modal({
  open,
  onClose,
  title,
  children,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  dismissible?: boolean;
}) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    if (open) {
      document.addEventListener("keydown", handleEsc);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && dismissible && onClose()}
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg md:max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-semibold text-lg">{title}</h2>
          {dismissible ? (
            <button
              type="button"
              aria-label={`Close ${title} modal`}
              onClick={onClose}
              className="p-1 rounded transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
