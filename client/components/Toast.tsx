import type { ToastAction, ToastType } from "../context/ToastContext";
import { useI18n } from "../lib/i18n";

const typeStyles: Record<ToastType, string> = {
  success: "bg-green-600 text-white",
  danger: "bg-red-600 text-white",
  info: "bg-blue-600 text-white",
};

const actionStyles: Record<NonNullable<ToastAction["variant"]>, string> = {
  primary: "bg-white/95 text-slate-900 hover:bg-white",
  secondary: "bg-white/15 text-white hover:bg-white/25",
};

export function Toast({
  message,
  type,
  actions = [],
  onClose,
}: {
  message: string;
  type: ToastType;
  actions?: ToastAction[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`toast-enter px-4 py-3 rounded-lg shadow-lg flex items-start justify-between gap-3 text-sm ${typeStyles[type]}`}
    >
      <div className="min-w-0">
        <div>{message}</div>
        {actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  action.onClick();
                  onClose();
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  actionStyles[action.variant ?? "secondary"]
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 opacity-70 hover:opacity-100 text-lg leading-none"
        aria-label={t("components.toast.closeNotification")}
      >
        &times;
      </button>
    </div>
  );
}
