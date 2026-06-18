import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import i18next from "i18next";
import {
  buildActivityDisplayRows,
  dedupePackageIssueUpdateNotice,
  getActivityTitle,
  getAutoremoveConfirmMessage,
  getPackageSelectionState,
  filterInstalledPackages,
  formatOsLifecycleField,
  InstalledPackagesSection,
  getVisiblePackageIssuesForCurrentCheck,
  HostKeyVerificationBanner,
  isScrollNearBottom,
  matchesHistoryEntryToSession,
  PackageManagerIssueBanner,
  RootUserInfoBanner,
  shouldShowRootUserInfoBanner,
  toggleSelectedPackageName,
  resolveCurrentActivitySession,
  shouldShowAutoremoveAction,
  getOperationNoticeState,
  OperationNoticeBanner,
  OsLifecycleWarningBanner,
} from "../../client/pages/SystemDetail";
import { SudoersSetupPanel } from "../../client/components/systems/SudoersSetupPanel";
import type { ActiveOperation, HistoryEntry, PackageManagerIssue } from "../../client/lib/systems";
import type { WsMessage } from "../../client/hooks/useCommandOutput";

function createHistoryEntry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "action" | "pkgManager" | "status" | "startedAt">): HistoryEntry {
  return {
    systemId: 1,
    packageCount: null,
    packages: null,
    packagesList: [],
    command: null,
    steps: null,
    output: null,
    error: null,
    completedAt: null,
    ...overrides,
  };
}

describe("autoremove action", () => {
  test("shows whenever a manager is supported and names skipped managers in the confirmation", () => {
    const support = {
      supportedManagers: ["apt", "flatpak"],
      skippedManagers: ["snap"],
    };

    expect(shouldShowAutoremoveAction(support)).toBe(true);
    expect(getAutoremoveConfirmMessage("Debian", support)).toContain("Will run for: apt, flatpak.");
    expect(getAutoremoveConfirmMessage("Debian", support)).toContain("configured: snap.");
    expect(shouldShowAutoremoveAction({ supportedManagers: [] })).toBe(false);
  });
});

describe("OS lifecycle presentation", () => {
  test("uses the security support date before Debian enters LTS", () => {
    expect(formatOsLifecycleField({
      osLifecycleStatus: "supported",
      osLifecycleEolDate: "2030-06-30",
      osLifecycleDaysUntilEol: 1475,
      osLifecycleSupportEndDate: "2028-08-09",
      osLifecycleDaysUntilSupportEnd: 785,
      osLifecycleLabel: "Debian 13 security support until 2028-08-09; LTS until 2030-06-30",
    })).toBe("Security support until 2028-08-09; LTS until 2030-06-30");
  });

  test("uses the final LTS date after regular Debian security support ends", () => {
    expect(formatOsLifecycleField({
      osLifecycleStatus: "support_ended",
      osLifecycleEolDate: "2028-06-30",
      osLifecycleDaysUntilEol: 744,
      osLifecycleSupportEndDate: "2026-07-11",
      osLifecycleDaysUntilSupportEnd: -6,
      osLifecycleLabel: "Debian 12 is in LTS until 2028-06-30",
    })).toBe("LTS until 2028-06-30");
  });

  test("includes both security support and LTS dates in upcoming support warnings", () => {
    const html = renderToStaticMarkup(createElement(OsLifecycleWarningBanner, {
      systemName: "Alpha",
      status: "support_ending",
      label: "Debian 13 security support ends in 30 days; LTS until 2030-06-30",
      eolDate: "2030-06-30",
      daysUntilEol: 1461,
      supportEndDate: "2028-08-09",
      daysUntilSupportEnd: 30,
      onDismiss: () => {},
    }));

    expect(html).toContain("regular security support ends on 2028-08-09");
    expect(html).toContain("LTS runs until 2030-06-30");
  });

  test("translates the lifecycle warning title instead of showing the server label", async () => {
    await i18next.changeLanguage("zh");
    let html = "";
    try {
      html = renderToStaticMarkup(createElement(OsLifecycleWarningBanner, {
        systemName: "Test FISH (Sudo)",
        status: "support_ending",
        label: "Debian 12 security support ends in 23 days; LTS until 2028-06-30",
        eolDate: "2028-06-30",
        daysUntilEol: 737,
        supportEndDate: "2026-07-11",
        daysUntilSupportEnd: 23,
        onDismiss: () => {},
      }));
    } finally {
      await i18next.changeLanguage("en");
    }

    expect(html).toContain("安全支持于 2026-07-11 结束（23 天）");
    expect(html).toContain("LTS 持续至 2028-06-30");
    expect(html).not.toContain("Debian 12 security support ends in 23 days");
  });
});

