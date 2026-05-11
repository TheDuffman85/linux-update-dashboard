import { describe, expect, test, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const {
  mockUseSystems,
  mockUseSystem,
  mockUseCreateSystem,
  mockUseUpdateSystem,
  mockUseDeleteSystem,
  mockUseReorderSystems,
  mockUseCheckUpdates,
  mockUseToast,
  mockUseUpgrade,
  mockUseAuth,
} = vi.hoisted(() => ({
  mockUseSystems: vi.fn(),
  mockUseSystem: vi.fn(),
  mockUseCreateSystem: vi.fn(),
  mockUseUpdateSystem: vi.fn(),
  mockUseDeleteSystem: vi.fn(),
  mockUseReorderSystems: vi.fn(),
  mockUseCheckUpdates: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseUpgrade: vi.fn(),
  mockUseAuth: vi.fn(),
}));

vi.mock("../../client/lib/systems", () => ({
  useSystems: mockUseSystems,
  useSystem: mockUseSystem,
  useCreateSystem: mockUseCreateSystem,
  useUpdateSystem: mockUseUpdateSystem,
  useDeleteSystem: mockUseDeleteSystem,
  useReorderSystems: mockUseReorderSystems,
}));

vi.mock("../../client/lib/updates", () => ({
  useCheckUpdates: mockUseCheckUpdates,
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
    mockUseSystem.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    mockUseCreateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseDeleteSystem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseReorderSystems.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseCheckUpdates.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseToast.mockReturnValue({ toasts: [], addToast: vi.fn(), removeToast: vi.fn() });
    mockUseUpgrade.mockReturnValue({ isUpgrading: () => false, upgradingCount: 0 });
    mockUseAuth.mockReturnValue({ user: { username: "tester" } });
  });

  test("does not render the removed potential commands action", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemsList />
      </MemoryRouter>,
    );

    expect(html).not.toContain('title="Potential commands"');
    expect(html).not.toContain("Potential Commands for Alpha");
  });
});
