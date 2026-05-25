import {
  forwardRef,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEventHandler,
} from "react";
import { useOptionalToast } from "../context/ToastContext";

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

export function CopyButton({
  text,
  className = "",
  disabled = false,
  successMessage = "Copied to clipboard",
}: {
  text: string;
  className?: string;
  disabled?: boolean;
  successMessage?: string;
}) {
  const toast = useOptionalToast();
  const [copied, setCopied] = useState(false);
  const canCopy = !disabled && text.length > 0;

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    if (!canCopy) return;

    try {
      await writeClipboard(text);
      setCopied(true);
      toast?.addToast(successMessage, "success");
    } catch {
      toast?.addToast("Could not copy to clipboard", "danger");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={!canCopy}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600/70 bg-slate-800/90 text-slate-200 shadow-sm transition-colors hover:bg-slate-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      title={copied ? "Copied" : "Copy to clipboard"}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      <CopyIcon copied={copied} />
    </button>
  );
}

export const CopyableCodeBlock = forwardRef<
  HTMLPreElement,
  {
    text: string;
    children: ReactNode;
    className: string;
    style?: CSSProperties;
    onScroll?: UIEventHandler<HTMLPreElement>;
    successMessage?: string;
  }
>(function CopyableCodeBlock(
  { text, children, className, style, onScroll, successMessage },
  ref,
) {
  return (
    <div className="relative">
      <CopyButton
        text={text}
        successMessage={successMessage}
        className="absolute right-2 top-2 z-10"
      />
      <pre
        ref={ref}
        onScroll={onScroll}
        className={className}
        style={{ ...style, paddingRight: "3.25rem" }}
      >
        {children}
      </pre>
    </div>
  );
});
