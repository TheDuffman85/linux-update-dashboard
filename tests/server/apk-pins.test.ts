import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { apkParser, APK_READ_WORLD_COMMAND, APK_SIMULATE_UPGRADE_COMMAND } from "../../server/ssh/parsers/apk";
import type { CheckCommandResult } from "../../server/ssh/parsers/types";
import { APK_FAILED_SIMULATION, APK_PINNED_LIST, APK_PINNED_WORLD } from "../fixtures/apk-pins";

function result(command: string, stdout: string, exitCode = 0): CheckCommandResult {
  return { command, stdout, stderr: "", exitCode };
}

function parse(world: string | null, simulation: string | null = APK_FAILED_SIMULATION) {
  const commandResults = [result("apk list -u 2>/dev/null", APK_PINNED_LIST)];
  if (world !== null) commandResults.push(result(APK_READ_WORLD_COMMAND, world));
  if (simulation !== null) commandResults.push(result(APK_SIMULATE_UPGRADE_COMMAND, simulation));
  return apkParser.parseCheckOutput("", "", 0, { commandResults });
}

describe("APK exact-version pins", () => {
  test.each([APK_FAILED_SIMULATION, "", null])("keeps explicit installed-version pins when simulation is unavailable (%s)", (simulation) => {
    const updates = parse(APK_PINNED_WORLD + "\n===LUDASH_APK_WORLD_STATUS:0===\n", simulation);
    expect(updates.map(({ packageName, isKeptBack }) => [packageName, isKeptBack])).toEqual([
      ["base-files", true], ["kernel", true], ["zlib", false],
    ]);
  });

  test("supports tagged pins and surrounding whitespace", () => {
    const updates = parse(" \tbase-files@custom=1~981c978eff\r\n");
    expect(updates[0].isKeptBack).toBe(true);
    expect(updates[1].isKeptBack).toBe(false);
  });

  test.each([
    "base-files>=1~981c978eff", "base-files<=1~981c978eff",
    "base-files>1~981c978eff", "base-files<1~981c978eff",
    "base-files~1", "base-files=~1", "base-files~=1",
    "base-files@custom", "base-files", "!base-files=1~981c978eff",
    "#base-files=1~981c978eff", "base-files=", "other=1~981c978eff",
  ])("does not infer a frozen version from %s", (world) => {
    expect(parse(world).every((update) => !update.isKeptBack)).toBe(true);
  });

  test("does not hide an update to an exact pin different from the installed version", () => {
    const updates = parse("base-files=1718~981c978eff");
    expect(updates[0]).toMatchObject({ newVersion: "1718~981c978eff", isKeptBack: false });
  });

  test("still uses successful simulation for indirect holds and target versions", () => {
    const updates = parse("base-files=1718~981c978eff", [
      "(1/2) Upgrading base-files (1~981c978eff -> 1718~981c978eff)",
      "(2/2) Upgrading zlib (1.3.1-r1 -> 1.3.1-r2)",
      "OK: 11.3 MiB in 136 packages",
      "===LUDASH_APK_SIMULATION_STATUS:0===",
    ].join("\n"));
    expect(updates.map(({ packageName, newVersion, isKeptBack }) => [packageName, newVersion, isKeptBack])).toEqual([
      ["base-files", "1718~981c978eff", false],
      ["kernel", "6.12.112~b4125196ecec75391093e1e2edeba490-r1", true],
      ["zlib", "1.3.1-r2", false],
    ]);
  });

  test("ignores partial world output after a failed read", () => {
    const world = APK_PINNED_WORLD + "\n===LUDASH_APK_WORLD_STATUS:1===\n";
    expect(parse(world).every((update) => !update.isKeptBack)).toBe(true);
    expect(apkParser.getCheckWarningMessage!(result(APK_READ_WORLD_COMMAND, world)))
      .toContain("Could not read /etc/apk/world");
  });

  test("still detects holds through simulation when the world read fails", () => {
    expect(parse("===LUDASH_APK_WORLD_STATUS:1===\n", "OK: 11 MiB in 136 packages\n")
      .every((update) => update.isKeptBack)).toBe(true);
  });

  test("keeps old check scripts compatible when world data is absent", () => {
    expect(parse(null, "OK: 11 MiB in 136 packages\n").every((update) => update.isKeptBack)).toBe(true);
    expect(parse(null, null).every((update) => !update.isKeptBack)).toBe(true);
  });
});