describe("RootUserInfoBanner", () => {
  test("renders as an informational notice with sudoers and dismiss actions", () => {
    const html = renderToStaticMarkup(createElement(RootUserInfoBanner, {
      systemName: "Debian",
      onOpenSudoers: () => {},
      onDismiss: () => {},
    }));

    expect(html).toContain("Least-privilege user recommended");
    expect(html).toContain("connects as");
    expect(html).toContain("root");
    expect(html).toContain("Sudoers Setup");
    expect(html).toContain("Dismiss");
    expect(html).toContain("bg-blue-50");
    expect(html).not.toContain("bg-amber-50");
    expect(html).not.toContain("bg-red-50");
  });

  test("reappears after a host key fingerprint change", () => {
    expect(shouldShowRootUserInfoBanner({
      username: "testuser",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 0,
      rootUserBannerDismissedHostKeyFingerprintSha256: null,
      trustedHostKeyFingerprintSha256: "SHA256:current",
    })).toBe(false);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 0,
      rootUserBannerDismissedHostKeyFingerprintSha256: null,
      trustedHostKeyFingerprintSha256: "SHA256:current",
    })).toBe(true);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256: "SHA256:current",
      trustedHostKeyFingerprintSha256: "SHA256:current",
    })).toBe(false);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256: "SHA256:old",
      trustedHostKeyFingerprintSha256: "SHA256:new",
    })).toBe(true);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256: "SHA256:old",
      trustedHostKeyFingerprintSha256: null,
    })).toBe(false);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256: null,
      trustedHostKeyFingerprintSha256: null,
    })).toBe(false);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 1,
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256: "SHA256:old",
      trustedHostKeyFingerprintSha256: null,
    })).toBe(false);

    expect(shouldShowRootUserInfoBanner({
      username: "root",
      hostKeyVerificationEnabled: 0,
      rootUserBannerDismissed: 0,
      rootUserBannerDismissedHostKeyFingerprintSha256: null,
      trustedHostKeyFingerprintSha256: null,
    })).toBe(true);
  });
});

describe("HostKeyVerificationBanner", () => {
  test("renders host-key approval guidance with a configuration action", () => {
    const html = renderToStaticMarkup(createElement(HostKeyVerificationBanner, {
      systemName: "Debian",
      onOpenConfiguration: () => {},
    }));

    expect(html).toContain("SSH host-key approval required");
    expect(html).toContain("Debian needs its SSH host key reviewed");
    expect(html).toContain("Open Configuration");
    expect(html).toContain("bg-amber-50");
  });
});

describe("OperationNoticeBanner", () => {
  test("renders generic update-check failures as a page-level banner", () => {
    const html = renderToStaticMarkup(createElement(OperationNoticeBanner, {
      state: {
        kind: "check_failed",
        title: "Update check failed",
        message: "The latest update check did not complete, so the package list may be unavailable.",
        error: "Error: All configured authentication methods failed",
      },
    }));

    expect(html).toContain("Update check failed");
    expect(html).toContain("All configured authentication methods failed");
    expect(html).toContain("mb-6");
    expect(html).toContain("bg-red-50");
    expect(html).not.toContain("mx-4");
  });

  test("renders failed upgrade activity as the same page-level banner", () => {
    const state = getOperationNoticeState(createHistoryEntry({
      id: 3,
      action: "upgrade_all",
      pkgManager: "apt",
      status: "failed",
      error: "E: Could not get lock /var/lib/dpkg/lock-frontend",
      startedAt: "2026-05-18 10:00:00",
      completedAt: "2026-05-18 10:00:02",
    }), 0);
    const html = renderToStaticMarkup(createElement(OperationNoticeBanner, { state }));

    expect(state).toMatchObject({
      kind: "operation_failed",
      title: "Upgrade failed",
      error: "E: Could not get lock /var/lib/dpkg/lock-frontend",
    });
    expect(html).toContain("Upgrade failed");
    expect(html).toContain("Could not get lock");
    expect(html).toContain("mb-6");
    expect(html).toContain("max-h-64 overflow-x-auto overflow-y-auto");
    expect(html).toContain("break-all");
  });

  test("does not produce a banner state for a latest successful operation", () => {
    expect(getOperationNoticeState(createHistoryEntry({
      id: 4,
      action: "reboot",
      pkgManager: "system",
      status: "success",
      error: "older checks may have failed, but this row is current",
      startedAt: "2026-05-18 11:00:00",
      completedAt: "2026-05-18 11:00:10",
    }), 0)).toBeNull();
  });
});

