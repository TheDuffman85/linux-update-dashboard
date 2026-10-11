import { useState } from "react";
import type { CredentialDetail, CredentialKind } from "../../lib/credentials";
import {
  ALL_CREDENTIAL_KINDS,
  buildCredentialPayload,
  CREDENTIAL_KIND_LABEL_KEYS,
  MAX_SECRET_VALUE_LENGTH,
  validateCredentialForm,
} from "../../lib/credential-form";
import { useI18n } from "../../lib/i18n";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

export function CredentialForm({
  initial,
  kinds = ALL_CREDENTIAL_KINDS,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: CredentialDetail;
  /** Kinds offered when creating; defaults to every kind. */
  kinds?: CredentialKind[];
  onSubmit: (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name || "");
  const [kind, setKind] = useState<CredentialKind>(
    initial?.kind || kinds[0] || "usernamePassword"
  );
  const [username, setUsername] = useState(initial?.payload.username || "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyPassword, setPrivateKeyPassword] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formValues = {
    username,
    password,
    privateKey,
    passphrase,
    certificatePem,
    privateKeyPem,
    privateKeyPassword,
    secretValue,
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const validationError = validateCredentialForm(
          name,
          kind,
          formValues,
          initial,
        );
        if (validationError) {
          setError(validationError);
          return;
        }

        setError(null);
        onSubmit({
          name,
          kind,
          payload: buildCredentialPayload(
            kind,
            formValues,
            initial
          ),
        });
      }}
      className="space-y-4"
    >
      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>{t("common.name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            className={inputClass}
            placeholder={t("components.credentialForm.opsSshKey")}
            required
            maxLength={100}
          />
        </div>
        <div>
          <label className={labelClass}>{t("common.type")}</label>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as CredentialKind);
              if (error) setError(null);
            }}
            className={inputClass}
            disabled={!!initial}
          >
            {(initial ? [initial.kind] : kinds).map(
              (value) => (
                <option key={value} value={value}>
                  {t(CREDENTIAL_KIND_LABEL_KEYS[value])}
                </option>
              )
            )}
          </select>
        </div>
      </div>

      {kind !== "secret" && (
        <div>
          <label className={labelClass}>{t("common.username")}</label>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError(null);
            }}
            className={inputClass}
            placeholder="root"
            required
          />
        </div>
      )}

      {kind === "secret" && (
        <div>
          <label className={labelClass}>{t("components.credentialForm.secretValue")}</label>
          <input
            type="password"
            autoComplete="off"
            value={secretValue}
            onChange={(e) => {
              setSecretValue(e.target.value);
              if (error) setError(null);
            }}
            className={inputClass}
            maxLength={MAX_SECRET_VALUE_LENGTH}
            placeholder={
              initial?.payload.value === "(stored)" ? t("common.unchanged") : ""
            }
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t("components.credentialForm.secretValueHint")}
          </p>
        </div>
      )}

      {kind === "usernamePassword" && (
        <div>
          <label className={labelClass}>{t("common.password")}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            className={inputClass}
            placeholder={
              initial?.payload.password === "(stored)" ? t("common.unchanged") : ""
            }
          />
        </div>
      )}

      {kind === "sshKey" && (
        <>
          <div>
            <label className={labelClass}>{t("components.credentialForm.privateKey")}</label>
            <textarea
              value={privateKey}
              onChange={(e) => {
                setPrivateKey(e.target.value);
                if (error) setError(null);
              }}
              className={`${inputClass} h-32 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.privateKey === "(stored)"
                  ? t("common.unchanged")
                  : "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("components.credentialForm.passphrase")}</label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                if (error) setError(null);
              }}
              className={inputClass}
              placeholder={
                initial?.payload.passphrase === "(stored)" ? t("common.unchanged") : ""
              }
            />
          </div>
        </>
      )}

      {kind === "certificate" && (
        <>
          <div>
            <label className={labelClass}>{t("components.credentialForm.openSshCertificate")}</label>
            <textarea
              value={certificatePem}
              onChange={(e) => {
                setCertificatePem(e.target.value);
                if (error) setError(null);
              }}
              className={`${inputClass} h-28 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.certificatePem === "(stored)"
                  ? t("common.unchanged")
                  : "ssh-ed25519-cert-v01@openssh.com AAAA..."
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("components.credentialForm.privateKey")}</label>
            <textarea
              value={privateKeyPem}
              onChange={(e) => {
                setPrivateKeyPem(e.target.value);
                if (error) setError(null);
              }}
              className={`${inputClass} h-28 resize-y font-mono text-xs`}
              placeholder={
                initial?.payload.privateKeyPem === "(stored)"
                  ? t("common.unchanged")
                  : "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("components.credentialForm.privateKeyPassword")}</label>
            <input
              type="password"
              value={privateKeyPassword}
              onChange={(e) => {
                setPrivateKeyPassword(e.target.value);
                if (error) setError(null);
              }}
              className={inputClass}
              placeholder={
                initial?.payload.privateKeyPassword === "(stored)"
                  ? t("common.unchanged")
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
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : t("common.save")}
        </button>
      </div>
    </form>
  );
}
