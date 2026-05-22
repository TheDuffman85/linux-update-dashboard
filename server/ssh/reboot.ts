import { sudo } from "./parsers/types";

export function getProxmoxBackupGuardCommand(): string {
  return [
    "# Block rebooting Proxmox VE while backup tasks are running.",
    "if ! command -v pveversion >/dev/null 2>&1 && ! command -v pvesh >/dev/null 2>&1; then",
    "  exit 0",
    "fi",
    "",
    "if ! command -v pvesh >/dev/null 2>&1; then",
    "  echo \"Reboot blocked: Proxmox detected but pvesh is unavailable.\"",
    "  exit 1",
    "fi",
    "",
    "tasks=$(",
    `  ${sudo("pvesh get /cluster/tasks --typefilter vzdump --statusfilter running --output-format json")} 2>&1`,
    ")",
    "status=$?",
    "if [ \"$status\" -ne 0 ]; then",
    "  echo \"Reboot blocked: could not verify Proxmox backup activity.\"",
    "  printf '%s\\n' \"$tasks\"",
    "  exit 1",
    "fi",
    "",
    "if printf '%s\\n' \"$tasks\" | grep -q '\"type\"[[:space:]]*:[[:space:]]*\"vzdump\"' && \\",
    "   printf '%s\\n' \"$tasks\" | grep -q '\"status\"[[:space:]]*:[[:space:]]*\"running\"'; then",
    "  echo \"Reboot blocked: Proxmox backup task is running.\"",
    "  printf '%s\\n' \"$tasks\"",
    "  exit 1",
    "fi",
  ].join("\n");
}

export function getRebootCommand(): string {
  return [
    "# Reboot the remote system using sudo when the current user is not root.",
    sudo("reboot"),
  ].join("\n");
}
