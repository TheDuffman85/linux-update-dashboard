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

  test("marks Debian releases in LTS as support-ended warnings instead of EOL", () => {
    const lifecycle = resolveOsLifecycle(
      { osId: "debian", osVersion: "12" },
      { now: new Date("2026-06-16T12:00:00Z"), warningDays: 180 },
    );

    expect(lifecycle.osLifecycleStatus).toBe("support_ended");
    expect(lifecycle.osLifecycleSupportEndDate).toBe("2026-06-10");
    expect(lifecycle.osLifecycleEolDate).toBe("2028-06-30");
    expect(lifecycle.osLifecycleDismissedKey).toBe("debian:12:2028-06-30:support_ended");
  });

  test("tracks dismissal by exact warning key", () => {
    const lifecycle = resolveOsLifecycle(
      {
        osId: "debian",
        osVersion: "12",
        osLifecycleDismissedKey: "debian:12:2028-06-30:support_ended",
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

    expect(lifecycle.osLifecycleStatus).toBe("support_ended");
    expect(lifecycle.osLifecycleSupportEndDate).toBe("2026-06-10");
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
