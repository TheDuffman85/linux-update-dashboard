import { describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import { inspect } from "util";
import { getEncryptor, initEncryptor } from "../../server/security";
import {
  buildPersistentSetupCommand,
  initSSHManager,
} from "../../server/ssh/connection";
import {
  redactSecretValues,
  SecretInput,
  StreamRedactor,
} from "../../server/ssh/secret-input";

const TOKEN = "ghp_exampleTokenValue1234567890";

function fakeExec() {
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    end: (input?: string) => void;
  };
  stream.stderr = new EventEmitter();
  const calls: { command: string; stdin: string | undefined }[] = [];
  const conn = new EventEmitter() as EventEmitter & {
    exec: (command: string, callback: (err: Error | null, channel: typeof stream) => void) => void;
  };
  let pendingOutput: Array<[string, string]> = [];
  conn.exec = (command, callback) => {
    stream.end = (input?: string) => {
      calls[calls.length - 1].stdin = input;
      queueMicrotask(() => {
        for (const [channel, chunk] of pendingOutput) {
          if (channel === "stdout") stream.emit("data", Buffer.from(chunk));
          else stream.stderr.emit("data", Buffer.from(chunk));
        }
        stream.emit("close", 0);
      });
    };
    calls.push({ command, stdin: undefined });
    callback(null, stream);
  };
  return {
    conn,
    calls,
    setOutput(output: Array<[string, string]>) {
      pendingOutput = output;
    },
  };
}

describe("SecretInput", () => {
  test("builds a preamble with variable names only", () => {
    const input = new SecretInput([{ envVar: "DEBGET_TOKEN", value: TOKEN }]);
    const preamble = input.preamble();

    expect(preamble).toContain("IFS= read -r DEBGET_TOKEN");
    expect(preamble).toContain("export DEBGET_TOKEN");
    expect(preamble).not.toContain(TOKEN);
    expect(input.stdinPrefix()).toBe(`${TOKEN}\n`);
  });

  test("never serializes values", () => {
    const input = new SecretInput([{ envVar: "DEBGET_TOKEN", value: TOKEN }]);

    expect(JSON.stringify({ input })).not.toContain(TOKEN);
    expect(String(input)).not.toContain(TOKEN);
    expect(inspect(input)).not.toContain(TOKEN);
  });

  test("rejects invalid names and multi-line values", () => {
    expect(() => new SecretInput([{ envVar: "bad-name", value: "x" }])).toThrow();
    expect(() => new SecretInput([{ envVar: "TOKEN", value: "a\nb" }])).toThrow();
    expect(() => new SecretInput([
      { envVar: "TOKEN", value: "a" },
      { envVar: "TOKEN", value: "b" },
    ])).toThrow();
  });
});

describe("secret redaction", () => {
  test("redacts complete values", () => {
    expect(redactSecretValues(`auth ${TOKEN} ok`, [TOKEN])).toBe("auth *** ok");
  });

  test("redacts values split across chunks without delaying normal output", () => {
    const redactor = new StreamRedactor([TOKEN]);
    const emitted = [
      redactor.push("plain line\n"),
      redactor.push(`token=${TOKEN.slice(0, 10)}`),
      redactor.push(`${TOKEN.slice(10)} done\n`),
      redactor.flush(),
    ];

    expect(emitted[0]).toBe("plain line\n");
    expect(emitted.join("")).toBe("plain line\ntoken=*** done\n");
    expect(emitted.join("")).not.toContain(TOKEN.slice(0, 10));
  });

  test("flushes a held-back prefix that never completes a secret", () => {
    const redactor = new StreamRedactor([TOKEN]);
    const out = redactor.push("ends with ghp_") + redactor.flush();
    expect(out).toBe("ends with ghp_");
  });

  test("does not redact very short values", () => {
    expect(redactSecretValues("a b c", ["b"])).toBe("a b c");
  });
});

describe("SSHConnectionManager.runCommand with secrets", () => {
  test("prepends the preamble and sends secrets before the sudo password", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const { conn, calls } = fakeExec();
    const secretInput = new SecretInput([{ envVar: "DEBGET_TOKEN", value: TOKEN }]);

    const result = await manager.runCommand(
      conn as any,
      "sudo -S -p '' deb-get show obsidian",
      1,
      "sudo-pass",
      undefined,
      undefined,
      { secretInput },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0].command).toContain("IFS= read -r DEBGET_TOKEN");
    expect(calls[0].command).not.toContain(TOKEN);
    expect(calls[0].stdin).toBe(`${TOKEN}\nsudo-pass\n`);
  });

  test("redacts secret values from streamed and returned output", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const { conn, setOutput } = fakeExec();
    setOutput([
      ["stdout", `Authorization: token ${TOKEN.slice(0, 7)}`],
      ["stdout", `${TOKEN.slice(7)}\n`],
      ["stderr", `curl: header ${TOKEN}\n`],
    ]);
    const secretInput = new SecretInput([{ envVar: "DEBGET_TOKEN", value: TOKEN }]);
    const streamed: string[] = [];

    const result = await manager.runCommand(
      conn as any,
      "deb-get show obsidian",
      1,
      undefined,
      (chunk) => streamed.push(chunk),
      undefined,
      { secretInput },
    );

    expect(result.stdout).toBe("Authorization: token ***\n");
    expect(result.stderr).toBe("curl: header ***\n");
    expect(streamed.join("")).not.toContain(TOKEN.slice(0, 7) + TOKEN.slice(7, 10));
    expect(streamed.join("")).toContain("***");
  });

  test("keeps the existing behavior without secrets", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const { conn, calls } = fakeExec();

    await manager.runCommand(conn as any, "echo ok", 1, undefined, undefined, undefined, {
      secretInput: new SecretInput([]),
    });

    expect(calls[0].command).not.toContain("read -r");
    expect(calls[0].stdin).toBeUndefined();
  });
});

describe("buildPersistentSetupCommand with secrets", () => {
  test("pipes stdin into the script even without a sudo password", () => {
    const preamble = new SecretInput([{ envVar: "DEBGET_TOKEN", value: TOKEN }]).preamble();
    const { setupCmd, useSudoStdin, useStdinPipe } = buildPersistentSetupCommand(
      "sudo -S -p '' deb-get upgrade --dg-only 2>&1",
      false,
      preamble,
    );
    const script = Buffer.from(/printf '%s' '([^']+)'/.exec(setupCmd)![1], "base64").toString();

    expect(useSudoStdin).toBe(false);
    expect(useStdinPipe).toBe(true);
    expect(setupCmd).toContain('mkfifo "$STDINFILE"');
    expect(setupCmd).toContain('< "$4"');
    expect(script).toContain("IFS= read -r DEBGET_TOKEN");
    expect(script).toContain("sudo -n deb-get upgrade --dg-only");
    expect(script).not.toContain(TOKEN);
    expect(setupCmd).not.toContain(TOKEN);
  });

  test("keeps /dev/null stdin when there is neither a secret nor a password", () => {
    const { setupCmd, useStdinPipe } = buildPersistentSetupCommand("apk upgrade 2>&1", false);

    expect(useStdinPipe).toBe(false);
    expect(setupCmd).toContain("< /dev/null");
    expect(setupCmd).not.toContain("mkfifo");
  });
});
