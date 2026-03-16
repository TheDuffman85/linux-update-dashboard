import { describe, expect, test } from "bun:test";
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
};

describe("ActivityStepViewer", () => {
  test("hides step tabs when only one step is available", () => {
    const html = renderToStaticMarkup(
      <ActivityStepViewer viewerId="single-step" steps={[baseStep]} />
    );

    expect(html).not.toContain('aria-label="Activity steps"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("apt-get update");
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
    expect(html).toContain("Listing available updates");
  });
});
