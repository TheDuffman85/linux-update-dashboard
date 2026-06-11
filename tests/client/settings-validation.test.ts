import { describe, expect, test } from "vitest";
import { NUMERIC_SETTING_RULES, normalizeSettingsUpdate } from "../../client/lib/settings-validation";

describe("normalizeSettingsUpdate", () => {
  test("clamps numeric settings to their allowed ranges", () => {
    expect(
      normalizeSettingsUpdate({
        activity_history_limit: "999",
        ssh_timeout_seconds: "2",
        cmd_timeout_seconds: "601",
        concurrent_connections: "0",
      }),
    ).toEqual({
      activity_history_limit: "200",
      ssh_timeout_seconds: "5",
      cmd_timeout_seconds: "600",
      concurrent_connections: "1",
    });
  });

  test("enforces the minimum activity history limit", () => {
    expect(
      normalizeSettingsUpdate({
        activity_history_limit: "1",
      }),
    ).toEqual({
      activity_history_limit: "5",
    });
  });

  test("falls back to defaults for invalid numeric input", () => {
    expect(
      normalizeSettingsUpdate({
        activity_history_limit: "nope",
      }),
    ).toEqual({
      activity_history_limit: "20",
    });
  });

  test("uses provided numeric rules for timeout maximums", () => {
    expect(
      normalizeSettingsUpdate(
        {
          ssh_timeout_seconds: "240",
          cmd_timeout_seconds: "900",
        },
        {
          ...NUMERIC_SETTING_RULES,
          ssh_timeout_seconds: { min: 5, max: 240, fallback: 30 },
          cmd_timeout_seconds: { min: 10, max: 900, fallback: 120 },
        },
      ),
    ).toEqual({
      ssh_timeout_seconds: "240",
      cmd_timeout_seconds: "900",
    });
  });
});
