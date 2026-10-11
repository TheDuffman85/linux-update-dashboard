import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import systemsRoutes from "../../server/routes/systems";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { SecretInput } from "../../server/ssh/secret-input";
import {
  REPOSITORY_SOURCE_CONTENT_ENV,
  REPOSITORY_SOURCE_MAX_EDIT_BYTES,
  REPOSITORY_SOURCE_MAX_FILE_BYTES,
  buildRepositorySourceWriteCommand,
  buildRepositorySourcesCommand,
  findRepositorySourceGroup,
  groupRepositorySourcePatterns,
  parseRepositorySourcesOutput,
  redactRepositorySourceContent,
  sha256Hex,
  validateRepositorySourceContent,
  type RepositorySourceFormat,
  type RepositorySourcePatternGroup,
} from "../../server/ssh/repository-sources";
import { buildUnifiedDiff } from "../../server/utils/line-diff";

function encodeLine(index: number, path: string, content: string | Buffer | null): string {
  const encodedPath = Buffer.from(path).toString("base64");
  return content === null
    ? `F\t${index}\t${encodedPath}\tunreadable\t`
    : `F\t${index}\t${encodedPath}\tok\t${Buffer.from(content).toString("base64")}`;
}

function group(
  glob: string,
  format: RepositorySourceFormat = "apt-list",
  editable = true,
  pkgManagers = ["apt"],
): RepositorySourcePatternGroup {
  return { glob, format, editable, pkgManagers };
}

describe("repository source descriptors", () => {
  test("reads a directory shared by dnf and yum once", () => {
    const groups = groupRepositorySourcePatterns(["dnf", "yum", "snap"]);
    const yumRepos = groups.filter((entry) => entry.glob === "/etc/yum.repos.d/*.repo");

    expect(yumRepos).toEqual([group("/etc/yum.repos.d/*.repo", "ini", true, ["dnf", "yum"])]);
    expect(groups.some((entry) => entry.pkgManagers.includes("snap"))).toBe(false);
  });

  test("covers both APT source formats", () => {
    expect(groupRepositorySourcePatterns(["apt"])).toEqual([
      group("/etc/apt/sources.list"),
      group("/etc/apt/sources.list.d/*.list"),
      group("/etc/apt/sources.list.d/*.sources", "deb822"),
    ]);
  });

  test("keeps vendor and flatpak files read-only", () => {
    expect(findRepositorySourceGroup("/usr/share/dnf5/repos.d/fedora.repo", ["dnf"])?.editable).toBe(false);
    expect(findRepositorySourceGroup("/var/lib/flatpak/repo/config", ["flatpak"])?.editable).toBe(false);
  });

  test("matches edit paths only inside the manager's own patterns", () => {
    expect(findRepositorySourceGroup("/etc/apt/sources.list.d/debian.sources", ["apt"])?.format).toBe("deb822");
    expect(findRepositorySourceGroup("/etc/apt/sources.list.d/sub/x.list", ["apt"])).toBeNull();
    expect(findRepositorySourceGroup("/etc/apt/sources.list.d/x.list.save", ["apt"])).toBeNull();
    expect(findRepositorySourceGroup("/etc/yum.repos.d/x.repo", ["apt"])).toBeNull();
  });

  test("rejects globs that could escape their directory", () => {
    expect(() => buildRepositorySourcesCommand([group("/etc/apt/../shadow")]))
      .toThrow("Unsafe repository source path");
    expect(() => buildRepositorySourcesCommand([group("/etc/apt/$(id)")]))
      .toThrow("Unsafe repository source path");
    expect(() => buildRepositorySourceWriteCommand("/etc/apt/sources.list.d/../../shadow"))
      .toThrow("Unsafe repository source path");
    expect(() => buildRepositorySourceWriteCommand("/etc/apt/sources.list.d/a b.list"))
      .toThrow("Unsafe repository source path");
  });
});

