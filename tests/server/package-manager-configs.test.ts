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

  test("rejects duplicate and colliding custom config entry keys", () => {
    expect(validateCustomPackageManagerConfigEntries([
      { key: "channel", defaultValue: "stable" },
      { key: "channel", defaultValue: "edge" },
    ])).toBe("Duplicate custom config key: channel");

    expect(validateCustomPackageManagerConfigEntries([
      { key: "channel", defaultValue: "stable" },
    ], [
      { name: "otherpm", configEntries: [{ key: "channel", defaultValue: "edge" }] },
    ])).toBe("Custom config key channel is already used by otherpm");
  });
});
