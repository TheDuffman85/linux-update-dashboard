import type { Client } from "ssh2";
import type { SSHConnectionManager } from "./connection";

const DETECTION_COMMANDS: [string, string][] = [
  ["apt", "command -v apt >/dev/null 2>&1 && echo 'found'"],
  ["dnf", "command -v dnf >/dev/null 2>&1 && echo 'found'"],
  ["yum", "command -v yum >/dev/null 2>&1 && echo 'found'"],
  ["pacman", "command -v pacman >/dev/null 2>&1 && echo 'found'"],
  ["flatpak", "command -v flatpak >/dev/null 2>&1 && echo 'found'"],
  ["snap", "command -v snap >/dev/null 2>&1 && echo 'found'"],
];

export async function detectPackageManagers(
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<string[]> {
  const detected: string[] = [];

  for (const [name, cmd] of DETECTION_COMMANDS) {
    const { stdout, exitCode } = await sshManager.runCommand(conn, cmd, 10);
    if (exitCode === 0 && stdout.includes("found")) {
      detected.push(name);
    }
  }

  // If both dnf and yum are found, prefer dnf
  if (detected.includes("dnf") && detected.includes("yum")) {
    detected.splice(detected.indexOf("yum"), 1);
  }

  return detected;
}
