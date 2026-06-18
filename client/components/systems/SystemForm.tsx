import { useEffect, useState } from "react";
import { useToast } from "../../context/ToastContext";
import { CredentialForm } from "../credentials/CredentialForm";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import { Badge } from "../Badge";
import {
  useCreateCredential,
  useCredentials,
  type CredentialKind,
} from "../../lib/credentials";
import { SSH_CREDENTIAL_KINDS } from "../../lib/credential-form";
import { validateSystemForm } from "../../lib/system-form-validation";
import { useRevokeHostKey, useSystems, useTestConnection } from "../../lib/systems";
import {
  getLegacyCustomConfigKey,
  normalizePackageManagerConfigs,
  SUPPORTED_PACKAGE_MANAGER_CONFIGS,
  type CustomPackageManagerConfig,
  type PackageManagerConfigs,
} from "../../lib/package-manager-configs";
import {
  getHostKeyStatusBadgeLabel,
  type HostKeyStatus,
} from "../../lib/host-key-status";
import {
  buildOperationKey,
  useScripts,
  type ScriptOperation,
} from "../../lib/scripts";
import { useI18n } from "../../lib/i18n";

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
  detectedPkgManagers?: string[];
  pkgManagerConfigs?: PackageManagerConfigs | null;
  autoHideKeptBackUpdates?: boolean;
  hidden?: boolean;
  scriptOverrides?: Record<string, string | null | undefined>;
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
const PACKAGE_MANAGER_ORDER = ["apt", "dnf", "yum", "pacman", "apk", "flatpak", "snap"];
const SCRIPT_OPERATION_LABEL_KEYS: Record<ScriptOperation, string> = {
  detect: "pages.scripts.operation.detect",
  check_updates: "pages.scripts.operation.checkUpdates",
  list_installed_packages: "pages.scripts.operation.listInstalledPackages",
  repair_issue: "pages.scripts.operation.repairIssue",
  autoremove: "pages.scripts.operation.autoremove",
  upgrade_all: "pages.scripts.operation.upgradeAll",
  full_upgrade_all: "pages.scripts.operation.fullUpgrade",
  upgrade_selected: "pages.scripts.operation.upgradeSelected",
  system_info: "pages.scripts.operation.systemInfo",
  reboot: "pages.scripts.operation.reboot",
};

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

function isHostKeyErrorMessage(message: string | null | undefined): boolean {
  return /HostKeyVerificationError|SSH host key approval required|SSH host key verification failed/i.test(
    message ?? ""
  );
}

function sortPackageManagers(a: string, b: string): number {
  const leftIndex = PACKAGE_MANAGER_ORDER.indexOf(a);
  const rightIndex = PACKAGE_MANAGER_ORDER.indexOf(b);
  if (leftIndex === -1 && rightIndex === -1) return a.localeCompare(b);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
}

