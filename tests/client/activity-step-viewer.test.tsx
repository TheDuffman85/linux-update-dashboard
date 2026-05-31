import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityStepViewer } from "../../client/pages/SystemDetail";
import type { ActivityStep } from "../../client/lib/systems";

const baseStep: ActivityStep = {
  label: "Fetching package lists",
  pkgManager: "apt",
  command: "apt-get update",
  output: "Hit:1 mirror\n",
  error: null,
  status: "success",
  startedAt: "2026-03-18 10:00:00",
  completedAt: "2026-03-18 10:01:05",
};

describe("ActivityStepViewer", () => {
  test("hides step tabs when only one step is available", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer viewerId="single-step" steps={[baseStep]} />
    );

    expect(html).not.toContain('aria-label="Activity steps"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("apt-get update");
    expect(html).not.toContain("Runtime 1m 5s");
  });

  test("shows step tabs when multiple steps are available", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer
        viewerId="multi-step"
        steps={[
          baseStep,
          {
            ...baseStep,
            label: "Listing available updates",
            command: "apt list --upgradable",
            output: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
          },
        ]}
      />
    );

    expect(html).toContain('aria-label="Activity steps"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("1/2 apt");
    expect(html).toContain("1m 5s");
    expect(html).not.toContain("Runtime 1m 5s");
    expect(html).toContain("Listing available updates");
  });

  test("syntax highlights shell commands", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer
        viewerId="highlighted-step"
        steps={[
          {
            ...baseStep,
            command: "# Fetch package lists\napt-get update",
          },
        ]}
      />
    );

    expect(html).toContain("script-code");
    expect(html).toContain("hljs-comment");
  });

  test("caps command panes to match output panes", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer viewerId="single-step" steps={[baseStep]} />
    );

    expect(html).toContain("script-code");
    expect(html).toContain("max-h-64 overflow-y-auto");
  });

  test("shows connection timing outside the command step tabs", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer
        viewerId="connect-step"
        steps={[
          {
            ...baseStep,
            label: "Connect over SSH",
            pkgManager: "system",
            command: "",
            output: null,
            startedAt: "2026-03-18 10:00:00",
            completedAt: "2026-03-18 10:00:37",
          },
          {
            ...baseStep,
            label: "Pre-reboot safety checks",
            pkgManager: "system",
            startedAt: "2026-03-18 10:00:37",
            completedAt: "2026-03-18 10:00:37",
          },
          {
            ...baseStep,
            label: "Reboot system",
            pkgManager: "system",
            command: "reboot",
            startedAt: "2026-03-18 10:00:37",
            completedAt: "2026-03-18 10:00:38",
          },
        ]}
      />
    );

    expect(html).toContain("SSH connected in 37s");
    expect(html).toContain("1/2 system");
    expect(html).toContain("2/2 system");
    expect(html).not.toContain("1/3 system");
  });

  test("opens failed history on the failed step", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer
        viewerId="failed-step"
        steps={[
          {
            ...baseStep,
            label: "Pre-reboot safety checks",
            pkgManager: "system",
            command: "echo precheck",
            output: null,
          },
          {
            ...baseStep,
            label: "Reboot system",
            pkgManager: "system",
            command: "reboot",
            output: null,
            error: "Reboot failed: Failed to talk to init daemon.",
            status: "failed",
          },
        ]}
      />
    );

    expect(html).toContain("Reboot failed: Failed to talk to init daemon.");
    expect(html).toContain("reboot");
    expect(html).not.toContain("echo precheck</code>");
  });
});
