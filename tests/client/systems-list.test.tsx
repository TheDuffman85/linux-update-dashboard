import { describe, expect, test, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const {
  mockUseSystems,
  mockUseSudoersPreview,
  mockUseCreateSystem,
  mockUseUpdateSystem,
  mockUseDeleteSystem,
  mockUseReorderSystems,
  mockUseSettings,
  mockUseToast,
  mockUseUpgrade,
  mockUseAuth,
} = vi.hoisted(() => ({
  mockUseSystems: vi.fn(),
  mockUseSudoersPreview: vi.fn(),
  mockUseCreateSystem: vi.fn(),
  mockUseUpdateSystem: vi.fn(),
  mockUseDeleteSystem: vi.fn(),
  mockUseReorderSystems: vi.fn(),
  mockUseSettings: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseUpgrade: vi.fn(),
  mockUseAuth: vi.fn(),
}));

vi.mock("../../client/lib/systems", () => ({
  useSystems: mockUseSystems,
  useSudoersPreview: mockUseSudoersPreview,
  useCreateSystem: mockUseCreateSystem,
  useUpdateSystem: mockUseUpdateSystem,
  useDeleteSystem: mockUseDeleteSystem,
  useReorderSystems: mockUseReorderSystems,
}));

vi.mock("../../client/lib/settings", () => ({
  useSettings: mockUseSettings,
}));

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
}));

vi.mock("../../client/context/UpgradeContext", () => ({
  useUpgrade: mockUseUpgrade,
}));

