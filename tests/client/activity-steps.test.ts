import { describe, expect, test } from "bun:test";
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
