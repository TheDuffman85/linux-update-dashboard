import { useEffect, useMemo, useState } from "react";

import { Layout } from "../components/Layout";
import { useToast } from "../context/ToastContext";
import { apiFetch } from "../lib/client";
import { useSystems } from "../lib/systems";

interface VsphereConnection {
  id: number;
  name: string;
  url: string;
  username: string;
  tlsMode: "strict" | "allow_self_signed";
  createdAt?: string;
  updatedAt?: string;
}

interface VmSearchResult {
  path: string;
  moref: string;
  name: string;
}

type SystemWithVsphere = {
  id: number;
  name: string;
  hostname?: string | null;
  vsphereConnectionId?: number | null;
  vsphereVmMoref?: string | null;
  vsphereVmName?: string | null;
  snapshotBeforeUpgrade?: number | boolean | null;
  snapshotQuiesce?: number | boolean | null;
  snapshotMemory?: number | boolean | null;
  snapshotRetentionHours?: number | null;
};

type DraftRow = {
  vsphereConnectionId: number | "";
  vsphereVmMoref: string;
  vsphereVmName: string;
  snapshotBeforeUpgrade: boolean;
  snapshotQuiesce: boolean;
  snapshotMemory: boolean;
  snapshotRetentionHours: number;
};

type MappingFilter = "all" | "mapped" | "unmapped";
type SnapshotFilter = "all" | "enabled" | "disabled";

function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1";
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{hint}</span> : null}
    </label>
  );
}

function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
}) {
  const classes =
    variant === "primary"
      ? "bg-blue-600 hover:bg-blue-700 text-white"
      : variant === "danger"
        ? "bg-red-600 hover:bg-red-700 text-white"
        : variant === "ghost"
          ? "hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100"
          : "border border-border hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${classes}`}
    >
      {children}
    </button>
  );
}

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const classes = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    green: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    red: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  }[tone];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

function emptyDraft(): DraftRow {
  return {
    vsphereConnectionId: "",
    vsphereVmMoref: "",
    vsphereVmName: "",
    snapshotBeforeUpgrade: false,
    snapshotQuiesce: true,
    snapshotMemory: false,
    snapshotRetentionHours: 72,
  };
}

function toDraft(system: SystemWithVsphere): DraftRow {
  return {
    vsphereConnectionId: system.vsphereConnectionId ?? "",
    vsphereVmMoref: system.vsphereVmMoref ?? "",
    vsphereVmName: system.vsphereVmName ?? "",
    snapshotBeforeUpgrade: asBool(system.snapshotBeforeUpgrade),
    snapshotQuiesce: asBool(system.snapshotQuiesce, true),
    snapshotMemory: asBool(system.snapshotMemory),
    snapshotRetentionHours: system.snapshotRetentionHours ?? 72,
  };
}

