import { describe, expect, test } from "vitest";
import { wrapRemoteCommand } from "../../server/ssh/connection";
import { sudo } from "../../server/ssh/parsers/types";
import { getRebootCommand } from "../../server/ssh/reboot";
import { sanitizeCommand, sanitizeOutput } from "../../server/utils/sanitize";

describe("sanitizeCommand", () => {
  test("strips the POSIX shell transport wrapper", () => {
    const command = wrapRemoteCommand("echo ok");
    expect(sanitizeCommand(command)).toBe(
      "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; echo ok"
    );
  });

  test("strips the shell wrapper while preserving the runtime sudo helper", () => {
    const runtimeCommand =
      `if [ "$(id -u)" = "0" ]; then apt-get upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' apt-get upgrade -y; else apt-get upgrade -y; fi 2>&1`;
    const command = wrapRemoteCommand(runtimeCommand);
    expect(sanitizeCommand(command)).toBe(
      `export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ${runtimeCommand}`
    );
  });

  test("preserves compact sudo wrappers built by the shared helper", () => {
    const command = `${sudo("apt-get update -qq")} 2>&1`;
    expect(sanitizeCommand(command)).toBe(command);
  });

  test("preserves multiline scripts instead of abbreviating their sudo wrappers", () => {
    const command = getRebootCommand();
    expect(sanitizeCommand(command)).toBe(command);
  });

  test("unescapes single quotes from wrapped commands", () => {
    const command = wrapRemoteCommand(`printf '%s\\n' "it's fine"`);
    expect(sanitizeCommand(command)).toBe(
      `export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; printf '%s\\n' "it's fine"`
    );
  });
});

describe("sanitizeOutput", () => {
  test("redacts plaintext password and passphrase-like pairs", () => {
    expect(
      sanitizeOutput('password=hunter2 passphrase: "letmein" api_key=abcdef')
    ).toBe('password=*** passphrase: *** api_key=***');
  });

  test("redacts embedded credentials and private keys", () => {
    expect(
      sanitizeOutput(
        "https://user:secret@example.com\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
      )
    ).toBe("https://***:***@example.com\n[REDACTED PRIVATE KEY]");
  });
});
