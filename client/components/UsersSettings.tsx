import { useState } from "react";
import { Badge } from "./Badge";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { useToast } from "../context/ToastContext";
import type { UserRole } from "../context/AuthContext";
import { validatePassword, validateRequiredText } from "../lib/form-validation";
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/date-time";
import {
  useCreateUser,
  useDeleteUser,
  useResetUserMfa,
  useResetUserPassword,
  useUpdateUser,
  useUsers,
  type ManagedUser,
} from "../lib/users";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:cursor-not-allowed disabled:opacity-60";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const actionButtonClass =
  "px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50";
const dangerButtonClass =
  "px-3 py-1.5 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50";

type PasswordForm = {
  password: string;
  confirm: string;
  requirePasswordChange: boolean;
};

const EMPTY_PASSWORD_FORM: PasswordForm = {
  password: "",
  confirm: "",
  requirePasswordChange: true,
};

function PasswordFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: PasswordForm;
  onChange: (value: PasswordForm) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-password`} className={labelClass}>
          {t("pages.settings.password")}
        </label>
        <input
          id={`${idPrefix}-password`}
          type="password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-400">
          {t("pages.settings.minimumCharactersMustIncludeUppercaseLowercaseAndA")}
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-confirm`} className={labelClass}>
          {t("pages.settings.users.confirmPassword")}
        </label>
        <input
          id={`${idPrefix}-confirm`}
          type="password"
          value={value.confirm}
          onChange={(e) => onChange({ ...value, confirm: e.target.value })}
          required
          autoComplete="new-password"
          className={inputClass}
        />
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value.requirePasswordChange}
          onChange={(e) =>
            onChange({ ...value, requirePasswordChange: e.target.checked })
          }
          className="mt-0.5 rounded border-border"
        />
        <span className="text-sm">
          {t("pages.settings.users.requirePasswordChange")}
        </span>
      </label>
    </>
  );
}

type PendingAction =
  | { kind: "delete" | "reset-mfa" | "disable"; user: ManagedUser }
  | null;

