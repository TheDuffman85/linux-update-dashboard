import { describe, expect, test } from "vitest";
import { deriveLiveActivitySteps, getActivityStepLabel } from "../../client/lib/activity-steps";
import type { WsMessage } from "../../client/hooks/useCommandOutput";

describe("deriveLiveActivitySteps", () => {
  test("groups websocket messages into ordered activity steps", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "phase", phase: "Fetching package lists" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
      { type: "started", command: "apt list --upgradable", pkgManager: "apt", startedAt: "2026-03-18 10:00:04" },
      { type: "phase", phase: "Listing available updates" },
      { type: "output", data: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n", stream: "stdout" },
      { type: "done", success: true, completedAt: "2026-03-18 10:00:06" },
    ];

    expect(deriveLiveActivitySteps(messages)).toEqual([
      {
        label: "Fetching package lists",
        pkgManager: "apt",
        command: "apt-get update",
        output: "Hit:1 mirror\n",
        error: null,
        status: "success",
        startedAt: "2026-03-18 10:00:00",
        completedAt: "2026-03-18 10:00:04",
      },
      {
        label: "Listing available updates",
        pkgManager: "apt",
        command: "apt list --upgradable",
        output: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
        error: null,
        status: "success",
        startedAt: "2026-03-18 10:00:04",
        completedAt: "2026-03-18 10:00:06",
      },
    ]);
  });

  test("marks the active step failed when an error arrives", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "phase", phase: "Fetching package lists" },
      { type: "error", message: "sudo: a password is required" },
      { type: "done", success: false, completedAt: "2026-03-18 10:00:03" },
    ];

    expect(deriveLiveActivitySteps(messages)).toEqual([
      {
        label: "Fetching package lists",
        pkgManager: "apt",
        command: "apt-get update",
        output: null,
        error: "sudo: a password is required",
        status: "failed",
        startedAt: "2026-03-18 10:00:00",
        completedAt: "2026-03-18 10:00:03",
      },
    ]);
  });

  test("marks only the step that warned when a check finishes with warnings", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "flatpak mask", pkgManager: "flatpak", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Could not read Flatpak masks." },
      { type: "started", command: "flatpak list", pkgManager: "flatpak", startedAt: "2026-03-18 10:00:02" },
      { type: "done", success: true, warning: true, completedAt: "2026-03-18 10:00:03" },
    ];

    expect(deriveLiveActivitySteps(messages)).toMatchObject([
      { status: "warning", error: "Could not read Flatpak masks.", completedAt: "2026-03-18 10:00:02" },
      { status: "success", error: null, completedAt: "2026-03-18 10:00:03" },
    ]);
  });

  test("keeps cancellation and lets an error override a warning", () => {
    expect(deriveLiveActivitySteps([
      { type: "started", command: "apk update", pkgManager: "apk", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Operation cancelled" },
      { type: "done", success: false, completedAt: "2026-03-18 10:00:01" },
    ])).toMatchObject([{ status: "cancelled" }]);

    expect(deriveLiveActivitySteps([
      { type: "started", command: "apk update", pkgManager: "apk", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "partial result" },
      { type: "error", message: "connection lost" },
      { type: "done", success: false, completedAt: "2026-03-18 10:00:01" },
    ])).toMatchObject([{ status: "failed" }]);
  });

  test("lets a cancellation override an earlier warning", () => {
    expect(deriveLiveActivitySteps([
      { type: "started", command: "apt-get upgrade", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Connection lost. Reconnecting" },
      { type: "warning", message: "Operation cancelled" },
    ])).toMatchObject([{ status: "cancelled" }]);

    expect(deriveLiveActivitySteps([
      { type: "started", command: "apt-get upgrade", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Connection lost. Reconnecting" },
      { type: "warning", message: "Operation cancelled" },
      { type: "done", success: false, completedAt: "2026-03-18 10:00:01" },
    ])).toMatchObject([{ status: "cancelled", completedAt: "2026-03-18 10:00:01" }]);
  });

  test("a later plain warning does not undo a cancellation", () => {
    expect(deriveLiveActivitySteps([
      { type: "started", command: "apt-get upgrade", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Operation cancelled" },
      { type: "warning", message: "Connection lost" },
    ])).toMatchObject([{ status: "cancelled" }]);
  });

  test("a failed operation is not masked by a warning on its last step", () => {
    expect(deriveLiveActivitySteps([
      { type: "started", command: "apt-get upgrade", pkgManager: "apt", startedAt: "2026-03-18 10:00:00" },
      { type: "warning", message: "Connection lost. Reconnecting" },
      { type: "done", success: false, completedAt: "2026-03-18 10:00:01" },
    ])).toMatchObject([{ status: "failed", completedAt: "2026-03-18 10:00:01" }]);
  });

  test("keeps a visible connection step before the first command", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "", pkgManager: "system", startedAt: "2026-03-18 10:00:00" },
      { type: "phase", phase: "Connect over SSH" },
      { type: "started", command: "reboot", pkgManager: "system", startedAt: "2026-03-18 10:00:37" },
      { type: "phase", phase: "Reboot system" },
      { type: "done", success: true, completedAt: "2026-03-18 10:00:38" },
    ];

    expect(deriveLiveActivitySteps(messages)).toMatchObject([
      {
        label: "Connect over SSH",
        command: "",
        status: "success",
        startedAt: "2026-03-18 10:00:00",
        completedAt: "2026-03-18 10:00:37",
      },
      {
        label: "Reboot system",
        command: "reboot",
        status: "success",
        startedAt: "2026-03-18 10:00:37",
        completedAt: "2026-03-18 10:00:38",
      },
    ]);
  });
});

describe("activity step labels", () => {
  test("strips trailing ellipsis from legacy step labels", () => {
    expect(
      getActivityStepLabel(
        {
          label: "Fetching package lists…",
          pkgManager: "apt",
          command: "apt-get update",
          output: null,
          error: null,
          status: "success",
        },
        0
      )
    ).toBe("Fetching package lists");
  });

  test("falls back to numbered labels when a step label is missing", () => {
    expect(
      getActivityStepLabel(
        {
          label: null,
          pkgManager: "apt",
          command: "apt-get update",
          output: null,
          error: null,
          status: "started",
        },
        1
      )
    ).toBe("Step 2");
  });
});
