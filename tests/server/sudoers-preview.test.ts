import { describe, expect, test } from "vitest";
import { buildCommandReference } from "../../server/services/command-reference";
import {
  buildExecutablePathLookupCommand,
  buildSudoersPreview,
  escapeSudoersArgs,
  parseExecutablePathLookupOutput,
  sanitizeSudoersFileSegment,
} from "../../server/services/sudoers-preview";

function createAptReference() {
  return buildCommandReference({
    pkgManager: "apt",
    detectedPkgManagers: JSON.stringify(["apt"]),
    disabledPkgManagers: null,
    pkgManagerConfigs: null,
  });
}

function aptPaths() {
  return new Map([
    ["apt-get", "/usr/bin/apt-get"],
    ["dpkg", "/usr/bin/dpkg"],
    ["pvesh", "/usr/bin/pvesh"],
    ["reboot", "/usr/sbin/reboot"],
  ]);
}

describe("sudoers preview generation", () => {
  test("formats paste-ready APT rules and comments selected-package wildcards", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
    });

    expect(preview.resolution).toBe("resolved");
    expect(preview.content).toContain("Defaults:updater !requiretty");
    expect(preview.content).toContain("/usr/bin/apt-get -o DPkg\\:\\:Lock\\:\\:Timeout\\=60 update -qq");
    expect(preview.content).toContain('/usr/sbin/reboot ""');
    expect(preview.content).toContain("WARNING: Selected-package upgrades are disabled by default.");
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: /usr/bin/apt-get -o DPkg\\:\\:Lock\\:\\:Timeout\\=60 install --only-upgrade -y *");
    expect(preview.content.match(/install --only-upgrade -y \*/g)).toHaveLength(1);
  });

  test("creates a visibly non-paste-ready fallback template", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      resolution: "fallback",
      resolutionError: "Host is offline",
    });

    expect(preview.content).toContain("WARNING: NOT PASTE-READY");
    expect(preview.content).toContain("Path resolution failed: Host is offline");
    expect(preview.content).toContain("REPLACE_WITH_ABSOLUTE_PATH/apt-get");
  });

  test("generates sudoers content for root SSH users", () => {
    const preview = buildSudoersPreview({
      username: "root",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
    });

    expect(preview).toMatchObject({
      required: true,
      resolution: "resolved",
    });
    expect(preview.content).toContain("Defaults:root !requiretty");
    expect(preview.content).toContain("root ALL=(root) NOPASSWD: /usr/bin/apt-get");
  });

  test("adds commented sudoedit rules for editable repository sources", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
      repositorySourcePaths: ["/etc/apt/sources.list", "/etc/apt/sources.list.d/debian.sources"],
    });

    expect(preview.content).toContain("Writing repository sources is root-equivalent");
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: sudoedit /etc/apt/sources.list\n");
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: sudoedit /etc/apt/sources.list.d/debian.sources\n");
    expect(preview.content).not.toMatch(/^updater .*sudoedit/m);
  });

  test("explains repository source rules when the files are unknown or absent", () => {
    const unknown = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
      repositorySourcePaths: null,
    });
    const none = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
      repositorySourcePaths: [],
    });
    const disabled = buildSudoersPreview({
      username: "updater",
      commandReference: createAptReference(),
      executablePaths: aptPaths(),
    });

    expect(unknown.content).toContain("# updater ALL=(root) NOPASSWD: sudoedit /absolute/path/to/file");
    expect(none.content).toContain("No editable repository source files were found on this host.");
    expect(disabled.content).not.toContain("sudoedit");
  });

  test("sanitizes file names and sudoers arguments", () => {
    expect(sanitizeSudoersFileSegment("ops team/blue")).toBe("ops-team-blue");
    expect(sanitizeSudoersFileSegment("..")).toBe("user");
    expect(escapeSudoersArgs("a,b:c=d\\e")).toBe("a\\,b\\:c\\=d\\\\e");
  });

  test("builds and parses one batched executable lookup", () => {
    const command = buildExecutablePathLookupCommand(["apt-get", "reboot"]);
    expect(command).toContain("command -v 'apt-get'");
    expect(command).toContain("command -v 'reboot'");
    expect(parseExecutablePathLookupOutput("apt-get\t/usr/bin/apt-get\nreboot\t/usr/sbin/reboot\n")).toEqual(
      new Map([
        ["apt-get", "/usr/bin/apt-get"],
        ["reboot", "/usr/sbin/reboot"],
      ]),
    );
  });

  test("includes safe custom rules and carries unsafe custom warnings", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: {
        exact: [],
        sudoers: [
          {
            id: "custom:sudo:0",
            category: "upgrade_all",
            label: "Custom upgrade",
            purpose: "Runs a custom upgrade",
            pkgManager: "custom",
            command: "/usr/local/bin/custom-upgrade --apply",
          },
        ],
        warnings: [
          {
            id: "unsafe:sudo:0",
            category: "upgrade_all",
            label: "Unsafe custom upgrade",
            pkgManager: "custom",
            message: "Runs a shell under sudo.",
            command: "sh /tmp/custom-upgrade.sh",
          },
        ],
        envKeep: [],
      },
    });

    expect(preview.content).toContain("/usr/local/bin/custom-upgrade --apply");
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      command: "sh /tmp/custom-upgrade.sh",
    }));
  });

});
