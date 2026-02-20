import { useState } from "react";
import { Link } from "react-router";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useSystems, useCreateSystem, useDeleteSystem } from "../api/systems";
import { useCheckUpdates } from "../api/updates";
import { useToast } from "../context/ToastContext";
import { SystemForm } from "../components/systems/SystemForm";

export default function SystemsList() {
  const { data: systems, isLoading } = useSystems();
  const createSystem = useCreateSystem();
  const deleteSystem = useDeleteSystem();
  const checkUpdates = useCheckUpdates();
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const handleCreate = (data: Parameters<typeof createSystem.mutate>[0]) => {
    createSystem.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        addToast("System added successfully", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleDelete = () => {
    if (deleteId === null) return;
    deleteSystem.mutate(deleteId, {
      onSuccess: () => {
        setDeleteId(null);
        addToast("System deleted", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleCheck = (id: number) => {
    checkUpdates.mutate(id, {
      onSuccess: (data) => {
        addToast(
          `Check complete: ${data.updateCount} update${data.updateCount !== 1 ? "s" : ""} found`,
          data.updateCount === 0 ? "success" : "info"
        );
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title="Systems"
      actions={
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Add System
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : systems && systems.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 hidden sm:table-cell">Host</th>
                <th className="px-4 py-3 hidden md:table-cell">OS</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Updates</th>
                <th className="px-4 py-3 hidden lg:table-cell">Last Checked</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {systems.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                  <td className="px-4 py-3">
                    <Link to={`/systems/${s.id}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {s.hostname}{s.port !== 22 && `:${s.port}`}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                    {s.osName || "-"}
                  </td>
                  <td className="px-4 py-3">
                    {s.isReachable === 1 ? (
                      <Badge variant="success" small>Online</Badge>
                    ) : s.isReachable === -1 ? (
                      <Badge variant="danger" small>Offline</Badge>
                    ) : (
                      <Badge variant="muted" small>Unknown</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {s.updateCount > 0 ? (
                      <Badge variant="warning" small>{s.updateCount}</Badge>
                    ) : s.isReachable === 1 ? (
                      <span className="text-green-600 text-xs">0</span>
                    ) : (
                      <span className="text-slate-400 text-xs">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-slate-400">
                    {s.cacheAge || "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleCheck(s.id)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Check for updates"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(s.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title="Delete system"
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
          <p className="text-slate-500 dark:text-slate-400 mb-4">No systems configured yet</p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add Your First System
          </button>
        </div>
      )}

      {/* Add system modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title="Add System">
        <SystemForm
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
          loading={createSystem.isPending}
        />
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete System"
        message="Are you sure you want to delete this system? This action cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleteSystem.isPending}
      />
    </Layout>
  );
}
