import { sudo } from "./parsers/types";

export function getRebootCommand(): string {
  return [
    "# Reboot the remote system using sudo when the current user is not root.",
    sudo("reboot"),
  ].join("\n");
}
