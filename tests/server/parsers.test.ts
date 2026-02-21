import { describe, test, expect } from "bun:test";
import { aptParser } from "../../server/ssh/parsers/apt";
import { dnfParser } from "../../server/ssh/parsers/dnf";
import { yumParser } from "../../server/ssh/parsers/yum";
import { pacmanParser } from "../../server/ssh/parsers/pacman";
import { flatpakParser } from "../../server/ssh/parsers/flatpak";
import { snapParser } from "../../server/ssh/parsers/snap";

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
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toContain("apt-get");
    expect(cmds[0]).toContain("update");
  });

  test("upgrade commands", () => {
    expect(aptParser.getUpgradeAllCommand()).toContain("apt-get");
    expect(aptParser.getUpgradeAllCommand()).toContain("upgrade");
    expect(aptParser.getUpgradePackageCommand("curl")).toContain("curl");
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
  });

  test("no full upgrade command", () => {
    expect(pacmanParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("FlatpakParser", () => {
  test("parse tab separated", () => {
    const stdout = "Firefox\torg.mozilla.firefox\t122.0\tstable\tflathub\n";
    const updates = flatpakParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].packageName).toBe("org.mozilla.firefox");
    expect(updates[0].newVersion).toBe("122.0");
  });

  test("empty", () => {
    const updates = flatpakParser.parseCheckOutput("", "", 0);
    expect(updates).toHaveLength(0);
  });

  test("no full upgrade command", () => {
    expect(flatpakParser.getFullUpgradeAllCommand()).toBeNull();
  });
});

describe("SnapParser", () => {
  test("parse with header", () => {
    const stdout =
      "Name      Version   Rev   Publisher   Notes\n" +
      "firefox   122.0     123   mozilla     -\n" +
      "vlc       3.0.20    456   videolan    -\n";
    const updates = snapParser.parseCheckOutput(stdout, "", 0);
    expect(updates).toHaveLength(2);
    expect(updates[0].packageName).toBe("firefox");
    expect(updates[0].newVersion).toBe("122.0");
  });

  test("no updates message", () => {
    const stdout = "All snaps up to date.\n";
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
