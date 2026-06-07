import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const {
  mockUseCreatePackageManager,
  mockUseCreateScript,
  mockUseDeletePackageManager,
  mockUseDeleteScript,
  mockUseImportPackageManagerBundle,
  mockUseScripts,
  mockUseToast,
  mockUseUpdatePackageManager,
  mockUseUpdateScript,
} = vi.hoisted(() => ({
  mockUseCreatePackageManager: vi.fn(),
  mockUseCreateScript: vi.fn(),
  mockUseDeletePackageManager: vi.fn(),
  mockUseDeleteScript: vi.fn(),
  mockUseImportPackageManagerBundle: vi.fn(),
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
    useImportPackageManagerBundle: mockUseImportPackageManagerBundle,
    useScripts: mockUseScripts,
    useUpdatePackageManager: mockUseUpdatePackageManager,
    useUpdateScript: mockUseUpdateScript,
  };
});

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
  useOptionalToast: mockUseToast,
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

import Scripts, { PackageManagerEditor, ScriptEditor } from "../../client/pages/Scripts";
import type { CustomPackageManagerBundle, ScriptDefinition } from "../../client/lib/scripts";

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

function renderPackageManagerEditor(options: {
  importBundle?: CustomPackageManagerBundle | null;
  importKeyExists?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <PackageManagerEditor
      draft={{
        name: "npm-project",
        label: "npm project",
        parserConfig: null,
        configEntries: [],
        builtin: false,
      }}
      setDraft={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onImport={vi.fn()}
      onClearImport={vi.fn()}
      importBundle={options.importBundle}
      importFileName={options.importBundle ? "npm-project-package-manager.json" : null}
      saveLabel={options.importBundle ? "Import" : "Save"}
      importKeyExists={options.importKeyExists}
    />,
  );
}

describe("Scripts page", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_REPO_URL__", "");
    const mutation = { mutate: vi.fn(), isPending: false };
    mockUseCreatePackageManager.mockReturnValue(mutation);
    mockUseCreateScript.mockReturnValue(mutation);
    mockUseDeletePackageManager.mockReturnValue(mutation);
    mockUseDeleteScript.mockReturnValue(mutation);
    mockUseImportPackageManagerBundle.mockReturnValue(mutation);
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

  test("keeps package-manager import action stable and shows example guidance", () => {
    vi.stubGlobal("__APP_REPO_URL__", "https://github.com/TheDuffman85/linux-update-dashboard");

    const html = renderPackageManagerEditor();

    expect(html).toContain("No support will be given for custom package managers.");
    expect(html).toContain("Import File");
    expect(html).toContain("The examples folder contains various custom package manager examples.");
    expect(html).toContain("https://github.com/TheDuffman85/linux-update-dashboard/tree/main/examples");
    expect(html).not.toContain("Load Import File");
    expect(html).not.toContain("Replace Import File");
    expect(html).not.toContain("Reload Import File");
  });

  test("hides package-manager import box after a file is loaded and offers unload", () => {
    const importBundle: CustomPackageManagerBundle = {
      format: "ludash.custom-package-manager.v1",
      exportedAt: "2026-06-07T00:00:00.000Z",
      packageManager: {
        name: "npm-project",
        label: "npm project",
        parserConfig: null,
        configEntries: [{ key: "projectPath", defaultValue: "~/project" }],
      },
      scripts: [
        {
          name: "Check npm project",
          description: null,
          type: "package_manager",
          operation: "check_updates",
          pkgManager: "npm-project",
          isDefault: true,
          steps: [{ label: "Check", command: "npm outdated" }],
          parserConfig: null,
          systemInfoConfig: null,
          sourceScriptId: null,
        },
      ],
    };

    const html = renderPackageManagerEditor({ importBundle });

    expect(html).toContain("Import Preview");
    expect(html).toContain("npm-project-package-manager.json");
    expect(html).toContain("Unload import file");
    expect(html).toContain("rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium");
    expect(html).not.toContain("Import File");
    expect(html).not.toContain("The examples folder contains various custom package manager examples.");
    expect(html).not.toContain("Load Import File");
    expect(html).not.toContain("Replace Import File");
    expect(html).not.toContain("Reload Import File");
  });

  test("warns and blocks package-manager imports for existing manager keys", () => {
    const importBundle: CustomPackageManagerBundle = {
      format: "ludash.custom-package-manager.v1",
      exportedAt: "2026-06-07T00:00:00.000Z",
      packageManager: {
        name: "npm-project",
        label: "npm project",
        parserConfig: null,
        configEntries: [],
      },
      scripts: [
        {
          name: "Check npm project",
          description: null,
          type: "package_manager",
          operation: "check_updates",
          pkgManager: "npm-project",
          isDefault: true,
          steps: [{ label: "Check", command: "npm outdated" }],
          parserConfig: null,
          systemInfoConfig: null,
          sourceScriptId: null,
        },
      ],
    };

    const html = renderPackageManagerEditor({ importBundle, importKeyExists: true });

    expect(html).toContain("This manager key already exists.");
    expect(html).toContain("Choose a different key.");
    expect(html).not.toContain("Choose a different key or unload the import file.");
    expect(html).toContain("disabled=\"\"");
  });

  test("omits package-manager examples link when repository URL is unavailable", () => {
    const html = renderPackageManagerEditor();

    expect(html).toContain("The examples folder contains various custom package manager examples.");
    expect(html).toContain("Import File");
    expect(html).not.toContain("View examples on GitHub");
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

  test("caps script command previews with internal scrolling", () => {
    mockUseScripts.mockReturnValue({
      data: {
        scripts: [
          {
            id: "builtin:system:system_info",
            readonly: true,
            name: "Collect system information",
            description: "Collects system details.",
            type: "system",
            operation: "system_info",
            pkgManager: null,
            steps: [{ label: "Collect system information", command: "echo OS" }],
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

    expect(html).toContain("script-code max-h-64 overflow-x-auto overflow-y-auto");
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

  test("shows issue detection rules on custom repair scripts", () => {
    const html = renderEditor({
      id: "custom:15",
      readonly: false,
      name: "Repair Linuxbrew",
      description: null,
      type: "package_manager",
      operation: "repair_issue",
      pkgManager: "brewlinux",
      steps: [{ label: "Repair", command: "brew repair" }],
      parserConfig: {
        issueRegex: "database needs repair",
        issueTitle: "Linuxbrew needs repair",
        issueMessage: "Run repair.",
      },
      systemInfoConfig: null,
      sourceScriptId: null,
    });

    expect(html).toContain("Issue Detection");
    expect(html).toContain("Issue Regex");
    expect(html).toContain("database needs repair");
    expect(html).not.toContain("Advanced parser rules");
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
