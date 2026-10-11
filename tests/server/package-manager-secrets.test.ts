import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  normalizePackageManagerConfigs,
  normalizePackageManagerSecretRefs,
  validateCustomPackageManagerConfigEntries,
  validatePackageManagerConfigsInput,
  validatePackageManagerSecretRefsInput,
} from "../../server/package-manager-configs";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  validateCredentialInput,
} from "../../server/services/credential-service";
import {
  createCustomPackageManager,
  createScript,
  deleteCustomPackageManager,
  exportCustomPackageManagerBundle,
  listPackageManagerDefinitions,
  renderCommandTemplate,
  updateCustomPackageManager,
} from "../../server/services/script-service";
import {
  resolveSecretInput,
  validateSecretRefCredentials,
  withSecretEnvNote,
} from "../../server/services/package-manager-secret-service";
import { buildCommandReference } from "../../server/services/command-reference";
import { buildSudoersPreview } from "../../server/services/sudoers-preview";

const TOKEN = "ghp_exampleTokenValue1234567890";
const SECRET_ENTRY = {
  key: "githubToken",
  description: "GitHub token for API rate limits",
  defaultValue: "",
  secret: true,
  envVar: "RELEASE_TOOL_TOKEN",
  sudoEnvKeep: true,
};

describe("secret config entry validation", () => {
  test("requires a safe environment variable name and an empty default", () => {
    expect(validateCustomPackageManagerConfigEntries([SECRET_ENTRY])).toBeNull();
    expect(validateCustomPackageManagerConfigEntries([{ ...SECRET_ENTRY, envVar: undefined }]))
      .toContain("envVar");
    expect(validateCustomPackageManagerConfigEntries([{ ...SECRET_ENTRY, envVar: "lower" }]))
      .toContain("envVar");
    for (const reserved of ["PATH", "LD_PRELOAD", "BASH_ENV", "SUDO_USER", "LUDASH_X", "PYTHONPATH"]) {
      expect(validateCustomPackageManagerConfigEntries([{ ...SECRET_ENTRY, envVar: reserved }]))
        .toContain("reserved");
    }
    expect(validateCustomPackageManagerConfigEntries([{ ...SECRET_ENTRY, defaultValue: "plain" }]))
      .toContain("defaultValue must be empty");
    expect(validateCustomPackageManagerConfigEntries([
      SECRET_ENTRY,
      { ...SECRET_ENTRY, key: "otherToken" },
    ])).toContain("Duplicate secret environment variable");
  });

  test("never stores plaintext values for secret entries", () => {
    const definitions = [{ name: "release-tool", configEntries: [SECRET_ENTRY, { key: "channel", defaultValue: "stable" }] }];

    expect(normalizePackageManagerConfigs({
      "release-tool": { githubToken: TOKEN, channel: "beta" },
    }, definitions)).toEqual({ "release-tool": { channel: "beta" } });
    expect(validatePackageManagerConfigsInput({
      "release-tool": { githubToken: TOKEN },
    }, definitions)).toContain("secret entry");
  });

  test("validates and normalizes secret references", () => {
    const definitions = [{ name: "release-tool", configEntries: [SECRET_ENTRY, { key: "channel", defaultValue: "stable" }] }];

    expect(validatePackageManagerSecretRefsInput({ "release-tool": { githubToken: 3 } }, definitions)).toBeNull();
    expect(validatePackageManagerSecretRefsInput({ "release-tool": { channel: 3 } }, definitions))
      .toContain("not a secret config entry");
    expect(validatePackageManagerSecretRefsInput({ apt: { githubToken: 3 } }, definitions))
      .toContain("no secret config entries");
    expect(validatePackageManagerSecretRefsInput({ "release-tool": { githubToken: "3; rm" } }, definitions))
      .toContain("credential ID");
    expect(normalizePackageManagerSecretRefs({
      "release-tool": { githubToken: 3, channel: 4 },
      apt: { githubToken: 5 },
    }, definitions)).toEqual({ "release-tool": { githubToken: 3 } });
  });

  test("accepts single-line secret credentials only", () => {
    expect(validateCredentialInput({ name: "token", kind: "secret", payload: { value: TOKEN } })).toBeNull();
    expect(validateCredentialInput({ name: "token", kind: "secret", payload: {} })).toContain("required");
    expect(validateCredentialInput({ name: "token", kind: "secret", payload: { value: "a\nb" } }))
      .toContain("single line");
  });
});

