import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Badge } from "./Badge";
import { Modal } from "./Modal";
import { useToast } from "../context/ToastContext";
import { useDateTime } from "../lib/date-time";
import { useI18n } from "../lib/i18n";
import {
  useConfirmOidcLink,
  useOidcLinkStatus,
  useStartOidcLink,
  useUnlinkOidc,
  type AccountHolderProof,
} from "../lib/oidc-link";

const OUTCOME_PARAM = "oidcLink";
const ERROR_OUTCOMES: Record<string, string> = {
  denied: "pages.settings.oidcLink.errorDenied",
  taken: "pages.settings.oidcLink.errorTaken",
  disabled: "pages.settings.oidcLink.errorDisabled",
  session: "pages.settings.oidcLink.errorSession",
  failed: "pages.settings.oidcLink.errorFailed",
};

const PROVIDER_STATUS = {
  current: { badge: "success", label: "pages.settings.oidcLink.statusLinked" },
  changed: { badge: "warning", label: "pages.settings.oidcLink.statusStale" },
  unavailable: { badge: "muted", label: "pages.settings.oidcLink.statusUnavailable" },
} as const;

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const primaryButtonClass =
  "px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50";
const secondaryButtonClass =
  "px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50";

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

const NOTICE_STYLES = {
  info: {
    box: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-100",
    icon: "text-blue-600 dark:text-blue-400",
    // Lucide's Info.
    path: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01",
  },
  warning: {
    box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-400",
    // Lucide's TriangleAlert.
    path: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01",
  },
};

