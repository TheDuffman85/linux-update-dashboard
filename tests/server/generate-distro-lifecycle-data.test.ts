import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("distro lifecycle generator", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("maps Debian security support and LTS without using paid extended support", () => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-lifecycle-generator-"));
    mkdirSync(join(tempDir, "server"));
    const preloadPath = join(tempDir, "fetch-fixture.mjs");
    writeFileSync(preloadPath, `
      globalThis.fetch = async (url) => ({
        ok: true,
        json: async () => url.endsWith("/debian.json") ? [
          { cycle: "13", support: "2028-08-09", eol: "2030-06-30", extendedSupport: "2035-06-30" },
          { cycle: "12", support: "2026-07-11", eol: "2028-06-30", extendedSupport: "2033-06-30" },
          { cycle: "10", support: "2022-09-10", eol: "2024-06-30", extendedSupport: "2029-06-30" },
          { cycle: "6", support: "2014-05-31", eol: "2016-02-29", extendedSupport: false },
        ] : [],
      });
    `);

    const result = spawnSync(process.execPath, [
      "--import", preloadPath,
      resolve("scripts/generate-distro-lifecycle-data.mjs"),
    ], {
      cwd: tempDir,
      env: { ...process.env, LUDASH_EOL_CATALOG_FILE: "" },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const generated = JSON.parse(readFileSync(
      join(tempDir, "server/generated/distro-lifecycle-data.json"), "utf8",
    ));
    expect(generated.catalog.debian).toEqual({
      label: "Debian",
      supportLabel: "security support",
      finalSupportLabel: "LTS",
      entries: [
        { cycle: "13", supportEnd: "2028-08-09", eol: "2030-06-30" },
        { cycle: "12", supportEnd: "2026-07-11", eol: "2028-06-30" },
        { cycle: "10", supportEnd: "2022-09-10", eol: "2024-06-30" },
        { cycle: "6", supportEnd: "2014-05-31", eol: "2016-02-29" },
      ],
    });
  });
});
