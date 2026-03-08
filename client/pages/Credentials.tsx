import { useState } from "react";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import {
  useCredential,
  useCredentials,
  useCreateCredential,
  useUpdateCredential,
  useDeleteCredential,
  type CredentialDetail,
  type CredentialKind,
  type CredentialSummary,
} from "../lib/credentials";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

const KIND_LABELS: Record<CredentialKind, string> = {
  usernamePassword: "User / Password",
  sshKey: "SSH Key",
  certificate: "Certificate",
};

function CredentialForm({
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
  const [kind, setKind] = useState<CredentialKind>(initial?.kind || "usernamePassword");
  const [username, setUsername] = useState(initial?.payload.username || "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyPassword, setPrivateKeyPassword] = useState("");

  const buildPayload = (): Record<string, string> => {
    if (kind === "usernamePassword") {
      return {
        username,
        password: password || (initial?.payload.password === "(stored)" ? "(stored)" : ""),
      };
    }
    if (kind === "sshKey") {
      return {
        username,
        privateKey: privateKey || (initial?.payload.privateKey === "(stored)" ? "(stored)" : ""),
        passphrase: passphrase || (initial?.payload.passphrase === "(stored)" ? "(stored)" : ""),
      };
    }
    return {
      username,
      certificatePem:
        certificatePem || (initial?.payload.certificatePem === "(stored)" ? "(stored)" : ""),
      privateKeyPem:
        privateKeyPem || (initial?.payload.privateKeyPem === "(stored)" ? "(stored)" : ""),
      privateKeyPassword:
        privateKeyPassword ||
        (initial?.payload.privateKeyPassword === "(stored)" ? "(stored)" : ""),
    };
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name,
          kind,
          payload: buildPayload(),
        });
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            {(Object.keys(KIND_LABELS) as CredentialKind[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(kind === "usernamePassword" || kind === "sshKey" || kind === "certificate") && (
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
      )}

      {kind === "usernamePassword" && (
        <div>
          <label className={labelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            placeholder={initial?.payload.password === "(stored)" ? "(unchanged)" : ""}
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
              className={`${inputClass} font-mono text-xs h-32 resize-y`}
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
              placeholder={initial?.payload.passphrase === "(stored)" ? "(unchanged)" : ""}
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
              className={`${inputClass} font-mono text-xs h-28 resize-y`}
              placeholder={initial?.payload.certificatePem === "(stored)" ? "(unchanged)" : "ssh-ed25519-cert-v01@openssh.com AAAA..."}
            />
          </div>
          <div>
            <label className={labelClass}>Private Key</label>
            <textarea
              value={privateKeyPem}
              onChange={(e) => setPrivateKeyPem(e.target.value)}
              className={`${inputClass} font-mono text-xs h-28 resize-y`}
              placeholder={initial?.payload.privateKeyPem === "(stored)" ? "(unchanged)" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            />
          </div>
          <div>
            <label className={labelClass}>Private Key Password</label>
            <input
              type="password"
              value={privateKeyPassword}
              onChange={(e) => setPrivateKeyPassword(e.target.value)}
              className={inputClass}
              placeholder={initial?.payload.privateKeyPassword === "(stored)" ? "(unchanged)" : ""}
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function Credentials() {
  const { data: credentials, isLoading } = useCredentials();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();
  const deleteCredential = useDeleteCredential();
  const { addToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteCredentialItem, setDeleteCredentialItem] = useState<CredentialSummary | null>(null);
  const { data: editCredential } = useCredential(editId);

  const handleCreate = (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => {
    createCredential.mutate(data, {
      onSuccess: () => {
        setShowCreate(false);
        addToast("Credential created", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpdate = (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => {
    if (editId === null) return;
    updateCredential.mutate(
      {
        id: editId,
        name: data.name,
        payload: data.payload,
      },
      {
        onSuccess: () => {
          setEditId(null);
          addToast("Credential updated", "success");
        },
        onError: (err) => addToast(err.message, "danger"),
      }
    );
  };

  const handleDelete = () => {
    if (!deleteCredentialItem) return;
    deleteCredential.mutate(deleteCredentialItem.id, {
      onSuccess: () => {
        setDeleteCredentialItem(null);
        addToast("Credential deleted", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title="Credentials"
      actions={
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Add Credential
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : credentials && credentials.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 hidden sm:table-cell">Type</th>
                <th className="px-4 py-3">References</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr
                  key={credential.id}
                  className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">{credential.name}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {KIND_LABELS[credential.kind]}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {credential.referenceCount > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {credential.references.map((ref) => (
                          <span
                            key={`${ref.type}-${ref.id}`}
                            className="inline-flex items-center rounded-full border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-200"
                          >
                            {ref.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {credential.referenceCount === 0 && (
                      <span className="text-xs text-slate-400">Unused</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setEditId(credential.id)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit credential"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteCredentialItem(credential)}
                        disabled={credential.referenceCount > 0}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          credential.referenceCount > 0
                            ? "Credential is in use and cannot be deleted"
                            : "Delete credential"
                        }
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-16">
          <p className="text-slate-500 dark:text-slate-400 mb-4">No reusable credentials yet</p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add Your First Credential
          </button>
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Add Credential" dismissible={false}>
        <CredentialForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          loading={createCredential.isPending}
        />
      </Modal>

      <Modal open={editId !== null} onClose={() => setEditId(null)} title="Edit Credential" dismissible={false}>
        {editId !== null && editCredential && (
          <CredentialForm
            initial={editCredential}
            onSubmit={handleUpdate}
            onCancel={() => setEditId(null)}
            loading={updateCredential.isPending}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={deleteCredentialItem !== null}
        onClose={() => setDeleteCredentialItem(null)}
        onConfirm={handleDelete}
        title="Delete Credential"
        message="Are you sure you want to delete this credential? This action cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleteCredential.isPending}
      />
    </Layout>
  );
}