describe("buildActivityDisplayRows", () => {
  test("creates a refresh session immediately from a check action hint", () => {
    const olderHistory = [
      createHistoryEntry({
        id: 1,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 0,
        startedAt: "2026-03-25 10:00:00",
        completedAt: "2026-03-25 10:00:05",
      }),
    ];
    const liveMessages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-25 11:00:01" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
    ];

    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-1",
      history: olderHistory,
      activeOp: null,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const rows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp: null,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(session?.key).toBe("activity-current-1");
    expect(rows[0]?.key).toBe("activity-current-1");
    expect(rows[0]?.historyId).toBeNull();
    expect(rows[0]?.isRunning).toBe(true);
  });

  test("marks the current activity as connecting before the first command starts", () => {
    const activeOp: ActiveOperation = {
      type: "check",
      startedAt: "2026-03-25 11:00:00",
    };
    const messages: WsMessage[] = [
      { type: "started", command: "", pkgManager: "system", startedAt: "2026-03-25 11:00:00" },
      { type: "phase", phase: "Connect over SSH" },
    ];
    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-connecting",
      history: [],
      activeOp,
      actionHint: "check",
      messages,
      isCommandActive: true,
      pendingTransition: true,
    });

    const rows = buildActivityDisplayRows({
      history: [],
      activeOp,
      messages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows[0]?.isConnecting).toBe(true);
    expect(rows[0]?.isRunning).toBe(true);
    expect(rows[0]?.liveSteps[0]).toMatchObject({
      label: "Connect over SSH",
      command: "",
      status: "started",
    });
  });

  test("keeps the same key from the first live render through the final history handoff", () => {
    const olderHistory = [
      createHistoryEntry({
        id: 4,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-25 20:30:00",
        completedAt: "2026-03-25 20:31:00",
      }),
    ];
    const activeOp: ActiveOperation = {
      type: "check",
      startedAt: "2026-03-25 21:00:00",
    };
    const liveMessages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-25 21:00:01" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
    ];
    const finishedMessages: WsMessage[] = [
      ...liveMessages,
      { type: "done", success: true, completedAt: "2026-03-25 21:00:04" },
    ];
    const startedHistory = [
      createHistoryEntry({
        id: 12,
        action: "check",
        pkgManager: "apt",
        status: "started",
        command: "apt-get update",
        startedAt: "2026-03-25 21:00:01",
      }),
      ...olderHistory,
    ];
    const finalHistory = [
      createHistoryEntry({
        id: 14,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 3,
        command: "apt-get update",
        startedAt: "2026-03-25 21:00:01",
        completedAt: "2026-03-25 21:00:04",
      }),
      ...olderHistory,
    ];

    let nextSessionId = 0;
    const nextSessionKey = () => `activity-current-${++nextSessionId}`;

    const firstSession = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey,
      history: olderHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const secondSession = resolveCurrentActivitySession({
      previousSession: firstSession,
      nextSessionKey,
      history: olderHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const startedSession = resolveCurrentActivitySession({
      previousSession: secondSession,
      nextSessionKey,
      history: startedHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const finalSession = resolveCurrentActivitySession({
      previousSession: startedSession,
      nextSessionKey,
      history: finalHistory,
      activeOp: null,
      actionHint: "check",
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: true,
    });
    const settledSession = resolveCurrentActivitySession({
      previousSession: finalSession,
      nextSessionKey,
      history: finalHistory,
      activeOp: null,
      actionHint: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: false,
    });

    const firstRows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: firstSession,
    });
    const secondRows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: secondSession,
    });
    const startedRows = buildActivityDisplayRows({
      history: startedHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: startedSession,
    });
    const finalRows = buildActivityDisplayRows({
      history: finalHistory,
      activeOp: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: true,
      currentSession: finalSession,
    });
    const settledRows = buildActivityDisplayRows({
      history: finalHistory,
      activeOp: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: false,
      currentSession: settledSession,
    });

    expect(firstSession?.key).toBe("activity-current-1");
    expect(secondSession?.key).toBe("activity-current-1");
    expect(startedSession?.key).toBe("activity-current-1");
    expect(finalSession?.key).toBe("activity-current-1");
    expect(settledSession?.key).toBe("activity-current-1");
    expect(firstRows[0]?.historyId).toBeNull();
    expect(startedRows[0]?.historyId).toBe(12);
    expect(finalRows[0]?.historyId).toBe(14);
    expect(firstRows[0]?.key).toBe("activity-current-1");
    expect(secondRows[0]?.key).toBe("activity-current-1");
    expect(startedRows[0]?.key).toBe("activity-current-1");
    expect(finalRows[0]?.key).toBe("activity-current-1");
    expect(settledRows[0]?.key).toBe("activity-current-1");
    expect(startedRows.filter((row) => row.historyId === 12)).toHaveLength(1);
    expect(finalRows.filter((row) => row.historyId === 14)).toHaveLength(1);
  });

  test("keeps a running DB-backed row single and uses live step details", () => {
    const history = [
      createHistoryEntry({
        id: 12,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "started",
        command: "apt-get upgrade -y",
        startedAt: "2026-03-25 20:00:00",
      }),
      createHistoryEntry({
        id: 8,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 0,
        startedAt: "2026-03-25 19:00:00",
        completedAt: "2026-03-25 19:00:05",
      }),
    ];
    const activeOp: ActiveOperation = {
      type: "upgrade_all",
      startedAt: "2026-03-25 19:59:59",
    };
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get upgrade -y", pkgManager: "apt", startedAt: "2026-03-25 20:00:00" },
      { type: "output", data: "Reading package lists...\n", stream: "stdout" },
    ];
    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-9",
      history,
      activeOp,
      actionHint: null,
      messages,
      isCommandActive: true,
      pendingTransition: true,
    });

    const rows = buildActivityDisplayRows({
      history,
      activeOp,
      messages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.historyId).toBe(12);
    expect(rows.filter((row) => row.historyId === 12)).toHaveLength(1);
    expect(rows[0]?.isRunning).toBe(true);
    expect(rows[0]?.useLiveDetails).toBe(true);
    expect(rows[0]?.liveSteps[0]?.output).toContain("Reading package lists");
  });

  test("uses live active-operation package names for running selected-package upgrades", () => {
    const history = [
      createHistoryEntry({
        id: 12,
        action: "upgrade_package",
        pkgManager: "apt",
        status: "started",
        command: "apt-get install --only-upgrade -y curl firefox",
        startedAt: "2026-03-25 20:00:00",
      }),
    ];
    const activeOp: ActiveOperation = {
      type: "upgrade_package",
      startedAt: "2026-03-25 20:00:00",
      packageNames: ["curl", "firefox"],
      packageName: "curl",
    };
    const messages: WsMessage[] = [
      {
        type: "started",
        command: "apt-get install --only-upgrade -y curl firefox",
        pkgManager: "apt",
        startedAt: "2026-03-25 20:00:00",
      },
    ];

    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-10",
      history,
      activeOp,
      actionHint: null,
      messages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const rows = buildActivityDisplayRows({
      history,
      activeOp,
      messages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows[0]?.packagesList).toEqual(["curl", "firefox"]);
    expect(getActivityTitle(rows[0]?.action || "", rows[0]?.packagesList || [], rows[0]?.packageName)).toBe(
      "Upgraded curl, firefox"
    );
  });

  test("marks a failed live check as stopped while waiting for failed history", () => {
    const history = [
      createHistoryEntry({
        id: 4,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 0,
        startedAt: "2026-03-25 19:00:00",
        completedAt: "2026-03-25 19:00:04",
      }),
    ];
    const messages: WsMessage[] = [
      {
        type: "started",
        command: "apt-get update",
        pkgManager: "apt",
        startedAt: "2026-03-25 20:00:00",
      },
      {
        type: "error",
        message: "E: Could not get lock /var/lib/apt/lists/lock",
      },
      {
        type: "done",
        success: false,
        completedAt: "2026-03-25 20:00:02",
      },
    ];

    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-11",
      history,
      activeOp: null,
      actionHint: "check",
      messages,
      isCommandActive: false,
      pendingTransition: true,
    });
    const rows = buildActivityDisplayRows({
      history,
      activeOp: null,
      messages,
      isCommandActive: false,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows[0]?.historyId).toBeNull();
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.isRunning).toBe(false);
    expect(rows[0]?.completedAt).toBe("2026-03-25 20:00:02");
  });

  test("lets websocket completion stop a stale started history row", () => {
    const history = [
      createHistoryEntry({
        id: 12,
        action: "upgrade_package",
        pkgManager: "apt",
        status: "started",
        command: "apt-get install --only-upgrade -y jq",
        startedAt: "2026-03-25 20:00:00",
      }),
    ];
    const messages: WsMessage[] = [
      {
        type: "started",
        command: "apt-get install --only-upgrade -y jq",
        pkgManager: "apt",
        startedAt: "2026-03-25 20:00:00",
      },
      {
        type: "output",
        data: "E: Could not get lock /var/lib/apt/lists/lock\n",
        stream: "stdout",
      },
      {
        type: "error",
        message: "E: Could not get lock /var/lib/apt/lists/lock",
      },
      {
        type: "done",
        success: false,
        completedAt: "2026-03-25 20:00:03",
      },
    ];

    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-12",
      history,
      activeOp: null,
      actionHint: null,
      messages,
      isCommandActive: false,
      pendingTransition: true,
    });
    const rows = buildActivityDisplayRows({
      history,
      activeOp: null,
      messages,
      isCommandActive: false,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows[0]?.historyId).toBe(12);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.isRunning).toBe(false);
    expect(rows[0]?.useLiveDetails).toBe(true);
    expect(rows[0]?.completedAt).toBe("2026-03-25 20:00:03");
  });
});

