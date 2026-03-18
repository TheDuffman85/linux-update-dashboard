import { describe, expect, test } from "bun:test";
import { formatDurationBetween, formatDurationMs } from "../../client/lib/time";

describe("duration formatting", () => {
  test("shows sub-second durations as decimal seconds", () => {
    expect(formatDurationMs(400)).toBe("0.4s");
    expect(
      formatDurationBetween("2026-03-18 10:00:00.100", "2026-03-18 10:00:00.500")
    ).toBe("0.4s");
  });

  test("keeps decimal precision for short multi-second durations", () => {
    expect(formatDurationMs(1_000)).toBe("1.0s");
    expect(formatDurationMs(2_700)).toBe("2.7s");
  });

  test("keeps whole-second style for longer durations", () => {
    expect(formatDurationMs(65_000)).toBe("1m 5s");
  });
});
