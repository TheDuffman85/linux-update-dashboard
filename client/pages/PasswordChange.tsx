import { useState } from "react";
import { AppLogo } from "../components/AppLogo";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/client";
import { validatePassword } from "../lib/form-validation";
import { useI18n } from "../lib/i18n";
import { useBranding } from "../lib/branding";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

// Shown instead of the app while the password an administrator chose must be replaced.
export default function PasswordChange() {
  const { user, logout, refresh } = useAuth();
  const { t } = useI18n();
  const { appName } = useBranding();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError(t("pages.settings.passwordsDoNotMatch"));
      return;
    }
    if (newPassword === currentPassword) {
      setError(t("pages.passwordChange.mustDiffer"));
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setLoading(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await refresh();
    } catch (err: unknown) {
      setError((err as Error).message || t("pages.settings.failedToChangePassword"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <div className="flex justify-center">
            <AppLogo size={48} />
          </div>
          <p className="mt-3 text-sm font-medium text-slate-500 dark:text-slate-400 break-words">
            {appName}
          </p>
          <h1 className="mt-1 text-xl font-semibold">
            {t("pages.passwordChange.title")}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {t("pages.passwordChange.description", { username: user?.username ?? "" })}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password-change-current" className={labelClass}>
              {t("pages.settings.currentPassword")}
            </label>
            <input
              id="password-change-current"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password-change-new" className={labelClass}>
              {t("pages.settings.newPassword")}
            </label>
            <input
              id="password-change-new"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
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
            <label htmlFor="password-change-confirm" className={labelClass}>
              {t("pages.settings.confirmNewPassword")}
            </label>
            <input
              id="password-change-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? (
              <span className="spinner spinner-sm" />
            ) : (
              t("pages.settings.changePassword")
            )}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full py-2 rounded-lg border border-border text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            {t("components.sidebar.logout")}
          </button>
        </form>
      </div>
    </div>
  );
}
