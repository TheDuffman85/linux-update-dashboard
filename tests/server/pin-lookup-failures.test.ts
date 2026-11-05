import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { flatpakParser, FLATPAK_CHECK_COMMAND } from "../../server/ssh/parsers/flatpak";
import { snapParser, SNAP_CHECK_COMMAND } from "../../server/ssh/parsers/snap";
import { debGetParser, debGetCheckScript, DEB_GET_INSTALLED_FILE } from "../../server/ssh/parsers/deb-get";
import { getCustomCheckErrorMessage, getBuiltinScripts } from "../../server/services/script-service";
import type { PackageParser } from "../../server/ssh/parsers/types";

const cases = [
  { manager: "flatpak", parser: flatpakParser, command: FLATPAK_CHECK_COMMAND, warning: "Could not read Flatpak masks" },
  { manager: "snap", parser: snapParser, command: SNAP_CHECK_COMMAND, warning: "Could not list installed snaps" },
  { manager: "deb-get", parser: debGetParser, command: debGetCheckScript(), warning: "Could not read APT holds" },
];

describe("optional pin lookups", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ludash-pin-lookups-"));
    const failLookup = 'if [ "$LUDASH_FAIL_LOOKUP" = 1 ]; then echo "pin lookup failed" >&2; exit 42; fi';
    const failUpdates = 'if [ "$LUDASH_FAIL_UPDATES" = 1 ]; then echo "update lookup failed" >&2; exit 43; fi';
    const scripts: Record<string, string> = {
      flatpak: [
        'case "$1" in',
        "list)",
        '  printf "org.example.App\\t1.0\\norg.example.Free\\t1.0\\n"',
        '  if [ "$LUDASH_FAIL_INSTALLED" = 1 ]; then echo "installed lookup failed" >&2; exit 44; fi;;',
        "mask)",
        '  if [ "$LUDASH_EMPTY_PINS" != 1 ]; then echo org.example.App; fi',
        // Deliberately print valid-looking partial data before failing.
        `  ${failLookup};;`,
        "remote-ls)",
        `  ${failUpdates}`,
        '  printf "Example\\torg.example.App\\t2.0\\tstable\\tflathub\\tapp/org.example.App/x86_64/stable\\n"',
        '  printf "Free\\torg.example.Free\\t2.0\\tstable\\tflathub\\tapp/org.example.Free/x86_64/stable\\n";;',
        "esac",
      ].join("\n"),
      snap: [
        'case "$1" in',
        "list)",
        '  if [ "$LUDASH_NO_SNAPS" = 1 ]; then echo "No snaps are installed yet." >&2; exit 0; fi',
        '  notes=held; if [ "$LUDASH_EMPTY_PINS" = 1 ]; then notes=-; fi',
        '  printf "Name Version Rev Tracking Publisher Notes\\nexample 1.0 1 latest/stable publisher %s\\nfree 1.0 1 latest/stable publisher -\\n" "$notes"',
        `  ${failLookup};;`,
        "refresh)",
        `  ${failUpdates}`,
        '  if [ "$LUDASH_UP_TO_DATE" = 1 ]; then echo "All snaps up to date." >&2; exit 0; fi',
        '  printf "Name Version Rev Publisher Notes\\nexample 2.0 2 publisher -\\nfree 2.0 2 publisher -\\n";;',
        "esac",
      ].join("\n"),
      "apt-mark": `if [ "$LUDASH_EMPTY_PINS" != 1 ]; then echo example; fi\n${failLookup}`,
      "deb-get": `${failUpdates}\nprintf 'Updater:\\tdeb-get\\nInstalled:\\t1.0\\nPublished:\\t2.0\\n'`,
      id: "echo 0",
      dpkg: "exit 0",
    };
    for (const [name, script] of Object.entries(scripts)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    }
    writeFileSync(join(dir, "installed"), "example 1 direct\nfree 1 direct\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(command: string, env: Record<string, string> = {}) {
    const shell = spawnSync("/bin/sh", ["-c", command.replaceAll(DEB_GET_INSTALLED_FILE, join(dir, "installed"))], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    });
    if (shell.error) throw shell.error;
    expect(shell.status).not.toBeNull();
    return { command, stdout: shell.stdout, stderr: shell.stderr, exitCode: shell.status! };
  }

  function updates(parser: PackageParser, result: ReturnType<typeof run>) {
    return parser.parseCheckOutput(result.stdout, result.stderr, result.exitCode);
  }

  test.each(cases)("$manager detects pins and emits no warning on success", ({ parser, command }) => {
    const result = run(command);
    expect(result.exitCode).toBe(0);
    expect(updates(parser, result).map((update) => update.isKeptBack)).toEqual([true, false]);
    expect(parser.getCheckWarningMessage!(result)).toBeNull();
  });

  test.each(cases)("$manager warns, preserves updates and rejects partial pin data on lookup failure", ({ parser, command, warning }) => {
    const result = run(command, { LUDASH_FAIL_LOOKUP: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("pin lookup failed");
    const parsed = updates(parser, result);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((update) => update.isKeptBack)).toEqual([false, false]);
    expect(parsed.every((update) => update.newVersion === "2.0")).toBe(true);
    expect(parser.getCheckWarningMessage!(result)).toContain(warning);
    if (parser.name === "snap") expect(parsed.every((update) => update.currentVersion === null)).toBe(true);
  });

  test.each(cases)("$manager reports incomplete pin detection only when its pin lookup failed", ({ parser, command }) => {
    expect(parser.isPinDetectionIncomplete!([run(command)])).toBe(false);
    expect(parser.isPinDetectionIncomplete!([run(command, { LUDASH_EMPTY_PINS: "1" })])).toBe(false);
    expect(parser.isPinDetectionIncomplete!([run(command, { LUDASH_FAIL_LOOKUP: "1" })])).toBe(true);
  });

  test("Flatpak pin detection stays complete when only the installed list failed", () => {
    expect(flatpakParser.isPinDetectionIncomplete!([run(FLATPAK_CHECK_COMMAND, { LUDASH_FAIL_INSTALLED: "1" })])).toBe(false);
  });

  test("Snap does not surface informational stderr as an error", () => {
    const upToDate = run(SNAP_CHECK_COMMAND, { LUDASH_UP_TO_DATE: "1" });
    expect(upToDate.exitCode).toBe(0);
    expect(upToDate.stderr).toBe("");
    expect(updates(snapParser, upToDate)).toEqual([]);

    const noSnaps = run(SNAP_CHECK_COMMAND, { LUDASH_NO_SNAPS: "1", LUDASH_UP_TO_DATE: "1" });
    expect(noSnaps.exitCode).toBe(0);
    expect(noSnaps.stderr).toBe("");
    expect(noSnaps.stdout).toContain("No snaps are installed yet.");
    expect(updates(snapParser, noSnaps)).toEqual([]);
    expect(snapParser.getCheckWarningMessage!(noSnaps)).toBeNull();
  });

  test("Snap keeps the refresh exit status and error text on failure", () => {
    const result = run(SNAP_CHECK_COMMAND, { LUDASH_FAIL_UPDATES: "1" });
    expect(result.exitCode).toBe(43);
    expect(result.stderr).toContain("update lookup failed");
  });

  test.each(cases)("$manager does not confuse empty pins with failed lookup", ({ parser, command }) => {
    const result = run(command, { LUDASH_EMPTY_PINS: "1" });
    expect(result.exitCode).toBe(0);
    expect(updates(parser, result).map((update) => update.isKeptBack)).toEqual([false, false]);
    expect(parser.getCheckWarningMessage!(result)).toBeNull();
  });

  test.each(cases)("$manager still fails when the update listing itself fails", ({ command }) => {
    const result = run(command, { LUDASH_FAIL_LOOKUP: "1", LUDASH_FAIL_UPDATES: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(getCustomCheckErrorMessage(null, result.stdout, result.stderr, result.exitCode)).toContain("update lookup failed");
  });

  test.each(cases)("$manager runtime uses the same probes as the parser", ({ manager, command }) => {
    const script = getBuiltinScripts().find((entry) => entry.pkgManager === manager && entry.operation === "check_updates");
    expect(script?.steps.some((step) => step.command.includes(command))).toBe(true);
  });

  test("Flatpak reports an installed-list failure independently of mask detection", () => {
    const result = run(FLATPAK_CHECK_COMMAND, { LUDASH_FAIL_INSTALLED: "1" });
    expect(result.exitCode).toBe(0);
    expect(updates(flatpakParser, result).map((update) => [update.currentVersion, update.isKeptBack]))
      .toEqual([[null, true], [null, false]]);
    expect(flatpakParser.getCheckWarningMessage!(result)).toContain("Could not list installed Flatpaks");
    expect(flatpakParser.getCheckWarningMessage!(result)).not.toContain("Could not read Flatpak masks");
  });

  test("Flatpak reports both failed optional probes", () => {
    const result = run(FLATPAK_CHECK_COMMAND, { LUDASH_FAIL_INSTALLED: "1", LUDASH_FAIL_LOOKUP: "1" });
    expect(flatpakParser.getCheckWarningMessage!(result)).toContain("Could not list installed Flatpaks");
    expect(flatpakParser.getCheckWarningMessage!(result)).toContain("Could not read Flatpak masks");
  });
});
