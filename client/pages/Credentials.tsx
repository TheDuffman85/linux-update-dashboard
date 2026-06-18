import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { CredentialForm } from "../components/credentials/CredentialForm";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import { CREDENTIAL_KIND_LABEL_KEYS } from "../lib/credential-form";
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
import { useI18n } from "../lib/i18n";

function moveCredential<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function getReferenceLabel(credential: CredentialSummary): string {
  if (credential.referenceCount === 0) return "Unused";
  return credential.references.map((ref) => ref.name).join(", ");
}

export default function Credentials() {
  const { data: credentials, isLoading } = useCredentials();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();
  const deleteCredential = useDeleteCredential();
  const reorderCredentials = useReorderCredentials();
  const { addToast } = useToast();
  const { t } = useI18n();
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
        addToast(t("pages.credentials.credentialCreated"), "success");
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
          addToast(t("pages.credentials.credentialUpdated"), "success");
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
        addToast(t("pages.credentials.credentialDeleted"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title={t("pages.credentials.credentials")}
      actions={
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          {t("pages.credentials.addCredential")}
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : credentials && credentials.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-x-auto overflow-y-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">{t("pages.credentials.name")}</th>
                <th className="px-4 py-3 hidden sm:table-cell">{t("pages.credentials.type")}</th>
                <th className="px-4 py-3">{t("pages.credentials.references")}</th>
                <th className="px-4 py-3 text-right">{t("pages.credentials.actions")}</th>
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
                        title={t("pages.credentials.dragToReorder")}
                        aria-label={t("pages.credentials.dragToReorderName", { name: credential.name })}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <span className="min-w-0 truncate font-medium">{credential.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {t(CREDENTIAL_KIND_LABEL_KEYS[credential.kind])}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    <span
                      className={`block max-w-md truncate ${
                        credential.referenceCount === 0 ? "text-xs text-slate-400" : ""
                      }`}
                      title={
                        credential.referenceCount === 0
                          ? t("pages.credentials.unused")
                          : getReferenceLabel(credential)
                      }
                    >
                      {credential.referenceCount === 0
                        ? t("pages.credentials.unused")
                        : getReferenceLabel(credential)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setEditId(credential.id)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.credentials.editCredential")}
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
                            ? t("pages.credentials.credentialIsInUseAndCannotBeDeleted")
                            : t("pages.credentials.deleteCredential")
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
          <p className="text-slate-500 dark:text-slate-400 mb-4">{t("pages.credentials.noReusableCredentialsYet")}</p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t("pages.credentials.addYourFirstCredential")}
          </button>
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t("pages.credentials.addCredential")}
        dismissible={!createCredential.isPending}
      >
        <CredentialForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          loading={createCredential.isPending}
        />
      </Modal>

      <Modal
        open={editId !== null}
        onClose={() => setEditId(null)}
        title={t("pages.credentials.editCredential2")}
        dismissible={!updateCredential.isPending}
      >
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
        title={t("pages.credentials.deleteCredential2")}
        message={t("pages.credentials.areYouSureYouWantToDeleteThis")}
        confirmLabel={t("pages.credentials.delete")}
        danger
        loading={deleteCredential.isPending}
      />
    </Layout>
  );
}
