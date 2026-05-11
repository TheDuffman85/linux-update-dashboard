import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const {
  mockUseCreatePackageManager,
  mockUseCreateScript,
  mockUseDeleteScript,
  mockUseScripts,
  mockUseToast,
  mockUseUpdateScript,
} = vi.hoisted(() => ({
  mockUseCreatePackageManager: vi.fn(),
  mockUseCreateScript: vi.fn(),
  mockUseDeleteScript: vi.fn(),
  mockUseScripts: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseUpdateScript: vi.fn(),
}));

vi.mock("../../client/lib/scripts", async () => {
  const actual = await vi.importActual<typeof import("../../client/lib/scripts")>(
    "../../client/lib/scripts",
  );
  return {
    ...actual,
    useCreatePackageManager: mockUseCreatePackageManager,
    useCreateScript: mockUseCreateScript,
    useDeleteScript: mockUseDeleteScript,
    useScripts: mockUseScripts,
    useUpdateScript: mockUseUpdateScript,
  };
});

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
}));

vi.mock("../../client/components/Layout", () => ({
  Layout: ({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock("../../client/components/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
}));

vi.mock("../../client/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import Scripts from "../../client/pages/Scripts";

describe("Scripts page", () => {
  beforeEach(() => {
    const mutation = { mutate: vi.fn(), isPending: false };
    mockUseCreatePackageManager.mockReturnValue(mutation);
    mockUseCreateScript.mockReturnValue(mutation);
    mockUseDeleteScript.mockReturnValue(mutation);
    mockUseUpdateScript.mockReturnValue(mutation);
    mockUseToast.mockReturnValue({ addToast: vi.fn() });
    mockUseScripts.mockReturnValue({
      data: {
        scripts: [],
        packageManagers: [],
        placeholders: [],
      },
      isLoading: false,
    });
  });

  test("offers package-manager creation without the old built-in copy action", () => {
    const html = renderToStaticMarkup(<Scripts />);

    expect(html).toContain("New Package Manager");
    expect(html).not.toContain("Copy Built-In");
    expect(html).not.toContain("Placeholder Help");
  });

  test("shows sudo badges for scripts with sudo helpers", () => {
    mockUseScripts.mockReturnValue({
      data: {
        scripts: [
          {
            id: "builtin:apt:upgrade_all",
            readonly: true,
            name: "Upgrade all APT packages",
            description: "Installs updates.",
            type: "package_manager",
            operation: "upgrade_all",
            pkgManager: "apt",
            steps: [{ label: "Upgrade", command: "{{sudo:apt-get upgrade -y}}" }],
            parserConfig: null,
            systemInfoConfig: null,
            sourceScriptId: null,
          },
        ],
        packageManagers: [],
        placeholders: [],
      },
      isLoading: false,
    });

    const html = renderToStaticMarkup(<Scripts />);

    expect(html).toContain("sudo");
  });
});