describe("repository source output", () => {
  test("parses files and merges managers for duplicate paths", () => {
    const groups = [
      group("/etc/yum.repos.d/*.repo", "ini", true, ["dnf"]),
      group("/etc/yum.repos.d/*.repo", "ini", true, ["yum"]),
    ];
    const stdout = [
      encodeLine(0, "/etc/yum.repos.d/fedora.repo", "[fedora]\nname=Fedora\n"),
      encodeLine(1, "/etc/yum.repos.d/fedora.repo", "[fedora]\nname=Fedora\n"),
      encodeLine(0, "/etc/yum.repos.d/secret.repo", null),
      "garbage line",
      "F\t0\tnot-base64!\tok\t",
      "F\t9\tL2V0Yy94\tok\t",
    ].join("\n");

    expect(parseRepositorySourcesOutput(stdout, groups, { editingEnabled: true })).toEqual([
      {
        path: "/etc/yum.repos.d/fedora.repo",
        format: "ini",
        pkgManagers: ["dnf", "yum"],
        readable: true,
        content: "[fedora]\nname=Fedora\n",
        truncated: false,
        redacted: false,
        sha256: sha256Hex("[fedora]\nname=Fedora\n"),
        editable: true,
        editBlockedReason: null,
      },
      {
        path: "/etc/yum.repos.d/secret.repo",
        format: "ini",
        pkgManagers: ["dnf"],
        readable: false,
        content: null,
        truncated: false,
        redacted: false,
        sha256: null,
        editable: false,
        editBlockedReason: "unreadable",
      },
    ]);
  });

  test("explains why a file cannot be edited", () => {
    const groups = [group("/etc/apt/sources.list.d/*.list"), group("/var/lib/flatpak/repo/config", "ini", false)];
    const reasons = (editingEnabled: boolean) => Object.fromEntries(parseRepositorySourcesOutput([
      encodeLine(0, "/etc/apt/sources.list.d/plain.list", "deb http://deb.debian.org/debian bookworm main\n"),
      encodeLine(0, "/etc/apt/sources.list.d/creds.list", "deb https://u:p@example.com/ stable main\n"),
      encodeLine(0, "/etc/apt/sources.list.d/latin1.list", Buffer.from([0x23, 0xe9, 0x0a])),
      encodeLine(0, "/etc/apt/sources.list.d/big.list", "#".repeat(REPOSITORY_SOURCE_MAX_EDIT_BYTES + 1)),
      encodeLine(0, "/etc/apt/sources.list.d/huge.list", "#".repeat(REPOSITORY_SOURCE_MAX_FILE_BYTES + 1)),
      encodeLine(0, "/etc/apt/sources.list.d/a b.list", "# spaces\n"),
      encodeLine(1, "/var/lib/flatpak/repo/config", "[core]\n"),
    ].join("\n"), groups, { editingEnabled }).map((file) => [file.path.split("/").at(-1), file.editBlockedReason]));

    expect(reasons(true)).toEqual({
      "plain.list": null,
      "creds.list": "redacted",
      "latin1.list": "encoding",
      "big.list": "too_large",
      "huge.list": "truncated",
      "a b.list": "path",
      config: "unsupported",
    });
    expect(reasons(false)["plain.list"]).toBe("disabled");
    expect(reasons(false).config).toBe("unsupported");
  });

  test("masks URL credentials and secret assignments", () => {
    const result = redactRepositorySourceContent([
      "deb https://user:s3cret@apt.example.com/debian bookworm main",
      "deb https://TOKEN@packages.example.com/ stable main",
      "deb http://deb.debian.org/debian bookworm main",
      "password = hunter2",
      "proxy_password=hunter3",
      "X-Repo-Token: abc",
      "Signed-By: /usr/share/keyrings/example.gpg",
    ].join("\n"));

    expect(result.redacted).toBe(true);
    expect(result.content).toBe([
      "deb https://***@apt.example.com/debian bookworm main",
      "deb https://***@packages.example.com/ stable main",
      "deb http://deb.debian.org/debian bookworm main",
      "password = ***",
      "proxy_password=***",
      "X-Repo-Token: ***",
      "Signed-By: /usr/share/keyrings/example.gpg",
    ].join("\n"));
    expect(redactRepositorySourceContent("deb http://deb.debian.org/debian bookworm main").redacted).toBe(false);
  });
});