function Notice({
  variant,
  title,
  children,
}: {
  variant: keyof typeof NOTICE_STYLES;
  title?: string;
  children: ReactNode;
}) {
  const style = NOTICE_STYLES[variant];
  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${style.box}`}>
      <svg
        className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d={style.path} />
      </svg>
      <div className="min-w-0">
        {title && <p className="font-medium mb-0.5">{title}</p>}
        <div className="opacity-90">{children}</div>
      </div>
    </div>
  );
}

/** Asks for the local password and authenticator code before a sign-in method changes. */
function AccountHolderForm({
  totpEnabled,
  danger = false,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  totpEnabled: boolean;
  danger?: boolean;
  submitLabel: string;
  busy: boolean;
  onSubmit: (proof: AccountHolderProof, onError: (message: string) => void) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        onSubmit({ password, ...(totpEnabled ? { totpCode } : {}) }, (message) => {
          setError(message);
          setTotpCode("");
        });
      }}
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="oidc-link-password" className={labelClass}>
          {t("pages.settings.currentPassword")}
        </label>
        <input
          id="oidc-link-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </div>
      {totpEnabled && (
        <div>
          <label htmlFor="oidc-link-totp" className={labelClass}>
            {t("pages.settings.authenticatorCode")}
          </label>
          <input
            id="oidc-link-totp"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            className={inputClass}
          />
        </div>
      )}
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={secondaryButtonClass}
        >
          {t("pages.settings.cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !password || (totpEnabled && !totpCode)}
          className={
            danger
              ? "px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50"
              : primaryButtonClass
          }
        >
          {busy ? <span className="spinner spinner-sm" /> : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function OidcLinkSettings() {
  const { t } = useI18n();
  const { formatDate } = useDateTime();
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: status } = useOidcLinkStatus();
  const startLink = useStartOidcLink();
  const confirmLink = useConfirmOidcLink();
  const unlink = useUnlinkOidc();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);

  const outcome = searchParams.get(OUTCOME_PARAM);
  const pending = status?.pending ?? null;

  // The identity provider returns here with the outcome of the link in the URL.
  useEffect(() => {
    if (!outcome || !status) return;
    if (outcome === "confirm" && pending) {
      setConfirmOpen(true);
    } else {
      addToast(
        t(ERROR_OUTCOMES[outcome] ?? "pages.settings.oidcLink.errorSession"),
        "danger",
      );
    }
    setSearchParams(
      (params) => {
        params.delete(OUTCOME_PARAM);
        return params;
      },
      { replace: true },
    );
  }, [addToast, outcome, pending, setSearchParams, status, t]);

  if (!status || (!status.available && !status.link)) return null;

  const { link } = status;
  const roleLabel = (role: "admin" | "read-only") =>
    role === "admin"
      ? t("pages.settings.users.roleAdmin")
      : t("pages.settings.users.roleReadOnly");

  const handleStart = () => {
    startLink.mutate(undefined, {
      onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const loginUrl = `${window.location?.origin ?? ""}/login?local=1`;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 md:p-6 mb-4">
      <h2 className="text-sm font-semibold mb-1">{t("pages.settings.oidcLink.title")}</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        {t(link ? "pages.settings.oidcLink.descriptionLinked" : "pages.settings.oidcLink.description")}
      </p>

      {link ? (
        <div className="flex flex-col gap-3 p-3 rounded-lg border border-border sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium truncate">{link.username}</span>
              <Badge variant={PROVIDER_STATUS[link.provider].badge} small>
                {t(PROVIDER_STATUS[link.provider].label)}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {[
                issuerHost(link.issuer),
                t("pages.settings.oidcLink.ssoAccess", { role: roleLabel(link.role) }),
                t("pages.settings.oidcLink.linkedOn", {
                  date: formatDate(new Date(link.linkedAt + "Z")),
                }),
              ].join(" · ")}
            </p>
          </div>
          {status.canManage && (
            <button
              type="button"
              onClick={() => setUnlinkOpen(true)}
              className={`shrink-0 self-start sm:self-auto ${secondaryButtonClass}`}
            >
              {t("pages.settings.oidcLink.unlink")}
            </button>
          )}
        </div>
      ) : (
        status.canManage && (
          <button
            type="button"
            onClick={handleStart}
            disabled={startLink.isPending}
            className={primaryButtonClass}
          >
            {t("pages.settings.oidcLink.link")}
          </button>
        )
      )}

      <div className="mt-4 space-y-3 empty:hidden">
        {link?.provider === "changed" && (
          <Notice variant="warning" title={t("pages.settings.oidcLink.staleTitle")}>
            {t("pages.settings.oidcLink.stale")}
          </Notice>
        )}
        {link?.provider === "unavailable" && (
          <Notice variant="info" title={t("pages.settings.oidcLink.unavailableTitle")}>
            {t("pages.settings.oidcLink.unavailable")}
          </Notice>
        )}
        {link?.method === "username" && (
          <Notice variant="warning" title={t("pages.settings.oidcLink.unverifiedTitle")}>
            {t("pages.settings.oidcLink.unverified")}
          </Notice>
        )}
        {status.canManage && !status.totpEnabled && (
          <Notice variant="warning" title={t("pages.settings.oidcLink.totpWarningTitle")}>
            {t("pages.settings.oidcLink.totpWarning")}
          </Notice>
        )}
        {status.canManage && status.passwordLoginDisabled && (
          <Notice variant="warning" title={t("pages.settings.oidcLink.passwordLoginWarningTitle")}>
            {t("pages.settings.oidcLink.passwordLoginWarning")}
          </Notice>
        )}
        {link && (
          <Notice variant="info" title={t("pages.settings.oidcLink.recoveryTitle")}>
            <p>{t("pages.settings.oidcLink.recovery")}</p>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="opacity-75">{t("pages.setup.username")}</dt>
              <dd className="font-medium break-all">{status.username}</dd>
              <dt className="opacity-75">{t("pages.settings.oidcLink.recoveryPage")}</dt>
              <dd className="break-all">
                <a href={loginUrl} className="underline underline-offset-2 hover:opacity-80">
                  {loginUrl}
                </a>
              </dd>
            </dl>
          </Notice>
        )}
        {!status.canManage && (
          <Notice variant="info" title={t("pages.settings.oidcLink.ssoSessionHintTitle")}>
            {t("pages.settings.oidcLink.ssoSessionHint")}
          </Notice>
        )}
      </div>

      <Modal
        open={confirmOpen && !!pending}
        onClose={() => setConfirmOpen(false)}
        title={t("pages.settings.oidcLink.confirmTitle")}
      >
        {pending && (
          <div className="space-y-4">
            <p className="text-sm">
              {t("pages.settings.oidcLink.confirmMessage", {
                identity: pending.username,
                issuer: issuerHost(pending.issuer),
                username: status.username,
              })}
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("pages.settings.oidcLink.confirmRole", { role: roleLabel(pending.role) })}
            </p>
            {pending.merge && (
              <Notice variant="warning">
                {t("pages.settings.oidcLink.mergeWarning", {
                  username: pending.merge.username,
                })}
                {pending.merge.apiTokenCount > 0 &&
                  ` ${t("pages.settings.oidcLink.mergeTokensWarning", {
                    count: pending.merge.apiTokenCount,
                  })}`}
              </Notice>
            )}
            <AccountHolderForm
              totpEnabled={status.totpEnabled}
              submitLabel={t("pages.settings.oidcLink.confirm")}
              busy={confirmLink.isPending}
              onCancel={() => setConfirmOpen(false)}
              onSubmit={(proof, onError) =>
                confirmLink.mutate(proof, {
                  onSuccess: () => {
                    addToast(t("pages.settings.oidcLink.linked"), "success");
                    setConfirmOpen(false);
                  },
                  onError: (err) => onError(err.message),
                })
              }
            />
          </div>
        )}
      </Modal>

      <Modal
        open={unlinkOpen}
        onClose={() => setUnlinkOpen(false)}
        title={t("pages.settings.oidcLink.unlinkTitle")}
      >
        <div className="space-y-4">
          <p className="text-sm">{t("pages.settings.oidcLink.unlinkMessage")}</p>
          {status.ssoTokenCount > 0 && (
            <Notice variant="warning">
              {t("pages.settings.oidcLink.unlinkTokensWarning", {
                count: status.ssoTokenCount,
              })}
            </Notice>
          )}
          <AccountHolderForm
            totpEnabled={status.totpEnabled}
            danger
            submitLabel={t("pages.settings.oidcLink.unlink")}
            busy={unlink.isPending}
            onCancel={() => setUnlinkOpen(false)}
            onSubmit={(proof, onError) =>
              unlink.mutate(proof, {
                onSuccess: () => {
                  addToast(t("pages.settings.oidcLink.unlinked"), "success");
                  setUnlinkOpen(false);
                },
                onError: (err) => onError(err.message),
              })
            }
          />
        </div>
      </Modal>
    </div>
  );
}
