import { describe, expect, test } from "vitest";
import { getCronPreview } from "../../client/lib/cron-preview";

describe("cron preview", () => {
  test("calculates runs in the server timezone and honors 12-hour descriptions", () => {
    const preview = getCronPreview(
      "0 9 * * *",
      new Date("2026-01-01T00:00:00Z"),
      1,
      "en",
      "Europe/Berlin",
      false,
    );

    expect("error" in preview).toBe(false);
    if ("error" in preview) return;
    expect(preview.nextRuns[0].toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(preview.description).toContain("09:00 AM");
  });

  test("describes a custom cron and returns upcoming runs", () => {
    const preview = getCronPreview(
      "0 3 * * 0",
      new Date("2026-05-08T10:00:00Z"),
    );

    expect(preview).not.toHaveProperty("error");
    if ("error" in preview) return;

    expect(preview.description).toContain("03:00");
    expect(preview.description).toContain("Sunday");
    expect(preview.nextRuns).toHaveLength(3);
    for (const run of preview.nextRuns) {
      expect(run.getDay()).toBe(0);
      expect(run.getHours()).toBe(3);
      expect(run.getMinutes()).toBe(0);
    }
  });

  test("reports invalid cron expressions", () => {
    expect(getCronPreview("definitely not cron")).toEqual({
      error: "Invalid cron expression",
    });
  });
});
