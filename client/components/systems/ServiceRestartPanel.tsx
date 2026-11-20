import { useEffect, useMemo, useState } from "react";
import { Badge } from "../Badge";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import { useI18n } from "../../lib/i18n";
import { useToast } from "../../context/ToastContext";
import {
  useRestartServices,
  useUpdateServiceRestartSkipPatterns,
  type System,
} from "../../lib/systems";
import {
  DEFAULT_SERVICE_RESTART_SKIP_PATTERNS,
  MAX_SERVICES_PER_RESTART,
  isServiceSkipped,
  normalizeServiceSkipPatterns,
  resolveServiceSkipPatterns,
  type ServiceRestartService,
} from "../../../shared/service-restart";

const WARNING_ICON_PATH =
  "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z";

function describeProcesses(service: ServiceRestartService): string {
  const byName = new Map<string, number[]>();
  for (const process of service.processes) {
    const name = process.comm || "?";
    byName.set(name, [...(byName.get(name) ?? []), process.pid]);
  }
  return [...byName.entries()]
    .map(([name, pids]) => `${name} (${pids.slice(0, 3).join(", ")}${pids.length > 3 ? ", …" : ""})`)
    .join(", ");
}

/**
 * Lists services that still run replaced binaries or libraries and restarts
 * the selected ones. Services on the skip list are shown but not preselected.
 */
