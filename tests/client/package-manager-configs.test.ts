import { describe, expect, test } from "vitest";
import {
  normalizePackageManagerConfigs,
  normalizePackageManagerSecretRefs,
  suggestSecretEnvVar,
} from "../../client/lib/package-manager-configs";

describe("client package-manager configs", () => {
  test("normalizes DNF and YUM EULA automation settings", () => {
    expect(normalizePackageManagerConfigs({
      dnf: {
        autoAcceptEulaOnUpgrade: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
    })).toEqual({
      dnf: {
        autoAcceptEulaOnUpgrade: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
    });
  });

  test("normalizes custom config values to visible config keys", () => {
    expect(normalizePackageManagerConfigs({
      brewlinux: { channel: "edge" },
    }, [
      {
        name: "brewlinux",
        configEntries: [{ key: "channel", defaultValue: "stable" }],
      },
    ])).toEqual({
      brewlinux: { channel: "edge" },
    });
  });

  test("can drop configs for deleted custom package managers before save", () => {
    expect(normalizePackageManagerConfigs({
      apt: { autoHideKeptBackUpdates: true },
      brewlinux: { channel: "edge" },
    }, [], false)).toEqual({
      apt: { autoHideKeptBackUpdates: true },
    });
  });

  test("does not treat unsupported built-in managers as custom config targets before save", () => {
    expect(normalizePackageManagerConfigs({
      snap: { channel: "edge" } as never,
    }, [
      {
        name: "snap",
        builtin: true,
        configEntries: [],
      },
    ], false)).toBeNull();
  });
  test("keeps auto-hide settings for every manager that reports pinned updates", () => {
    const configs = {
      pacman: { refreshDatabasesOnCheck: false, autoHideKeptBackUpdates: true },
      apk: { autoHideKeptBackUpdates: true },
      flatpak: { autoHideKeptBackUpdates: false },
      snap: { autoHideKeptBackUpdates: true },
      "deb-get": { autoHideKeptBackUpdates: true },
    };
    expect(normalizePackageManagerConfigs(configs, [{ name: "deb-get", builtin: true, configEntries: [] }], false)).toEqual(configs);
  });

  test("keeps declared custom snap entries next to auto-hide before save", () => {
    const definitions = [{
      name: "snap",
      builtin: true,
      configEntries: [{ key: "channel", defaultValue: "stable" }],
    }];
    const configs = { snap: { channel: "edge", autoHideKeptBackUpdates: false } } as never;

    expect(normalizePackageManagerConfigs(configs, definitions, false)).toEqual(configs);
    expect(normalizePackageManagerConfigs({ snap: { channel: "edge" } } as never, definitions, false)).toEqual({
      snap: { channel: "edge" },
    });
    expect(normalizePackageManagerConfigs({ snap: { other: "x" } } as never, definitions, false)).toBeNull();
  });

  test("never sends plaintext values for secret entries", () => {
    const managers = [{
      name: "deb-get",
      configEntries: [
        { key: "githubToken", defaultValue: "", secret: true, envVar: "DEBGET_TOKEN" },
        { key: "channel", defaultValue: "stable" },
      ],
    }];

    expect(normalizePackageManagerConfigs({
      "deb-get": { githubToken: "ghp_plaintext", channel: "beta" } as never,
    }, managers)).toEqual({ "deb-get": { channel: "beta" } });
    expect(normalizePackageManagerSecretRefs({
      "deb-get": { githubToken: 4, channel: 5 },
      other: { githubToken: 6 },
    }, managers)).toEqual({ "deb-get": { githubToken: 4 } });
  });

  test("suggests environment variable names from config keys", () => {
    expect(suggestSecretEnvVar("githubToken")).toBe("GITHUB_TOKEN");
    expect(suggestSecretEnvVar("api-key")).toBe("API_KEY");
    expect(suggestSecretEnvVar("2fa")).toBe("_2FA");
  });
});
