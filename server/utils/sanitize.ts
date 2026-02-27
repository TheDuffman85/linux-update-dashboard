/**
 * Sanitize sensitive information from command output, commands, and error messages
 * before they are sent to WebSocket clients, stored in the database, or logged.
 */

// ── Output / error sanitization ──────────────────────────────────────────────

const SENSITIVE_OUTPUT_PATTERNS: [RegExp, string][] = [
  // Sudo password prompts: [sudo] password for user:
  [/\[sudo\] password for \S+:/g, "[sudo] password for ***:"],
  // Generic "Password:" prompts (case-insensitive)
  [/^Password:\s*$/gim, "Password: ***"],
  // Sudo failure messages that may reveal usernames
  [
    /sudo:\s+\d+ incorrect password attempt/g,
    "sudo: incorrect password attempt",
  ],
  // URLs with embedded credentials: https://user:token@host/...
  [
    /(?<=\/\/)[^/@\s]+:[^/@\s]+(?=@)/g,
    "***:***",
  ],
  // Environment-style secret assignments: PASSWORD=value, SECRET_KEY=value, etc.
  [
    /\b(PASSWORD|PASSWD|SECRET|SECRET_KEY|TOKEN|ACCESS_TOKEN|API_KEY|PRIVATE_KEY|PASSPHRASE|CREDENTIAL|AUTH)\s*=\s*\S+/gi,
    "$1=***",
  ],
  // PEM private key blocks
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  ],
];

/** Redact sensitive patterns from command output or error text. */
export function sanitizeOutput(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_OUTPUT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Command display sanitization ─────────────────────────────────────────────

// Matches the verbose sudo() wrapper from server/ssh/parsers/types.ts:
//   if [ "$(id -u)" = "0" ]; then CMD; elif command -v sudo >/dev/null 2>&1; then sudo -S CMD; else CMD; fi
const SUDO_WRAPPER_RE =
  /if \[ "\$\(id -u\)" = "0" \]; then (.+?); elif command -v sudo >\/dev\/null 2>&1; then sudo -S \1; else \1; fi/g;

/**
 * Simplify the verbose sudo() shell wrapper into a readable "sudo CMD" form.
 * Non-sudo commands are returned unchanged.
 */
export function sanitizeCommand(command: string): string {
  return command.replace(SUDO_WRAPPER_RE, "sudo $1");
}
