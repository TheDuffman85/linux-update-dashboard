import { useEffect, useState } from "react";
import { useToast } from "../../context/ToastContext";
import { CredentialForm } from "../credentials/CredentialForm";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import {
  useCreateCredential,
  useCredentials,
  type CredentialKind,
} from "../../lib/credentials";
import { SSH_CREDENTIAL_KINDS } from "../../lib/credential-form";
import { validateSystemForm } from "../../lib/system-form-validation";
import { useRevokeHostKey, useSystems, useTestConnection } from "../../lib/systems";
import {
  normalizePackageManagerConfigs,
  SUPPORTED_PACKAGE_MANAGER_CONFIGS,
  type PackageManagerConfigs,
} from "../../lib/package-manager-configs";

interface SystemFormData {
  name: string;
  hostname: string;
  port: number;
  credentialId: number;
  proxyJumpSystemId?: number | null;
  hostKeyVerificationEnabled: boolean;
  validatedConfigToken?: string;
  sudoPassword?: string;
  disabledPkgManagers?: string[];
  pkgManagerConfigs?: PackageManagerConfigs | null;
  autoHideKeptBackUpdates?: boolean;
  excludeFromUpgradeAll?: boolean;
  hidden?: boolean;
  sourceSystemId?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PACKAGE_MANAGER_LABELS: Record<string, string> = {
  apt: "APT",
  dnf: "DNF",
  yum: "YUM",
  pacman: "Pacman",
  apk: "APK",
  flatpak: "Flatpak",
  snap: "Snap",
};

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export function SystemForm({
  initial,
  systemId,
  sourceSystemId,
  onSubmit,
  onCancel,
  loading = false,
}: {
  initial?: Omit<Partial<SystemFormData>, "autoHideKeptBackUpdates" | "excludeFromUpgradeAll"> & {
    detectedPkgManagers?: string[] | null;
    disabledPkgManagers?: string[] | null;
    pkgManagerConfigs?: PackageManagerConfigs | null;
    autoHideKeptBackUpdates?: number;
    excludeFromUpgradeAll?: number;
    approvedHostKey?: string | null;
    trustedHostKeyFingerprintSha256?: string | null;
    hostKeyStatus?: string;
  };
  systemId?: number;
  sourceSystemId?: number;
  onSubmit: (data: SystemFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const testConnection = useTestConnection();
  const revokeHostKey = useRevokeHostKey();
  const createCredential = useCreateCredential();
  const { data: allCredentials } = useCredentials();
  const { data: allSystems } = useSystems();
  const { addToast } = useToast();
  const credentials =
    allCredentials?.filter((credential) =>
      SSH_CREDENTIAL_KINDS.includes(credential.kind)
    ) || [];
  const availableSystems =
    allSystems?.filter((system) => system.id !== systemId) || [];
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    debugRef?: string;
  } | null>(null);
  const [validatedConfigToken, setValidatedConfigToken] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name || "");
  const [hostname, setHostname] = useState(initial?.hostname || "");
  const [port, setPort] = useState(initial?.port || 22);
  const [credentialId, setCredentialId] = useState<number>(initial?.credentialId || 0);
  const [proxyJumpSystemId, setProxyJumpSystemId] = useState<number | null>(
    initial?.proxyJumpSystemId ?? null
  );
  const [hostKeyVerificationEnabled, setHostKeyVerificationEnabled] = useState(
    initial?.hostKeyVerificationEnabled !== undefined
      ? initial.hostKeyVerificationEnabled !== false
      : true
  );
  const [sudoPassword, setSudoPassword] = useState("");
  const [detectedManagers, setDetectedManagers] = useState<string[]>(
    initial?.detectedPkgManagers ?? []
  );
  const [disabledManagers, setDisabledManagers] = useState<Set<string>>(
    new Set(initial?.disabledPkgManagers ?? [])
  );
  const [pkgManagerConfigs, setPkgManagerConfigs] = useState<PackageManagerConfigs>(
    initial?.pkgManagerConfigs
      ?? (initial?.autoHideKeptBackUpdates === 1
        ? { apt: { autoHideKeptBackUpdates: true } }
        : {})
  );
  const [excludeFromUpgradeAll, setExcludeFromUpgradeAll] = useState(
    initial?.excludeFromUpgradeAll === 1
  );
  const [hidden, setHidden] = useState(initial?.hidden === true);
  const selectedProxyJumpSystem =
    availableSystems.find((system) => system.id === proxyJumpSystemId) ?? null;
  const getChallengeSystemName = (challengeSystemId?: number) => {
    if (!challengeSystemId) return null;
    return allSystems?.find((system) => system.id === challengeSystemId)?.name ?? null;
  };
  const [pendingTrustChallenge, setPendingTrustChallenge] = useState<{
    token: string;
    challenges: Array<{
      systemId?: number;
      role: "jump" | "target";
      host: string;
      port: number;
      algorithm: string;
      fingerprintSha256: string;
      rawKey: string;
    }>;
  } | null>(null);
  const [approvedHostKey, setApprovedHostKey] = useState<string | null>(
    initial?.approvedHostKey ?? null
  );
  const [approvedHostKeyFingerprint, setApprovedHostKeyFingerprint] = useState<string | null>(
    initial?.trustedHostKeyFingerprintSha256 ?? null
  );
  const [showUnapprovedSaveWarning, setShowUnapprovedSaveWarning] = useState(false);
  const [showCreateCredential, setShowCreateCredential] = useState(false);

  const resetValidatedState = () => {
    setValidatedConfigToken(null);
    setPendingTrustChallenge(null);
  };

  useEffect(() => {
    resetValidatedState();
  }, [hostname, port, credentialId, proxyJumpSystemId, hostKeyVerificationEnabled]);

  useEffect(() => {
    setApprovedHostKey(initial?.approvedHostKey ?? null);
    setApprovedHostKeyFingerprint(initial?.trustedHostKeyFingerprintSha256 ?? null);
  }, [initial?.approvedHostKey, initial?.trustedHostKeyFingerprintSha256]);

  useEffect(() => {
    if (hostname !== (initial?.hostname || "") || port !== (initial?.port || 22)) {
      setApprovedHostKey(null);
      setApprovedHostKeyFingerprint(null);
    }
  }, [hostname, port, initial?.hostname, initial?.port]);

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

  const setManagerConfig = <T extends keyof PackageManagerConfigs>(
    manager: T,
    value: PackageManagerConfigs[T] | undefined,
  ) => {
    setPkgManagerConfigs((prev) => {
      const next = { ...prev };
      if (!value || Object.keys(value).length === 0) {
        delete next[manager];
      } else {
        next[manager] = value;
      }
      return next;
    });
  };

  const submitForm = () => {
    const validationError = validateSystemForm({
      name,
      hostname,
      port,
      credentialId,
      proxyJumpSystemId,
    });
    if (validationError) {
      addToast(validationError, "danger");
      return;
    }

    onSubmit({
      name,
      hostname,
      port,
      credentialId,
      proxyJumpSystemId,
      hostKeyVerificationEnabled,
      validatedConfigToken: validatedConfigToken || undefined,
      sudoPassword: sudoPassword || undefined,
      disabledPkgManagers: [...disabledManagers],
      pkgManagerConfigs: normalizePackageManagerConfigs(pkgManagerConfigs) ?? {},
      excludeFromUpgradeAll,
      hidden,
      sourceSystemId,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (hostKeyVerificationEnabled && !approvedHostKey) {
      setShowUnapprovedSaveWarning(true);
      return;
    }
    submitForm();
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
  const labelClass =
    "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
  const showsProxyJumpLoopbackWarning =
    proxyJumpSystemId !== null && isLoopbackHost(hostname);
  const visiblePackageManagers = Array.from(
    new Set([
      ...detectedManagers,
      ...Object.keys(pkgManagerConfigs),
    ]),
  ).sort((a, b) => {
    const order = ["apt", "dnf", "yum", "pacman", "apk", "flatpak", "snap"];
    const leftIndex = order.indexOf(a);
    const rightIndex = order.indexOf(b);
    if (leftIndex === -1 && rightIndex === -1) return a.localeCompare(b);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });

  const runConnectionTest = (extra?: {
    trustChallengeToken?: string;
    approvedHostKeys?: Array<{
      systemId?: number;
      role: "jump" | "target";
      host: string;
      port: number;
      algorithm: string;
      fingerprintSha256: string;
      rawKey: string;
    }>;
  }) => {
    const validationError = validateSystemForm({
      name,
      hostname,
      port,
      credentialId,
      proxyJumpSystemId,
    });
    if (validationError) {
      setTestResult({ success: false, message: validationError });
      return;
    }

    setTestResult(null);
    testConnection.mutate(
      {
        hostname,
        port,
        credentialId,
        proxyJumpSystemId,
        hostKeyVerificationEnabled,
        systemId,
        sourceSystemId: systemId ? undefined : sourceSystemId,
        ...extra,
      },
      {
        onSuccess: (data) => {
          setTestResult({
            success: data.success,
            message: data.message,
            debugRef: data.debugRef,
          });
          if (data.hostKeyChallenges?.length && data.trustChallengeToken) {
            setValidatedConfigToken(null);
            setPendingTrustChallenge({
              token: data.trustChallengeToken,
              challenges: data.hostKeyChallenges,
            });
            return;
          }

          setPendingTrustChallenge(null);
          if (data.success && data.validatedConfigToken) {
            setValidatedConfigToken(data.validatedConfigToken);
          }
          if (extra?.approvedHostKeys?.length) {
            const targetApproval = extra.approvedHostKeys.find(
              (approval) => approval.role === "target"
            );
            if (targetApproval) {
              setApprovedHostKey(
                `${targetApproval.algorithm} ${targetApproval.rawKey}`
              );
              setApprovedHostKeyFingerprint(targetApproval.fingerprintSha256);
            }
          }
          if (data.detectedManagers?.length) {
            setDetectedManagers(data.detectedManagers);
            setDisabledManagers((prev) => {
              const next = new Set<string>();
              for (const m of prev) {
                if (data.detectedManagers!.includes(m)) next.add(m);
              }
              return next;
            });
          }
        },
        onError: (err) => {
          setValidatedConfigToken(null);
          setPendingTrustChallenge(null);
          setTestResult({ success: false, message: err.message });
        },
      }
    );
  };

  const handleCreateCredential = (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => {
    createCredential.mutate(data, {
      onSuccess: (result) => {
        setCredentialId(result.id);
        setShowCreateCredential(false);
        addToast("Credential created", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <>
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
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value, 10))}
              required
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>SSH Credential</label>
          <div className="flex items-center gap-3">
            <select
              value={credentialId || ""}
              onChange={(e) => setCredentialId(Number(e.target.value))}
              required
              className={`${inputClass} flex-1`}
            >
              <option value="" disabled>
                {credentials.length > 0
                  ? "Select a credential"
                  : "Create a credential to continue"}
              </option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowCreateCredential(true)}
              className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              New Credential
            </button>
          </div>
          {credentials.length === 0 && (
            <div className="mt-2 rounded-lg border border-dashed border-border bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              No SSH credentials are available yet. Create one here without leaving this dialog.
            </div>
          )}
        </div>

        <div>
          <label className={labelClass}>Proxy Jump System</label>
          <select
            value={proxyJumpSystemId || ""}
            onChange={(e) => setProxyJumpSystemId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            <option value="">Direct connection</option>
            {availableSystems.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-1">
            Uses the selected system as a live SSH jump host chain.
          </p>
        </div>

        {showsProxyJumpLoopbackWarning && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            With Proxy Jump enabled, <span className="font-mono">{hostname || "localhost"}</span> is
            resolved from {selectedProxyJumpSystem ? ` ${selectedProxyJumpSystem.name}` : " the jump host"}.
            Use a host or IP that the jump host can reach instead of loopback.
          </div>
        )}

        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={hostKeyVerificationEnabled}
            onChange={(e) => setHostKeyVerificationEnabled(e.target.checked)}
            className="rounded mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-slate-700 dark:text-slate-200">
              Verify SSH host key
            </span>
            <span className="block text-xs text-slate-400 mt-0.5">
              Enabled by default for new systems. Disabling this weakens SSH trust checks for this system only.
            </span>
          </span>
        </label>

        {!hostKeyVerificationEnabled && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            Host-key verification is disabled for this system. Connections to this host will not verify the SSH server identity.
          </div>
        )}

        {systemId && hostKeyVerificationEnabled && (
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Approved SSH Host Key
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {approvedHostKey ? "Stored for this system" : "No approved key stored"}
                </div>
              </div>
              {approvedHostKey && (
                <button
                  type="button"
                  onClick={() => {
                    revokeHostKey.mutate(systemId, {
                      onSuccess: () => {
                        setApprovedHostKey(null);
                        setApprovedHostKeyFingerprint(null);
                        setValidatedConfigToken(null);
                      },
                      onError: (err) => {
                        setTestResult({
                          success: false,
                          message: err.message,
                        });
                      },
                    });
                  }}
                  disabled={revokeHostKey.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                >
                  {revokeHostKey.isPending ? "Revoking..." : "Revoke"}
                </button>
              )}
            </div>
            {approvedHostKey ? (
              <>
                <div className="text-xs text-slate-500 dark:text-slate-400 break-all">
                  Fingerprint: <span className="font-mono">{approvedHostKeyFingerprint}</span>
                </div>
                <pre className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                  {approvedHostKey}
                </pre>
              </>
            ) : (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Use Test Connection to approve and store the host key from this dialog.
              </div>
            )}
          </div>
        )}

        <div>
          <label className={labelClass}>Sudo Password (optional)</label>
          <input
            type="password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            className={inputClass}
            placeholder={sourceSystemId ? "(from source system)" : initial ? "(unchanged — defaults to SSH password)" : "Defaults to SSH password"}
          />
          <p className="text-xs text-slate-400 mt-1">Only needed if the sudo password differs from the SSH credential password</p>
        </div>

        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={excludeFromUpgradeAll}
            onChange={(e) => setExcludeFromUpgradeAll(e.target.checked)}
            className="rounded mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-slate-700 dark:text-slate-200">
              Exclude from Upgrade All
            </span>
            <span className="block text-xs text-slate-400 mt-0.5">
              Start unchecked in the Upgrade All Systems dialog
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className="rounded mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-slate-700 dark:text-slate-200">
              Hide from Dashboard
            </span>
            <span className="block text-xs text-slate-400 mt-0.5">
              Keeps this system available in Systems, but hides it from the dashboard, notifications, and Upgrade All.
            </span>
          </span>
        </label>

        {testResult && (
          <div className={`p-3 rounded-lg text-sm ${testResult.success ? "bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400" : "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400"}`}>
            <div>{testResult.message}</div>
            {!testResult.success && testResult.debugRef && (
              <div className="mt-2 text-xs opacity-80">
                Check container logs with debug reference <span className="font-mono">{testResult.debugRef}</span>.
              </div>
            )}
          </div>
        )}

        {visiblePackageManagers.length > 0 && (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Package Managers
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Enable package managers for this system and adjust manager-specific behavior where it is useful.
              </p>
            </div>

            {visiblePackageManagers.map((manager) => {
              const enabled = !disabledManagers.has(manager);
              const title = PACKAGE_MANAGER_LABELS[manager] ?? manager;
              const hasExtraSettings = (SUPPORTED_PACKAGE_MANAGER_CONFIGS as readonly string[]).includes(manager);

              return (
                <div key={manager} className="rounded-lg border border-border p-3 space-y-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {title}
                    </div>
                    <label className="mt-2 inline-flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleManager(manager)}
                        className="rounded"
                      />
                      <span className={enabled ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}>
                        Enabled
                      </span>
                    </label>
                    {!detectedManagers.includes(manager) && (
                      <p className="mt-2 text-xs text-slate-400">
                        Saved config is shown here even though this package manager is not currently detected.
                      </p>
                    )}
                  </div>

                  {manager === "apt" && (
                    <>
                      <div>
                        <label className={labelClass}>Default Upgrade Mode</label>
                        <select
                          value={pkgManagerConfigs.apt?.defaultUpgradeMode ?? "upgrade"}
                          onChange={(e) =>
                            setManagerConfig("apt", {
                              defaultUpgradeMode: e.target.value as "upgrade" | "full-upgrade",
                            })
                          }
                          className={inputClass}
                        >
                          <option value="upgrade">Standard upgrade</option>
                          <option value="full-upgrade">Full upgrade</option>
                        </select>
                      </div>
                      <p className="text-xs text-slate-400">
                        When set to full upgrade, the normal Upgrade action may install new dependencies or remove obsolete packages.
                      </p>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.apt?.autoHideKeptBackUpdates === true}
                          onChange={(e) =>
                            setManagerConfig("apt", {
                              ...pkgManagerConfigs.apt,
                              autoHideKeptBackUpdates: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Auto-hide kept-back packages
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Automatically move kept-back APT updates into the hidden-updates list after refreshes.
                          </span>
                        </span>
                      </label>
                    </>
                  )}

                  {manager === "dnf" && (
                    <>
                      <div>
                        <label className={labelClass}>Default Upgrade Mode</label>
                        <select
                          value={pkgManagerConfigs.dnf?.defaultUpgradeMode ?? "upgrade"}
                          onChange={(e) =>
                            setManagerConfig("dnf", {
                              ...pkgManagerConfigs.dnf,
                              defaultUpgradeMode: e.target.value as "upgrade" | "distro-sync",
                            })
                          }
                          className={inputClass}
                        >
                          <option value="upgrade">Standard upgrade</option>
                          <option value="distro-sync">Distro sync</option>
                        </select>
                      </div>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.dnf?.refreshMetadataOnCheck === true}
                          onChange={(e) =>
                            setManagerConfig("dnf", {
                              ...pkgManagerConfigs.dnf,
                              refreshMetadataOnCheck: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Refresh metadata during checks
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Uses `dnf check-update --refresh` to force a metadata refresh during update checks.
                          </span>
                        </span>
                      </label>
                    </>
                  )}

                  {manager === "pacman" && (
                    <label className="flex items-start gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pkgManagerConfigs.pacman?.refreshDatabasesOnCheck !== false}
                        onChange={(e) =>
                          setManagerConfig("pacman", {
                            refreshDatabasesOnCheck: e.target.checked,
                          })
                        }
                        className="rounded mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-slate-700 dark:text-slate-200">
                          Refresh package databases during checks
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          Disabling this skips the `pacman -Sy` refresh step and uses locally cached sync data only.
                        </span>
                      </span>
                    </label>
                  )}

                  {manager === "apk" && (
                    <label className="flex items-start gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pkgManagerConfigs.apk?.refreshIndexesOnCheck !== false}
                        onChange={(e) =>
                          setManagerConfig("apk", {
                            refreshIndexesOnCheck: e.target.checked,
                          })
                        }
                        className="rounded mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-slate-700 dark:text-slate-200">
                          Refresh package indexes during checks
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          Disabling this skips `apk update` during checks and only lists updates from the current local index state.
                        </span>
                      </span>
                    </label>
                  )}

                  {manager === "flatpak" && (
                    <label className="flex items-start gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pkgManagerConfigs.flatpak?.refreshAppstreamOnCheck !== false}
                        onChange={(e) =>
                          setManagerConfig("flatpak", {
                            refreshAppstreamOnCheck: e.target.checked,
                          })
                        }
                        className="rounded mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-slate-700 dark:text-slate-200">
                          Refresh appstream data during checks
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          Disabling this skips the appstream refresh step and only checks for updates with current local metadata.
                        </span>
                      </span>
                    </label>
                  )}

                  {!hasExtraSettings && (
                    <p className="text-xs text-slate-400">
                      No additional settings for this package manager yet.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <button
            type="button"
            disabled={testConnection.isPending || !hostname || credentialId <= 0}
            onClick={() => runConnectionTest()}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {testConnection.isPending ? (
              <span className="spinner spinner-sm" />
            ) : hostKeyVerificationEnabled && !approvedHostKey ? (
              "Approve SSH Host Key"
            ) : (
              "Test Connection"
            )}
          </button>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || credentialId <= 0}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {loading ? <span className="spinner spinner-sm" /> : "Save"}
            </button>
          </div>
        </div>
      </form>

      <Modal
        open={pendingTrustChallenge !== null}
        onClose={() => setPendingTrustChallenge(null)}
        title="Approve SSH Host Key"
        dismissible={!testConnection.isPending}
      >
        {pendingTrustChallenge && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Approve the reported SSH host key before this connection can be trusted.
            </p>
            <div className="space-y-3">
              {pendingTrustChallenge.challenges.map((challenge) => (
                <div key={`${challenge.role}-${challenge.host}-${challenge.port}-${challenge.fingerprintSha256}`} className="rounded-lg border border-border p-3 text-sm">
                  <div className="font-medium text-slate-800 dark:text-slate-100">
                    {challenge.role === "target" ? "Target host" : "Jump host"}
                  </div>
                  {getChallengeSystemName(challenge.systemId) && (
                    <div className="text-sm text-slate-200">
                      {getChallengeSystemName(challenge.systemId)}
                    </div>
                  )}
                  <div className="text-slate-500 dark:text-slate-400">
                    {challenge.host}:{challenge.port}
                  </div>
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    <div>Algorithm: <span className="font-mono">{challenge.algorithm}</span></div>
                    <div>Fingerprint: <span className="font-mono break-all">{challenge.fingerprintSha256}</span></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingTrustChallenge(null)}
                disabled={testConnection.isPending}
                className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  runConnectionTest({
                    trustChallengeToken: pendingTrustChallenge.token,
                    approvedHostKeys: pendingTrustChallenge.challenges,
                  })
                }
                disabled={testConnection.isPending}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {testConnection.isPending ? <span className="spinner spinner-sm" /> : "Approve and Continue"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={showCreateCredential}
        onClose={() => setShowCreateCredential(false)}
        title="Add Credential"
        dismissible={!createCredential.isPending}
      >
        <CredentialForm
          onSubmit={handleCreateCredential}
          onCancel={() => setShowCreateCredential(false)}
          loading={createCredential.isPending}
        />
      </Modal>

      <ConfirmDialog
        open={showUnapprovedSaveWarning}
        onClose={() => setShowUnapprovedSaveWarning(false)}
        onConfirm={() => {
          setShowUnapprovedSaveWarning(false);
          submitForm();
        }}
        title="Save Without Approved Host Key"
        message="SSH host-key verification is enabled, but no host key has been approved yet. You can save now, but SSH actions will require approving the host key later from this dialog."
        confirmLabel="Save Anyway"
      />
    </>
  );
}