describe("package manager secrets", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-pm-secrets-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    createCustomPackageManager({
      name: "release-tool",
      label: "release-tool",
      configEntries: [SECRET_ENTRY, { key: "channel", defaultValue: "stable" }],
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  let systemCounter = 0;
  function insertSystem(secretRefs: unknown, detected: string[] = []): number {
    systemCounter += 1;
    return getDb().insert(systems).values({
      name: `desktop-${systemCounter}`,
      hostname: `desktop-${systemCounter}.local`,
      port: 22,
      authType: "password",
      username: "updater",
      detectedPkgManagers: JSON.stringify(detected),
      pkgManagerSecretRefs: secretRefs ? JSON.stringify(secretRefs) : null,
    }).returning({ id: systems.id }).get().id;
  }

  test("stores secret credentials encrypted and never lists their values", () => {
    const id = createCredential({ name: "release-tool token", kind: "secret", payload: { value: TOKEN } });
    const row = getDb().select().from(credentials).where(eq(credentials.id, id)).get();

    expect(row?.payload).not.toContain(TOKEN);
    expect(JSON.stringify(listCredentials())).not.toContain(TOKEN);
  });

  test("resolves the secret environment for the manager that owns it", () => {
    const credentialId = createCredential({ name: "release-tool token", kind: "secret", payload: { value: TOKEN } });
    const systemId = insertSystem({ "release-tool": { githubToken: credentialId } });
    const system = getDb().select().from(systems).where(eq(systems.id, systemId)).get();

    const secretInput = resolveSecretInput(system, "release-tool");
    expect(secretInput?.envVars).toEqual(["RELEASE_TOOL_TOKEN"]);
    expect(secretInput?.stdinPrefix()).toBe(`${TOKEN}\n`);
    expect(resolveSecretInput(system, "apt")).toBeNull();
    expect(withSecretEnvNote("release-tool show x", secretInput)).toBe(
      "# Secret environment (via stdin): RELEASE_TOOL_TOKEN\nrelease-tool show x",
    );
  });

  test("rejects SSH credentials as secret references", () => {
    const sshCredentialId = createCredential({
      name: "ssh",
      kind: "usernamePassword",
      payload: { username: "root", password: "pw" },
    });

    expect(validateSecretRefCredentials({ "release-tool": { githubToken: sshCredentialId } }))
      .toContain("not a secret credential");
    expect(validateSecretRefCredentials({ "release-tool": { githubToken: 999 } }))
      .toContain("does not exist");
  });

  test("blocks deleting a secret credential that a system references", () => {
    const credentialId = createCredential({ name: "release-tool token", kind: "secret", payload: { value: TOKEN } });
    insertSystem({ "release-tool": { githubToken: credentialId } });

    const result = deleteCredential(credentialId);
    expect(result.ok).toBe(false);
    expect(result.references).toEqual([
      expect.objectContaining({ type: "packageManagerSecret", pkgManager: "release-tool", key: "githubToken" }),
    ]);
  });

  test("rejects config placeholders for secret entries in scripts", () => {
    expect(() => renderCommandTemplate("release-tool --token {{config.githubToken}}", { pkgManager: "release-tool" }))
      .toThrow("secret entry");
    expect(renderCommandTemplate("release-tool --channel {{config.channel}}", { pkgManager: "release-tool" }))
      .toBe("release-tool --channel stable");
    expect(() => createScript({
      name: "Check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "release-tool",
      steps: [{ label: "Check", command: "echo {{config.githubToken}}" }],
    })).toThrow("secret entry");
  });

  test("exports secret entry definitions without any values", () => {
    const credentialId = createCredential({ name: "release-tool token", kind: "secret", payload: { value: TOKEN } });
    insertSystem({ "release-tool": { githubToken: credentialId } });

    const bundle = exportCustomPackageManagerBundle("release-tool");
    expect(bundle.packageManager.configEntries).toContainEqual(SECRET_ENTRY);
    expect(JSON.stringify(bundle)).not.toContain(TOKEN);
  });

  test("prunes references when an entry stops being secret or the manager is deleted", () => {
    const credentialId = createCredential({ name: "release-tool token", kind: "secret", payload: { value: TOKEN } });
    const systemId = insertSystem({ "release-tool": { githubToken: credentialId } });

    updateCustomPackageManager("release-tool", {
      label: "release-tool",
      configEntries: [{ key: "githubToken", defaultValue: "" }],
    });
    expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.pkgManagerSecretRefs)
      .toBeNull();

    updateCustomPackageManager("release-tool", { label: "release-tool", configEntries: [SECRET_ENTRY] });
    getDb().update(systems)
      .set({ pkgManagerSecretRefs: JSON.stringify({ "release-tool": { githubToken: credentialId } }) })
      .where(eq(systems.id, systemId))
      .run();
    deleteCustomPackageManager("release-tool");
    expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.pkgManagerSecretRefs)
      .toBeNull();
    expect(listPackageManagerDefinitions().some((manager) => manager.name === "release-tool")).toBe(false);
  });

  test("adds an env_keep rule for active managers without changing command rules", () => {
    const withoutSecret = (() => {
      const systemId = insertSystem(null, ["apt"]);
      return buildCommandReference({
        ...getDb().select().from(systems).where(eq(systems.id, systemId)).get()!,
      });
    })();
    expect(withoutSecret.envKeep).toEqual([]);
    expect(buildSudoersPreview({ username: "updater", commandReference: withoutSecret }).content)
      .not.toContain("env_keep");

    createScript({
      name: "Check release-tool",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "release-tool",
      isDefault: true,
      steps: [{ label: "Check", command: "{{sudo:release-tool show obsidian}}" }],
      parserConfig: { updateRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+) (?<newVersion>\\S+)$" },
    });
    const systemId = insertSystem(null, ["apt", "release-tool"]);
    const reference = buildCommandReference(getDb().select().from(systems).where(eq(systems.id, systemId)).get()!);
    const preview = buildSudoersPreview({ username: "updater", commandReference: reference });

    expect(reference.envKeep).toEqual([{ envVar: "RELEASE_TOOL_TOKEN", pkgManager: "release-tool", key: "githubToken" }]);
    expect(preview.content).toContain('Defaults:updater env_keep += "RELEASE_TOOL_TOKEN"');
    expect(preview.content).toContain("release-tool show obsidian");
    expect(preview.content).not.toContain(TOKEN);
  });
});
