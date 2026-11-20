import { sudo } from "./parsers/types";

/**
 * Restarts the one service in `{{service}}`. The dashboard runs it once per
 * service, so each run delivers the sudo password once and matches an exact
 * per-service sudoers rule. Only running services restart: the list comes from
 * an earlier scan, and a service stopped since then must stay stopped.
 */
export function getRestartServiceCommand(): string {
  return [
    "# Restart one service that still runs replaced binaries or libraries.",
    "if [ -d /run/systemd/system ]; then",
    "  # Sudoers-relevant command: systemctl try-restart -- {{service}}",
    `  ${sudo("systemctl try-restart -- {{service}}")} 2>&1`,
    "elif command -v rc-service >/dev/null 2>&1; then",
    "  # Sudoers-relevant command: rc-service --ifstarted {{service}} restart",
    `  ${sudo("rc-service --ifstarted {{service}} restart")} 2>&1`,
    "else",
    "  echo \"No supported init system found (systemd or OpenRC).\"",
    "  exit 1",
    "fi",
  ].join("\n");
}