export function ServiceRestartPanel({
  system,
  readOnly,
  busy,
}: {
  system: System;
  readOnly: boolean;
  /** Another operation is running on this system. */
  busy: boolean;
}) {
  const { t } = useI18n();
  const { addToast } = useToast();
  const restartServices = useRestartServices();
  const updateSkipPatterns = useUpdateServiceRestartSkipPatterns();
  const info = system.serviceRestartInfo;
  const skipPatterns = resolveServiceSkipPatterns(system.serviceRestartSkipPatterns);
  const services = info?.services ?? [];
  const restartable = useMemo(
    () => services.filter((service) => !isServiceSkipped(service.unit, skipPatterns)).map((service) => service.unit),
    [services, skipPatterns],
  );
  // The API accepts a limited number of services per request, so preselect no more.
  const restartableKey = restartable.slice(0, MAX_SERVICES_PER_RESTART).join("\n");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(restartableKey ? restartableKey.split("\n") : []));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipListOpen, setSkipListOpen] = useState(false);
  const [skipListDraft, setSkipListDraft] = useState("");

  // A new scan or skip list resets the selection to the restartable services.
  useEffect(() => {
    setSelected(new Set(restartableKey ? restartableKey.split("\n") : []));
  }, [restartableKey]);

  if (!info) return null;
  const restarting = restartServices.isPending || system.activeOperation?.type === "restart_services";
  // After a restart whose follow-up scan did not finish, the list needs a refresh first.
  const stale = info.stale === true;
  const hasFindings = services.length > 0 || info.managerNeedsReexec || info.otherProcesses.length > 0;

  if (!hasFindings) {
    // Every listed service restarted, but the check afterwards did not finish:
    // the host may still need restarts, so ask for a refresh instead of hiding.
    if (stale) {
      return (
        <p className="mb-6 text-xs font-medium text-amber-700 dark:text-amber-400">
          {t("pages.systemDetail.serviceRestart.staleList")}
        </p>
      );
    }
    if (info.status === "ok") return null;
    return (
      <p className="mb-6 text-xs text-slate-500 dark:text-slate-400">
        {info.status === "denied"
          ? t("pages.systemDetail.serviceRestart.scanDenied")
          : info.status === "unsupported"
            ? t("pages.systemDetail.serviceRestart.scanUnsupported")
            : t("pages.systemDetail.serviceRestart.scanPartial")}
      </p>
    );
  }

  const selectedUnits = services.map((service) => service.unit).filter((unit) => selected.has(unit));
  const selectionFull = selectedUnits.length >= MAX_SERVICES_PER_RESTART;
  const toggle = (unit: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(unit)) next.delete(unit);
      else if (next.size < MAX_SERVICES_PER_RESTART) next.add(unit);
      return next;
    });
  };

  const handleRestart = () => {
    setConfirmOpen(false);
    restartServices.mutate({ id: system.id, services: selectedUnits }, {
      onSuccess: (result) => addToast(
        result.status === "success" ? t("pages.systemDetail.serviceRestart.toastRestarted") : result.message,
        result.status === "success" ? "success" : result.status === "failed" ? "danger" : "info",
      ),
      onError: (error: Error) => addToast(error.message, "danger"),
    });
  };

  const openSkipList = () => {
    setSkipListDraft(skipPatterns.join("\n"));
    setSkipListOpen(true);
  };

  const saveSkipList = (patterns: string[] | null) => {
    updateSkipPatterns.mutate({ id: system.id, patterns }, {
      onSuccess: () => {
        setSkipListOpen(false);
        addToast(t("pages.systemDetail.serviceRestart.toastSkipListSaved"), "success");
      },
      onError: (error: Error) => addToast(error.message, "danger"),
    });
  };

  const handleSaveSkipList = () => {
    const normalized = normalizeServiceSkipPatterns(skipListDraft.split("\n"));
    if ("error" in normalized) {
      addToast(normalized.error, "danger");
      return;
    }
    saveSkipList(normalized.patterns);
  };

  const highlighted = restartable.length > 0;
  const tone = highlighted
    ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400"
    : "border-border bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300";

  return (
    <div className={`mb-6 rounded-xl border text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={WARNING_ICON_PATH} />
        </svg>
        <span className="font-medium">
          {highlighted
            ? t("pages.systemDetail.serviceRestart.title", { count: restartable.length })
            : t("pages.systemDetail.serviceRestart.titleNoneRestartable")}
        </span>
        <span className="flex-1 min-w-[12rem] opacity-90">{t("pages.systemDetail.serviceRestart.description")}</span>
        {!readOnly && (
          <>
            <button
              onClick={openSkipList}
              disabled={updateSkipPatterns.isPending}
              className="px-3 py-1 text-xs font-medium rounded-lg border border-current/30 bg-white/70 dark:bg-slate-900/30 hover:bg-white dark:hover:bg-slate-900/50 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {t("pages.systemDetail.serviceRestart.editSkipList")}
            </button>
            {services.length > 0 && (
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={restarting || busy || stale || selectedUnits.length === 0}
                className="px-3 py-1 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {restarting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="spinner spinner-sm" />
                    {t("pages.systemDetail.serviceRestart.restarting")}
                  </span>
                ) : t("pages.systemDetail.serviceRestart.restartSelected", { count: selectedUnits.length })}
              </button>
            )}
          </>
        )}
      </div>

      {services.length > 0 && (
        <ul className="border-t border-current/15 divide-y divide-current/10">
          {services.map((service) => {
            const skipped = isServiceSkipped(service.unit, skipPatterns);
            return (
              <li key={service.unit} className="flex items-start gap-3 px-4 py-2">
                {!readOnly && (
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={selected.has(service.unit)}
                    disabled={restarting || stale || (selectionFull && !selected.has(service.unit))}
                    onChange={() => toggle(service.unit)}
                    aria-label={service.unit}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs text-slate-800 dark:text-slate-100 break-all">{service.unit}</code>
                    {skipped && (
                      <span title={t("pages.systemDetail.serviceRestart.skippedHint")}>
                        <Badge variant="muted" small>{t("pages.systemDetail.serviceRestart.skipped")}</Badge>
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 break-all"
                    title={service.files.join("\n")}
                  >
                    {describeProcesses(service)}
                    {service.files[0] ? ` · ${service.files[0]}${service.files.length > 1 ? " …" : ""}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(info.managerNeedsReexec || info.otherProcesses.length > 0 || info.status === "partial" || stale
        || (!readOnly && services.length > MAX_SERVICES_PER_RESTART)) && (
        <div className="border-t border-current/15 px-4 py-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
          {stale && <p className="font-medium">{t("pages.systemDetail.serviceRestart.staleList")}</p>}
          {!readOnly && services.length > MAX_SERVICES_PER_RESTART && (
            <p>{t("pages.systemDetail.serviceRestart.selectionLimit", { max: MAX_SERVICES_PER_RESTART })}</p>
          )}
          {info.managerNeedsReexec && (
            <p>
              {info.init === "systemd"
                ? t("pages.systemDetail.serviceRestart.managerReexec")
                : t("pages.systemDetail.serviceRestart.managerReboot")}
            </p>
          )}
          {info.otherProcesses.length > 0 && (
            <p>
              {t("pages.systemDetail.serviceRestart.otherProcesses", {
                count: info.otherProcesses.length,
                names: [...new Set(info.otherProcesses.map((process) => process.comm || String(process.pid)))].slice(0, 8).join(", "),
              })}
            </p>
          )}
          {info.status === "partial" && <p>{t("pages.systemDetail.serviceRestart.scanPartial")}</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleRestart}
        title={t("pages.systemDetail.serviceRestart.confirmTitle")}
        message={t("pages.systemDetail.serviceRestart.confirmMessage", {
          count: selectedUnits.length,
          systemName: system.name,
        })}
        confirmLabel={t("pages.systemDetail.serviceRestart.restart")}
        danger
        loading={restarting}
      >
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border px-3 py-2 font-mono text-xs space-y-0.5">
          {selectedUnits.map((unit) => (
            <li key={unit} className="flex items-center gap-2">
              <span className="break-all">{unit}</span>
              {isServiceSkipped(unit, skipPatterns) && (
                <Badge variant="warning" small>{t("pages.systemDetail.serviceRestart.skipped")}</Badge>
              )}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <Modal
        open={skipListOpen}
        onClose={() => setSkipListOpen(false)}
        title={t("pages.systemDetail.serviceRestart.skipListTitle")}
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          {t("pages.systemDetail.serviceRestart.skipListDescription")}
        </p>
        {system.serviceRestartSkipPatterns === null && (
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {t("pages.systemDetail.serviceRestart.skipListUsingDefaults")}
          </p>
        )}
        <textarea
          value={skipListDraft}
          onChange={(event) => setSkipListDraft(event.target.value)}
          rows={12}
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs"
        />
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button
            onClick={() => {
              setSkipListDraft(DEFAULT_SERVICE_RESTART_SKIP_PATTERNS.join("\n"));
              saveSkipList(null);
            }}
            disabled={updateSkipPatterns.isPending}
            className="mr-auto px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {t("pages.systemDetail.serviceRestart.resetToDefaults")}
          </button>
          <button
            onClick={() => setSkipListOpen(false)}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSaveSkipList}
            disabled={updateSkipPatterns.isPending}
            className="px-4 py-2 text-sm rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {updateSkipPatterns.isPending ? <span className="spinner spinner-sm" /> : t("common.save")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
