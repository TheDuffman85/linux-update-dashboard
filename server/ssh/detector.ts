import type { Client } from "ssh2";
import type { SSHConnectionManager } from "./connection";

const DETECTION_COMMANDS: [string, string][] = [
  ["apt", "which apt 2>/dev/null && echo 'found'"],
  ["dnf", "which dnf 2>/dev/null && echo 'found'"],
  ["yum", "which yum 2>/dev/null && echo 'found'"],
  ["pacman", "which pacman 2>/dev/null && echo 'found'"],
];

const OPTIONAL_DETECTION: [string, string][] = [
  ["flatpak", "which flatpak 2>/dev/null && echo 'found'"],
  ["snap", "which snap 2>/dev/null && echo 'found'"],
];

export async function detectPackageManagers(
  sshManager: SSHConnectionManager,
  conn: Client,
  checkFlatpak = false,
  checkSnap = false
): Promise<string[]> {
  const detected: string[] = [];

  const commands = [...DETECTION_COMMANDS];
  if (checkFlatpak) commands.push(OPTIONAL_DETECTION[0]);
  if (checkSnap) commands.push(OPTIONAL_DETECTION[1]);

  for (const [name, cmd] of commands) {
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
