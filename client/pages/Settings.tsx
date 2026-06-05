import { useState, useEffect } from "react";
import { Layout } from "../components/Layout";
import { useSettings, useUpdateSettings } from "../lib/settings";
import { validatePassword, validateRequiredText } from "../lib/form-validation";
import { normalizeSettingsUpdate } from "../lib/settings-validation";
import { usePasskeys, useDeletePasskey, useRegisterPasskey, useRenamePasskey } from "../lib/passkeys";
import { useApiTokens, useCreateApiToken, useRenameApiToken, useDeleteApiToken } from "../lib/api-tokens";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/client";

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
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const { addToast } = useToast();
  const { hasPassword, refresh: refreshAuth } = useAuth();

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

  useEffect(() => {
    if (settings) {
      const cleanedForm = { ...settings };
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
  }, [settings]);

  const handleSave = (keys: string[]) => {
    const data: Record<string, string> = {};
    for (const k of keys) {
      if (storedSecrets[k] && !form[k]) {
        data[k] = "(stored)";
      } else {
        data[k] = form[k] ?? "";
      }
    }
    const normalizedData = normalizeSettingsUpdate(data);
    setForm((prev) => ({ ...prev, ...normalizedData }));

    updateSettings.mutate(normalizedData, {
      onSuccess: (res) => {
        if (res.oidcError) {
          addToast(`Settings saved, but OIDC configuration failed: ${res.oidcError}`, "danger");
        } else {
          addToast("Settings saved", "success");
        }
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPassword !== confirmPassword) {
      setPwError("Passwords do not match");
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
      addToast("Password changed successfully", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setPwError((err as Error).message || "Failed to change password");
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
      <Layout title="Settings">
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Settings">
      <SettingSection title="Activity History">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
          <div>
            <label className={labelClass}>Number of Activities</label>
            <input
              type="number"
              min={5}
              max={200}
              value={form.activity_history_limit || "20"}
              onChange={(e) =>
                setForm({ ...form, activity_history_limit: e.target.value })
              }
              className={inputClass}
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Keeps only this many recent activity entries per system. Older history is
          automatically deleted, and the same limit is used in the Activity History
          on the system detail page.
        </p>
        <button
          onClick={() => handleSave(["activity_history_limit"])}
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          Save
        </button>
      </SettingSection>

      {/* SSH */}
      <SettingSection title="SSH">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Connection Timeout (s)</label>
            <input
              type="number"
              min={5}
              max={120}
              value={form.ssh_timeout_seconds || "30"}
              onChange={(e) =>
                setForm({ ...form, ssh_timeout_seconds: e.target.value })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Command Timeout (s)</label>
            <input
              type="number"
              min={10}
              max={600}
              value={form.cmd_timeout_seconds || "120"}
              onChange={(e) =>
                setForm({ ...form, cmd_timeout_seconds: e.target.value })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Concurrent Connections</label>
            <input
              type="number"
              min={1}
              max={50}
              value={form.concurrent_connections || "5"}
              onChange={(e) =>
                setForm({ ...form, concurrent_connections: e.target.value })
              }
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
              <span className="block text-sm">Least-privilege root user check</span>
              <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                Show a notice when a system connects as root instead of a dedicated non-root SSH user.
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
          Save
        </button>
      </SettingSection>

      {/* Password */}
      <SettingSection title="Password">
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
                <span className="text-sm">Disable password login</span>
              </label>
              {!canDisable ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  Register a passkey or configure SSO before disabling password login.
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  When enabled, only Passkey and SSO login methods are available.
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
          Save
        </button>

        {hasPassword && (
          <>
            <hr className="my-6 border-border" />
            <h3 className="text-sm font-semibold mb-4">Change Password</h3>
            <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
              {pwError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
                  {pwError}
                </div>
              )}
              <div>
                <label className={labelClass}>Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-slate-400">
                  Minimum 8 characters, must include uppercase, lowercase, and a digit
                </p>
              </div>
              <div>
                <label className={labelClass}>Confirm New Password</label>
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
                {pwLoading ? <span className="spinner spinner-sm" /> : "Change Password"}
              </button>
            </form>
          </>
        )}
      </SettingSection>

      {/* Passkeys — only in secure contexts where WebAuthn is available */}
      {window.isSecureContext && (
        <SettingSection title="Passkeys">
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
                                onSuccess: () => addToast("Passkey renamed", "success"),
                                onError: (err) => addToast(err.message || "Failed to rename", "danger"),
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
                        title="Click to rename"
                      >
                        {pk.name || (
                          <span className="font-mono text-slate-400">
                            {pk.credentialId.slice(0, 16)}…
                          </span>
                        )}
                      </button>
                    )}
                    <span className="ml-3 text-xs text-slate-500 shrink-0">
                      Added{" "}
                      {new Date(pk.createdAt + "Z").toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setDeleteTarget(pk.id)}
                    className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                    title="Remove passkey"
                    aria-label={`Remove passkey ${pk.name || pk.credentialId.slice(0, 16)}`}
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
              No passkeys registered. Add one to enable passwordless login.
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
                        addToast("Passkey registered successfully", "success");
                        setShowNamePrompt(false);
                        setNewPasskeyName("");
                      },
                      onError: (err) =>
                        addToast(err.message || "Failed to register passkey", "danger"),
                    });
                  }
                  if (e.key === "Escape") {
                    setShowNamePrompt(false);
                    setNewPasskeyName("");
                  }
                }}
                maxLength={50}
                placeholder="Passkey name (e.g. YubiKey, MacBook)"
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
              <button
                onClick={() => {
                  registerPasskey.mutate(newPasskeyName.trim() || undefined, {
                    onSuccess: () => {
                      addToast("Passkey registered successfully", "success");
                      setShowNamePrompt(false);
                      setNewPasskeyName("");
                    },
                    onError: (err) =>
                      addToast(err.message || "Failed to register passkey", "danger"),
                  });
                }}
                disabled={registerPasskey.isPending}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {registerPasskey.isPending ? (
                  <span className="spinner spinner-sm" />
                ) : (
                  "Register"
                )}
              </button>
              <button
                onClick={() => {
                  setShowNamePrompt(false);
                  setNewPasskeyName("");
                }}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNamePrompt(true)}
              disabled={registerPasskey.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              Register New Passkey
            </button>
          )}

          <ConfirmDialog
            open={deleteTarget !== null}
            onClose={() => setDeleteTarget(null)}
            onConfirm={() => {
              if (deleteTarget !== null) {
                deletePasskey.mutate(deleteTarget, {
                  onSuccess: () => {
                    addToast("Passkey removed", "success");
                    setDeleteTarget(null);
                  },
                  onError: (err) => {
                    addToast(
                      err.message || "Failed to remove passkey",
                      "danger"
                    );
                    setDeleteTarget(null);
                  },
                });
              }
            }}
            title="Remove Passkey"
            message="Are you sure you want to remove this passkey? You will no longer be able to use it to sign in."
            confirmLabel="Remove"
            danger
            loading={deletePasskey.isPending}
          />
        </SettingSection>
      )}

      {/* OIDC */}
      <SettingSection title="OIDC (SSO)">
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Issuer URL</label>
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
            <label className={labelClass}>Client ID</label>
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
            <label className={labelClass}>Client Secret</label>
            <input
              type="password"
              value={form.oidc_client_secret || ""}
              onChange={(e) =>
                setForm({ ...form, oidc_client_secret: e.target.value })
              }
              className={inputClass}
              placeholder={storedSecrets.oidc_client_secret && !form.oidc_client_secret ? "(unchanged)" : ""}
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
          Save
        </button>
      </SettingSection>

      {/* API Tokens */}
      <SettingSection title="API Tokens">
        <p className="text-xs text-slate-500 mb-4">
          Use API tokens to access dashboard data from external tools (e.g. homepage widgets).
          Tokens cannot access management endpoints (settings, auth, passkeys).
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
                                onSuccess: () => addToast("Token renamed", "success"),
                                onError: (err) => addToast(err.message || "Failed to rename", "danger"),
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
                        title="Click to rename"
                      >
                        {tk.name || (
                          <span className="italic text-slate-400">Unnamed token</span>
                        )}
                      </button>
                    )}
                    <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                      tk.readOnly
                        ? "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                        : "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                    }`}>
                      {tk.readOnly ? "Read-only" : "Read/Write"}
                    </span>
                    {isExpired ? (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                        Expired
                      </span>
                    ) : tk.expiresAt ? (
                      <span className="ml-2 text-xs text-slate-500 shrink-0">
                        Expires{" "}
                        {new Date(tk.expiresAt + "Z").toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="ml-2 text-xs text-slate-500 shrink-0">
                        Never expires
                      </span>
                    )}
                    <span className="ml-2 text-xs text-slate-500 shrink-0">
                      Created{" "}
                      {new Date(tk.createdAt + "Z").toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setTokenDeleteTarget(tk.id)}
                    className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                    title="Revoke API token"
                    aria-label={`Revoke API token ${tk.name}`}
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
            No API tokens created yet.
          </p>
        )}

        {showTokenForm ? (
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
              <input
                autoFocus
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                maxLength={50}
                placeholder="e.g. Homepage widget"
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Permission</label>
              <select
                value={newTokenReadOnly ? "readonly" : "readwrite"}
                onChange={(e) => setNewTokenReadOnly(e.target.value === "readonly")}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="readonly">Read-only</option>
                <option value="readwrite">Read &amp; Write</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Valid for</label>
              <select
                value={newTokenExpiry}
                onChange={(e) => setNewTokenExpiry(e.target.value)}
                className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="0">Never expires</option>
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
                      addToast(err.message || "Failed to create token", "danger"),
                  }
                );
              }}
              disabled={createApiToken.isPending}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {createApiToken.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                "Generate"
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
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowTokenForm(true)}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            Generate New Token
          </button>
        )}

        {/* Token created modal */}
        <Modal
          open={generatedToken !== null}
          onClose={() => setGeneratedToken(null)}
          title="API Token Created"
        >
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
            Copy this token now. It will not be shown again.
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
              {tokenCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setGeneratedToken(null)}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              Done
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
                  addToast("API token revoked", "success");
                  setTokenDeleteTarget(null);
                },
                onError: (err) => {
                  addToast(err.message || "Failed to revoke token", "danger");
                  setTokenDeleteTarget(null);
                },
              });
            }
          }}
          title="Revoke API Token"
          message="Are you sure you want to revoke this API token? Any integrations using it will stop working."
          confirmLabel="Revoke"
          danger
          loading={deleteApiToken.isPending}
        />
      </SettingSection>

    </Layout>
  );
}
