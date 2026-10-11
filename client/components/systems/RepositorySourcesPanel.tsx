import { useEffect, useRef, useState } from "react";
import { AgoLabel } from "../AgoLabel";
import { Badge } from "../Badge";
import { CopyableCodeBlock } from "../CopyableCodeBlock";
import { useOptionalToast } from "../../context/ToastContext";
import { ApiError } from "../../lib/client";
import { highlightRepositorySource } from "../../lib/repository-source-highlight";
import {
  useRepositorySources,
  useSaveRepositorySource,
  type RepositorySourceEditBlockedReason,
  type RepositorySourceFile,
  type RepositorySourceFormat,
} from "../../lib/systems";
import { useI18n } from "../../lib/i18n";

const EDIT_BLOCKED_REASON_KEYS: Partial<Record<RepositorySourceEditBlockedReason, string>> = {
  truncated: "components.repositorySources.editBlocked.truncated",
  too_large: "components.repositorySources.editBlocked.tooLarge",
  redacted: "components.repositorySources.editBlocked.redacted",
  encoding: "components.repositorySources.editBlocked.encoding",
  path: "components.repositorySources.editBlocked.path",
};

const secondaryButtonClass =
  "px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap";
const primaryButtonClass =
  "px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-colors disabled:opacity-50 whitespace-nowrap";

function RepositorySourceEditor({
  id,
  value,
  format,
  onChange,
}: {
  id: string;
  value: string;
  format: RepositorySourceFormat;
  onChange: (value: string) => void;
}) {
  const highlightRef = useRef<HTMLPreElement | null>(null);

  return (
    <div className="relative mt-3 min-h-48 overflow-hidden rounded-lg border border-border bg-slate-950 focus-within:ring-2 focus-within:ring-blue-500">
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className="script-editor-highlight pointer-events-none absolute inset-0 min-h-48 overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all"
      >
        <code>{highlightRepositorySource(value, format)}{"\n"}</code>
      </pre>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (!highlightRef.current) return;
          highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        rows={Math.min(24, Math.max(10, value.split("\n").length + 1))}
        className="relative block min-h-48 w-full resize-y bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-white selection:bg-blue-500/30 focus:outline-none whitespace-pre-wrap break-all"
      />
    </div>
  );
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-5 text-slate-100 whitespace-pre-wrap break-all">
      {diff.split("\n").map((line, index) => {
        const className = line.startsWith("+++") || line.startsWith("---")
          ? "text-slate-400"
          : line.startsWith("@@")
            ? "text-sky-300"
            : line.startsWith("+")
              ? "text-green-300"
              : line.startsWith("-")
                ? "text-red-300"
                : undefined;
        return <div key={index} className={className}>{line || " "}</div>;
      })}
    </pre>
  );
}

function RepositorySourceFileBlock({
  file,
  systemId,
  readOnly,
  editing,
  editLocked,
  onEditingChange,
  onReload,
}: {
  file: RepositorySourceFile;
  systemId: number;
  readOnly: boolean;
  /** This file is the one being edited. */
  editing: boolean;
  /** Another file is being edited, so this one cannot start. */
  editLocked: boolean;
  onEditingChange: (editing: boolean) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const toast = useOptionalToast();
  const save = useSaveRepositorySource(systemId);
  const [draft, setDraft] = useState("");
  // Captured when editing starts so a refresh cannot hide a concurrent change.
  const [baseSha256, setBaseSha256] = useState<string | null>(null);
  const [review, setReview] = useState<{ diff: string; content: string } | null>(null);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const blockedReasonKey = file.editBlockedReason ? EDIT_BLOCKED_REASON_KEYS[file.editBlockedReason] : undefined;

  const handleError = (err: unknown) => {
    const conflict = err instanceof ApiError && err.status === 409 && err.details.reason === "conflict";
    setError({ message: err instanceof Error ? err.message : String(err), conflict });
  };

  const startEditing = () => {
    setError(null);
    setReview(null);
    setBaseSha256(file.sha256);
    setDraft(file.content ?? "");
    onEditingChange(true);
  };

  const stopEditing = () => {
    setReview(null);
    setError(null);
    onEditingChange(false);
  };

  const reviewChanges = () => {
    if (!baseSha256) return;
    setError(null);
    const content = draft;
    save.mutate({ path: file.path, content, baseSha256, dryRun: true }, {
      onSuccess: (result) => {
        if (!result.changed) {
          toast?.addToast(t("components.repositorySources.noChanges"), "info");
          stopEditing();
          return;
        }
        setReview({ diff: result.diff, content });
      },
      onError: handleError,
    });
  };

  const confirmSave = () => {
    if (!review || !baseSha256) return;
    save.mutate({ path: file.path, content: review.content, baseSha256 }, {
      onSuccess: () => {
        toast?.addToast(t("components.repositorySources.saved", { path: file.path }), "success");
        stopEditing();
      },
      onError: (err) => {
        setReview(null);
        handleError(err);
      },
    });
  };

  return (
    <div className="py-4 border-b border-border last:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm break-all text-slate-900 dark:text-slate-100">{file.path}</code>
        {file.pkgManagers.map((pkgManager) => (
          <Badge key={pkgManager} variant="muted" small>{pkgManager}</Badge>
        ))}
        {file.redacted ? <Badge variant="info" small>{t("components.repositorySources.credentialsMasked")}</Badge> : null}
        {file.truncated ? <Badge variant="warning" small>{t("components.repositorySources.truncated")}</Badge> : null}
        {!file.readable ? <Badge variant="warning" small>{t("components.repositorySources.unreadable")}</Badge> : null}
        {!readOnly && file.editable && !editing ? (
          <button
            type="button"
            onClick={startEditing}
            disabled={editLocked}
            className={`ml-auto ${secondaryButtonClass}`}
          >
            {t("components.repositorySources.edit")}
          </button>
        ) : null}
      </div>
      {!readOnly && blockedReasonKey ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t(blockedReasonKey)}</p>
      ) : null}

      {editing && review ? (
        <>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            {t("components.repositorySources.confirmMessage", { path: file.path })}
          </p>
          <DiffPreview diff={review.diff} />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setReview(null)}
              disabled={save.isPending}
              className={secondaryButtonClass}
            >
              {t("components.repositorySources.backToEditor")}
            </button>
            <button
              type="button"
              onClick={confirmSave}
              disabled={save.isPending}
              className={`${primaryButtonClass} bg-red-600 hover:bg-red-700`}
            >
              {save.isPending ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  {t("components.repositorySources.saving")}
                </span>
              ) : t("components.repositorySources.save")}
            </button>
          </div>
        </>
      ) : editing ? (
        <>
          <RepositorySourceEditor
            id={`repository-source-${file.path}`}
            value={draft}
            format={file.format}
            onChange={setDraft}
          />
          {error ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <span>{error.message}</span>
              {error.conflict ? (
                <button
                  type="button"
                  onClick={() => {
                    stopEditing();
                    onReload();
                  }}
                  className="px-3 py-1 text-xs font-medium rounded-lg border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                >
                  {t("components.repositorySources.reload")}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={stopEditing}
              disabled={save.isPending}
              className={secondaryButtonClass}
            >
              {t("components.repositorySources.cancel")}
            </button>
            <button
              type="button"
              onClick={reviewChanges}
              disabled={save.isPending}
              className={`${primaryButtonClass} bg-blue-600 hover:bg-blue-700`}
            >
              {save.isPending ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  {t("components.repositorySources.reviewing")}
                </span>
              ) : t("components.repositorySources.reviewChanges")}
            </button>
          </div>
        </>
      ) : file.readable && file.content !== null ? (
        <CopyableCodeBlock
          text={file.content}
          className="script-code mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100 whitespace-pre-wrap break-all"
          successMessage="components.repositorySources.copied"
          expandable
        >
          <code>{highlightRepositorySource(file.content, file.format)}</code>
        </CopyableCodeBlock>
      ) : (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {t("components.repositorySources.unreadableDescription")}
        </p>
      )}
    </div>
  );
}

