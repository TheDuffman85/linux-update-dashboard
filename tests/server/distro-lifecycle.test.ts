import { describe, expect, test } from "vitest";
import { resolveOsLifecycle } from "../../server/distro-lifecycle";

describe("resolveOsLifecycle", () => {
  test("marks supported releases outside the warning window", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "ubuntu", osVersion: "24.04" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("supported");
    expect(lifecycle.osLifecycleEolDate).toBe("2029-05-31");
    expect(lifecycle.osLifecycleDismissedKey).toBeNull();
  });

  test("marks releases approaching EOL", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "ubuntu", osVersion: "25.10" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("approaching_eol");
    expect(lifecycle.osLifecycleEolDate).toBe("2026-07-01");
    expect(lifecycle.osLifecycleDaysUntilEol).toBe(15);
    expect(lifecycle.osLifecycleDismissedKey).toBe("ubuntu:25.10:2026-07-01:approaching_eol");
  });

  test("marks EOL releases", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "debian", osVersion: "10" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("eol");
    expect(lifecycle.osLifecycleEolDate).toBe("2024-06-30");
    expect(lifecycle.osLifecycleDismissedKey).toBe("debian:10:2024-06-30:eol");
  });

  test("marks Debian releases with security support ending soon", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "debian", osVersion: "12" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("support_ending");
    expect(lifecycle.osLifecycleSupportEndDate).toBe("2026-07-11");
    expect(lifecycle.osLifecycleDaysUntilSupportEnd).toBe(25);
    expect(lifecycle.osLifecycleEolDate).toBe("2028-06-30");
    expect(lifecycle.osLifecycleLabel).toBe("Debian 12 security support ends in 25 days; LTS until 2028-06-30");
    expect(lifecycle.osLifecycleDismissedKey).toBe("debian:12:2028-06-30:support_ending");
  });

  test("uses the Debian security support date for supported releases with later LTS EOL", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "debian", osVersion: "13" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("supported");
    expect(lifecycle.osLifecycleSupportEndDate).toBe("2028-08-09");
    expect(lifecycle.osLifecycleEolDate).toBe("2030-06-30");
    expect(lifecycle.osLifecycleLabel).toBe("Debian 13 security support until 2028-08-09; LTS until 2030-06-30");
    expect(lifecycle.osLifecycleDismissedKey).toBeNull();
  });

  test("tracks dismissal by exact warning key", () => {
    const lifecycle = resolveOsLifecycle(
      {
        osId: "debian",
        osVersion: "12",
        osLifecycleDismissedKey: "debian:12:2028-06-30:support_ending",
      },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleBannerDismissed).toBe(true);
  });

  test("uses Raspberry Pi OS as Debian lifecycle", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "raspbian", osName: "Raspberry Pi OS 12 (bookworm)", osVersion: "12" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 30 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("support_ending");
    expect(lifecycle.osLifecycleSupportEndDate).toBe("2026-07-11");
    expect(lifecycle.osLifecycleEolDate).toBe("2028-06-30");
  });

  test("returns unknown for unsupported distro identities", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "arch", osName: "Arch Linux", osVersion: "" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("unknown");
    expect(lifecycle.osLifecycleEolDate).toBeNull();
  });
});