describe("APK pin detection completeness", () => {
  const ok = "OK: 11 MiB in 136 packages\n===LUDASH_APK_SIMULATION_STATUS:0===\n";
  const worldFailed = result(APK_READ_WORLD_COMMAND, "===LUDASH_APK_WORLD_STATUS:1===\n");

  const worldOk = result(APK_READ_WORLD_COMMAND, "===LUDASH_APK_WORLD_STATUS:0===\n");
  const listing = result("apk list -u", APK_PINNED_LIST);
  const failedSimulation = result(APK_SIMULATE_UPGRADE_COMMAND, APK_FAILED_SIMULATION);
  const okSimulation = result(APK_SIMULATE_UPGRADE_COMMAND, ok);

  test.each([
    ["failed simulation", [failedSimulation], true],
    ["failed simulation with a readable world", [worldOk, failedSimulation], true],
    ["failed simulation and world read", [worldFailed, failedSimulation], true],
    ["successful simulation", [okSimulation], false],
    ["successful simulation with an unreadable world", [worldFailed, okSimulation], false],
    ["failed world read without a simulation step", [listing, worldFailed], true],
    ["world command that exited non-zero without a simulation step", [listing, result("cat /etc/apk/world", "", 1)], true],
    ["readable world without a simulation step", [listing, worldOk], false],
    ["no detection steps", [listing], false],
  ])("%s", (_name, commandResults, expected) => {
    expect(apkParser.isPinDetectionIncomplete!(commandResults)).toBe(expected);
  });
});

describe("APK simulation warning wording", () => {
  const failed = result(APK_SIMULATE_UPGRADE_COMMAND, APK_FAILED_SIMULATION);

  test("mentions the exact-pin fallback only when the world file was read", () => {
    const worldOk = result(APK_READ_WORLD_COMMAND, "===LUDASH_APK_WORLD_STATUS:0===\n");
    expect(apkParser.getCheckWarningMessage!(failed, { commandResults: [worldOk] }))
      .toContain("Only exact pins matching installed versions can be detected");
  });

  test.each([
    ["the world read failed", [result(APK_READ_WORLD_COMMAND, "===LUDASH_APK_WORLD_STATUS:1===\n")]],
    ["an older script has no world step", [result("apk list -u", APK_PINNED_LIST)]],
    ["no earlier steps are known", undefined],
  ])("does not promise the fallback when %s", (_name, commandResults) => {
    const warning = apkParser.getCheckWarningMessage!(failed, commandResults && { commandResults });
    expect(warning).not.toContain("Only exact pins");
    expect(warning).toContain("neither exact pins nor dependency-based holds could be determined");
  });

  test("always says that earlier pins are kept", () => {
    expect(apkParser.getCheckWarningMessage!(failed)).toContain("Pins found by earlier checks are kept");
  });
});

describe("APK probe warnings", () => {
  test("captures a failing simulation status even if it printed an earlier OK line", () => {
    const command = 'apk() { printf "OK: partial output\\n"; return 99; }\n' + APK_SIMULATE_UPGRADE_COMMAND;
    const shell = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toContain("===LUDASH_APK_SIMULATION_STATUS:99===");
    const warning = apkParser.getCheckWarningMessage!(result(APK_SIMULATE_UPGRADE_COMMAND, shell.stdout));
    expect(warning).toContain("failed (exit code 99)");
    expect(parse(APK_PINNED_WORLD, shell.stdout).map((update) => update.isKeptBack)).toEqual([true, true, false]);
  });

  test("captures a failed world read without aborting the check", () => {
    const command = 'cat() { printf "Permission denied\\n" >&2; return 1; }\n' + APK_READ_WORLD_COMMAND;
    const shell = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toContain("Permission denied");
    expect(apkParser.getCheckWarningMessage!(result(APK_READ_WORLD_COMMAND, shell.stdout)))
      .toContain("Could not read /etc/apk/world");
  });

  test.each(["", "ERROR: unable to select packages\n"])("warns for older simulation commands that swallowed failure (%s)", (stdout) => {
    expect(apkParser.getCheckWarningMessage!(result("apk upgrade --simulate 2>&1 || true", stdout)))
      .toContain("did not report a successful result");
  });

  test("rejects a failed command even if its output says OK", () => {
    const commandResults = [
      result("apk list -u", APK_PINNED_LIST),
      result(APK_SIMULATE_UPGRADE_COMMAND, "OK: 11 MiB in 136 packages\n", 1),
    ];
    expect(apkParser.parseCheckOutput("", "", 0, { commandResults }).every((update) => !update.isKeptBack)).toBe(true);
  });

  test("does not warn for successful probes or unrelated check steps", () => {
    for (const step of [
      result(APK_READ_WORLD_COMMAND, "===LUDASH_APK_WORLD_STATUS:0===\n"),
      result(APK_SIMULATE_UPGRADE_COMMAND, "OK: 11 MiB in 136 packages\n===LUDASH_APK_SIMULATION_STATUS:0===\n"),
      result("apk list -u", ""),
    ]) {
      expect(apkParser.getCheckWarningMessage!(step)).toBeNull();
    }
  });
});
