import { describe, expect, test } from "bun:test";
import { wrapRemoteCommand } from "../../server/ssh/connection";
import { sanitizeCommand } from "../../server/utils/sanitize";

describe("sanitizeCommand", () => {
  test("strips the POSIX shell transport wrapper", () => {
    const command = wrapRemoteCommand("echo ok");
    expect(sanitizeCommand(command)).toBe(
      "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; echo ok"
    );
  });

  test("strips the shell wrapper before simplifying sudo", () => {
    const command = wrapRemoteCommand(
      'if [ "$(id -u)" = "0" ]; then apt-get upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S apt-get upgrade -y; else apt-get upgrade -y; fi 2>&1'
    );
    expect(sanitizeCommand(command)).toBe(
      "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; sudo apt-get upgrade -y 2>&1"
    );
  });

  test("unescapes single quotes from wrapped commands", () => {
    const command = wrapRemoteCommand(`printf '%s\\n' "it's fine"`);
    expect(sanitizeCommand(command)).toBe(
      `export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; printf '%s\\n' "it's fine"`
    );
  });
});
