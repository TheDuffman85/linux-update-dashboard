import { Modal } from "./Modal";

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">
        {message}
      </p>
      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className={`px-4 py-2 text-sm rounded-lg text-white transition-colors disabled:opacity-50 ${
            danger
              ? "bg-red-600 hover:bg-red-700"
              : "bg-blue-600 hover:bg-blue-700"
          }`}
        >
          {loading ? <span className="spinner spinner-sm" /> : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