describe("PackageManagerIssueBanner", () => {
  const issue: PackageManagerIssue = {
    id: 7,
    systemId: 1,
    pkgManager: "apt",
    issueKey: "apt_dpkg_interrupted",
    title: "APT needs repair",
    message: "dpkg was interrupted. Run dpkg --configure -a to finish pending package configuration before checking for updates again.",
    repairCommand: "dpkg --configure -a",
    active: 1,
    dismissedBootId: null,
    dismissedUptimeSeconds: null,
    dismissedAt: null,
    detectedAt: "2026-05-17 10:00:00",
    lastSeenAt: "2026-05-17 10:00:00",
    resolvedAt: null,
    createdAt: "2026-05-17 10:00:00",
    updatedAt: "2026-05-17 10:00:00",
  };

  test("renders solve and dismiss actions for visible package manager issues", () => {
    const html = renderToStaticMarkup(createElement(PackageManagerIssueBanner, {
      issues: [issue],
      onSolve: () => {},
      onDismiss: () => {},
    }));

    expect(html).toContain("APT needs repair");
    expect(html).toContain("dpkg was interrupted");
    expect(html).toContain("Solve");
    expect(html).toContain("Dismiss");
  });

  test("hides update warning when package issue banner already shows the same warning", () => {
    const state = dedupePackageIssueUpdateNotice({
      kind: "check_warning",
      title: "Update check completed with warnings",
      message: "Showing the updates that were found before one or more package manager checks failed.",
      error: `[apt] ${issue.message}`,
    }, [issue]);

    expect(state).toBeNull();
  });

  test("keeps unrelated update warning text after removing package issue duplicate", () => {
    const state = dedupePackageIssueUpdateNotice({
      kind: "check_warning",
      title: "Update check completed with warnings",
      message: "Showing the updates that were found before one or more package manager checks failed.",
      error: `[apt] ${issue.message}\n\n[flatpak] remote metadata refresh failed`,
    }, [issue]);

    expect(state).toMatchObject({
      kind: "check_warning",
      error: "[flatpak] remote metadata refresh failed",
    });
  });

  test("hides package issue actions while sudo credentials block the latest check", () => {
    expect(getVisiblePackageIssuesForCurrentCheck([issue], {
      status: "failed",
      error: "[apt] sudo: a password is required",
      startedAt: "2026-05-17 10:00:00",
      completedAt: "2026-05-17 10:00:01",
    })).toEqual([]);
  });
});