describe("repository source validation", () => {
  test("checks one-line APT entries", () => {
    expect(validateRepositorySourceContent([
      "# comment",
      "",
      "deb http://deb.debian.org/debian bookworm main contrib",
      "deb [arch=amd64 signed-by=/usr/share/keyrings/x.gpg] https://example.com/apt stable main",
      "deb-src http://deb.debian.org/debian bookworm main",
      "deb file:/srv/repo ./",
    ].join("\n"), "apt-list")).toBeNull();
    expect(validateRepositorySourceContent("deb http://deb.debian.org/debian\n", "apt-list"))
      .toEqual({ line: 1, message: expect.stringContaining("Expected") });
    expect(validateRepositorySourceContent("# ok\nhttp://example.com/ stable main\n", "apt-list")?.line).toBe(2);
  });

  test("checks deb822 stanzas", () => {
    const valid = [
      "# Debian",
      "Types: deb deb-src",
      "URIs: http://deb.debian.org/debian",
      "Suites: bookworm bookworm-updates",
      "Components: main",
      "Signed-By:",
      " -----BEGIN PGP PUBLIC KEY BLOCK-----",
      " .",
      " -----END PGP PUBLIC KEY BLOCK-----",
      "",
      "Types: deb",
      "URIs: http://security.debian.org/debian-security",
      "Suites: bookworm-security",
      "Components: main",
      "",
    ].join("\n");
    expect(validateRepositorySourceContent(valid, "deb822")).toBeNull();
    expect(validateRepositorySourceContent("Types: deb\nURIs: http://x/\n\nTypes: deb\n", "deb822"))
      .toEqual({ line: 1, message: "Entry is missing required field(s): Suites" });
    expect(validateRepositorySourceContent("Types: deb\nnot a field\n", "deb822")?.line).toBe(2);
    expect(validateRepositorySourceContent(" orphan continuation\n", "deb822")?.line).toBe(1);
  });

  test("checks INI section headers and NUL bytes", () => {
    expect(validateRepositorySourceContent("[options]\nColor\nInclude = /etc/pacman.d/mirrorlist\n", "ini")).toBeNull();
    expect(validateRepositorySourceContent("[fedora\nname=x\n", "ini")?.line).toBe(1);
    expect(validateRepositorySourceContent("a\0b", "plain")?.message).toContain("NUL");
  });
});

describe("unified diff", () => {
  test("returns an empty diff for equal content", () => {
    expect(buildUnifiedDiff("/f", "a\nb\n", "a\nb\n")).toBe("");
  });

  test("shows changed lines with context and hunk headers", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9", "10", "11"].join("\n") + "\n";

    expect(buildUnifiedDiff("/etc/apt/sources.list", before, after)).toBe([
      "--- /etc/apt/sources.list",
      "+++ /etc/apt/sources.list",
      "@@ -2,9 +2,10 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
      " 9",
      " 10",
      "+11",
    ].join("\n"));
  });

  test("handles empty files", () => {
    expect(buildUnifiedDiff("/f", "", "deb x y\n")).toBe("--- /f\n+++ /f\n@@ -0,0 +1,1 @@\n+deb x y");
  });
});

