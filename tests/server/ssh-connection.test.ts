import { describe, expect, test } from "bun:test";
import {
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
