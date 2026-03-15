import { describe, expect, test } from "bun:test";
import { deriveLiveActivitySteps, getActivityStepLabel } from "../../client/lib/activity-steps";
import type { WsMessage } from "../../client/hooks/useCommandOutput";

describe("deriveLiveActivitySteps", () => {
  test("groups websocket messages into ordered activity steps", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt" },
      { type: "phase", phase: "Fetching package lists" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
      { type: "started", command: "apt list --upgradable", pkgManager: "apt" },
      { type: "phase", phase: "Listing available updates" },
      { type: "output", data: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n", stream: "stdout" },
      { type: "done", success: true },
    ];

    expect(deriveLiveActivitySteps(messages)).toEqual([
      {
        label: "Fetching package lists",
        pkgManager: "apt",
        command: "apt-get update",
        output: "Hit:1 mirror\n",
        error: null,
        status: "success",
      },
      {
        label: "Listing available updates",
        pkgManager: "apt",
        command: "apt list --upgradable",
        output: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
        error: null,
        status: "success",
      },
    ]);
  });

  test("marks the active step failed when an error arrives", () => {
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt" },
      { type: "phase", phase: "Fetching package lists" },
      { type: "error", message: "sudo: a password is required" },
      { type: "done", success: false },
    ];

    expect(deriveLiveActivitySteps(messages)).toEqual([
      {
        label: "Fetching package lists",
        pkgManager: "apt",
        command: "apt-get update",
        output: null,
        error: "sudo: a password is required",
        status: "failed",
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
