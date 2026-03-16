import { describe, expect, test } from "bun:test";
import { normalizeSettingsUpdate } from "../../client/lib/settings-validation";

describe("normalizeSettingsUpdate", () => {
  test("clamps numeric settings to their allowed ranges", () => {
    expect(
      normalizeSettingsUpdate({
        check_interval_minutes: "1",
        cache_duration_hours: "999",
        ssh_timeout_seconds: "2",
        cmd_timeout_seconds: "601",
        concurrent_connections: "0",
      }),
    ).toEqual({
      check_interval_minutes: "5",
      cache_duration_hours: "168",
      ssh_timeout_seconds: "5",
      cmd_timeout_seconds: "600",
      concurrent_connections: "1",
    });
  });

  test("falls back to defaults for invalid numeric input", () => {
    expect(
      normalizeSettingsUpdate({
        check_interval_minutes: "",
        cache_duration_hours: "abc",
      }),
    ).toEqual({
      check_interval_minutes: "15",
      cache_duration_hours: "12",
    });
  });
});