export default function VSphere() {
  const { addToast } = useToast();
  const { data: systems = [], isLoading: systemsLoading, refetch: refetchSystems } = useSystems();

  const [connections, setConnections] = useState<VsphereConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "production-vcenter",
    url: "https://vcenter.example.local",
    username: "svc-ludash-snapshots@vsphere.local",
    password: "",
    tlsMode: "allow_self_signed" as "strict" | "allow_self_signed",
  });

  const [drafts, setDrafts] = useState<Record<number, DraftRow>>({});
  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(null);
  const [vmSearch, setVmSearch] = useState("");
  const [vmResults, setVmResults] = useState<VmSearchResult[]>([]);

  const [search, setSearch] = useState("");
  const [mappingFilter, setMappingFilter] = useState<MappingFilter>("all");
  const [snapshotFilter, setSnapshotFilter] = useState<SnapshotFilter>("all");
  const [connectionFilter, setConnectionFilter] = useState<number | "all">("all");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const inputClass = "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-900";

  const systemRows = systems as SystemWithVsphere[];

  async function loadConnections() {
    setConnectionsLoading(true);
    try {
      const result = await apiFetch<VsphereConnection[] | { connections: VsphereConnection[] }>("/vsphere/connections");
      setConnections(Array.isArray(result) ? result : result.connections ?? []);
    } catch (error) {
      addToast((error as Error).message || "Failed to load vSphere connections", "danger");
    } finally {
      setConnectionsLoading(false);
    }
  }

  useEffect(() => {
    void loadConnections();
  }, []);

  useEffect(() => {
    const next: Record<number, DraftRow> = {};
    for (const system of systemRows) next[system.id] = toDraft(system);
    setDrafts((current) => ({ ...next, ...current }));
  }, [systems]);

  const connectionById = useMemo(() => {
    const map = new Map<number, VsphereConnection>();
    for (const connection of connections) map.set(connection.id, connection);
    return map;
  }, [connections]);

  const selectedSystem = useMemo(
    () => systemRows.find((system) => system.id === selectedSystemId) ?? null,
    [systemRows, selectedSystemId],
  );

  const selectedDraft = selectedSystemId ? drafts[selectedSystemId] ?? emptyDraft() : emptyDraft();

  const summary = useMemo(() => {
    let mapped = 0;
    let snapshotEnabled = 0;
    let needsAttention = 0;
    for (const system of systemRows) {
      const row = drafts[system.id] ?? toDraft(system);
      const isMapped = !!row.vsphereConnectionId && !!row.vsphereVmMoref;
      if (isMapped) mapped += 1;
      if (row.snapshotBeforeUpgrade) snapshotEnabled += 1;
      if (row.snapshotBeforeUpgrade && !isMapped) needsAttention += 1;
    }
    return { total: systemRows.length, mapped, snapshotEnabled, needsAttention };
  }, [systemRows, drafts]);

  const filteredSystems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return systemRows.filter((system) => {
      const row = drafts[system.id] ?? toDraft(system);
      const isMapped = !!row.vsphereConnectionId && !!row.vsphereVmMoref;
      const needsAttention = row.snapshotBeforeUpgrade && !isMapped;
      const haystack = `${system.name} ${system.hostname ?? ""} ${row.vsphereVmName} ${row.vsphereVmMoref}`.toLowerCase();

      if (query && !haystack.includes(query)) return false;
      if (mappingFilter === "mapped" && !isMapped) return false;
      if (mappingFilter === "unmapped" && isMapped) return false;
      if (snapshotFilter === "enabled" && !row.snapshotBeforeUpgrade) return false;
      if (snapshotFilter === "disabled" && row.snapshotBeforeUpgrade) return false;
      if (connectionFilter !== "all" && row.vsphereConnectionId !== connectionFilter) return false;
      if (needsAttentionOnly && !needsAttention) return false;
      return true;
    });
  }, [systemRows, drafts, search, mappingFilter, snapshotFilter, connectionFilter, needsAttentionOnly]);

  function updateDraft(systemId: number, patch: Partial<DraftRow>) {
    setDrafts((prev) => ({
      ...prev,
      [systemId]: { ...(prev[systemId] ?? emptyDraft()), ...patch },
    }));
  }

  function openEditor(system: SystemWithVsphere) {
    setSelectedSystemId(system.id);
    setVmSearch((drafts[system.id]?.vsphereVmName || system.vsphereVmName || system.name || "").toString());
    setVmResults([]);
  }

  async function createConnection(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create-connection");
    try {
      await apiFetch("/vsphere/connections", { method: "POST", body: JSON.stringify(form) });
      addToast("vCenter connection saved", "success");
      setForm((prev) => ({ ...prev, password: "" }));
      await loadConnections();
    } catch (error) {
      addToast((error as Error).message || "Failed to create vCenter connection", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(id: number) {
    setBusy(`test-${id}`);
    try {
      await apiFetch(`/vsphere/connections/${id}/test`, { method: "POST" });
      addToast("vCenter connection test succeeded", "success");
    } catch (error) {
      addToast((error as Error).message || "vCenter connection test failed", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function deleteConnection(connection: VsphereConnection) {
    const usedBy = systemRows.filter((system) => (drafts[system.id] ?? toDraft(system)).vsphereConnectionId === connection.id).length;
    const message = usedBy > 0
      ? `Remove ${connection.name}? This will clear vSphere mappings and disable pre-upgrade snapshots for ${usedBy} system(s). Continue?`
      : `Remove ${connection.name}? Continue?`;
    if (!window.confirm(message)) return;

    setBusy(`delete-connection-${connection.id}`);
    try {
      await apiFetch(`/vsphere/connections/${connection.id}`, { method: "DELETE" });
      addToast("vCenter credentials removed", "success");
      await loadConnections();
      await refetchSystems();
      setDrafts((current) => {
        const next = { ...current };
        for (const system of systemRows) {
          if (next[system.id]?.vsphereConnectionId === connection.id) {
            next[system.id] = { ...next[system.id], ...emptyDraft() };
          }
        }
        return next;
      });
    } catch (error) {
      addToast((error as Error).message || "Failed to remove vCenter credentials", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function searchVms() {
    if (!selectedSystemId) return;
    const row = drafts[selectedSystemId] ?? emptyDraft();
    if (!row.vsphereConnectionId) {
      addToast("Choose a vCenter connection first", "danger");
      return;
    }

    setBusy(`search-${selectedSystemId}`);
    try {
      const query = encodeURIComponent(vmSearch || "");
      const results = await apiFetch<VmSearchResult[]>(`/vsphere/connections/${row.vsphereConnectionId}/vms?search=${query}`);
      setVmResults(results);
      if (results.length === 0) addToast("No matching VMs found", "danger");
    } catch (error) {
      addToast((error as Error).message || "VM search failed", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function saveSystemMapping(systemId: number) {
    const row = drafts[systemId] ?? emptyDraft();
    setBusy(`save-${systemId}`);
    try {
      await apiFetch(`/vsphere/systems/${systemId}`, {
        method: "PUT",
        body: JSON.stringify({
          vsphereConnectionId: row.vsphereConnectionId === "" ? null : Number(row.vsphereConnectionId),
          vsphereVmMoref: row.vsphereVmMoref || null,
          vsphereVmName: row.vsphereVmName || null,
          snapshotBeforeUpgrade: row.snapshotBeforeUpgrade,
          snapshotQuiesce: row.snapshotQuiesce,
          snapshotMemory: row.snapshotMemory,
          snapshotRetentionHours: Number(row.snapshotRetentionHours) || 72,
        }),
      });
      addToast("System vSphere settings saved", "success");
      await refetchSystems();
    } catch (error) {
      addToast((error as Error).message || "Failed to save system mapping", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function clearMapping(systemId: number) {
    updateDraft(systemId, emptyDraft());
    setBusy(`save-${systemId}`);
    try {
      await apiFetch(`/vsphere/systems/${systemId}`, {
        method: "PUT",
        body: JSON.stringify({
          vsphereConnectionId: null,
          vsphereVmMoref: null,
          vsphereVmName: null,
          snapshotBeforeUpgrade: false,
          snapshotQuiesce: true,
          snapshotMemory: false,
          snapshotRetentionHours: 72,
        }),
      });
      addToast("System vSphere mapping cleared", "success");
      await refetchSystems();
    } catch (error) {
      addToast((error as Error).message || "Failed to clear mapping", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function createManualSnapshot(systemId: number) {
    setBusy(`snapshot-${systemId}`);
    try {
      await apiFetch(`/vsphere/systems/${systemId}/snapshots`, { method: "POST" });
      addToast("Manual snapshot created", "success");
    } catch (error) {
      addToast((error as Error).message || "Snapshot creation failed", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function applyBulk(patch: Partial<DraftRow>, label: string) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      addToast("Select at least one system first", "danger");
      return;
    }
    if (!window.confirm(`${label} for ${ids.length} selected system(s)?`)) return;

    setBusy("bulk");
    try {
      for (const id of ids) {
        const row = { ...(drafts[id] ?? emptyDraft()), ...patch };
        updateDraft(id, row);
        await apiFetch(`/vsphere/systems/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            vsphereConnectionId: row.vsphereConnectionId === "" ? null : Number(row.vsphereConnectionId),
            vsphereVmMoref: row.vsphereVmMoref || null,
            vsphereVmName: row.vsphereVmName || null,
            snapshotBeforeUpgrade: row.snapshotBeforeUpgrade,
            snapshotQuiesce: row.snapshotQuiesce,
            snapshotMemory: row.snapshotMemory,
            snapshotRetentionHours: Number(row.snapshotRetentionHours) || 72,
          }),
        });
      }
      addToast(`${label} completed`, "success");
      setSelectedIds(new Set());
      await refetchSystems();
    } catch (error) {
      addToast((error as Error).message || "Bulk update failed", "danger");
    } finally {
      setBusy(null);
    }
  }

  function toggleSelected(id: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleVisible(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const system of filteredSystems) {
        if (checked) next.add(system.id);
        else next.delete(system.id);
      }
      return next;
    });
  }

  const allVisibleSelected = filteredSystems.length > 0 && filteredSystems.every((system) => selectedIds.has(system.id));

  return (
    <Layout title="VMware vSphere" contentWidth="full">
      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">vCenter connections</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Store vCenter credentials used by the dashboard to create pre-upgrade snapshots.
              </p>
            </div>
          </div>

          <form onSubmit={createConnection} className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </Field>
            <Field label="vCenter URL">
              <input className={inputClass} value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
            </Field>
            <Field label="Username">
              <input className={inputClass} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required />
            </Field>
            <Field label="Password">
              <input className={inputClass} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
            </Field>
            <Field label="TLS mode">
              <select className={inputClass} value={form.tlsMode} onChange={(event) => setForm({ ...form, tlsMode: event.target.value as "strict" | "allow_self_signed" })}>
                <option value="strict">Strict certificate check</option>
                <option value="allow_self_signed">Allow self-signed</option>
              </select>
            </Field>
            <div className="md:col-span-2 xl:col-span-5">
              <Button type="submit" disabled={busy === "create-connection"}>
                {busy === "create-connection" ? "Saving..." : "Save vCenter connection"}
              </Button>
            </div>
          </form>

          <div className="mt-5 overflow-x-auto">
            {connectionsLoading ? (
              <p className="text-sm text-slate-500">Loading vCenter connections...</p>
            ) : connections.length === 0 ? (
              <p className="text-sm text-slate-500">No vCenter connections saved yet.</p>
            ) : (
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">URL</th>
                    <th className="py-2 pr-4">Username</th>
                    <th className="py-2 pr-4">TLS</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {connections.map((connection) => (
                    <tr key={connection.id}>
                      <td className="py-2 pr-4 font-medium">{connection.name}</td>
                      <td className="py-2 pr-4">{connection.url}</td>
                      <td className="py-2 pr-4">{connection.username}</td>
                      <td className="py-2 pr-4">{connection.tlsMode === "allow_self_signed" ? "Self-signed allowed" : "Strict"}</td>
                      <td className="flex gap-2 py-2 pr-4">
                        <Button variant="secondary" onClick={() => testConnection(connection.id)} disabled={busy === `test-${connection.id}`}>
                          {busy === `test-${connection.id}` ? "Testing..." : "Test"}
                        </Button>
                        <Button variant="danger" onClick={() => deleteConnection(connection)} disabled={busy === `delete-connection-${connection.id}`}>
                          {busy === `delete-connection-${connection.id}` ? "Removing..." : "Remove credentials"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-2xl font-semibold">{summary.total}</div>
            <div className="text-sm text-slate-500">Linux systems</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-2xl font-semibold">{summary.mapped}</div>
            <div className="text-sm text-slate-500">Mapped to vSphere</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-2xl font-semibold">{summary.snapshotEnabled}</div>
            <div className="text-sm text-slate-500">Pre-upgrade snapshots enabled</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="text-2xl font-semibold">{summary.needsAttention}</div>
            <div className="text-sm text-slate-500">Need attention</div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Fleet mapping</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Search, filter, bulk-edit, and map systems without scrolling through one large card per VM.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => applyBulk({ snapshotBeforeUpgrade: true }, "Enable pre-upgrade snapshots")} disabled={busy === "bulk"}>
                Enable selected
              </Button>
              <Button variant="secondary" onClick={() => applyBulk({ snapshotBeforeUpgrade: false }, "Disable pre-upgrade snapshots")} disabled={busy === "bulk"}>
                Disable selected
              </Button>
              <Button variant="secondary" onClick={() => applyBulk({ snapshotQuiesce: true, snapshotMemory: false, snapshotRetentionHours: 72 }, "Apply safe defaults")} disabled={busy === "bulk"}>
                Safe defaults
              </Button>
            </div>
          </div>

          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <Field label="Search">
              <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="system, hostname, VM name, MoRef" />
            </Field>
            <Field label="vCenter">
              <select className={inputClass} value={connectionFilter} onChange={(event) => setConnectionFilter(event.target.value === "all" ? "all" : Number(event.target.value))}>
                <option value="all">All vCenters</option>
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
              </select>
            </Field>
            <Field label="Mapping">
              <select className={inputClass} value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value as MappingFilter)}>
                <option value="all">All</option>
                <option value="mapped">Mapped</option>
                <option value="unmapped">Unmapped</option>
              </select>
            </Field>
            <Field label="Snapshot">
              <select className={inputClass} value={snapshotFilter} onChange={(event) => setSnapshotFilter(event.target.value as SnapshotFilter)}>
                <option value="all">All</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </Field>
            <Field label="Problems">
              <label className="flex h-[38px] items-center gap-2 text-sm">
                <input type="checkbox" checked={needsAttentionOnly} onChange={(event) => setNeedsAttentionOnly(event.target.checked)} />
                Needs attention only
              </label>
            </Field>
          </div>

          {systemsLoading ? (
            <p className="text-sm text-slate-500">Loading systems...</p>
          ) : filteredSystems.length === 0 ? (
            <p className="text-sm text-slate-500">No systems match the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-3"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleVisible(event.target.checked)} /></th>
                    <th className="py-2 pr-4">System</th>
                    <th className="py-2 pr-4">vCenter</th>
                    <th className="py-2 pr-4">vSphere VM</th>
                    <th className="py-2 pr-4">Snapshot</th>
                    <th className="py-2 pr-4">Options</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredSystems.map((system) => {
                    const row = drafts[system.id] ?? toDraft(system);
                    const isMapped = !!row.vsphereConnectionId && !!row.vsphereVmMoref;
                    const needsAttention = row.snapshotBeforeUpgrade && !isMapped;
                    return (
                      <tr key={system.id} className="align-top">
                        <td className="py-3 pr-3"><input type="checkbox" checked={selectedIds.has(system.id)} onChange={(event) => toggleSelected(system.id, event.target.checked)} /></td>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{system.name}</div>
                          <div className="text-xs text-slate-500">{system.hostname || "-"}</div>
                        </td>
                        <td className="py-3 pr-4">{row.vsphereConnectionId ? connectionById.get(Number(row.vsphereConnectionId))?.name ?? `#${row.vsphereConnectionId}` : "-"}</td>
                        <td className="py-3 pr-4">
                          <div className="font-medium">{row.vsphereVmName || "-"}</div>
                          <div className="text-xs text-slate-500">{row.vsphereVmMoref || ""}</div>
                        </td>
                        <td className="py-3 pr-4">{row.snapshotBeforeUpgrade ? <Pill tone="green">Enabled</Pill> : <Pill>Disabled</Pill>}</td>
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {row.snapshotQuiesce ? <Pill tone="blue">Quiesce</Pill> : <Pill>no quiesce</Pill>}
                            {row.snapshotMemory ? <Pill tone="amber">Memory</Pill> : <Pill>No memory</Pill>}
                            <Pill>{row.snapshotRetentionHours}h</Pill>
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          {needsAttention ? <Pill tone="red">Needs mapping</Pill> : isMapped ? <Pill tone="green">Ready</Pill> : <Pill tone="amber">Unmapped</Pill>}
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" onClick={() => openEditor(system)}>Edit</Button>
                            <Button variant="secondary" onClick={() => createManualSnapshot(system.id)} disabled={busy === `snapshot-${system.id}` || !isMapped}>
                              {busy === `snapshot-${system.id}` ? "Creating..." : "Test snapshot"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>Production note:</strong> snapshots are not backups. Keep memory snapshots disabled unless you specifically need them, and remove old snapshots after the maintenance window.
        </section>
      </div>

      {selectedSystem ? (
	<div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={() => setSelectedSystemId(null)}>
  	  <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Edit vSphere mapping</h2>
                <p className="mt-1 text-sm text-slate-500">{selectedSystem.name} · {selectedSystem.hostname || "no hostname"}</p>
              </div>
              <Button variant="ghost" onClick={() => setSelectedSystemId(null)}>Close</Button>
            </div>

            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="vCenter">
                  <select
                    className={inputClass}
                    value={selectedDraft.vsphereConnectionId}
                    onChange={(event) => updateDraft(selectedSystem.id, { vsphereConnectionId: event.target.value ? Number(event.target.value) : "" })}
                  >
                    <option value="">Not configured</option>
                    {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                  </select>
                </Field>
                <Field label="Retention hours">
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    value={selectedDraft.snapshotRetentionHours}
                    onChange={(event) => updateDraft(selectedSystem.id, { snapshotRetentionHours: Number(event.target.value) })}
                  />
                </Field>
              </div>

              <Field label="Search vSphere VM">
                <div className="flex gap-2">
                  <input className={inputClass} value={vmSearch} onChange={(event) => setVmSearch(event.target.value)} placeholder={selectedSystem.name} />
                  <Button variant="secondary" onClick={searchVms} disabled={busy === `search-${selectedSystem.id}`}>
                    {busy === `search-${selectedSystem.id}` ? "Searching..." : "Search"}
                  </Button>
                </div>
              </Field>

              {vmResults.length > 0 ? (
                <div className="rounded-lg border border-border bg-slate-50 p-3 dark:bg-slate-900/40">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">VM search results</p>
                  <div className="space-y-2">
                    {vmResults.map((vm) => (
                      <button
                        key={`${vm.moref}-${vm.path}`}
                        type="button"
                        onClick={() => updateDraft(selectedSystem.id, { vsphereVmMoref: vm.moref, vsphereVmName: vm.name })}
                        className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-white dark:hover:bg-slate-800"
                      >
                        <span className="font-medium">{vm.name}</span>
                        <span className="ml-2 text-xs text-slate-500">{vm.moref}</span>
                        <div className="text-xs text-slate-500">{vm.path}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="VM name">
                  <input className={inputClass} value={selectedDraft.vsphereVmName} onChange={(event) => updateDraft(selectedSystem.id, { vsphereVmName: event.target.value })} />
                </Field>
                <Field label="VM MoRef">
                  <input className={inputClass} value={selectedDraft.vsphereVmMoref} onChange={(event) => updateDraft(selectedSystem.id, { vsphereVmMoref: event.target.value })} placeholder="vm-12345" />
                </Field>
              </div>

              <div className="space-y-3 rounded-lg border border-border p-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selectedDraft.snapshotBeforeUpgrade} onChange={(event) => updateDraft(selectedSystem.id, { snapshotBeforeUpgrade: event.target.checked })} />
                  Create snapshot before upgrade
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selectedDraft.snapshotQuiesce} onChange={(event) => updateDraft(selectedSystem.id, { snapshotQuiesce: event.target.checked })} />
                  Quiesce guest filesystem
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selectedDraft.snapshotMemory} onChange={(event) => updateDraft(selectedSystem.id, { snapshotMemory: event.target.checked })} />
                  Include VM memory
                </label>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button onClick={() => saveSystemMapping(selectedSystem.id)} disabled={busy === `save-${selectedSystem.id}`}>
                  {busy === `save-${selectedSystem.id}` ? "Saving..." : "Save mapping"}
                </Button>
                <Button variant="secondary" onClick={() => createManualSnapshot(selectedSystem.id)} disabled={busy === `snapshot-${selectedSystem.id}` || !selectedDraft.vsphereConnectionId || !selectedDraft.vsphereVmMoref}>
                  {busy === `snapshot-${selectedSystem.id}` ? "Creating..." : "Create test snapshot"}
                </Button>
                <Button variant="danger" onClick={() => clearMapping(selectedSystem.id)} disabled={busy === `save-${selectedSystem.id}`}>
                  Clear mapping
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Layout>
  );
}
