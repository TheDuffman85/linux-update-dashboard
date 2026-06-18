import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type RefObject,
  type ReactNode,
  type UIEventHandler,
} from "react";
import { useOptionalToast } from "../context/ToastContext";
import { useI18n } from "../lib/i18n";

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
  successMessage = "components.copyableCodeBlock.copiedToClipboard",
}: {
  text: string;
  className?: string;
  disabled?: boolean;
  successMessage?: string;
}) {
  const toast = useOptionalToast();
  const { t } = useI18n();
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
      toast?.addToast(t(successMessage), "success");
    } catch {
      toast?.addToast(t("components.copyableCodeBlock.couldNotCopyToClipboard"), "danger");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={!canCopy}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600/70 bg-slate-800/90 text-slate-200 shadow-sm transition-colors hover:bg-slate-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      title={copied ? t("components.copyableCodeBlock.copied") : t("components.copyableCodeBlock.copyToClipboard")}
      aria-label={copied ? t("components.copyableCodeBlock.copied") : t("components.copyableCodeBlock.copyToClipboard")}
    >
      <CopyIcon copied={copied} />
    </button>
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export function isContentOverflowing({
  scrollHeight,
  clientHeight,
}: Pick<HTMLElement, "scrollHeight" | "clientHeight">) {
  return scrollHeight > clientHeight;
}

export function useContentExpansion<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  contentKey: string,
  enabled = true,
) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  const measureOverflow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setCanExpand(expanded || isContentOverflowing(el));
  }, [containerRef, expanded]);

  useEffect(() => {
    if (!enabled) return;
    measureOverflow();

    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, contentKey, enabled, measureOverflow]);

  return {
    expanded,
    canExpand,
    toggleExpanded: () => setExpanded((current) => !current),
    expansionStyle: expanded ? { maxHeight: "none" } : undefined,
  };
}

export function ContentExpansionButton({
  expanded,
  onToggle,
  className = "",
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const label = expanded ? t("components.copyableCodeBlock.collapseContent") : t("components.copyableCodeBlock.showAllContent");

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600/70 bg-slate-800/90 text-slate-200 shadow-sm transition-colors hover:bg-slate-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        {expanded ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 15 6-6 6 6" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
        )}
      </svg>
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
    expandable?: boolean;
  }
>(function CopyableCodeBlock(
  { text, children, className, style, onScroll, successMessage, expandable = false },
  forwardedRef,
) {
  const preRef = useRef<HTMLPreElement>(null);
  const {
    expanded,
    canExpand,
    toggleExpanded,
    expansionStyle,
  } = useContentExpansion(preRef, text, expandable);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-[1] flex gap-1">
        {expandable && canExpand && (
          <ContentExpansionButton expanded={expanded} onToggle={toggleExpanded} />
        )}
        <CopyButton
          text={text}
          successMessage={successMessage}
        />
      </div>
      <pre
        ref={(node) => {
          preRef.current = node;
          setRef(forwardedRef, node);
        }}
        onScroll={onScroll}
        className={className}
        style={{ minHeight: "2.75rem", ...style, ...expansionStyle, paddingRight: expandable && canExpand ? "5.25rem" : "3.25rem" }}
      >
        {children}
      </pre>
    </div>
  );
});