describe("SudoersSetupPanel", () => {
  test("renders a resolved file, commented wildcard guidance, install steps, and warnings", () => {
    const html = renderToStaticMarkup(createElement(SudoersSetupPanel, {
      preview: {
        username: "ludash",
        filePath: "/etc/sudoers.d/linux-update-dashboard-ludash",
        required: true,
        resolution: "resolved",
        resolutionError: null,
        content: 'Defaults:ludash !requiretty\n\nludash ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y\n\n# WARNING: Selected-package upgrades are disabled by default.\n# Uncomment only the rules you need. Each wildcard broadens the allowed command arguments.\n# ludash ALL=(root) NOPASSWD: /usr/bin/apt-get install --only-upgrade -y *',
        warnings: [
          {
            id: "custom:sudo:0",
            category: "upgrade_all",
            label: "Unsafe custom upgrade",
            pkgManager: "apt",
            message: "Runs a shell under sudo; prefer allowing the atomic command instead of a writable script or shell wrapper.",
            command: "sh /tmp/ludash-upgrade.sh",
          },
        ],
      },
    }));

    expect(html).toContain("paths resolved");
    expect(html).toContain("/etc/sudoers.d/linux-update-dashboard-ludash");
    expect(html).toContain("ludash");
    expect(html).toContain("ALL=(root)");
    expect(html).toContain("NOPASSWD:");
    expect(html).toContain("/usr/bin/apt-get");
    expect(html).toContain("upgrade -y");
    expect(html).toContain('class="sudoers-directive"');
    expect(html).toContain('class="sudoers-keyword"');
    expect(html).toContain('class="sudoers-runas"');
    expect(html).toContain('class="sudoers-tag"');
    expect(html).toContain('class="sudoers-path"');
    expect(html).toContain("WARNING: Selected-package upgrades are disabled by default.");
    expect(html).toContain("# ludash ALL=(root) NOPASSWD: /usr/bin/apt-get install --only-upgrade -y *");
    expect(html).not.toContain("Enable selected-package upgrades");
    expect(html).toContain("sudo visudo -f");
    expect(html).toContain("Commands omitted for manual review");
    expect(html).toContain("Runs a shell under sudo");
  });

  test("renders fallback and root-user guidance", () => {
    const fallbackHtml = renderToStaticMarkup(createElement(SudoersSetupPanel, {
      preview: {
        username: "ludash",
        filePath: "/etc/sudoers.d/linux-update-dashboard-ludash",
        required: true,
        resolution: "fallback",
        resolutionError: "Host is offline",
        content: "REPLACE_WITH_ABSOLUTE_PATH/apt-get",
        warnings: [],
      },
    }));
    expect(fallbackHtml).toContain("template only");
    expect(fallbackHtml).toContain("REPLACE_WITH_ABSOLUTE_PATH/apt-get");
    expect(fallbackHtml).toContain('class="sudoers-placeholder"');
    expect(fallbackHtml).not.toContain("This template is not paste-ready.");
    expect(fallbackHtml).not.toContain("Host is offline");

    const rootHtml = renderToStaticMarkup(createElement(SudoersSetupPanel, {
      preview: {
        username: "root",
        filePath: "/etc/sudoers.d/linux-update-dashboard-root",
        required: true,
        resolution: "resolved",
        resolutionError: null,
        content: 'Defaults:root !requiretty\n\nroot ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y',
        warnings: [],
      },
    }));
    expect(rootHtml).toContain("Least-privilege user recommended");
    expect(rootHtml).toContain("dedicated non-root SSH account");
    expect(rootHtml).toContain("root");
    expect(rootHtml).toContain("ALL");
    expect(rootHtml).toContain("=(root)");
    expect(rootHtml).toContain("NOPASSWD:");
    expect(rootHtml).toContain("/usr/bin/apt-get");
  });
});

