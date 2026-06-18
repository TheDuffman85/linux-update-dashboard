import { useState, useEffect } from "react";
import { Layout } from "../components/Layout";
import { useSettingsResponse, useUpdateSettings } from "../lib/settings";
import { validatePassword, validateRequiredText } from "../lib/form-validation";
import {
  NUMERIC_SETTING_RULES,
  normalizeIntegerSetting,
  normalizeSettingsUpdate,
  type NumericSettingKey,
  type NumericSettingRules,
} from "../lib/settings-validation";
import { usePasskeys, useDeletePasskey, useRegisterPasskey, useRenamePasskey } from "../lib/passkeys";
import { useApiTokens, useCreateApiToken, useRenameApiToken, useDeleteApiToken } from "../lib/api-tokens";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/client";
import {
  BROWSER_LANGUAGE_SETTING,
  LANGUAGE_SETTING_KEY,
  SUPPORTED_LANGUAGES,
  getLanguageLabel,
  normalizeLanguagePreference,
  resolveLanguagePreference,
  translateForLanguage,
  type TranslationValues,
  useI18n,
} from "../lib/i18n";

function SettingSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 md:p-6 mb-4">
      <h2 className="text-sm font-semibold mb-4">{title}</h2>
      {children}
    </div>
  );
}

export default function Settings() {
  const { data: settingsResponse, isLoading } = useSettingsResponse();
  const updateSettings = useUpdateSettings();
  const { addToast } = useToast();
  const { hasPassword, refresh: refreshAuth } = useAuth();
  const { browserLanguage, t } = useI18n();

  const { data: passkeys, isLoading: passkeysLoading } = usePasskeys();
  const deletePasskey = useDeletePasskey();
  const registerPasskey = useRegisterPasskey();
  const renamePasskey = useRenamePasskey();
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [showNamePrompt, setShowNamePrompt] = useState(false);

  const { data: apiTokens, isLoading: tokensLoading } = useApiTokens();
  const createApiToken = useCreateApiToken();
  const renameApiToken = useRenameApiToken();
  const deleteApiToken = useDeleteApiToken();
  const [tokenDeleteTarget, setTokenDeleteTarget] = useState<number | null>(null);
  const [tokenEditingId, setTokenEditingId] = useState<number | null>(null);
  const [tokenEditingName, setTokenEditingName] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenExpiry, setNewTokenExpiry] = useState("30");
  const [newTokenReadOnly, setNewTokenReadOnly] = useState(true);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  const [form, setForm] = useState<Record<string, string>>({});
  const [storedSecrets, setStoredSecrets] = useState<Record<string, boolean>>({});
  const numericSettingRules: NumericSettingRules = {
    ...NUMERIC_SETTING_RULES,
    ...(settingsResponse?.numericSettingRules ?? {}),
  };

  useEffect(() => {
    if (settingsResponse?.settings) {
      const cleanedForm = { ...settingsResponse.settings };
      const secrets: Record<string, boolean> = {};
      for (const key of ["oidc_client_secret"]) {
        if (cleanedForm[key] === "(stored)") {
          secrets[key] = true;
          cleanedForm[key] = "";
        }
      }
      setStoredSecrets(secrets);
      setForm(cleanedForm);
    }
  }, [settingsResponse]);

  const setNumericField = (key: NumericSettingKey, value: string) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const normalizeNumericField = (key: NumericSettingKey) => {
    setForm((prev) => ({
      ...prev,
      [key]: normalizeIntegerSetting(key, prev[key] ?? "", numericSettingRules),
    }));
  };

  const handleSave = (keys: string[]) => {
    const data: Record<string, string> = {};
    for (const k of keys) {
      if (storedSecrets[k] && !form[k]) {
        data[k] = "(stored)";
      } else {
        data[k] = form[k] ?? "";
      }
    }
    const normalizedData = normalizeSettingsUpdate(data, numericSettingRules);
    setForm((prev) => ({ ...prev, ...normalizedData }));
    const toastT =
      LANGUAGE_SETTING_KEY in normalizedData
        ? (key: string, values?: TranslationValues) =>
            translateForLanguage(
              resolveLanguagePreference(
                normalizeLanguagePreference(normalizedData[LANGUAGE_SETTING_KEY]),
              ),
              key,
              values,
            )
        : t;

    updateSettings.mutate(normalizedData, {
      onSuccess: (res) => {
        if (res.oidcError) {
          addToast(
            toastT("pages.settings.settingsSavedButOidcConfigurationFailedError", {
              error: res.oidcError,
            }),
            "danger",
          );
        } else {
          addToast(toastT("pages.settings.settingsSaved"), "success");
        }
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPassword !== confirmPassword) {
      setPwError(t("pages.settings.passwordsDoNotMatch"));
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setPwError(passwordError);
      return;
    }
    setPwLoading(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      addToast(t("pages.settings.passwordChangedSuccessfully"), "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setPwError((err as Error).message || t("pages.settings.failedToChangePassword"));
    } finally {
      setPwLoading(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
  const labelClass =
    "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

  if (isLoading) {
    return (
      <Layout title={t("pages.settings.settings")}>
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout title={t("pages.settings.settings")}>
      <SettingSection title={t("pages.settings.general")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
          <div>
            <label className={labelClass}>{t("pages.settings.activityHistory")}</label>
            <input
              type="number"
              min={numericSettingRules.activity_history_limit.min}
              max={numericSettingRules.activity_history_limit.max}
              value={form.activity_history_limit || "20"}
              onChange={(e) =>
                setNumericField("activity_history_limit", e.target.value)
              }
              onBlur={() => normalizeNumericField("activity_history_limit")}
              className={inputClass}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("pages.settings.keepsOnlyThisManyRecentActivityEntriesPer")}
            </p>
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.eolWarningWindowDays")}</label>
            <input
              type="number"
              min={numericSettingRules.distro_eol_warning_days.min}
              max={numericSettingRules.distro_eol_warning_days.max}
              value={form.distro_eol_warning_days || "180"}
              onChange={(e) =>
                setNumericField("distro_eol_warning_days", e.target.value)
              }
              onBlur={() => normalizeNumericField("distro_eol_warning_days")}
              className={inputClass}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("pages.settings.showsDashboardAndSystemWarningsThisManyDays")}
            </p>
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.language")}</label>
            <select
              value={form[LANGUAGE_SETTING_KEY] || BROWSER_LANGUAGE_SETTING}
              onChange={(e) =>
                setForm({
                  ...form,
                  [LANGUAGE_SETTING_KEY]: e.target.value,
                })
              }
              className={inputClass}
            >
              <option value={BROWSER_LANGUAGE_SETTING}>
                {t("pages.settings.browserDefaultLanguage", {
                  language: getLanguageLabel(browserLanguage),
                })}
              </option>
              {SUPPORTED_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("pages.settings.usesYourBrowserPreferredLanguageByDefaultAnd")}
            </p>
          </div>
        </div>
        <button
          onClick={() =>
            handleSave([
              "activity_history_limit",
              "distro_eol_warning_days",
              LANGUAGE_SETTING_KEY,
            ])
          }
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {t("pages.settings.save")}
        </button>
      </SettingSection>

      {/* SSH */}
      <SettingSection title={t("pages.settings.ssh")}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>{t("pages.settings.connectionTimeoutS")}</label>
            <input
              type="number"
              value={form.ssh_timeout_seconds || "30"}
              onChange={(e) =>
                setNumericField("ssh_timeout_seconds", e.target.value)
              }
              onBlur={() => normalizeNumericField("ssh_timeout_seconds")}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.commandTimeoutS")}</label>
            <input
              type="number"
              value={form.cmd_timeout_seconds || "120"}
              onChange={(e) =>
                setNumericField("cmd_timeout_seconds", e.target.value)
              }
              onBlur={() => normalizeNumericField("cmd_timeout_seconds")}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.concurrentConnections")}</label>
            <input
              type="number"
              value={form.concurrent_connections || "5"}
              onChange={(e) =>
                setNumericField("concurrent_connections", e.target.value)
              }
              onBlur={() => normalizeNumericField("concurrent_connections")}
              className={inputClass}
            />
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-border">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_root_user_check !== "false"}
              onChange={(e) =>
                setForm({
                  ...form,
                  enable_root_user_check: e.target.checked ? "true" : "false",
                })
              }
              className="mt-0.5 rounded border-border"
            />
            <span>
              <span className="block text-sm">{t("pages.settings.leastPrivilegeRootUserCheck")}</span>
              <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t("pages.settings.showANoticeWhenASystemConnectsAs")}
              </span>
            </span>
          </label>
        </div>
        <button
          onClick={() =>
            handleSave([
              "ssh_timeout_seconds",
              "cmd_timeout_seconds",
              "concurrent_connections",
              "enable_root_user_check",
            ])
          }
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {t("pages.settings.save")}
        </button>
      </SettingSection>

      {/* Password */}
      <SettingSection title={t("pages.settings.password")}>
        {(() => {
          const hasAlternativeAuth =
            (passkeys && passkeys.length > 0) ||
            !!(form.oidc_issuer && form.oidc_client_id);
          const canDisable = hasAlternativeAuth;
          return (
            <>
              <label className={`flex items-center gap-2 ${canDisable ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
                <input
                  type="checkbox"
                  checked={form.disable_password_login === "true"}
                  onChange={(e) =>
                    setForm({ ...form, disable_password_login: e.target.checked ? "true" : "false" })
                  }
                  disabled={!canDisable && form.disable_password_login !== "true"}
                  className="rounded border-border"
                />
                <span className="text-sm">{t("pages.settings.disablePasswordLogin")}</span>
              </label>
              {!canDisable ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t("pages.settings.registerAPasskeyOrConfigureSsoBeforeDisabling")}
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  {t("pages.settings.whenEnabledOnlyPasskeyAndSsoLoginMethods")}
                </p>
              )}
            </>
          );
        })()}
        <button
          onClick={() => {
            handleSave(["disable_password_login"]);
            refreshAuth();
          }}
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {t("pages.settings.save")}
        </button>

        {hasPassword && (
          <>
            <hr className="my-6 border-border" />
            <h3 className="text-sm font-semibold mb-4">{t("pages.settings.changePassword")}</h3>
            <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
              {pwError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
                  {pwError}
                </div>
              )}
              <div>
                <label className={labelClass}>{t("pages.settings.currentPassword")}</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.settings.newPassword")}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-slate-400">
                  {t("pages.settings.minimumCharactersMustIncludeUppercaseLowercaseAndA")}
                </p>
              </div>
              <div>
                <label className={labelClass}>{t("pages.settings.confirmNewPassword")}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                disabled={pwLoading}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {pwLoading ? <span className="spinner spinner-sm" /> : t("pages.settings.changePassword")}
              </button>
            </form>
          </>
        )}
      </SettingSection>

      {/* Passkeys — only in secure contexts where WebAuthn is available */}
      {window.isSecureContext && (
        <SettingSection title={t("pages.settings.passkeys")}>
          {passkeysLoading ? (
            <div className="flex justify-center py-4">
              <span className="spinner !w-5 !h-5 text-blue-500" />
            </div>
          ) : passkeys && passkeys.length > 0 ? (
            <div className="space-y-2 mb-4">
              {passkeys.map((pk) => (
                <div
                  key={pk.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border"
                >
                  <div className="min-w-0 flex items-center">
                    {editingId === pk.id ? (
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                          const trimmed = editingName.trim();
                          const nameError = trimmed
                            ? validateRequiredText(trimmed, "Passkey name", 50)
                            : null;
                          if (nameError) {
                            addToast(nameError, "danger");
                          } else if (trimmed && trimmed !== (pk.name ?? "")) {
                            renamePasskey.mutate(
                              { id: pk.id, name: trimmed },
                              {
                                onSuccess: () => addToast(t("pages.settings.passkeyRenamed"), "success"),
                                onError: (err) => addToast(err.message || t("pages.settings.failedToRename"), "danger"),
                              }
                            );
                          }
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        maxLength={50}
                        className="text-sm px-1.5 py-0.5 rounded border border-blue-500 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setEditingId(pk.id);
                          setEditingName(pk.name ?? "");
                        }}
                        className="text-sm truncate hover:underline cursor-pointer text-left"
                        title={t("pages.settings.clickToRename")}
                      >
                        {pk.name || (
                          <span className="font-mono text-slate-400">
                            {pk.credentialId.slice(0, 16)}…
                          </span>
                        )}
                      </button>
                    )}
                    <span className="ml-3 text-xs text-slate-500 shrink-0">
                      {t("pages.settings.added")}{" "}
                      {new Date(pk.createdAt + "Z").toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setDeleteTarget(pk.id)}
                    className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                    title={t("pages.settings.removePasskey")}
                    aria-label={t("pages.settings.removePasskeyName", {
                      name: pk.name || pk.credentialId.slice(0, 16),
                    })}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500 mb-4">
              {t("pages.settings.noPasskeysRegisteredAddOneToEnablePasswordless")}
            </p>
          )}

          {showNamePrompt ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newPasskeyName}
                onChange={(e) => setNewPasskeyName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    registerPasskey.mutate(newPasskeyName.trim() || undefined, {
                      onSuccess: () => {
                        addToast(t("pages.settings.passkeyRegisteredSuccessfully"), "success");
                        setShowNamePrompt(false);
                        setNewPasskeyName("");
                      },
                      onError: (err) =>
                        addToast(err.message || t("pages.settings.failedToRegisterPasskey"), "danger"),
                    });
                  }
                  if (e.key === "Escape") {
                    setShowNamePrompt(false);
                    setNewPasskeyName("");
                  }
                }}
                maxLength={50}
                placeholder={t("pages.settings.passkeyNameEGYubikeyMacbook")}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
              <button
                onClick={() => {
                  registerPasskey.mutate(newPasskeyName.trim() || undefined, {
                    onSuccess: () => {
                      addToast(t("pages.settings.passkeyRegisteredSuccessfully"), "success");
                      setShowNamePrompt(false);
                      setNewPasskeyName("");
                    },
                    onError: (err) =>
                      addToast(err.message || t("pages.settings.failedToRegisterPasskey"), "danger"),
                  });
                }}
                disabled={registerPasskey.isPending}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {registerPasskey.isPending ? (
                  <span className="spinner spinner-sm" />
                ) : (
                  t("pages.settings.register")
                )}
              </button>
              <button
                onClick={() => {
                  setShowNamePrompt(false);
                  setNewPasskeyName("");
                }}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                {t("pages.settings.cancel")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNamePrompt(true)}
              disabled={registerPasskey.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {t("pages.settings.registerNewPasskey")}
            </button>
          )}

          <ConfirmDialog
            open={deleteTarget !== null}
            onClose={() => setDeleteTarget(null)}
            onConfirm={() => {
              if (deleteTarget !== null) {
                deletePasskey.mutate(deleteTarget, {
                  onSuccess: () => {
                    addToast(t("pages.settings.passkeyRemoved"), "success");
                    setDeleteTarget(null);
                  },
                  onError: (err) => {
                    addToast(
                      err.message || t("pages.settings.failedToRemovePasskey"),
                      "danger"
                    );
                    setDeleteTarget(null);
                  },
                });
              }
            }}
            title={t("pages.settings.removePasskey2")}
            message={t("pages.settings.areYouSureYouWantToRemoveThis")}
            confirmLabel={t("pages.settings.remove")}
            danger
            loading={deletePasskey.isPending}
          />
        </SettingSection>
      )}

      {/* OIDC */}
      <SettingSection title={t("pages.settings.oidcSso")}>
        <div className="space-y-4">
          <div>
            <label className={labelClass}>{t("pages.settings.issuerUrl")}</label>
            <input
              type="url"
              value={form.oidc_issuer || ""}
              onChange={(e) =>
                setForm({ ...form, oidc_issuer: e.target.value })
              }
              className={inputClass}
              placeholder="https://auth.example.com"
            />
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.clientId")}</label>
            <input
              type="text"
              value={form.oidc_client_id || ""}
              onChange={(e) =>
                setForm({ ...form, oidc_client_id: e.target.value })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{t("pages.settings.clientSecret")}</label>
            <input
              type="password"
              value={form.oidc_client_secret || ""}
              onChange={(e) =>
                setForm({ ...form, oidc_client_secret: e.target.value })
              }
              className={inputClass}
              placeholder={storedSecrets.oidc_client_secret && !form.oidc_client_secret ? t("pages.settings.unchanged") : ""}
            />
          </div>
        </div>
        <button
          onClick={() =>
            handleSave(["oidc_issuer", "oidc_client_id", "oidc_client_secret"])
          }
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {t("pages.settings.save")}
        </button>
      </SettingSection>

      {/* API Tokens */}
      <SettingSection title={t("pages.settings.apiTokens")}>
        <p className="text-xs text-slate-500 mb-4">
          {t("pages.settings.useApiTokensToAccessDashboardDataFrom")}
        </p>
        {tokensLoading ? (
          <div className="flex justify-center py-4">
            <span className="spinner !w-5 !h-5 text-blue-500" />
          </div>
        ) : apiTokens && apiTokens.length > 0 ? (
          <div className="space-y-2 mb-4">
            {apiTokens.map((tk) => {
              const isExpired = tk.expiresAt
                ? new Date(tk.expiresAt + "Z") <= new Date()
                : false;
              return (
                <div
                  key={tk.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border"
                >
                  <div className="min-w-0 flex items-center flex-wrap gap-y-1">
                    {tokenEditingId === tk.id ? (
                      <input
                        autoFocus
                        value={tokenEditingName}
                        onChange={(e) => setTokenEditingName(e.target.value)}
                        onBlur={() => {
                          const trimmed = tokenEditingName.trim();
                          const nameError = trimmed
                            ? validateRequiredText(trimmed, "Token name", 50)
                            : null;
                          if (nameError) {
                            addToast(nameError, "danger");
                          } else if (trimmed && trimmed !== (tk.name ?? "")) {
                            renameApiToken.mutate(
                              { id: tk.id, name: trimmed },
                              {
                                onSuccess: () => addToast(t("pages.settings.tokenRenamed"), "success"),
                                onError: (err) => addToast(err.message || t("pages.settings.failedToRename"), "danger"),
                              }
                            );
                          }
                          setTokenEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setTokenEditingId(null);
                        }}
                        maxLength={50}
                        className="text-sm px-1.5 py-0.5 rounded border border-blue-500 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setTokenEditingId(tk.id);
                          setTokenEditingName(tk.name ?? "");
                        }}
                        className="text-sm truncate hover:underline cursor-pointer text-left"
                        title={t("pages.settings.clickToRename")}
                      >
                        {tk.name || (
                          <span className="italic text-slate-400">{t("pages.settings.unnamedToken")}</span>
                        )}
                      </button>
                    )}
                    <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                      tk.readOnly
                        ? "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                        : "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                    }`}>
                      {tk.readOnly ? t("pages.settings.readOnly") : t("pages.settings.readWrite")}
                    </span>
                    {isExpired ? (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                        {t("pages.settings.expired")}
                      </span>
                    ) : tk.expiresAt ? (
                      <span className="ml-2 text-xs text-slate-500 shrink-0">
                        {t("pages.settings.expires")}{" "}
                        {new Date(tk.expiresAt + "Z").toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="ml-2 text-xs text-slate-500 shrink-0">
                        {t("pages.settings.neverExpires")}
                      </span>
                    )}
                    <span className="ml-2 text-xs text-slate-500 shrink-0">
                      {t("pages.settings.created")}{" "}
                      {new Date(tk.createdAt + "Z").toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setTokenDeleteTarget(tk.id)}
                    className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                    title={t("pages.settings.revokeApiToken")}
                    aria-label={t("pages.settings.revokeApiTokenName", {
                      name: tk.name ?? "",
                    })}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-500 mb-4">
            {t("pages.settings.noApiTokensCreatedYet")}
          </p>
        )}

        {showTokenForm ? (
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("pages.settings.name")}</label>
              <input
                autoFocus
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                maxLength={50}
                placeholder={t("pages.settings.eGHomepageWidget")}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("pages.settings.permission")}</label>
              <select
                value={newTokenReadOnly ? "readonly" : "readwrite"}
                onChange={(e) => setNewTokenReadOnly(e.target.value === "readonly")}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="readonly">{t("pages.settings.readOnly")}</option>
                <option value="readwrite">{t("pages.settings.readWrite2")}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("pages.settings.validFor")}</label>
              <select
                value={newTokenExpiry}
                onChange={(e) => setNewTokenExpiry(e.target.value)}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="30">{t("pages.settings.days")}</option>
                <option value="60">{t("pages.settings.days2")}</option>
                <option value="90">{t("pages.settings.days3")}</option>
                <option value="365">{t("pages.settings.year")}</option>
                <option value="0">{t("pages.settings.neverExpires")}</option>
              </select>
            </div>
            <button
              onClick={() => {
                createApiToken.mutate(
                  {
                    name: newTokenName.trim() || undefined,
                    expiresInDays: parseInt(newTokenExpiry, 10),
                    readOnly: newTokenReadOnly,
                  },
                  {
                    onSuccess: (data) => {
                      setGeneratedToken(data.token);
                      setTokenCopied(false);
                      setShowTokenForm(false);
                      setNewTokenName("");
                      setNewTokenExpiry("30");
                      setNewTokenReadOnly(true);
                    },
                    onError: (err) =>
                      addToast(err.message || t("pages.settings.failedToCreateToken"), "danger"),
                  }
                );
              }}
              disabled={createApiToken.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {createApiToken.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                t("pages.settings.generate")
              )}
            </button>
            <button
              onClick={() => {
                setShowTokenForm(false);
                setNewTokenName("");
                setNewTokenExpiry("30");
                setNewTokenReadOnly(true);
              }}
              className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              {t("pages.settings.cancel")}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowTokenForm(true)}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            {t("pages.settings.generateNewToken")}
          </button>
        )}

        {/* Token created modal */}
        <Modal
          open={generatedToken !== null}
          onClose={() => setGeneratedToken(null)}
          title={t("pages.settings.apiTokenCreated")}
        >
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
            {t("pages.settings.copyThisTokenNowItWillNotBe")}
          </p>
          <div className="flex items-center gap-2 mb-6">
            <input
              readOnly
              value={generatedToken ?? ""}
              className="flex-1 px-3 py-2 text-sm font-mono rounded-lg border border-border bg-slate-50 dark:bg-slate-900 select-all"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={() => {
                if (generatedToken) {
                  navigator.clipboard.writeText(generatedToken);
                  setTokenCopied(true);
                }
              }}
              className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0"
            >
              {tokenCopied ? t("pages.settings.copied") : t("pages.settings.copy")}
            </button>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setGeneratedToken(null)}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              {t("pages.settings.done")}
            </button>
          </div>
        </Modal>

        {/* Delete confirmation */}
        <ConfirmDialog
          open={tokenDeleteTarget !== null}
          onClose={() => setTokenDeleteTarget(null)}
          onConfirm={() => {
            if (tokenDeleteTarget !== null) {
              deleteApiToken.mutate(tokenDeleteTarget, {
                onSuccess: () => {
                  addToast(t("pages.settings.apiTokenRevoked"), "success");
                  setTokenDeleteTarget(null);
                },
                onError: (err) => {
                  addToast(err.message || t("pages.settings.failedToRevokeToken"), "danger");
                  setTokenDeleteTarget(null);
                },
              });
            }
          }}
          title={t("pages.settings.revokeApiToken2")}
          message={t("pages.settings.areYouSureYouWantToRevokeThis")}
          confirmLabel={t("pages.settings.revoke")}
          danger
          loading={deleteApiToken.isPending}
        />
      </SettingSection>

    </Layout>
  );
}