vi.mock("../../client/context/AuthContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../../client/components/Layout", () => ({
  Layout: ({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{actions}</div>
      <div>{children}</div>
    </div>
  ),
}));

import { translateForLanguage } from "../../client/lib/i18n";
import type { System } from "../../client/lib/systems";

import { filterSystems } from "../../client/lib/system-search";

import SystemsList, { getEditSystemIdFromRouteState } from "../../client/pages/SystemsList";

describe("SystemsList", () => {
  beforeEach(() => {
    mockUseSystems.mockReturnValue({
      data: [
        {
          id: 1,
          sortOrder: 0,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          credentialId: 1,
          proxyJumpSystemId: null,
          authType: "password",
          username: "root",
          hostKeyVerificationEnabled: 1,
          approvedHostKey: null,
          trustedHostKeyAlgorithm: null,
          trustedHostKeyFingerprintSha256: null,
          hostKeyTrustedAt: null,
          hostKeyStatus: "verified",
          proxyJumpChain: [],
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          autoHideKeptBackUpdates: 0,
          osName: "Debian",
          osVersion: "12",
          kernel: null,
          hostnameRemote: null,
          uptime: null,
          arch: null,
          cpuCores: null,
          memory: null,
          disk: null,
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          hidden: 0,
          needsReboot: 0,
          isReachable: 1,
          lastSeenAt: null,
          createdAt: "2026-03-30 10:00:00",
          updatedAt: "2026-03-30 10:00:00",
          updateCount: 0,
          securityCount: 0,
          keptBackCount: 0,
          lastCheck: null,
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          activeOperation: null,
          supportsFullUpgrade: true,
          scriptOverrides: {},
        },
      ],
      isLoading: false,
      refetch: vi.fn(),
    });
    mockUseSudoersPreview.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    mockUseSettings.mockReturnValue({
      data: { enable_root_user_check: "true" },
      isLoading: false,
    });
    mockUseCreateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseDeleteSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseReorderSystems.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseToast.mockReturnValue({ toasts: [], addToast: vi.fn(), removeToast: vi.fn() });
    mockUseUpgrade.mockReturnValue({ isUpgrading: () => false, upgradingCount: 0 });
    mockUseAuth.mockReturnValue({ user: { username: "tester" } });
  });

  test("renders accessible search without a matching count", () => {
    const html = renderToStaticMarkup(<MemoryRouter><SystemsList /></MemoryRouter>);
    expect(html).toContain('aria-label="Search systems"');
    expect(html).not.toContain("Showing 1 of 1 systems");
  });

  test("matches identities, OS, and displayed status badges in the active language", () => {
    const base: System = mockUseSystems().data[0];
    const systems: System[] = [
      { ...base, osLifecycleStatus: "supported", osLifecycleLabel: "", hostKeyStatus: "verified" },
      { ...base, id: 2, name: "Beta", hostname: "192.0.2.20", port: 2222, osName: null, isReachable: -1, hidden: 1, osLifecycleStatus: "eol", osLifecycleLabel: "", hostKeyStatus: "needs_approval", proxyJumpChain: [{ id: 3, name: "Gateway" }], needsReboot: 1, packageIssueCount: 1 },
      { ...base, id: 3, name: "Gamma", hostname: "gamma.local", osName: "Alpine", isReachable: 0, hidden: 0, osLifecycleStatus: "supported", osLifecycleLabel: "", hostKeyStatus: "verification_disabled" },
    ];
    const t = (key: string, values?: Record<string, string | number>) => translateForLanguage("en", key, values);
    for (const query of ["  ALPha  ", "alpha.local", "debian", "online", "approved"]) {
      expect(filterSystems(systems, query, t).map((system) => system.id), query).toEqual([1]);
    }
    for (const query of ["192.0.2.20:2222", "offline", "hidden", "eol", "needs approval", "via Gateway", "reboot required", "pkg issue"]) {
      expect(filterSystems(systems, query, t).map((system) => system.id), query).toEqual([2]);
    }
    expect(filterSystems(systems, "verification off", t).map((system) => system.id)).toEqual([3]);
    expect(filterSystems(systems, "unknown", t).map((system) => system.id)).toEqual([3]);
    expect(filterSystems(systems, "", t)).toBe(systems);
    expect(filterSystems(systems, "  ", t)).toBe(systems);
    expect(filterSystems([...systems].reverse(), "a", t).map((system) => system.id)).toEqual([3, 2, 1]);
    expect(filterSystems(systems, "nonexistent", t)).toEqual([]);
    expect(filterSystems(systems, "Reihenfolge", t)).toEqual([]);
    const de = (key: string, values?: Record<string, string | number>) => translateForLanguage("de", key, values);
    expect(filterSystems(systems, de("pages.systemsList.hidden"), de).map((system) => system.id)).toEqual([2]);
  });

  test("keeps the original empty repository message separate from search results", () => {
    mockUseSystems.mockReturnValue({ data: [], isLoading: false, refetch: vi.fn() });
    const html = renderToStaticMarkup(<MemoryRouter><SystemsList /></MemoryRouter>);
    expect(html).toContain("No systems configured yet");
    expect(html).not.toContain("No systems match your search");
    expect(html).not.toContain('aria-label="Search systems"');
  });

  test("searches dashboard payloads without ProxyJump or host-key status metadata", () => {
    const systems = [
      { id: 1, name: "Alpha", hostname: "alpha.local", port: 22, osName: "Debian", isReachable: 1 },
      { id: 2, name: "Beta", hostname: "192.0.2.20", port: 2222, osName: null, isReachable: -1 },
    ];
    const t = vi.fn((key: string, values?: Record<string, string | number>) => {
      expect(typeof key).toBe("string");
      return translateForLanguage("en", key, values);
    });
    expect(filterSystems(systems, "alpha", t).map((system) => system.id)).toEqual([1]);
    expect(filterSystems(systems, "192.0.2.20:2222", t).map((system) => system.id)).toEqual([2]);
    expect(filterSystems(systems, "offline", t).map((system) => system.id)).toEqual([2]);
    expect(filterSystems(systems, "debian", t).map((system) => system.id)).toEqual([1]);
    expect(filterSystems(systems, "approved", t)).toEqual([]);
    expect(filterSystems(systems, "missing", t)).toEqual([]);
    expect(filterSystems(systems, "", t)).toBe(systems);
  });

  test("renders a sudoers setup action and keeps its modal closed by default", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemsList />
      </MemoryRouter>,
    );

    expect(html).toContain('title="Sudoers setup"');
    expect(html).toContain('aria-label="Sudoers setup for Alpha"');
    expect(html).not.toContain("Sudoers Setup for Alpha");
  });

  test("labels Debian LTS lifecycle warnings without dates", () => {
    mockUseSystems.mockReturnValue({
      data: [
        {
          id: 1,
          sortOrder: 0,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          credentialId: 1,
          proxyJumpSystemId: null,
          authType: "password",
          username: "root",
          hostKeyVerificationEnabled: 1,
          approvedHostKey: null,
          trustedHostKeyAlgorithm: null,
          trustedHostKeyFingerprintSha256: null,
          hostKeyTrustedAt: null,
          hostKeyStatus: "verified",
          proxyJumpChain: [],
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          autoHideKeptBackUpdates: 0,
          osName: "Debian",
          osVersion: "12",
          osLifecycleStatus: "support_ended",
          osLifecycleEolDate: "2028-06-30",
          osLifecycleDaysUntilEol: 744,
          osLifecycleSupportEndDate: "2026-07-11",
          osLifecycleDaysUntilSupportEnd: -6,
          osLifecycleLabel: "Debian 12 is in LTS until 2028-06-30",
          osLifecycleDismissedKey: "debian:12:2028-06-30:support_ended",
          osLifecycleDismissedAt: null,
          osLifecycleBannerDismissed: false,
          kernel: null,
          hostnameRemote: null,
          uptime: null,
          arch: null,
          cpuCores: null,
          memory: null,
          disk: null,
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          hidden: 0,
          needsReboot: 0,
          isReachable: 1,
          lastSeenAt: null,
          createdAt: "2026-03-30 10:00:00",
          updatedAt: "2026-03-30 10:00:00",
          updateCount: 0,
          securityCount: 0,
          keptBackCount: 0,
          lastCheck: null,
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          activeOperation: null,
          supportsFullUpgrade: true,
          scriptOverrides: {},
        },
      ],
      isLoading: false,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemsList />
      </MemoryRouter>,
    );

    expect(html).toContain("LTS");
    expect(html).not.toContain("in LTS");
    expect(html).not.toContain("LTS until 2028-06-30");
    expect(html).not.toContain("support ended");
  });

  test("parses the system configuration route state", () => {
    expect(getEditSystemIdFromRouteState({ editSystemId: 42 })).toBe(42);
    expect(getEditSystemIdFromRouteState({ editSystemId: "42" })).toBeNull();
    expect(getEditSystemIdFromRouteState(null)).toBeNull();
  });
});