export function SystemForm({
  initial,
  systemId,
  sourceSystemId,
  onSubmit,
  onCancel,
  loading = false,
}: {
  initial?: Omit<Partial<SystemFormData>, "autoHideKeptBackUpdates"> & {
    detectedPkgManagers?: string[] | null;
    disabledPkgManagers?: string[] | null;
    pkgManagerConfigs?: PackageManagerConfigs | null;
    autoHideKeptBackUpdates?: number;
    approvedHostKey?: string | null;
    trustedHostKeyFingerprintSha256?: string | null;
    hostKeyStatus?: HostKeyStatus;
    scriptOverrides?: Record<string, string>;
  };
  systemId?: number;
  sourceSystemId?: number;
  onSubmit: (data: SystemFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const testConnection = useTestConnection();
  const revokeHostKey = useRevokeHostKey();
  const createCredential = useCreateCredential();
  const { data: allCredentials } = useCredentials();
  const { data: allSystems } = useSystems();
  const { data: scriptsData } = useScripts();
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
  const [hidden, setHidden] = useState(initial?.hidden === true);
  const [scriptOverrides, setScriptOverrides] = useState<Record<string, string>>(
    initial?.scriptOverrides ?? {}
  );
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
  const [hostKeyStatus, setHostKeyStatus] = useState<HostKeyStatus>(
    initial?.hostKeyStatus ?? (initial?.approvedHostKey ? "verified" : "needs_approval")
  );
  const [showUnapprovedSaveWarning, setShowUnapprovedSaveWarning] = useState(false);
  const [showCreateCredential, setShowCreateCredential] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);

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
    setHostKeyStatus(
      initial?.hostKeyStatus ?? (initial?.approvedHostKey ? "verified" : "needs_approval")
    );
  }, [initial?.approvedHostKey, initial?.trustedHostKeyFingerprintSha256, initial?.hostKeyStatus]);

  useEffect(() => {
    if (hostname !== (initial?.hostname || "") || port !== (initial?.port || 22)) {
      setApprovedHostKey(null);
      setApprovedHostKeyFingerprint(null);
      setHostKeyStatus(hostKeyVerificationEnabled ? "needs_approval" : "verification_disabled");
    }
  }, [hostname, port, initial?.hostname, initial?.port, hostKeyVerificationEnabled]);

  useEffect(() => {
    setHostKeyStatus((prev) => {
      if (!hostKeyVerificationEnabled) return "verification_disabled";
      if (prev === "verification_disabled") {
        return approvedHostKey ? "verified" : "needs_approval";
      }
      return prev;
    });
  }, [hostKeyVerificationEnabled, approvedHostKey]);

  const customPackageManagers = scriptsData?.packageManagers ?? [];
  const supportedPackageManagerNames = new Set([
    ...PACKAGE_MANAGER_ORDER,
    ...customPackageManagers.map((manager) => manager.name),
  ]);
  const customPackageManagerNames = new Set(
    customPackageManagers
      .filter((manager) => !manager.builtin)
      .map((manager) => manager.name),
  );
  const shouldShowManager = (manager: string) => {
    if (!supportedPackageManagerNames.has(manager)) return false;
    return !customPackageManagerNames.has(manager) || detectedManagers.includes(manager);
  };
  const isManagerEnabled = (manager: string) => {
    if (customPackageManagerNames.has(manager) && !detectedManagers.includes(manager)) {
      return false;
    }
    return !disabledManagers.has(manager);
  };

  const toggleManager = (manager: string) => {
    const enabled = isManagerEnabled(manager);
    setDisabledManagers((prev) => {
      const next = new Set(prev);
      if (enabled) {
        next.add(manager);
      } else {
        next.delete(manager);
      }
      return next;
    });
    if (enabled) {
      setScriptOverrides((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${manager}/`)) delete next[key];
        }
        return next;
      });
    }
    if (customPackageManagerNames.has(manager) && !enabled) {
      setDetectedManagers((prev) => (
        prev.includes(manager) ? prev : [...prev, manager]
      ));
    }
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

  const setCustomManagerConfigValue = (manager: string, key: string, value: string) => {
    setPkgManagerConfigs((prev) => {
      const current = prev[manager] && typeof prev[manager] === "object" && !Array.isArray(prev[manager])
        ? prev[manager] as CustomPackageManagerConfig
        : {};
      return {
        ...prev,
        [manager]: {
          ...current,
          [key]: value,
        },
      };
    });
  };

  const packageManagerConfigsWithCustomDefaults = (): PackageManagerConfigs => {
    const next: PackageManagerConfigs = { ...pkgManagerConfigs };
    for (const manager of customPackageManagers) {
      if (!visiblePackageManagers.includes(manager.name)) continue;
      if (!isManagerEnabled(manager.name) || manager.configEntries.length === 0) continue;
      const current = next[manager.name] && typeof next[manager.name] === "object" && !Array.isArray(next[manager.name])
        ? next[manager.name] as CustomPackageManagerConfig
        : {};
      next[manager.name] = Object.fromEntries(
        manager.configEntries.map((entry) => [
          entry.key,
          current[entry.key] ?? current[getLegacyCustomConfigKey(manager.name, entry.key)] ?? entry.defaultValue,
        ]),
      );
    }
    return next;
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

    const activeScriptOverrides = Object.fromEntries(
      Object.entries(scriptOverrides).filter(([key]) => {
        const [manager] = key.split("/");
        return manager === "system" || (
          supportedPackageManagerNames.has(manager) &&
          !disabledManagers.has(manager)
        );
      }),
    );

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
      detectedPkgManagers: detectedManagers,
      pkgManagerConfigs: normalizePackageManagerConfigs(
        packageManagerConfigsWithCustomDefaults(),
        customPackageManagers,
        false,
      ) ?? {},
      hidden,
      scriptOverrides: activeScriptOverrides,
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
      ...Object.keys(scriptOverrides)
        .map((key) => key.split("/")[0])
        .filter((manager) => manager && manager !== "system"),
    ]),
  ).filter(shouldShowManager).sort(sortPackageManagers);
  const packageManagerLabels = new Map(
    customPackageManagers.map((manager) => [manager.name, manager.label]),
  );
  const visibleScriptPackageManagers = visiblePackageManagers.filter(isManagerEnabled);
  const packageScriptOperations: ScriptOperation[] = [
    "detect",
    "check_updates",
    "list_installed_packages",
    "repair_issue",
    "autoremove",
    "upgrade_all",
    "full_upgrade_all",
    "upgrade_selected",
  ];
  const systemScriptOperations: ScriptOperation[] = ["system_info", "reboot"];
  const operationLabels = Object.fromEntries(
    Object.entries(SCRIPT_OPERATION_LABEL_KEYS).map(([operation, labelKey]) => [
      operation,
      t(labelKey),
    ]),
  ) as Record<ScriptOperation, string>;
  const compatibleScripts = (operation: ScriptOperation, pkgManager: string | null) =>
    (scriptsData?.scripts ?? []).filter(
      (script) => script.operation === operation && script.pkgManager === pkgManager,
    );
  const setScriptOverride = (operation: ScriptOperation, pkgManager: string | null, scriptId: string) => {
    const key = buildOperationKey(operation, pkgManager);
    setScriptOverrides((prev) => {
      const next = { ...prev };
      if (scriptId) next[key] = scriptId;
      else delete next[key];
      return next;
    });
  };

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
          if (data.hostKeyChallenges?.length && data.trustChallengeToken) {
            setTestResult(null);
            setValidatedConfigToken(null);
            setHostKeyStatus("needs_approval");
            setPendingTrustChallenge({
              token: data.trustChallengeToken,
              challenges: data.hostKeyChallenges,
            });
            return;
          }

          setTestResult({
            success: data.success,
            message: data.message,
            debugRef: data.debugRef,
          });
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
              setHostKeyStatus("verified");
            }
          }
          if (!data.success && isHostKeyErrorMessage(data.message)) {
            setHostKeyStatus("needs_approval");
          } else if (data.success && hostKeyVerificationEnabled) {
            setHostKeyStatus(approvedHostKey || extra?.approvedHostKeys?.length ? "verified" : hostKeyStatus);
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
          if (isHostKeyErrorMessage(err.message)) {
            setHostKeyStatus("needs_approval");
          }
          setTestResult({ success: false, message: err.message });
        },
      }
    );
  };

  const storedHostKeyNeedsAttention =
    hostKeyVerificationEnabled &&
    approvedHostKey !== null &&
    hostKeyStatus === "needs_approval";
  const canRunConnectionTest = !testConnection.isPending && !!hostname && credentialId > 0;
  const hasPendingHostKeyReview = pendingTrustChallenge !== null;
  const needsHostKeyApproval =
    hostKeyVerificationEnabled &&
    (hostKeyStatus === "needs_approval" || !approvedHostKey);
  const approvalFlowActive =
    hostKeyVerificationEnabled && (hasPendingHostKeyReview || needsHostKeyApproval);
  const showHostKeyFetchAction =
    hostKeyVerificationEnabled && !hasPendingHostKeyReview && needsHostKeyApproval;
  const hostKeyFetchActionLabel = t("components.systemForm.reviewKey");
  const showRevokeHostKeyAction =
    !!systemId && approvedHostKey !== null && !hasPendingHostKeyReview;
  const pendingTargetChallenge = pendingTrustChallenge?.challenges.find(
    (challenge) => challenge.role === "target"
  ) ?? null;
  const pendingReviewShowsMultipleHosts =
    (pendingTrustChallenge?.challenges.length ?? 0) > 1;
  const pendingChallengeCount = pendingTrustChallenge?.challenges.length ?? 0;
  const pendingTargetFingerprint = pendingTargetChallenge?.fingerprintSha256 ?? null;
  const fetchedHostKeyDiffersFromApproved =
    storedHostKeyNeedsAttention &&
    approvedHostKeyFingerprint !== null &&
    pendingTargetFingerprint !== null &&
    approvedHostKeyFingerprint !== pendingTargetFingerprint;
  const footerConnectionTestDisabled =
    !canRunConnectionTest || approvalFlowActive;
  const footerConnectionTestTitle = approvalFlowActive
    ? t("components.systemForm.completeSshHostKeyApprovalBeforeConnectionTest")
    : undefined;

  const hostKeySummary = approvedHostKey
    ? hasPendingHostKeyReview
      ? ""
      : storedHostKeyNeedsAttention
        ? t("components.systemForm.storedApprovalNoLongerMatchesHost")
        : systemId
          ? t("components.systemForm.approvedHostKeyStoredForSystem")
          : t("components.systemForm.approvedHostKeyWillBeSaved")
    : hasPendingHostKeyReview
      ? ""
      : t("components.systemForm.noApprovedHostKeyStored");

  const handleCreateCredential = (data: {
    name: string;
    kind: CredentialKind;
    payload: Record<string, string>;
  }) => {
    createCredential.mutate(data, {
      onSuccess: (result) => {
        setCredentialId(result.id);
        setShowCreateCredential(false);
        addToast(t("components.systemForm.credentialCreated"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>{t("components.systemForm.displayName")}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} placeholder={t("components.systemForm.myServer")} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelClass}>{t("components.systemForm.hostnameIp")}</label>
            <input type="text" value={hostname} onChange={(e) => setHostname(e.target.value)} required className={inputClass} placeholder="192.168.1.100" />
          </div>
          <div>
            <label className={labelClass}>{t("components.systemForm.sshPort")}</label>
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
          <label className={labelClass}>{t("components.systemForm.sshCredential")}</label>
          <div className="flex items-center gap-3">
            <select
              value={credentialId || ""}
              onChange={(e) => setCredentialId(Number(e.target.value))}
              required
              className={`${inputClass} flex-1`}
            >
              <option value="" disabled>
                {credentials.length > 0
                  ? t("components.systemForm.selectCredential")
                  : t("components.systemForm.createCredentialToContinue")}
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
              {t("components.systemForm.newCredential")}
            </button>
          </div>
          {credentials.length === 0 && (
            <div className="mt-2 rounded-lg border border-dashed border-border bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              {t("components.systemForm.noSshCredentialsAvailable")}
            </div>
          )}
        </div>

        <div>
          <label className={labelClass}>{t("components.systemForm.proxyJumpSystem")}</label>
          <select
            value={proxyJumpSystemId || ""}
            onChange={(e) => setProxyJumpSystemId(e.target.value ? Number(e.target.value) : null)}
            className={inputClass}
          >
            <option value="">{t("components.systemForm.directConnection")}</option>
            {availableSystems.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-1">
            {t("components.systemForm.proxyJumpDescription")}
          </p>
        </div>

        {showsProxyJumpLoopbackWarning && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            {t("components.systemForm.proxyJumpLoopbackPrefix")} <span className="font-mono">{hostname || "localhost"}</span> {t("components.systemForm.proxyJumpLoopbackMiddle")}
            {selectedProxyJumpSystem ? ` ${selectedProxyJumpSystem.name}` : ` ${t("components.systemForm.theJumpHost")}`}.
            {t("components.systemForm.proxyJumpLoopbackSuffix")}
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
              {t("components.systemForm.verifySshHostKey")}
            </span>
            <span className="block text-xs text-slate-400 mt-0.5">
              {t("components.systemForm.verifySshHostKeyDescription")}
            </span>
          </span>
        </label>

        {!hostKeyVerificationEnabled && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            {t("components.systemForm.hostKeyVerificationDisabledWarning")}
          </div>
        )}

        {hostKeyVerificationEnabled && (
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {t("components.systemForm.sshHostKeyApproval")}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {hostKeySummary}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 sm:shrink-0">
                {storedHostKeyNeedsAttention ? (
                  <Badge variant="warning" small>{getHostKeyStatusBadgeLabel("needs_approval")}</Badge>
                ) : approvedHostKey ? (
                  <Badge variant="success" small>{getHostKeyStatusBadgeLabel("verified")}</Badge>
                ) : (
                  <Badge variant="warning" small>{getHostKeyStatusBadgeLabel("needs_approval")}</Badge>
                )}
              {hasPendingHostKeyReview && pendingReviewShowsMultipleHosts && (
                <Badge variant="muted" small>{`${pendingChallengeCount}\u00A0keys`}</Badge>
              )}
              {showRevokeHostKeyAction && (
                <button
                  type="button"
                  onClick={() => {
                    revokeHostKey.mutate(systemId, {
                      onSuccess: () => {
                        setApprovedHostKey(null);
                        setApprovedHostKeyFingerprint(null);
                        setHostKeyStatus("needs_approval");
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
                  {revokeHostKey.isPending ? t("components.systemForm.revoking") : t("components.systemForm.revoke")}
                </button>
              )}
              {showHostKeyFetchAction && (
                <button
                  type="button"
                  onClick={() => runConnectionTest()}
                  disabled={!canRunConnectionTest}
                  className="whitespace-nowrap px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                >
                  {testConnection.isPending ? t("common.checking") : hostKeyFetchActionLabel}
                </button>
              )}
              </div>
            </div>
            {storedHostKeyNeedsAttention && !hasPendingHostKeyReview && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {t("components.systemForm.storedSshHostKeyNoLongerMatches")}
              </div>
            )}
            {hasPendingHostKeyReview ? (
              <div className="space-y-4">
                <div className="text-sm text-slate-600 dark:text-slate-300">
                  {pendingReviewShowsMultipleHosts
                    ? t("components.systemForm.reviewAllFetchedHostKeys", { count: pendingChallengeCount })
                    : fetchedHostKeyDiffersFromApproved
                    ? t("components.systemForm.hostPresentedDifferentKey")
                    : t("components.systemForm.reviewFetchedHostKey")}
                </div>
                {fetchedHostKeyDiffersFromApproved && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    <div className="font-medium">{t("components.systemForm.approvedHostKeyDoesNotMatchCurrent")}</div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">{t("components.systemForm.approvedFingerprint")}</div>
                        <div className="mt-1 font-mono text-xs break-all">{approvedHostKeyFingerprint}</div>
                      </div>
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">{t("components.systemForm.currentFingerprint")}</div>
                        <div className="mt-1 font-mono text-xs break-all">{pendingTargetFingerprint}</div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="space-y-3">
                  {pendingTrustChallenge.challenges.map((challenge, index) => (
                    <div key={`${challenge.role}-${challenge.host}-${challenge.port}-${challenge.fingerprintSha256}`} className="rounded-lg border border-border p-3 text-sm">
                      {pendingReviewShowsMultipleHosts && (
                        <>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                {t("components.systemForm.indexOfCount", { index: index + 1, count: pendingChallengeCount })}
                              </div>
                              <div className="mt-1 font-medium text-slate-800 dark:text-slate-100">
                                {getChallengeSystemName(challenge.systemId) ?? `${challenge.host}:${challenge.port}`}
                              </div>
                            </div>
                            <Badge variant={challenge.role === "target" ? "info" : "muted"} small>
                              {challenge.role === "target" ? t("components.systemForm.target") : t("components.systemForm.jump")}
                            </Badge>
                          </div>
                          <div className="mt-1 text-slate-500 dark:text-slate-400">
                            {challenge.host}:{challenge.port}
                          </div>
                        </>
                      )}
                      {!pendingReviewShowsMultipleHosts && (
                        <div className="text-sm text-slate-600 dark:text-slate-300">
                          {t("components.systemForm.reviewingRoleHostKey", { role: challenge.role === "target" ? t("components.systemForm.targetLower") : t("components.systemForm.jumpLower") })}
                          {getChallengeSystemName(challenge.systemId) ? ` ${t("components.systemForm.forName", { name: getChallengeSystemName(challenge.systemId) })}` : ""}
                          <span className="text-slate-500 dark:text-slate-400"> ({challenge.host}:{challenge.port})</span>
                        </div>
                      )}
                      <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 break-all">
                        {t("components.systemForm.fingerprint")}: <span className="font-mono">{challenge.fingerprintSha256}</span>
                      </div>
                      <pre className="mt-3 text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                        {`${challenge.algorithm} ${challenge.rawKey}`}
                      </pre>
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
                    {t("components.systemForm.discard")}
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
                    {testConnection.isPending ? <span className="spinner spinner-sm" /> : t("components.systemForm.approve")}
                  </button>
                </div>
              </div>
            ) : approvedHostKey ? (
              <>
                <div className="text-xs text-slate-500 dark:text-slate-400 break-all">
                  {t("components.systemForm.fingerprint")}: <span className="font-mono">{approvedHostKeyFingerprint}</span>
                </div>
                <pre className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                  {approvedHostKey}
                </pre>
              </>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-slate-500 dark:text-slate-400 break-all">
                  {t("components.systemForm.approvedFingerprint")}: <span className="font-mono">{t("components.systemForm.notApprovedYet")}</span>
                </div>
                <div className="rounded-lg bg-slate-900 p-3 text-xs text-slate-400">
                  <div className="font-mono">{t("components.systemForm.noApprovedSshHostKeyStored")}</div>
                  <div className="mt-2">
                    {t("components.systemForm.fetchCurrentHostKeyDescription")}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label className={labelClass}>{t("components.systemForm.sudoPasswordOptional")}</label>
          <input
            type="password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            className={inputClass}
            placeholder={sourceSystemId ? t("components.systemForm.fromSourceSystem") : initial ? t("components.systemForm.unchangedDefaultsToSshPassword") : t("components.systemForm.defaultsToSshPassword")}
          />
          <p className="text-xs text-slate-400 mt-1">{t("components.systemForm.sudoPasswordHelp")}</p>
        </div>

        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className="rounded mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-slate-700 dark:text-slate-200">
              {t("components.systemForm.hideFromDashboard")}
            </span>
            <span className="block text-xs text-slate-400 mt-0.5">
              {t("components.systemForm.hideFromDashboardDescription")}
            </span>
          </span>
        </label>

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
              const enabled = isManagerEnabled(manager);
              const title = PACKAGE_MANAGER_LABELS[manager] ?? packageManagerLabels.get(manager) ?? manager;
              const customManager = customPackageManagers.find((entry) => entry.name === manager);
              const customConfigEntries = customManager?.configEntries ?? [];
              const hasExtraSettings =
                (SUPPORTED_PACKAGE_MANAGER_CONFIGS as readonly string[]).includes(manager) ||
                customConfigEntries.length > 0;

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
                            {t("components.systemForm.autoHideKeptBackPackages")}
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            {t("components.systemForm.autoHideKeptBackPackagesDescription")}
                          </span>
                        </span>
                      </label>
                    </>
                  )}

                  {manager === "dnf" && (
                    <>
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
                            {t("components.systemForm.refreshMetadataDuringChecks")}
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            {t("components.systemForm.refreshMetadataDuringChecksDescription")}
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.dnf?.autoAcceptNewSigningKeysOnCheck === true}
                          onChange={(e) =>
                            setManagerConfig("dnf", {
                              ...pkgManagerConfigs.dnf,
                              autoAcceptNewSigningKeysOnCheck: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Allow automatic acceptance of new repository signing keys during update checks
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Disabled by default. Enable only if you trust the configured repositories and want unattended checks to import newly presented signing keys.
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.dnf?.autoAcceptEulaOnUpgrade === true}
                          onChange={(e) =>
                            setManagerConfig("dnf", {
                              ...pkgManagerConfigs.dnf,
                              autoAcceptEulaOnUpgrade: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Allow automatic EULA acceptance during upgrades
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Prepends `ACCEPT_EULA=Y` to DNF upgrade commands for packages that require unattended license acceptance, such as `msodbcsql18`.
                          </span>
                        </span>
                      </label>
                    </>
                  )}

                  {manager === "yum" && (
                    <>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.yum?.autoAcceptNewSigningKeysOnCheck === true}
                          onChange={(e) =>
                            setManagerConfig("yum", {
                              ...pkgManagerConfigs.yum,
                              autoAcceptNewSigningKeysOnCheck: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Allow automatic acceptance of new repository signing keys during update checks
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Disabled by default. Enable only if you trust the configured repositories and want unattended checks to import newly presented signing keys.
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-3 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pkgManagerConfigs.yum?.autoAcceptEulaOnUpgrade === true}
                          onChange={(e) =>
                            setManagerConfig("yum", {
                              ...pkgManagerConfigs.yum,
                              autoAcceptEulaOnUpgrade: e.target.checked,
                            })
                          }
                          className="rounded mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-slate-700 dark:text-slate-200">
                            Allow automatic EULA acceptance during upgrades
                          </span>
                          <span className="block text-xs text-slate-400 mt-0.5">
                            Prepends `ACCEPT_EULA=Y` to YUM upgrade commands for packages that require unattended license acceptance, such as `msodbcsql18`.
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
                          {t("components.systemForm.refreshPackageDatabasesDuringChecks")}
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          {t("components.systemForm.refreshPackageDatabasesDuringChecksDescription")}
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
                          {t("components.systemForm.refreshPackageIndexesDuringChecks")}
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          {t("components.systemForm.refreshPackageIndexesDuringChecksDescription")}
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
                          {t("components.systemForm.refreshAppstreamDataDuringChecks")}
                        </span>
                        <span className="block text-xs text-slate-400 mt-0.5">
                          {t("components.systemForm.refreshAppstreamDataDuringChecksDescription")}
                        </span>
                      </span>
                    </label>
                  )}

                  {customConfigEntries.length > 0 && (
                    <div className="space-y-3">
                      {customConfigEntries.map((entry) => {
                        const config = pkgManagerConfigs[manager] && typeof pkgManagerConfigs[manager] === "object" && !Array.isArray(pkgManagerConfigs[manager])
                          ? pkgManagerConfigs[manager] as CustomPackageManagerConfig
                          : {};
                        return (
                          <div key={entry.key}>
                            <label className={labelClass}>{entry.key}</label>
                            <input
                              value={config[entry.key] ?? config[getLegacyCustomConfigKey(manager, entry.key)] ?? entry.defaultValue}
                              onChange={(e) => setCustomManagerConfigValue(manager, entry.key, e.target.value)}
                              className={inputClass}
                            />
                            {entry.description && (
                              <p className="mt-1 text-xs text-slate-400">
                                {entry.description}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
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

        {(scriptsData?.scripts.length ?? 0) > 0 && (
          <section className="space-y-4 rounded-lg border border-border p-3">
            <button
              type="button"
              aria-expanded={scriptsOpen}
              aria-controls="system-script-overrides"
              onClick={() => setScriptsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Scripts
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Optional overrides; Standard uses the detected package manager defaults.
                </p>
              </div>
              <svg
                className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${scriptsOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {scriptsOpen && (
              <div id="system-script-overrides" className="space-y-4">
                <div className="rounded-lg border border-border p-3 space-y-3">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {t("components.systemForm.systemOperations")}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {systemScriptOperations.map((operation) => {
                      const key = buildOperationKey(operation, null);
                      const options = compatibleScripts(operation, null);
                      return (
                        <div key={key}>
                          <label className={labelClass}>{operationLabels[operation]}</label>
                          <select
                            value={scriptOverrides[key] ?? ""}
                            onChange={(e) => setScriptOverride(operation, null, e.target.value)}
                            className={inputClass}
                          >
                            <option value="">{t("common.standard")}</option>
                            {options.map((script) => (
                              <option key={script.id} value={script.id}>
                                {script.name}{script.readonly ? ` (${t("pages.scripts.builtIn2")})` : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {visibleScriptPackageManagers.map((manager) => (
                  <div key={`scripts-${manager}`} className="rounded-lg border border-border p-3 space-y-3">
                    <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {PACKAGE_MANAGER_LABELS[manager] ?? packageManagerLabels.get(manager) ?? manager}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {packageScriptOperations.map((operation) => {
                        const key = buildOperationKey(operation, manager);
                        const options = compatibleScripts(operation, manager);
                        if (options.length === 0 && !scriptOverrides[key]) return null;
                        return (
                          <div key={key}>
                            <label className={labelClass}>{operationLabels[operation]}</label>
                            <select
                              value={scriptOverrides[key] ?? ""}
                              onChange={(e) => setScriptOverride(operation, manager, e.target.value)}
                              className={inputClass}
                            >
                              <option value="">{t("common.standard")}</option>
                              {options.map((script) => (
                                <option key={script.id} value={script.id}>
                                  {script.name}{script.readonly ? ` (${t("pages.scripts.builtIn2")})` : ""}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

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

        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="min-w-0">
            <button
              type="button"
              disabled={footerConnectionTestDisabled}
              title={footerConnectionTestTitle}
              onClick={() => runConnectionTest()}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {testConnection.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                t("components.systemForm.testConnection")
              )}
            </button>
            <p className="mt-1 text-xs text-slate-400">
              {t("components.systemForm.testConnectionDescription")}
            </p>
          </div>

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
              {loading ? <span className="spinner spinner-sm" /> : t("common.save")}
            </button>
          </div>
        </div>
      </form>

      <Modal
        open={showCreateCredential}
        onClose={() => setShowCreateCredential(false)}
        title={t("pages.credentials.addCredential")}
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
        title={t("components.systemForm.saveWithoutHostKeyApproval")}
        message={t("components.systemForm.saveWithoutHostKeyApprovalMessage")}
        confirmLabel={t("components.systemForm.saveAnyway")}
      />
    </>
  );
}
