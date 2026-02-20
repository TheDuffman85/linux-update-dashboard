import type { ToastType } from "../context/ToastContext";

const typeStyles: Record<ToastType, string> = {
  success: "bg-green-600 text-white",
  danger: "bg-red-600 text-white",
  info: "bg-blue-600 text-white",
};

export function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: ToastType;
  onClose: () => void;
}) {
  return (
    <div
      className={`toast-enter px-4 py-3 rounded-lg shadow-lg flex items-center justify-between gap-3 text-sm ${typeStyles[type]}`}
    >
      <span>{message}</span>
      <button
        onClick={onClose}
        className="opacity-70 hover:opacity-100 text-lg leading-none"
      >
        &times;
      </button>
    </div>
  );
}
