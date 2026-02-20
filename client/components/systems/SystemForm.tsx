import { useState } from "react";

interface SystemFormData {
  name: string;
  hostname: string;
  port: number;
  authType: string;
  username: string;
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
}

export function SystemForm({
  initial,
  onSubmit,
  onCancel,
  loading = false,
}: {
  initial?: Partial<SystemFormData>;
  onSubmit: (data: SystemFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [hostname, setHostname] = useState(initial?.hostname || "");
  const [port, setPort] = useState(initial?.port || 22);
  const [authType, setAuthType] = useState(initial?.authType || "password");
  const [username, setUsername] = useState(initial?.username || "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");

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
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder={initial ? "(unchanged)" : ""} />
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

      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50">
          {loading ? <span className="spinner spinner-sm" /> : initial ? "Save Changes" : "Add System"}
        </button>
      </div>
    </form>
  );
}
