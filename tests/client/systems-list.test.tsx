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

import SystemsList from "../../client/pages/SystemsList";

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
          upgradeOrder: 1,
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
    mockUseCreateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseDeleteSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseReorderSystems.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseToast.mockReturnValue({ toasts: [], addToast: vi.fn(), removeToast: vi.fn() });
    mockUseUpgrade.mockReturnValue({ isUpgrading: () => false, upgradingCount: 0 });
    mockUseAuth.mockReturnValue({ user: { username: "tester" } });
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
});
