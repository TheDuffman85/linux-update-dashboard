import { useState, useEffect } from "react";
import { Layout } from "../components/Layout";
import { useSettings, useUpdateSettings } from "../lib/settings";
import { useToast } from "../context/ToastContext";

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
    </Layout>
  );
}