export function UsersSettings() {
  const { t } = useI18n();
  const { formatDate } = useDateTime();
  const { addToast } = useToast();
  const { data: users, isLoading } = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();
  const resetMfa = useResetUserMfa();
  const deleteUser = useDeleteUser();

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("read-only");
  const [newPassword, setNewPassword] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [createError, setCreateError] = useState("");

  const [passwordTarget, setPasswordTarget] = useState<ManagedUser | null>(null);
  const [resetForm, setResetForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [resetError, setResetError] = useState("");

  const [pending, setPending] = useState<PendingAction>(null);

  const checkPasswordForm = (form: PasswordForm): string | null => {
    if (form.password !== form.confirm) return t("pages.settings.passwordsDoNotMatch");
    return validatePassword(form.password);
  };

  const openCreate = () => {
    setNewUsername("");
    setNewRole("read-only");
    setNewPassword(EMPTY_PASSWORD_FORM);
    setCreateError("");
    setCreateOpen(true);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const error =
      validateRequiredText(newUsername, t("pages.setup.username"), 128) ??
      checkPasswordForm(newPassword);
    if (error) {
      setCreateError(error);
      return;
    }
    createUser.mutate(
      {
        username: newUsername.trim(),
        password: newPassword.password,
        role: newRole,
        requirePasswordChange: newPassword.requirePasswordChange,
      },
      {
        onSuccess: () => {
          addToast(t("pages.settings.users.created"), "success");
          setCreateOpen(false);
        },
        onError: (err) => setCreateError(err.message),
      },
    );
  };

  const openPasswordReset = (user: ManagedUser) => {
    setResetForm(EMPTY_PASSWORD_FORM);
    setResetError("");
    setPasswordTarget(user);
  };

  const handlePasswordReset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordTarget) return;
    const error = checkPasswordForm(resetForm);
    if (error) {
      setResetError(error);
      return;
    }
    resetPassword.mutate(
      {
        id: passwordTarget.id,
        password: resetForm.password,
        requirePasswordChange: resetForm.requirePasswordChange,
      },
      {
        onSuccess: () => {
          addToast(t("pages.settings.users.passwordReset"), "success");
          setPasswordTarget(null);
        },
        onError: (err) => setResetError(err.message),
      },
    );
  };

  const changeAccess = (
    user: ManagedUser,
    changes: { role?: UserRole; disabled?: boolean },
    onDone?: () => void,
  ) => {
    updateUser.mutate(
      { id: user.id, ...changes },
      {
        onSuccess: () => {
          addToast(t("pages.settings.users.updated"), "success");
          onDone?.();
        },
        onError: (err) => {
          addToast(err.message, "danger");
          onDone?.();
        },
      },
    );
  };

  const confirmPending = () => {
    if (!pending) return;
    const { kind, user } = pending;
    const done = () => setPending(null);
    if (kind === "disable") {
      changeAccess(user, { disabled: true }, done);
      return;
    }
    const mutation = kind === "delete" ? deleteUser : resetMfa;
    mutation.mutate(user.id, {
      onSuccess: () => {
        addToast(
          t(
            kind === "delete"
              ? "pages.settings.users.deleted"
              : "pages.settings.users.mfaReset",
          ),
          "success",
        );
        done();
      },
      onError: (err) => {
        addToast(err.message, "danger");
        done();
      },
    });
  };

  const pendingDialog = pending
    ? {
        delete: {
          title: t("pages.settings.users.deleteTitle"),
          message:
            pending.user.source === "oidc"
              ? t("pages.settings.users.deleteOidcMessage", {
                  username: pending.user.username,
                })
              : t("pages.settings.users.deleteMessage", {
                  username: pending.user.username,
                }),
          confirmLabel: t("pages.settings.users.delete"),
        },
        "reset-mfa": {
          title: t("pages.settings.users.resetMfaTitle"),
          message: t("pages.settings.users.resetMfaMessage", {
            username: pending.user.username,
          }),
          confirmLabel: t("pages.settings.users.resetMfa"),
        },
        disable: {
          title: t("pages.settings.users.disableTitle"),
          message: t("pages.settings.users.disableMessage", {
            username: pending.user.username,
          }),
          confirmLabel: t("pages.settings.users.disable"),
        },
      }[pending.kind]
    : null;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 md:p-6 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold mb-1">{t("pages.settings.users")}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("pages.settings.users.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          {t("pages.settings.users.add")}
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <span className="spinner !w-5 !h-5 text-blue-500" />
        </div>
      ) : (
        <div className="space-y-2">
          {(users ?? []).map((user) => {
            const local = user.source === "local";
            const busy = updateUser.isPending && updateUser.variables?.id === user.id;
            return (
              <div
                key={user.id}
                data-testid={`user-row-${user.username}`}
                className="flex flex-col gap-3 p-3 rounded-lg border border-border lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">{user.username}</span>
                    {user.current && (
                      <Badge variant="info" small>
                        {t("pages.settings.users.you")}
                      </Badge>
                    )}
                    <Badge variant="muted" small>
                      {local
                        ? t("pages.settings.users.sourceLocal")
                        : t("pages.settings.users.sourceOidc")}
                    </Badge>
                    {user.disabled && (
                      <Badge variant="danger" small>
                        {t("pages.settings.users.disabled")}
                      </Badge>
                    )}
                    {user.passwordChangeRequired && (
                      <Badge variant="warning" small>
                        {t("pages.settings.users.passwordChangePending")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {[
                      t("pages.settings.users.createdOn", {
                        date: formatDate(new Date(user.createdAt + "Z")),
                      }),
                      user.totpEnabled ? t("pages.settings.users.totpOn") : null,
                      user.passkeyCount > 0
                        ? t("pages.settings.users.passkeyCount", {
                            count: user.passkeyCount,
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {local && !user.current ? (
                    <select
                      aria-label={t("pages.settings.users.roleFor", {
                        username: user.username,
                      })}
                      value={user.role}
                      disabled={busy}
                      onChange={(e) =>
                        changeAccess(user, { role: e.target.value as UserRole })
                      }
                      className="px-2 py-1.5 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 disabled:opacity-60"
                    >
                      <option value="admin">{t("pages.settings.users.roleAdmin")}</option>
                      <option value="read-only">
                        {t("pages.settings.users.roleReadOnly")}
                      </option>
                    </select>
                  ) : (
                    <Badge variant={user.role === "admin" ? "info" : "muted"}>
                      {user.role === "admin"
                        ? t("pages.settings.users.roleAdmin")
                        : t("pages.settings.users.roleReadOnly")}
                    </Badge>
                  )}
                  {local && !user.current && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          user.disabled
                            ? changeAccess(user, { disabled: false })
                            : setPending({ kind: "disable", user })
                        }
                        className={actionButtonClass}
                      >
                        {user.disabled
                          ? t("pages.settings.users.enable")
                          : t("pages.settings.users.disable")}
                      </button>
                      <button
                        type="button"
                        onClick={() => openPasswordReset(user)}
                        className={actionButtonClass}
                      >
                        {t("pages.settings.users.resetPassword")}
                      </button>
                      {(user.totpEnabled || user.passkeyCount > 0) && (
                        <button
                          type="button"
                          onClick={() => setPending({ kind: "reset-mfa", user })}
                          className={actionButtonClass}
                        >
                          {t("pages.settings.users.resetMfa")}
                        </button>
                      )}
                    </>
                  )}
                  {!user.current && (
                    <button
                      type="button"
                      onClick={() => setPending({ kind: "delete", user })}
                      className={dangerButtonClass}
                    >
                      {t("pages.settings.users.delete")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        {t("pages.settings.users.oidcHint")}
      </p>

      <Modal
        open={createOpen}
        onClose={() => !createUser.isPending && setCreateOpen(false)}
        title={t("pages.settings.users.add")}
        dismissible={!createUser.isPending}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {createError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
              {createError}
            </div>
          )}
          <div>
            <label htmlFor="new-user-username" className={labelClass}>
              {t("pages.setup.username")}
            </label>
            <input
              id="new-user-username"
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              required
              maxLength={128}
              autoComplete="off"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="new-user-role" className={labelClass}>
              {t("pages.settings.users.role")}
            </label>
            <select
              id="new-user-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className={inputClass}
            >
              <option value="read-only">{t("pages.settings.users.roleReadOnly")}</option>
              <option value="admin">{t("pages.settings.users.roleAdmin")}</option>
            </select>
          </div>
          <PasswordFields idPrefix="new-user" value={newPassword} onChange={setNewPassword} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={createUser.isPending}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {t("pages.settings.cancel")}
            </button>
            <button
              type="submit"
              disabled={createUser.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {createUser.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                t("pages.settings.users.create")
              )}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={passwordTarget !== null}
        onClose={() => !resetPassword.isPending && setPasswordTarget(null)}
        title={t("pages.settings.users.resetPasswordFor", {
          username: passwordTarget?.username ?? "",
        })}
        dismissible={!resetPassword.isPending}
      >
        <form onSubmit={handlePasswordReset} className="space-y-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("pages.settings.users.resetPasswordDescription")}
          </p>
          {resetError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
              {resetError}
            </div>
          )}
          <PasswordFields idPrefix="reset-user" value={resetForm} onChange={setResetForm} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setPasswordTarget(null)}
              disabled={resetPassword.isPending}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {t("pages.settings.cancel")}
            </button>
            <button
              type="submit"
              disabled={resetPassword.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {resetPassword.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                t("pages.settings.users.resetPassword")
              )}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
        title={pendingDialog?.title ?? ""}
        message={pendingDialog?.message ?? ""}
        confirmLabel={pendingDialog?.confirmLabel}
        danger
        loading={deleteUser.isPending || resetMfa.isPending || updateUser.isPending}
      />
    </div>
  );
}
