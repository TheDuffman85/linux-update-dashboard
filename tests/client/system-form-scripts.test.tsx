import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const {
  mockUseCreateCredential,
  mockUseCredentials,
  mockUseRevokeHostKey,
  mockUseSystems,
  mockUseTestConnection,
  mockUseScripts,
  mockUseToast,
} = vi.hoisted(() => ({
  mockUseCreateCredential: vi.fn(),
  mockUseCredentials: vi.fn(),
  mockUseRevokeHostKey: vi.fn(),
  mockUseSystems: vi.fn(),
  mockUseTestConnection: vi.fn(),
  mockUseScripts: vi.fn(),
  mockUseToast: vi.fn(),
}));

vi.mock("../../client/lib/credentials", () => ({
  useCreateCredential: mockUseCreateCredential,
  useCredentials: mockUseCredentials,
}));

vi.mock("../../client/lib/systems", () => ({
  useRevokeHostKey: mockUseRevokeHostKey,
  useSystems: mockUseSystems,
  useTestConnection: mockUseTestConnection,
}));

vi.mock("../../client/lib/scripts", async () => {
  const actual = await vi.importActual<typeof import("../../client/lib/scripts")>(
    "../../client/lib/scripts",
  );
  return {
    ...actual,
    useScripts: mockUseScripts,
  };
});

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
}));

vi.mock("../../client/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../client/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("../../client/components/credentials/CredentialForm", () => ({
  CredentialForm: () => null,
}));

vi.mock("../../client/components/Badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { SystemForm } from "../../client/components/systems/SystemForm";
import type { ScriptOperation } from "../../client/lib/scripts";

const customAptOperations: ScriptOperation[] = [
  "detect",
  "check_updates",
  "list_installed_packages",
  "repair_issue",
  "upgrade_all",
  "full_upgrade_all",
  "upgrade_selected",
];

describe("SystemForm script operations", () => {
  beforeEach(() => {
    mockUseCreateCredential.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseCredentials.mockReturnValue({
      data: [
        {
          id: 1,
          name: "SSH credential",
          kind: "usernamePassword",
        },
      ],
    });
    mockUseRevokeHostKey.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseSystems.mockReturnValue({ data: [] });
    mockUseTestConnection.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseToast.mockReturnValue({ addToast: vi.fn() });
    mockUseScripts.mockReturnValue({
      data: {
        packageManagers: [
          {
            id: 1,
            name: "custom-apt",
            label: "Custom APT",
            parserConfig: null,
            configEntries: [],
            builtin: false,
          },
        ],
        scripts: customAptOperations.map((operation) => ({
          id: `custom:${operation}`,
          readonly: false,
          name: `Custom APT ${operation}`,
          description: null,
          type: "package_manager",
          operation,
          pkgManager: "custom-apt",
          steps: [{ label: "Run", command: "apt-get --version" }],
          parserConfig: null,
          systemInfoConfig: null,
          sourceScriptId: `builtin:apt:${operation}`,
        })),
        placeholders: [],
      },
    });
  });

  test("hides custom package-manager controls until the manager is detected", () => {
    const html = renderToStaticMarkup(
      <SystemForm
        initial={{
          name: "Debian",
          hostname: "debian.local",
          port: 22,
          credentialId: 1,
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          scriptOverrides: {},
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).not.toContain("Custom APT");
    expect(html).toContain("Tests the connection and detects available package managers.");
    expect(html).not.toContain("Saved config is shown here even though this package manager is not currently detected.");
    for (const operation of customAptOperations) {
      expect(html).not.toContain(`Custom APT ${operation}`);
    }
  });

  test("keeps script override controls collapsed by default", () => {
    const html = renderToStaticMarkup(
      <SystemForm
        initial={{
          name: "Debian",
          hostname: "debian.local",
          port: 22,
          credentialId: 1,
          detectedPkgManagers: ["apt", "custom-apt"],
          disabledPkgManagers: [],
          scriptOverrides: {},
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Scripts");
    expect(html).toContain("Optional overrides; Standard uses the detected package manager defaults.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Custom APT");
    expect(html).not.toContain("Saved config is shown here even though this package manager is not currently detected.");
    for (const operation of customAptOperations) {
      expect(html).not.toContain(`Custom APT ${operation}`);
    }
  });

  test("shows custom package-manager config entries when the manager is available", () => {
    mockUseScripts.mockReturnValue({
      data: {
        packageManagers: [
          {
            id: 1,
            name: "custom-apt",
            label: "Custom APT",
            parserConfig: null,
            builtin: false,
            configEntries: [
              { key: "channel", description: "Release channel", defaultValue: "stable" },
            ],
          },
        ],
        scripts: [],
        placeholders: [],
      },
    });

    const html = renderToStaticMarkup(
      <SystemForm
        initial={{
          name: "Debian",
          hostname: "debian.local",
          port: 22,
          credentialId: 1,
          detectedPkgManagers: ["custom-apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: { "custom-apt": { channel: "edge" } },
          scriptOverrides: {},
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Custom APT");
    expect(html).toContain("channel");
    expect(html).toContain("Release channel");
    expect(html).toContain("edge");
  });

  test("hides configs for deleted custom package managers", () => {
    const html = renderToStaticMarkup(
      <SystemForm
        initial={{
          name: "Debian",
          hostname: "debian.local",
          port: 22,
          credentialId: 1,
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: {
            apt: { autoHideKeptBackUpdates: true },
            hermes: { branch: "main" },
          },
          scriptOverrides: {},
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("APT");
    expect(html).not.toContain("hermes");
    expect(html).not.toContain("branch");
  });
});
