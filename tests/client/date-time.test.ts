import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BROWSER_TIME_FORMAT_SETTING,
  formatDateTimeValue,
  getBrowserTimeFormat,
  normalizeTimeFormatPreference,
  resolveTimeFormatPreference,
} from "../../client/lib/date-time";

describe("date and time settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("normalizes missing and invalid preferences to the browser default", () => {
    expect(normalizeTimeFormatPreference(undefined)).toBe(
      BROWSER_TIME_FORMAT_SETTING,
    );
    expect(normalizeTimeFormatPreference("invalid")).toBe(
      BROWSER_TIME_FORMAT_SETTING,
    );
    expect(normalizeTimeFormatPreference("12h")).toBe("12h");
    expect(normalizeTimeFormatPreference("24h")).toBe("24h");
  });

  test("detects the browser hour cycle", () => {
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({
        locale: "en-US",
        calendar: "gregory",
        numberingSystem: "latn",
        timeZone: "UTC",
        hour12: true,
      });

    expect(getBrowserTimeFormat()).toBe("12h");

    resolvedOptions.mockReturnValue({
      locale: "de-DE",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "UTC",
      hour12: false,
    });
    expect(getBrowserTimeFormat()).toBe("24h");
  });

  test("resolves browser default independently from the UI language locale", () => {
    expect(resolveTimeFormatPreference(BROWSER_TIME_FORMAT_SETTING, "24h")).toBe(
      "24h",
    );
    expect(resolveTimeFormatPreference(BROWSER_TIME_FORMAT_SETTING, "12h")).toBe(
      "12h",
    );
    expect(resolveTimeFormatPreference("12h", "24h")).toBe("12h");
  });

  test("keeps a browser 24-hour preference when the UI language is English", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "UTC",
      hour12: false,
    });

    const formatted = formatDateTimeValue(
      new Date("2026-01-02T20:30:00Z"),
      "en-US",
      { timeZone: "UTC", timeFormat: BROWSER_TIME_FORMAT_SETTING },
    );

    expect(formatted).toContain("20:30:00");
    expect(formatted).not.toContain("PM");
  });

  test("applies the deployment timezone and explicit hour format", () => {
    const date = new Date("2026-01-02T20:30:00Z");

    expect(
      formatDateTimeValue(date, "en-US", {
        timeZone: "Europe/Berlin",
        timeFormat: "12h",
      }),
    ).toContain("9:30:00 PM");
    expect(
      formatDateTimeValue(date, "en-US", {
        timeZone: "Europe/Berlin",
        timeFormat: "24h",
      }),
    ).toContain("21:30:00");
  });
});
