import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { customPackageManagers, customScripts, systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import scriptsRoutes from "../../server/routes/scripts";
import {
  getScriptById,
  parseUpdatesWithScript,
  resolveRuntimeSteps,
  type ScriptDefinition,
  type ScriptOperation,
} from "../../server/services/script-service";
import { aptParser } from "../../server/ssh/parsers/apt";
import type { ParsedUpdate } from "../../server/ssh/parsers";

const CUSTOM_APT = "custom-apt";
type CopyPackageManagerResponse = {
  manager: { name: string; label: string };
  scripts: ScriptDefinition[];
};

async function postJson<T>(app: Hono, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return res.json() as Promise<T>;
}

function insertSystem(id: number): void {
  getDb().insert(systems).values({
    id,
    name: `system-${id}`,
    hostname: `system-${id}.local`,
    port: 22,
    authType: "password",
    username: "root",
  }).run();
}

function normalizePkgManager(updates: ParsedUpdate[]): ParsedUpdate[] {
  return updates.map((update) => ({ ...update, pkgManager: "apt" }));
}

describe("scripts routes custom APT copy flow", () => {
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-scripts-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    app = new Hono();
    app.route("/api/scripts", scriptsRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("copies built-in APT into a custom package manager through API-created DB rows", async () => {
    const operations = [
      "detect",
      "check_updates",
      "upgrade_all",
      "full_upgrade_all",
      "upgrade_selected",
    ] as const;
    const copied = await postJson<CopyPackageManagerResponse>(
      app,
      "/api/scripts/package-managers/copy-builtin",
      {
        sourceManager: "apt",
        name: CUSTOM_APT,
        label: "Custom APT",
        color: "#2563eb",
      },
    );
    const copiedScripts = copied.scripts;

    expect(copied.manager).toMatchObject({ name: CUSTOM_APT, label: "Custom APT" });
    expect(getDb().select().from(customPackageManagers).all()).toMatchObject([
      { name: CUSTOM_APT, label: "Custom APT" },
    ]);
    expect(getDb().select().from(customScripts).all()).toHaveLength(operations.length);
    expect(copiedScripts.every((script) => script.sourceScriptId?.startsWith("builtin:apt:"))).toBe(true);

    insertSystem(10);
    for (const operation of operations) {
      const customCommands = resolveRuntimeSteps({
        systemId: 10,
        operation,
        pkgManager: CUSTOM_APT,
        packages: ["curl", "openssl"],
      }).map((step) => step.command);
      const builtinCommands = resolveRuntimeSteps({
        systemId: 10,
        operation,
        pkgManager: "apt",
        packages: ["curl", "openssl"],
      }).map((step) => step.command);

      expect(customCommands).toEqual(builtinCommands);
    }

    const customCheckScript = getScriptById(
      copiedScripts.find((script) => script.operation === "check_updates")?.id ?? "",
    );
    const listStdout = [
      "curl/bookworm 8.0.1-1 amd64 [upgradable from: 7.88.1-10]",
      "openssl/bookworm-security 3.0.11-1 amd64 [upgradable from: 3.0.9-1]",
      "linux-image-amd64/bookworm 6.1.99-1 amd64 [upgradable from: 6.1.90-1]",
    ].join("\n");
    const commandResults = [
      {
        command: aptParser.getCheckCommands()[0],
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
      {
        command: aptParser.getCheckCommands()[1],
        stdout: listStdout,
        stderr: "",
        exitCode: 0,
      },
      {
        command: aptParser.getCheckCommands()[2],
        stdout: [
          "Inst curl [7.88.1-10] (8.0.1-1 Debian:12/stable [amd64])",
          "Inst openssl [3.0.9-1] (3.0.11-1 Debian-Security:12/stable-security [amd64])",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      },
    ];

    const builtinUpdates = aptParser.parseCheckOutput("", "", 0, { commandResults });
    const customUpdates = parseUpdatesWithScript(
      CUSTOM_APT,
      customCheckScript,
      commandResults,
    );

    expect(normalizePkgManager(customUpdates)).toEqual(normalizePkgManager(builtinUpdates));
    expect(customUpdates.find((update) => update.packageName === "linux-image-amd64")?.isKeptBack).toBe(true);
  });
});
