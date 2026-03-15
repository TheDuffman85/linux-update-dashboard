import { useState } from "react";
import type { CredentialDetail, CredentialKind } from "../../lib/credentials";
import {
  buildCredentialPayload,
  CREDENTIAL_KIND_LABELS,
} from "../../lib/credential-form";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

export function CredentialForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: CredentialDetail;
  onSubmit: (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [kind, setKind] = useState<CredentialKind>(
    initial?.kind || "usernamePassword"
  );
  const [username, setUsername] = useState(initial?.payload.username || "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyPassword, setPrivateKeyPassword] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name,
          kind,
          payload: buildCredentialPayload(
            kind,
            {
              username,
              password,
              privateKey,
              passphrase,
              certificatePem,
              privateKeyPem,
              privateKeyPassword,
            },
            initial
          ),
        });
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Ops SSH Key"
            required
          />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CredentialKind)}
            className={inputClass}
            disabled={!!initial}
          >
            {(Object.keys(CREDENTIAL_KIND_LABELS) as CredentialKind[]).map(
              (value) => (
                <option key={value} value={value}>
                  {CREDENTIAL_KIND_LABELS[value]}
                </option>
              )
            )}
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={inputClass}
          placeholder="root"
          required
        />
      </div>

      {kind === "usernamePassword" && (
        <div>
          <label className={labelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            placeholder={
              initial?.payload.password === "(stored)" ? "(unchanged)" : ""
            }
          />
        </div>
      )}

      {kind === "sshKey" && (
        <>
          <div>
            <label className={labelClass}>Private Key</label>
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              className={`${inputClass} h-32 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.privateKey === "(stored)"
                  ? "(unchanged)"
                  : "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className={labelClass}>Passphrase</label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className={inputClass}
              placeholder={
                initial?.payload.passphrase === "(stored)" ? "(unchanged)" : ""
              }
            />
          </div>
        </>
      )}

      {kind === "certificate" && (
        <>
          <div>
            <label className={labelClass}>OpenSSH Certificate</label>
            <textarea
              value={certificatePem}
              onChange={(e) => setCertificatePem(e.target.value)}
              className={`${inputClass} h-28 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.certificatePem === "(stored)"
                  ? "(unchanged)"
                  : "ssh-ed25519-cert-v01@openssh.com AAAA..."
              }
            />
          </div>
          <div>
            <label className={labelClass}>Private Key</label>
            <textarea
              value={privateKeyPem}
              onChange={(e) => setPrivateKeyPem(e.target.value)}
              className={`${inputClass} h-28 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.privateKeyPem === "(stored)"
                  ? "(unchanged)"
                  : "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className={labelClass}>Private Key Password</label>
            <input
              type="password"
              value={privateKeyPassword}
              onChange={(e) => setPrivateKeyPassword(e.target.value)}
              className={inputClass}
              placeholder={
                initial?.payload.privateKeyPassword === "(stored)"
                  ? "(unchanged)"
                  : ""
              }
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : "Save"}
        </button>
      </div>
    </form>
  );
}
