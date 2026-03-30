import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PotentialCommandsPanel } from "../../client/components/systems/PotentialCommandsPanel";
import type { CommandReference } from "../../client/lib/systems";

const commandReference: CommandReference = {
  exact: [
    {
      id: "system-info",
      category: "system_info",
      label: "Collect system information",
      purpose: "Collects OS, kernel, uptime, resources, and reboot-related system details",
      pkgManager: null,
      command: "echo \"===OS===\"; cat /etc/os-release",
    },
    {
      id: "upgrade-all:apt",
      category: "upgrade_all",
      label: "Upgrade all APT packages",
      purpose: "Installs all available APT updates for this system",
      pkgManager: "apt",
      command: "export DEBIAN_FRONTEND=noninteractive; if [ \"$(id -u)\" = \"0\" ]; then apt-get -o DPkg::Lock::Timeout=60 upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' apt-get -o DPkg::Lock::Timeout=60 upgrade -y; else apt-get -o DPkg::Lock::Timeout=60 upgrade -y; fi 2>&1",
    },
  ],
  sudoers: [
    {
      id: "upgrade-all:apt",
      category: "upgrade_all",
      label: "Upgrade all APT packages",
      purpose: "Installs all available APT updates for this system",
      pkgManager: "apt",
      command: "apt-get -o DPkg::Lock::Timeout=60 upgrade -y",
    },
  ],
};

describe("PotentialCommandsPanel", () => {
  test("renders command groups with purpose text", () => {
    const html = renderToStaticMarkup(
      <PotentialCommandsPanel commandReference={commandReference} />,
    );

    expect(html).toContain("same backend command builders used at runtime");
    expect(html).toContain("Exact remote commands");
    expect(html).toContain("Sudoers-relevant commands");
    expect(html).toContain("Used for:");
    expect(html).toContain("Installs all available APT updates for this system");
    expect(html).toContain("apt-get -o DPkg::Lock::Timeout=60 upgrade -y");
    expect(html).toContain(">apt<");
  });
});
