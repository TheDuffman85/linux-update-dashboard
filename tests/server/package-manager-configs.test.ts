import { describe, expect, test } from "vitest";
import {
  normalizePackageManagerConfigs,
  parsePackageManagerConfigs,
  serializePackageManagerConfigs,
  validatePackageManagerConfigsInput,
  validateCustomPackageManagerConfigEntries,
} from "../../server/package-manager-configs";

describe("package-manager configs", () => {
  test("normalizes and serializes DNF and YUM signing-key settings", () => {
    const normalized = normalizePackageManagerConfigs({
      dnf: {
        defaultUpgradeMode: "distro-sync",
        refreshMetadataOnCheck: true,
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
    });

    expect(normalized).toEqual({
      dnf: {
        defaultUpgradeMode: "distro-sync",
        refreshMetadataOnCheck: true,
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
        autoAcceptEulaOnUpgrade: true,
      },
    });
    expect(parsePackageManagerConfigs(serializePackageManagerConfigs(normalized))).toEqual(normalized);
  });

  test("rejects non-boolean signing-key settings", () => {
    expect(validatePackageManagerConfigsInput({
      dnf: {
        autoAcceptNewSigningKeysOnCheck: "yes",
      },
    })).toBe("pkgManagerConfigs.dnf.autoAcceptNewSigningKeysOnCheck must be a boolean");

    expect(validatePackageManagerConfigsInput({
      yum: {
        autoAcceptNewSigningKeysOnCheck: "yes",
      },
    })).toBe("pkgManagerConfigs.yum.autoAcceptNewSigningKeysOnCheck must be a boolean");

    expect(validatePackageManagerConfigsInput({
      dnf: {
        autoAcceptEulaOnUpgrade: "yes",
      },
    })).toBe("pkgManagerConfigs.dnf.autoAcceptEulaOnUpgrade must be a boolean");

    expect(validatePackageManagerConfigsInput({
      yum: {
        autoAcceptEulaOnUpgrade: "yes",
      },
    })).toBe("pkgManagerConfigs.yum.autoAcceptEulaOnUpgrade must be a boolean");
  });

  test("validates and normalizes custom manager config values", () => {
    const customManagers = [
      {
        name: "brewlinux",
        configEntries: [
          { key: "channel", defaultValue: "stable", description: "Release channel" },
        ],
      },
    ];

    expect(validatePackageManagerConfigsInput({
      brewlinux: { channel: "edge" },
    }, customManagers)).toBeNull();
    expect(normalizePackageManagerConfigs({
      brewlinux: { channel: "edge", unknown: "ignored" },
    }, customManagers)).toEqual({
      brewlinux: { channel: "edge" },
    });
    expect(validatePackageManagerConfigsInput({
      brewlinux: { unknown: "edge" },
    }, customManagers)).toBe("pkgManagerConfigs.brewlinux.unknown is not supported");
  });

  test("validates and normalizes built-in manager custom config values", () => {
    const managers = [
      {
        name: "apt",
        configEntries: [
          { key: "mirror", defaultValue: "main" },
        ],
      },
    ];

    expect(validatePackageManagerConfigsInput({
      apt: {
        defaultUpgradeMode: "full-upgrade",
        mirror: "internal",
      },
    }, managers)).toBeNull();
    expect(normalizePackageManagerConfigs({
      apt: {
        defaultUpgradeMode: "full-upgrade",
        mirror: "internal",
        unknown: "ignored",
      },
    }, managers)).toEqual({
      apt: {
        defaultUpgradeMode: "full-upgrade",
        mirror: "internal",
      },
    });
    expect(validateCustomPackageManagerConfigEntries([
      { key: "defaultUpgradeMode", defaultValue: "fast" },
    ], managers, "apt")).toBe("Custom config key defaultUpgradeMode collides with a built-in apt config key");
  });

  test("rejects duplicate custom config entry keys within one manager", () => {
    expect(validateCustomPackageManagerConfigEntries([
      { key: "channel", defaultValue: "stable" },
      { key: "channel", defaultValue: "edge" },
    ], [], "brewlinux")).toBe("Duplicate custom config key: channel");

    expect(validateCustomPackageManagerConfigEntries([
      { key: "channel", defaultValue: "stable" },
    ], [
      { name: "otherpm", configEntries: [{ key: "channel", defaultValue: "edge" }] },
    ], "brewlinux")).toBeNull();
    expect(validateCustomPackageManagerConfigEntries([
      { key: "mirror", defaultValue: "internal" },
    ], [
      { name: "dnf", configEntries: [{ key: "mirror", defaultValue: "public" }] },
    ], "apt")).toBeNull();

    expect(validateCustomPackageManagerConfigEntries([
      { key: "autoAcceptEulaOnUpgradePrefix", defaultValue: "unsafe" },
    ], [], "dnf")).toBe("Custom config key autoAcceptEulaOnUpgradePrefix collides with a built-in dnf config key");
  });

  test("accepts and keeps auto-hide settings for managers that report pinned updates", () => {
    const configs = {
      pacman: { autoHideKeptBackUpdates: true },
      apk: { autoHideKeptBackUpdates: true },
      flatpak: { autoHideKeptBackUpdates: false },
      snap: { autoHideKeptBackUpdates: true },
      "deb-get": { autoHideKeptBackUpdates: true },
    };

    expect(validatePackageManagerConfigsInput(configs)).toBeNull();
    expect(normalizePackageManagerConfigs(configs)).toEqual(configs);
    expect(parsePackageManagerConfigs(serializePackageManagerConfigs(configs))).toEqual(configs);
  });

  test("rejects invalid values and other settings for snap and deb-get", () => {
    expect(validatePackageManagerConfigsInput({ snap: { autoHideKeptBackUpdates: "yes" } }))
      .toBe("pkgManagerConfigs.snap.autoHideKeptBackUpdates must be a boolean");
    expect(validatePackageManagerConfigsInput({ apk: { autoHideKeptBackUpdates: 1 } }))
      .toBe("pkgManagerConfigs.apk.autoHideKeptBackUpdates must be a boolean");
    expect(validatePackageManagerConfigsInput({ snap: { channel: "edge" } }))
      .toBe("pkgManagerConfigs.snap.channel is not supported");
    expect(validatePackageManagerConfigsInput({ "deb-get": { other: "x" } }))
      .toBe("pkgManagerConfigs.deb-get.other is not supported");
  });

  test("still refuses a plaintext value for the deb-get secret entry", () => {
    expect(validatePackageManagerConfigsInput({ "deb-get": { githubToken: "ghp_x" } }, [{
      name: "deb-get",
      configEntries: [{ key: "githubToken", defaultValue: "", secret: true, envVar: "DEBGET_TOKEN" }],
    }])).toBe("pkgManagerConfigs.deb-get.githubToken is a secret entry; assign a secret credential instead");
  });

  test("keeps declared custom entries for snap and deb-get next to auto-hide", () => {
    const definitions = ["snap", "deb-get"].map((name) => ({
      name,
      configEntries: [{ key: "channel", defaultValue: "stable" }],
    }));
    const configs = {
      snap: { channel: "edge", autoHideKeptBackUpdates: false },
      "deb-get": { channel: "beta", autoHideKeptBackUpdates: false },
    } as never;

    expect(validatePackageManagerConfigsInput(configs, definitions)).toBeNull();
    expect(normalizePackageManagerConfigs(configs, definitions)).toEqual(configs);
    expect(normalizePackageManagerConfigs({ snap: { channel: "edge" } }, definitions)).toEqual({
      snap: { channel: "edge" },
    });
    expect(parsePackageManagerConfigs(serializePackageManagerConfigs(configs, definitions), definitions)).toEqual(configs);
  });

  test("drops undeclared snap settings when normalizing", () => {
    expect(normalizePackageManagerConfigs({ snap: { channel: "edge" } })).toBeNull();
    expect(normalizePackageManagerConfigs(
      { snap: { other: "x", autoHideKeptBackUpdates: true } },
      [{ name: "snap", configEntries: [{ key: "channel", defaultValue: "stable" }] }],
    )).toEqual({ snap: { autoHideKeptBackUpdates: true } });
  });
});
