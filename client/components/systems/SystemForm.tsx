import { useState } from "react";
import { useTestConnection } from "../../lib/systems";

interface SystemFormData {
  name: string;
  hostname: string;
  port: number;
  authType: string;
  username: string;
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
  sudoPassword?: string;
  disabledPkgManagers?: string[];
  sourceSystemId?: number;
}

export function SystemForm({
  initial,
  systemId,
  sourceSystemId,
  onSubmit,
  onCancel,
  loading = false,
}: {
  initial?: Partial<SystemFormData> & {
    detectedPkgManagers?: string[] | null;
    disabledPkgManagers?: string[] | null;
  };
  systemId?: number;
  sourceSystemId?: number;
  onSubmit: (data: SystemFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const testConnection = useTestConnection();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [name, setName] = useState(initial?.name || "");
  const [hostname, setHostname] = useState(initial?.hostname || "");
  const [port, setPort] = useState(initial?.port || 22);
  const [authType, setAuthType] = useState(initial?.authType || "password");
  const [username, setUsername] = useState(initial?.username || "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [detectedManagers, setDetectedManagers] = useState<string[]>(
    initial?.detectedPkgManagers ?? []
  );
  const [disabledManagers, setDisabledManagers] = useState<Set<string>>(
    new Set(initial?.disabledPkgManagers ?? [])
  );

  const toggleManager = (manager: string) => {
    setDisabledManagers((prev) => {
      const next = new Set(prev);
      if (next.has(manager)) {
        next.delete(manager);
      } else {
        next.add(manager);
      }
      return next;
    });
  };

  const credentialPlaceholder = sourceSystemId
    ? "(from source system)"
    : initial
      ? "(unchanged)"
      : "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      hostname,
      port,
      authType,
      username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      keyPassphrase: keyPassphrase || undefined,
      sudoPassword: sudoPassword || undefined,
      disabledPkgManagers: disabledManagers.size > 0 ? [...disabledManagers] : undefined,
      sourceSystemId,
    });
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
  const labelClass =
    "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass}>Display Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} placeholder="My Server" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={labelClass}>Hostname / IP</label>
          <input type="text" value={hostname} onChange={(e) => setHostname(e.target.value)} required className={inputClass} placeholder="192.168.1.100" />
        </div>
        <div>
          <label className={labelClass}>SSH Port</label>
          <input type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value, 10))} required className={inputClass} />
        </div>
      </div>

      <div>
        <label className={labelClass}>SSH Username</label>
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required className={inputClass} placeholder="root" />
      </div>

      <div>
        <label className={labelClass}>Authentication Method</label>
        <div className="flex gap-4 mt-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="authType" value="password" checked={authType === "password"} onChange={() => setAuthType("password")} />
            Password
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="authType" value="key" checked={authType === "key"} onChange={() => setAuthType("key")} />
            SSH Key
          </label>
        </div>
      </div>

      {authType === "password" && (
        <div>
          <label className={labelClass}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder={credentialPlaceholder} />
        </div>
      )}

      {authType === "key" && (
        <>
          <div>
            <label className={labelClass}>Private Key</label>
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              className={`${inputClass} font-mono text-xs h-32 resize-y`}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </div>
          <div>
            <label className={labelClass}>Key Passphrase (optional)</label>
            <input type="password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} className={inputClass} />
          </div>
        </>
      )}

      <div>
        <label className={labelClass}>Sudo Password (optional)</label>
        <input type="password" value={sudoPassword} onChange={(e) => setSudoPassword(e.target.value)} className={inputClass} placeholder={sourceSystemId ? "(from source system)" : initial ? "(unchanged — defaults to SSH password)" : "Defaults to SSH password"} />
        <p className="text-xs text-slate-400 mt-1">Only needed if the sudo password differs from the SSH password</p>
      </div>

      {testResult && (
        <div className={`p-3 rounded-lg text-sm ${testResult.success ? "bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400" : "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400"}`}>
          {testResult.message}
        </div>
      )}

      {detectedManagers.length > 0 && (
        <div>
          <label className={labelClass}>Detected Package Managers</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {detectedManagers.map((m) => (
              <label
                key={m}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${
                  !disabledManagers.has(m)
                    ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300"
                    : "border-border bg-slate-50 dark:bg-slate-800 text-slate-400"
                }`}
              >
                <input
                  type="checkbox"
                  checked={!disabledManagers.has(m)}
                  onChange={() => toggleManager(m)}
                  className="rounded"
                />
                {m}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button
          type="button"
          disabled={testConnection.isPending || !hostname || !username}
          onClick={() => {
            setTestResult(null);
            testConnection.mutate(
              {
                hostname,
                port,
                username,
                authType,
                password: password || undefined,
                privateKey: privateKey || undefined,
                keyPassphrase: keyPassphrase || undefined,
                systemId: systemId ?? sourceSystemId,
              },
              {
                onSuccess: (data) => {
                  setTestResult(data);
                  if (data.detectedManagers?.length) {
                    setDetectedManagers(data.detectedManagers);
                    // Keep existing disabled state, but remove managers no longer detected
                    setDisabledManagers((prev) => {
                      const next = new Set<string>();
                      for (const m of prev) {
                        if (data.detectedManagers!.includes(m)) next.add(m);
                      }
                      return next;
                    });
                  }
                },
                onError: (err) => setTestResult({ success: false, message: err.message }),
              }
            );
          }}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {testConnection.isPending ? <span className="spinner spinner-sm" /> : "Test Connection"}
        </button>
        <button type="submit" disabled={loading} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50">
          {loading ? <span className="spinner spinner-sm" /> : initial ? "Save Changes" : "Add System"}
        </button>
      </div>
    </form>
  );
}
