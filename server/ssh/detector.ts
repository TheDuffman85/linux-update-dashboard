import type { Client } from "ssh2";
import type { SSHConnectionManager } from "./connection";

export interface PackageManagerDetectionCommand {
  name: string;
  command: string;
}

const DETECTION_COMMANDS: PackageManagerDetectionCommand[] = [
  { name: "apt", command: "command -v apt >/dev/null 2>&1 && echo 'found'" },
  { name: "dnf", command: "command -v dnf >/dev/null 2>&1 && echo 'found'" },
  { name: "yum", command: "command -v yum >/dev/null 2>&1 && echo 'found'" },
  { name: "pacman", command: "command -v pacman >/dev/null 2>&1 && echo 'found'" },
  { name: "apk", command: "command -v apk >/dev/null 2>&1 && echo 'found'" },
  { name: "flatpak", command: "command -v flatpak >/dev/null 2>&1 && echo 'found'" },
  { name: "snap", command: "command -v snap >/dev/null 2>&1 && echo 'found'" },
];

export function getPackageManagerDetectionCommands(): PackageManagerDetectionCommand[] {
  return DETECTION_COMMANDS.map((entry) => ({ ...entry }));
}

export async function detectPackageManagers(
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<string[]> {
  const detected: string[] = [];

  for (const { name, command } of DETECTION_COMMANDS) {
    const { stdout, exitCode } = await sshManager.runCommand(conn, command, 10);
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
