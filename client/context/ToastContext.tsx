import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export type ToastType = "success" | "danger" | "info";
export type ToastAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
};

export type ToastOptions = {
  actions?: ToastAction[];
  durationMs?: number | null;
  onClose?: () => void;
};

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  actions?: ToastAction[];
  onClose?: () => void;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType, options?: ToastOptions) => string;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

let fallbackToastIdCounter = 0;

export function createToastId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  fallbackToastIdCounter += 1;
  return `${Date.now().toString(36)}-${fallbackToastIdCounter.toString(36)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    const toast = toastsRef.current.find((t) => t.id === id);
    const nextToasts = toastsRef.current.filter((t) => t.id !== id);
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
    toast?.onClose?.();
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", options: ToastOptions = {}) => {
      const id = createToastId();
      const nextToasts = [
        ...toastsRef.current,
        {
          id,
          message,
          type,
          actions: options.actions,
          onClose: options.onClose,
        },
      ];
      toastsRef.current = nextToasts;
      setToasts(nextToasts);

      const duration =
        options.durationMs === undefined
          ? type === "danger"
            ? 15000
            : 5000
          : options.durationMs;
      if (duration !== null) {
        setTimeout(() => removeToast(id), duration);
      }
      return id;
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function useOptionalToast() {
  return useContext(ToastContext);
}