describe("InstalledPackagesSection", () => {
  const packages = [
    {
      id: 1,
      systemId: 1,
      pkgManager: "apt",
      packageName: "curl",
      currentVersion: "8.0",
      architecture: "amd64",
      repository: null,
      cachedAt: "2026-06-01 10:00:00",
    },
    {
      id: 2,
      systemId: 1,
      pkgManager: "flatpak",
      packageName: "org.example.App",
      currentVersion: "1.2.3",
      architecture: "x86_64",
      repository: "flathub",
      cachedAt: "2026-06-01 10:00:00",
    },
  ];

  test("renders collapsed with count, search, and inventory columns", () => {
    const html = renderToStaticMarkup(createElement(InstalledPackagesSection, {
      installedPackages: packages,
      cacheTimestamp: "2026-06-01 10:00:00",
    }));

    expect(html).toMatch(/<details class="[^"]*"><summary/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("Installed Packages");
    expect(html).toContain('title="');
    expect(html).toContain("Search installed packages");
    expect(html).toContain("Installed Version");
    expect(html).toContain('type="text"');
    expect(html).toContain("Architecture");
    expect(html).not.toContain("Repository");
  });

  test("filters by package, version, manager, and architecture", () => {
    expect(filterInstalledPackages(packages, "curl")).toHaveLength(1);
    expect(filterInstalledPackages(packages, "1.2.3")).toHaveLength(1);
    expect(filterInstalledPackages(packages, "flatpak")).toHaveLength(1);
    expect(filterInstalledPackages(packages, "amd64")).toHaveLength(1);
    expect(filterInstalledPackages(packages, "flathub")).toEqual([]);
    expect(filterInstalledPackages(packages, "missing")).toEqual([]);
  });

  test("renders a distinct empty snapshot message", () => {
    const html = renderToStaticMarkup(createElement(InstalledPackagesSection, { installedPackages: [] }));
    expect(html).toContain("No installed package snapshot collected. Run Refresh to collect one.");
  });
});

