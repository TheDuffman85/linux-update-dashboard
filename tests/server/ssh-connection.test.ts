import { describe, expect, test } from "bun:test";
import {
  buildPersistentSetupCommand,
  buildTestConnectionFailureMessage,
  buildTailMonitorCommand,
  preparePersistentSudoCommand,
  wrapRemoteCommand,
} from "../../server/ssh/connection";

describe("wrapRemoteCommand", () => {
  test("wraps commands in a POSIX shell with PATH and locale setup", () => {
    const wrapped = wrapRemoteCommand("echo ok");
    expect(wrapped).toBe(
      "sh -lc 'export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; echo ok'"
    );
  });

  test("escapes single quotes in the wrapped payload", () => {
    const wrapped = wrapRemoteCommand("printf '%s\\n' \"it's fine\"");
    expect(wrapped).toContain(`printf '"'"'%s\\n'"'"' "it'"'"'s fine"`);
  });
});

describe("preparePersistentSudoCommand", () => {
  test("returns command unchanged when sudo -S is absent", () => {
    const cmd = "apt-get update -qq 2>&1";
    expect(preparePersistentSudoCommand(cmd)).toBe(cmd);
  });

  test("replaces sudo -S with sudo -n", () => {
    const cmd =
      'if [ "$(id -u)" = "0" ]; then apt-get upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S apt-get upgrade -y; else apt-get upgrade -y; fi 2>&1';
    const out = preparePersistentSudoCommand(cmd);
    expect(out).toContain("then sudo -n apt-get upgrade -y");
    expect(out).not.toContain("then sudo -S apt-get");
  });

  test("replaces every sudo -S occurrence", () => {
    const out = preparePersistentSudoCommand(
      "sudo -S apt-get update && sudo -S apt-get upgrade"
    );
    expect((out.match(/sudo -n/g) || []).length).toBe(2);
    expect((out.match(/sudo -S/g) || []).length).toBe(0);
  });

  test("still produces a wrapped command without sudo stdin usage", () => {
    const prepared = preparePersistentSudoCommand(
      "sudo -S apt-get update && sudo -S apt-get upgrade"
    );
    const wrapped = wrapRemoteCommand(prepared);
    expect(wrapped).toContain("sh -lc");
    expect(wrapped).toContain("sudo -n apt-get update && sudo -n apt-get upgrade");
    expect(wrapped).not.toContain("sudo -S");
  });
});

describe("buildPersistentSetupCommand", () => {
  test("uses a portable mktemp basename instead of a suffixed template", () => {
    const { setupCmd, useSudoLaunch } = buildPersistentSetupCommand(
      "apk upgrade 2>&1",
      false
    );

    expect(useSudoLaunch).toBe(false);
    expect(setupCmd).toContain('BASE=$(mktemp /tmp/ludash_XXXXXX)');
    expect(setupCmd).toContain('SCRIPT="${BASE}.sh"');
    expect(setupCmd).toContain('LOGFILE="${BASE}.log"');
    expect(setupCmd).toContain('EXITFILE="${BASE}.exit"');
    expect(setupCmd).toContain('rm -f "$BASE"');
    expect(setupCmd).toContain('chmod 700 "$SCRIPT"');
    expect(setupCmd).toContain('nohup sh "$1" "$2" > "$3" 2>&1 < /dev/null &');
    expect(setupCmd).not.toContain('mktemp /tmp/ludash_XXXXXX.sh');
  });

  test("keeps sudo-stdin launch path when a password is provided", () => {
    const command =
      'if [ "$(id -u)" = "0" ]; then apk upgrade; elif command -v sudo >/dev/null 2>&1; then sudo -S apk upgrade; else apk upgrade; fi 2>&1';
    const { setupCmd, useSudoLaunch } = buildPersistentSetupCommand(
      command,
      true
    );

    expect(useSudoLaunch).toBe(true);
    expect(setupCmd).toContain("sudo -S -p ''");
  });
});

describe("buildTailMonitorCommand", () => {
  test("uses a BusyBox-compatible tail monitor", () => {
    const cmd = buildTailMonitorCommand("/tmp/ludash_abc.log", 1234);

    expect(cmd).toContain('tail -F "$LOGFILE" 2>/dev/null &');
    expect(cmd).toContain('while [ -d "/proc/$PID" ]; do sleep 1; done');
    expect(cmd).toContain('kill "$TAILPID" 2>/dev/null || true');
    expect(cmd).not.toContain("tail --pid=");
    expect(cmd).not.toContain("&;");
  });
});

describe("buildTestConnectionFailureMessage", () => {
  test("explains loopback targets when Proxy Jump channel opening fails", () => {
    const message = buildTestConnectionFailureMessage(
      {
        hostname: "localhost",
        proxyJumpSystemId: 17,
      },
      new Error("(SSH) Channel open failure: Connection refused")
    );

    expect(message).toContain("Connection failed: (SSH) Channel open failure: Connection refused");
    expect(message).toContain("localhost is resolved from the jump host");
    expect(message).toContain("Use a host or IP that the jump host can reach instead of loopback");
  });

  test("leaves direct-connection failures unchanged", () => {
    const message = buildTestConnectionFailureMessage(
      {
        hostname: "localhost",
      },
      new Error("(SSH) Channel open failure: Connection refused")
    );

    expect(message).toBe("Connection failed: (SSH) Channel open failure: Connection refused");
  });
});
