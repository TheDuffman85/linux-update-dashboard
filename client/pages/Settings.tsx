import { useState, useEffect } from "react";
import { Layout } from "../components/Layout";
import { useSettings, useUpdateSettings } from "../lib/settings";
import { usePasskeys, useDeletePasskey, useRegisterPasskey, useRenamePasskey } from "../lib/passkeys";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
    updateSettings.mutate(data, {
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
    if (newPassword.length < 8) {
      setPwError("Password must be at least 8 characters");
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
      {/* Cache */}
      <SettingSection title="Update Schedule">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
          <div>
            <label className={labelClass}>Check Interval (minutes)</label>
            <input
              type="number"
              min={5}
              max={1440}
              value={form.check_interval_minutes || "15"}
              onChange={(e) =>
                setForm({ ...form, check_interval_minutes: e.target.value })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Cache Duration (hours)</label>
            <input
              type="number"
              min={1}
              max={168}
              value={form.cache_duration_hours || "12"}
              onChange={(e) =>
                setForm({ ...form, cache_duration_hours: e.target.value })
              }
              className={inputClass}
            />
          </div>
        </div>
        <button
          onClick={() => handleSave(["check_interval_minutes", "cache_duration_hours"])}
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
        <button
          onClick={() =>
            handleSave([
              "ssh_timeout_seconds",
              "cmd_timeout_seconds",
              "concurrent_connections",
            ])
          }
          disabled={updateSettings.isPending}
          className="mt-4 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          Save
        </button>
      </SettingSection>

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

      {/* Password */}
      <SettingSection title="Password">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.disable_password_login === "true"}
            onChange={(e) =>
              setForm({ ...form, disable_password_login: e.target.checked ? "true" : "false" })
            }
            className="rounded border-border"
          />
          <span className="text-sm">Disable password login</span>
        </label>
        <p className="mt-1 text-xs text-slate-400">
          When enabled, only Passkey and SSO login methods are available.
        </p>
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
                          if (trimmed && trimmed !== (pk.name ?? "")) {
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
                    className="ml-4 shrink-0 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Remove
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

    </Layout>
  );
}
