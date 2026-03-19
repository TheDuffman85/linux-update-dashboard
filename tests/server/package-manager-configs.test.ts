import { describe, expect, test } from "bun:test";
import {
  normalizePackageManagerConfigs,
  parsePackageManagerConfigs,
  serializePackageManagerConfigs,
  validatePackageManagerConfigsInput,
} from "../../server/package-manager-configs";

describe("package-manager configs", () => {
  test("normalizes and serializes DNF and YUM signing-key settings", () => {
    const normalized = normalizePackageManagerConfigs({
      dnf: {
        defaultUpgradeMode: "distro-sync",
        refreshMetadataOnCheck: true,
        autoAcceptNewSigningKeysOnCheck: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
      },
    });

    expect(normalized).toEqual({
      dnf: {
        defaultUpgradeMode: "distro-sync",
        refreshMetadataOnCheck: true,
        autoAcceptNewSigningKeysOnCheck: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
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
  });
});
