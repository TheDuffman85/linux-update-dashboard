import { describe, expect, test } from "vitest";
import { normalizePackageManagerConfigs } from "../../client/lib/package-manager-configs";

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
      snap: { channel: "edge" },
    }, [
      {
        name: "snap",
        builtin: true,
        configEntries: [],
      },
    ], false)).toBeNull();
  });
});