describe("repository source shell commands", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-repo-sources-"));
  });

  afterEach(() => {
    try {
      chmodSync(join(tempDir, "sources.list.d"), 0o755);
    } catch {
      // Not created by every test.
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reads matching regular files through a POSIX shell", () => {
    const dir = join(tempDir, "sources.list.d");
    mkdirSync(dir);
    mkdirSync(join(dir, "nested.list"));
    writeFileSync(join(tempDir, "sources.list"), "deb http://deb.debian.org/debian bookworm main\n");
    writeFileSync(join(dir, "with space.list"), "deb https://u:p@example.com/ stable main\n");
    writeFileSync(join(dir, "big.list"), "#".repeat(REPOSITORY_SOURCE_MAX_FILE_BYTES + 10));
    writeFileSync(join(dir, "ignored.list.save"), "deb http://old/ x main\n");
    const groups = [
      group(join(tempDir, "sources.list")),
      group(join(dir, "*.list")),
      group(join(dir, "*.sources"), "deb822"),
    ];

    const stdout = execFileSync("sh", ["-c", buildRepositorySourcesCommand(groups)], { encoding: "utf8" });
    const files = parseRepositorySourcesOutput(stdout, groups);

    expect(files.map((file) => file.path)).toEqual([
      join(tempDir, "sources.list"),
      join(dir, "big.list"),
      join(dir, "with space.list"),
    ]);
    expect(files[0].content).toBe("deb http://deb.debian.org/debian bookworm main\n");
    expect(files[1].truncated).toBe(true);
    expect(files[1].content).toHaveLength(REPOSITORY_SOURCE_MAX_FILE_BYTES);
    expect(files[2]).toMatchObject({ content: "deb https://***@example.com/ stable main\n", redacted: true });
  });

  test.skipIf(process.getuid?.() === 0)("reports files the SSH user cannot read", () => {
    const dir = join(tempDir, "sources.list.d");
    mkdirSync(dir);
    writeFileSync(join(dir, "private.list"), "deb https://example.com/ stable main\n");
    chmodSync(join(dir, "private.list"), 0o000);
    const groups = [group(join(dir, "*.list"))];

    const stdout = execFileSync("sh", ["-c", buildRepositorySourcesCommand(groups)], { encoding: "utf8" });

    expect(parseRepositorySourcesOutput(stdout, groups)).toEqual([
      expect.objectContaining({ path: join(dir, "private.list"), readable: false, content: null }),
    ]);
  });

  function writeFakeSudo(binDir: string, options: { insertDoubleDash: boolean }) {
    mkdirSync(binDir);
    // Behaves like `sudo -S -p '' -e FILE`: reads the password from stdin, runs
    // $SUDO_EDITOR on a temporary copy, and copies the result back.
    writeFileSync(join(binDir, "sudo"), [
      "#!/bin/sh",
      'IFS= read -r pw',
      '[ "$pw" = "sudo-password" ] || { echo "unexpected password: $pw" >&2; exit 9; }',
      'for last; do :; done',
      'tmp=$(mktemp)',
      'cp "$last" "$tmp"',
      `$SUDO_EDITOR ${options.insertDoubleDash ? "-- " : ""}"$tmp" || exit 1`,
      'cat "$tmp" > "$last"',
      'rm -f "$tmp"',
      "",
    ].join("\n"));
    chmodSync(join(binDir, "sudo"), 0o755);
  }

  test.skipIf(process.getuid?.() === 0).each([
    { insertDoubleDash: true },
    { insertDoubleDash: false },
  ])("writes through sudoedit's editor hook (double dash: $insertDoubleDash)", (options) => {
    const target = join(tempDir, "sources.list");
    writeFileSync(target, "deb http://old.example.com/ stable main\n");
    const binDir = join(tempDir, "bin");
    writeFakeSudo(binDir, options);
    const content = "deb http://new.example.com/ stable main\n# ünïcödé\n";
    const secret = new SecretInput([{
      envVar: REPOSITORY_SOURCE_CONTENT_ENV,
      value: Buffer.from(content).toString("base64"),
    }]);

    const stagingDirs = () => readdirSync("/tmp").filter((name) => name.startsWith("ludash_")).sort();
    const before = stagingDirs();

    execFileSync("sh", ["-c", secret.preamble() + buildRepositorySourceWriteCommand(target)], {
      input: `${secret.stdinPrefix()}sudo-password\n`,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(readFileSync(target, "utf8")).toBe(content);
    expect(stagingDirs()).toEqual(before);
  });

  test("refuses symlinks and missing files", () => {
    const real = join(tempDir, "real.list");
    writeFileSync(real, "x\n");
    execFileSync("ln", ["-s", real, join(tempDir, "link.list")]);

    for (const path of [join(tempDir, "link.list"), join(tempDir, "missing.list")]) {
      let status = 0;
      try {
        execFileSync("sh", ["-c", buildRepositorySourceWriteCommand(path)], { stdio: "pipe" });
      } catch (error) {
        status = (error as { status: number }).status;
      }
      expect(status, path).toBe(2);
    }
    expect(readFileSync(real, "utf8")).toBe("x\n");
  });
});

describe("repository sources routes", () => {
  let tempDir: string;
  const debianSources = "Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm\nComponents: main\n";
  const debianSourcesPath = "/etc/apt/sources.list.d/debian.sources";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-repo-sources-route-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(detected: string[], options: { disabled?: string[]; editing?: boolean } = {}) {
    return getDb().insert(systems).values({
      name: "Sources host",
      hostname: "sources.local",
      port: 22,
      authType: "password",
      username: "updater",
      encryptedSudoPassword: getEncryptor().encrypt("sudo-password"),
      pkgManager: detected[0] ?? null,
      detectedPkgManagers: JSON.stringify(detected),
      disabledPkgManagers: JSON.stringify(options.disabled ?? []),
      repositorySourceEditingEnabled: options.editing ? 1 : 0,
    }).returning({ id: systems.id }).get().id;
  }

  function createApp(options: { apiToken?: boolean } = {}) {
    const app = new Hono();
    if (options.apiToken) {
      app.use("*", async (c, next) => {
        c.set("apiToken" as never, true as never);
        await next();
      });
    }
    app.route("/api/systems", systemsRoutes);
    return app;
  }

  function mockSsh(results: Array<{ stdout?: string; stderr?: string; exitCode?: number }>) {
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => ({}));
    (sshManager as any).disconnect = vi.fn();
    const queue = [...results];
    (sshManager as any).runCommand = vi.fn(async () => {
      const next = queue.shift() ?? {};
      return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 };
    });
    return sshManager as any;
  }

  function put(app: Hono, systemId: number, body: Record<string, unknown>) {
    return app.request(`/api/systems/${systemId}/repository-sources`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("returns the files of the active package managers", async () => {
    const systemId = createSystem(["apt", "flatpak", "snap"], { disabled: ["flatpak"] });
    const sshManager = mockSsh([{ stdout: encodeLine(2, debianSourcesPath, debianSources) }]);

    const response = await createApp().request(`/api/systems/${systemId}/repository-sources`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ pkgManagers: ["apt"], unsupportedPkgManagers: ["snap"], editingEnabled: false });
    expect(body.files).toEqual([expect.objectContaining({
      path: debianSourcesPath,
      format: "deb822",
      pkgManagers: ["apt"],
      editable: false,
      editBlockedReason: "disabled",
    })]);
    const command = sshManager.runCommand.mock.calls[0][1] as string;
    expect(command).toContain("/etc/apt/sources.list.d/*.sources");
    expect(command).not.toContain("flatpak");
    expect(command).not.toContain("sudo");
    expect(sshManager.disconnect).toHaveBeenCalledTimes(1);
  });

  test("skips SSH when no active manager has repository sources", async () => {
    const systemId = createSystem(["snap"]);
    const sshManager = mockSsh([]);

    const response = await createApp().request(`/api/systems/${systemId}/repository-sources`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pkgManagers: [], unsupportedPkgManagers: ["snap"], files: [] });
    expect(sshManager.connect).not.toHaveBeenCalled();
  });

  test("returns 502 when the host cannot be read", async () => {
    const systemId = createSystem(["apt"]);
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => {
      throw new Error("Host is offline");
    });

    const response = await createApp().request(`/api/systems/${systemId}/repository-sources`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Host is offline" });
  });

  test("saves a file through sudoedit and records the diff", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    const newContent = debianSources.replace("main", "main contrib");
    const sshManager = mockSsh([
      { stdout: encodeLine(0, debianSourcesPath, debianSources) },
      {},
      { stdout: encodeLine(0, debianSourcesPath, newContent) },
    ]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: newContent,
      baseSha256: sha256Hex(debianSources),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.file).toMatchObject({ path: debianSourcesPath, content: newContent, sha256: sha256Hex(newContent) });
    expect(body.diff).toContain("-Components: main\n+Components: main contrib");

    const [, writeCommand, , sudoPassword, , , options] = sshManager.runCommand.mock.calls[1];
    expect(writeCommand).toContain(`target='${debianSourcesPath}'`);
    expect(writeCommand).toContain("sudo -S -p '' -e \"$target\"");
    expect(writeCommand).not.toContain(Buffer.from(newContent).toString("base64"));
    expect(sudoPassword).toBe("sudo-password");
    expect(options.secretInput.envVars).toEqual([REPOSITORY_SOURCE_CONTENT_ENV]);

    const history = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all();
    expect(history).toEqual([expect.objectContaining({
      action: "repository_source_edit",
      pkgManager: "apt",
      status: "success",
      packages: JSON.stringify([debianSourcesPath]),
      output: expect.stringContaining("+Components: main contrib"),
    })]);
  });

  test("previews the diff without writing on a dry run", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    const sshManager = mockSsh([{ stdout: encodeLine(0, debianSourcesPath, debianSources) }]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: `${debianSources}\n# extra`,
      baseSha256: sha256Hex(debianSources),
      dryRun: true,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ changed: true, diff: expect.stringContaining("+# extra") });
    expect(sshManager.runCommand).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(updateHistory).all()).toEqual([]);
  });

  test("rejects concurrent changes on the host", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    const sshManager = mockSsh([{ stdout: encodeLine(0, debianSourcesPath, `${debianSources}# changed\n`) }]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: debianSources,
      baseSha256: sha256Hex(debianSources),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "conflict" });
    expect(sshManager.runCommand).toHaveBeenCalledTimes(1);
  });

  test("fails when sudoedit did not change the file", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    mockSsh([
      { stdout: encodeLine(0, debianSourcesPath, debianSources) },
      {},
      { stdout: encodeLine(0, debianSourcesPath, debianSources) },
    ]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: `${debianSources}# new\n`,
      baseSha256: sha256Hex(debianSources),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("sudoedit");
    expect(getDb().select().from(updateHistory).all()).toEqual([
      expect.objectContaining({ action: "repository_source_edit", status: "failed" }),
    ]);
  });

  test("reports sudo errors from the write step", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    mockSsh([
      { stdout: encodeLine(0, debianSourcesPath, debianSources) },
      { stderr: "Sorry, user updater is not allowed to execute 'sudoedit /etc/apt/sources.list.d/debian.sources' as root.", exitCode: 1 },
    ]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: `${debianSources}# new\n`,
      baseSha256: sha256Hex(debianSources),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("not allowed to execute 'sudoedit");
  });

  test.each([
    ["editing is disabled", { editing: false }, { content: "deb http://x/ y main\n" }, 403],
    ["the path is outside the patterns", { editing: true }, { path: "/etc/shadow" }, 400],
    ["the path escapes the directory", { editing: true }, { path: "/etc/apt/sources.list.d/../../shadow.list" }, 400],
    ["the content is invalid", { editing: true }, { content: "Types: deb\n" }, 400],
    ["the content is too large", { editing: true }, { content: `#${"x".repeat(REPOSITORY_SOURCE_MAX_EDIT_BYTES)}\n` }, 400],
  ])("rejects saving when %s", async (_label, systemOptions, overrides, status) => {
    const systemId = createSystem(["apt"], systemOptions);
    const sshManager = mockSsh([]);

    const response = await put(createApp(), systemId, {
      path: debianSourcesPath,
      content: debianSources,
      baseSha256: sha256Hex(debianSources),
      ...overrides,
    });

    expect(response.status).toBe(status);
    expect(sshManager.connect).not.toHaveBeenCalled();
  });

  test("returns the failing line for invalid content", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    mockSsh([]);

    const response = await put(createApp(), systemId, {
      path: "/etc/apt/sources.list",
      content: "deb http://deb.debian.org/debian bookworm main\ndeb broken\n",
      baseSha256: "x",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ line: 2, error: expect.stringContaining("Line 2") });
  });

  test("does not let API tokens edit repository sources", async () => {
    const systemId = createSystem(["apt"], { editing: true });
    const sshManager = mockSsh([]);

    const response = await put(createApp({ apiToken: true }), systemId, {
      path: debianSourcesPath,
      content: debianSources,
      baseSha256: sha256Hex(debianSources),
    });

    expect(response.status).toBe(403);
    expect(sshManager.connect).not.toHaveBeenCalled();
  });
});
