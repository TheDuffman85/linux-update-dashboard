import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const {
  mockUseCreatePackageManager,
  mockUseCreateScript,
  mockUseDeletePackageManager,
  mockUseDeleteScript,
  mockUseScripts,
  mockUseToast,
  mockUseUpdatePackageManager,
  mockUseUpdateScript,
} = vi.hoisted(() => ({
  mockUseCreatePackageManager: vi.fn(),
  mockUseCreateScript: vi.fn(),
  mockUseDeletePackageManager: vi.fn(),
  mockUseDeleteScript: vi.fn(),
  mockUseScripts: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseUpdatePackageManager: vi.fn(),
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
    useDeletePackageManager: mockUseDeletePackageManager,
    useDeleteScript: mockUseDeleteScript,
    useScripts: mockUseScripts,
    useUpdatePackageManager: mockUseUpdatePackageManager,
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

import Scripts, { ScriptEditor } from "../../client/pages/Scripts";
import type { ScriptDefinition } from "../../client/lib/scripts";

function renderEditor(script: ScriptDefinition): string {
  return renderToStaticMarkup(
    <ScriptEditor
      script={script}
      packageManagers={[
        { name: "apt", label: "APT" },
        { name: "brewlinux", label: "Linuxbrew" },
      ]}
      placeholders={[]}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("Scripts page", () => {
  beforeEach(() => {
    const mutation = { mutate: vi.fn(), isPending: false };
    mockUseCreatePackageManager.mockReturnValue(mutation);
    mockUseCreateScript.mockReturnValue(mutation);
    mockUseDeletePackageManager.mockReturnValue(mutation);
    mockUseDeleteScript.mockReturnValue(mutation);
    mockUseUpdatePackageManager.mockReturnValue(mutation);
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

  test("summarizes package manager management while collapsed by default", () => {
    mockUseScripts.mockReturnValue({
      data: {
        scripts: [
          {
            id: "custom:1",
            readonly: false,
            name: "Check Linuxbrew",
            description: null,
            type: "package_manager",
            operation: "check_updates",
            pkgManager: "brewlinux",
            steps: [{ label: "Check", command: "brew outdated" }],
            parserConfig: null,
            systemInfoConfig: null,
            sourceScriptId: null,
          },
        ],
        packageManagers: [
          {
            id: 1,
            name: "brewlinux",
            label: "Linuxbrew",
            parserConfig: null,
            configEntries: [],
            builtin: false,
          },
        ],
        placeholders: [],
      },
      isLoading: false,
    });

    const html = renderToStaticMarkup(<Scripts />);

    expect(html).toContain("Package Managers");
    expect(html).toContain("8 managers");
    expect(html).toContain("1 custom");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Edit package manager");
    expect(html).not.toContain("Focus");
  });

  test("shows where custom scripts are assigned", () => {
    mockUseScripts.mockReturnValue({
      data: {
        scripts: [
          {
            id: "custom:7",
            readonly: false,
            name: "Detect APT (Copy)",
            description: null,
            type: "package_manager",
            operation: "detect",
            pkgManager: "apt",
            steps: [{ label: "Detect APT", command: "command -v apt" }],
            parserConfig: null,
            systemInfoConfig: null,
            sourceScriptId: "builtin:apt:detect",
            usageCount: 1,
            usages: [
              {
                systemId: 42,
                systemName: "web-42",
                operationKey: "apt/detect",
              },
            ],
          },
        ],
        packageManagers: [],
        placeholders: [],
      },
      isLoading: false,
    });

    const html = renderToStaticMarkup(<Scripts />);

    expect(html).toContain("1 system");
    expect(html).toContain("Assigned to web-42");
    expect(html).toContain("web-42");
    expect(html).toContain("Detection");
  });

  test("explains built-in package-manager check runtime behavior", () => {
    const html = renderEditor({
      id: "builtin:apt:check_updates",
      readonly: true,
      name: "Check APT updates",
      description: null,
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "List updates", command: "apt list --upgradable" }],
      parserConfig: null,
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(html).toContain("Runtime behavior");
    expect(html).toContain("Steps, output, parser, and exit codes");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("parser input");
  });

  test("keeps detection scripts to one clear step", () => {
    const html = renderEditor({
      id: "custom:10",
      readonly: false,
      name: "Detect Linuxbrew",
      description: null,
      type: "package_manager",
      operation: "detect",
      pkgManager: "brewlinux",
      steps: [{ label: "Detect Linuxbrew", command: "command -v brew && echo found" }],
      parserConfig: null,
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(html).toContain("Detection scripts use one command");
    expect(html).toContain("Detection scripts use one step");
    expect(html).toContain("detection output");
  });

  test("shows custom parser output selection and step badges", () => {
    const html = renderEditor({
      id: "custom:11",
      readonly: false,
      name: "Check Linuxbrew",
      description: null,
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [
        { label: "Refresh metadata", command: "brew update" },
        { label: "List updates", command: "brew outdated" },
      ],
      parserConfig: {
        parseStep: 0,
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      },
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(html).toContain("Output to Parse");
    expect(html).toContain("Step 1: Refresh metadata");
    expect(html).toContain("Last step (List updates)");
    expect(html).toContain("parsed output");
    expect(html).toContain("streamed only");
  });

  test("warns when a saved parser output step no longer exists", () => {
    const html = renderEditor({
      id: "custom:12",
      readonly: false,
      name: "Broken custom check",
      description: null,
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "List updates", command: "brew outdated" }],
      parserConfig: {
        parseStep: 3,
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      },
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(html).toContain("The saved parser step is outside the current step list.");
    expect(html).toContain("Missing step 4");
  });

  test("explains system-info and reboot step output behavior", () => {
    const systemInfoHtml = renderEditor({
      id: "custom:13",
      readonly: false,
      name: "System info",
      description: null,
      type: "system",
      operation: "system_info",
      pkgManager: null,
      steps: [{ label: "Collect", command: "echo OS" }],
      parserConfig: null,
      systemInfoConfig: { mode: "sectioned" },
      sourceScriptId: null,
    });
    const rebootHtml = renderEditor({
      id: "custom:14",
      readonly: false,
      name: "Reboot",
      description: null,
      type: "system",
      operation: "reboot",
      pkgManager: null,
      steps: [
        { label: "Safety check", command: "true" },
        { label: "Reboot", command: "reboot" },
      ],
      parserConfig: null,
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(systemInfoHtml).toContain("system fields");
    expect(systemInfoHtml).toContain("Advanced system-info mapping");
    expect(rebootHtml).toContain("reboot guard");
    expect(rebootHtml).toContain("reboot command");
    expect(rebootHtml).toContain("Steps, output, parser, and exit codes");
  });
});