describe("matchesHistoryEntryToSession", () => {
  test("accepts a finalized history row that starts after the active-operation timestamp", () => {
    expect(
      matchesHistoryEntryToSession(
        createHistoryEntry({
          id: 20,
          action: "check",
          pkgManager: "apt",
          status: "success",
          startedAt: "2026-03-25 21:00:01",
          completedAt: "2026-03-25 21:00:04",
        }),
        {
          key: "activity-current-3",
          action: "check",
          activeStartedAt: "2026-03-25 21:00:00",
          firstCommandStartedAt: "2026-03-25 21:00:01",
        },
      )
    ).toBe(true);
  });
});

describe("isScrollNearBottom", () => {
  test("returns true when the viewer is already following the end of the log", () => {
    expect(isScrollNearBottom(600, 260, 300)).toBe(true);
  });

  test("returns false when the user has scrolled meaningfully away from the end", () => {
    expect(isScrollNearBottom(600, 200, 300)).toBe(false);
  });
});

describe("package selection helpers", () => {
  test("toggle selection supports select, select-all state, and deselect", () => {
    const updates = [
      { packageName: "bash" },
      { packageName: "curl" },
    ];

    const afterFirstToggle = toggleSelectedPackageName([], "bash");
    expect(afterFirstToggle).toEqual(["bash"]);

    const selectedAll = [...afterFirstToggle, "curl"];
    expect(getPackageSelectionState(selectedAll, updates)).toMatchObject({
      selectedCount: 2,
      allSelected: true,
      indeterminate: false,
    });

    const afterDeselect = toggleSelectedPackageName(selectedAll, "bash");
    expect(getPackageSelectionState(afterDeselect, updates)).toMatchObject({
      selectedCount: 1,
      allSelected: false,
      indeterminate: true,
    });
  });

  test("selection state carries disabled status for busy system detail actions", () => {
    const state = getPackageSelectionState(["bash"], [{ packageName: "bash" }], true);
    expect(state.selectionDisabled).toBe(true);
    expect(state.selectedCount).toBe(1);
  });
});