/** Body of the repository sources modal on the Systems page. */
export function RepositorySourcesPanel({
  systemId,
  readOnly = false,
  onEditingChange,
  onOpenSystemSettings,
}: {
  systemId: number;
  readOnly?: boolean;
  /** Reports whether a file is being edited, e.g. to keep the modal from closing. */
  onEditingChange?: (editing: boolean) => void;
  /** Opens the system settings, where repository source editing is turned on. */
  onOpenSystemSettings?: () => void;
}) {
  const { t } = useI18n();
  const sources = useRepositorySources(systemId);
  const data = sources.data;
  const [editingPath, setEditingPath] = useState<string | null>(null);

  useEffect(() => {
    onEditingChange?.(editingPath !== null);
  }, [editingPath, onEditingChange]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t("components.repositorySources.description")}
        </p>
        <div className="flex items-center gap-2 self-start shrink-0">
          {data ? <AgoLabel timestamp={data.fetchedAt} /> : null}
          <button
            type="button"
            onClick={() => void sources.refetch()}
            disabled={sources.isFetching || editingPath !== null}
            className={secondaryButtonClass}
          >
            {sources.isFetching ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                {t("components.repositorySources.refreshing")}
              </span>
            ) : t("components.repositorySources.refresh")}
          </button>
        </div>
      </div>

      {!readOnly && data && !data.editingEnabled && data.files.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-slate-50 dark:bg-slate-800/60 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-slate-600 dark:text-slate-300">
            {t("components.repositorySources.editingDisabledHint")}
          </p>
          {onOpenSystemSettings ? (
            <button
              type="button"
              onClick={onOpenSystemSettings}
              className={`self-start sm:self-auto shrink-0 ${secondaryButtonClass}`}
            >
              {t("components.repositorySources.openSystemSettings")}
            </button>
          ) : null}
        </div>
      ) : null}

      {!data && sources.isFetching ? (
        <div className="flex justify-center py-10">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : sources.isError && !sources.isFetching ? (
        <div className="text-sm text-red-600 dark:text-red-400">
          {t("components.repositorySources.loadFailed", { error: sources.error.message })}
        </div>
      ) : data ? (
        <>
          {data.unsupportedPkgManagers.length > 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("components.repositorySources.unsupportedManagers", {
                managers: data.unsupportedPkgManagers.join(", "),
              })}
            </p>
          ) : null}
          {data.files.length === 0 ? (
            <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
              {data.pkgManagers.length === 0
                ? t("components.repositorySources.noSupportedManagers")
                : t("components.repositorySources.noFiles")}
            </div>
          ) : (
            <div className="border-t border-border pt-4">
              {data.files.map((file) => (
                <RepositorySourceFileBlock
                  key={file.path}
                  file={file}
                  systemId={systemId}
                  readOnly={readOnly}
                  editing={editingPath === file.path}
                  editLocked={editingPath !== null && editingPath !== file.path}
                  onEditingChange={(editing) => setEditingPath(editing ? file.path : null)}
                  onReload={() => void sources.refetch()}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
