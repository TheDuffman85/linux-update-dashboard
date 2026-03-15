import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { CredentialForm } from "../components/credentials/CredentialForm";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import { CREDENTIAL_KIND_LABELS } from "../lib/credential-form";
import {
  useCredential,
  useCredentials,
  useCreateCredential,
  useUpdateCredential,
  useDeleteCredential,
  useReorderCredentials,
  type CredentialKind,
  type CredentialSummary,
} from "../lib/credentials";

function moveCredential<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

export default function Credentials() {
  const { data: credentials, isLoading } = useCredentials();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();
  const deleteCredential = useDeleteCredential();
  const reorderCredentials = useReorderCredentials();
  const { addToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteCredentialItem, setDeleteCredentialItem] = useState<CredentialSummary | null>(null);
  const [orderedCredentials, setOrderedCredentials] = useState<CredentialSummary[]>([]);
  const orderedCredentialsRef = useRef<CredentialSummary[]>([]);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const { data: editCredential } = useCredential(editId);

  useEffect(() => {
    setOrderedCredentials(credentials ?? []);
  }, [credentials]);

  useEffect(() => {
    orderedCredentialsRef.current = orderedCredentials;
  }, [orderedCredentials]);

  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || orderedCredentials.length <= 1) {
      sortableRef.current?.destroy();
      sortableRef.current = null;
      return;
    }

    sortableRef.current?.destroy();
    sortableRef.current = new Sortable(tbody, {
      animation: 150,
      handle: ".drag-handle",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (
          evt.oldIndex === undefined ||
          evt.newIndex === undefined ||
          evt.oldIndex === evt.newIndex
        ) {
          return;
        }

        const previousCredentials = orderedCredentialsRef.current;
        const nextCredentials = moveCredential(previousCredentials, evt.oldIndex, evt.newIndex);

        setOrderedCredentials(nextCredentials);
        reorderCredentials.mutate(nextCredentials.map((credential) => credential.id), {
          onError: (err) => {
            setOrderedCredentials(previousCredentials);
            addToast(err.message, "danger");
          },
        });
      },
    });

    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [orderedCredentials.length, reorderCredentials, addToast]);

  useEffect(() => {
    sortableRef.current?.option("disabled", reorderCredentials.isPending);
  }, [reorderCredentials.isPending]);

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
            <tbody ref={tbodyRef}>
              {orderedCredentials.map((credential) => (
                <tr
                  key={credential.id}
                  className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          reorderCredentials.isPending || orderedCredentials.length < 2
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                        }`}
                        title="Drag to reorder"
                        aria-label={`Drag to reorder ${credential.name}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <span className="min-w-0 truncate font-medium">{credential.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {CREDENTIAL_KIND_LABELS[credential.kind]}
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
