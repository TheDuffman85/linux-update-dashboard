import { describe, expect, test } from "vitest";
import { parseTimeZone } from "../../server/time-zone";

describe("timezone configuration", () => {
  test("accepts and canonicalizes IANA timezones", () => {
    expect(parseTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(parseTimeZone(" UTC ")).toBe("UTC");
    expect(parseTimeZone(undefined)).toBeNull();
  });

  test("rejects invalid TZ values", () => {
    expect(() => parseTimeZone("not/a-timezone")).toThrow("Invalid TZ value");
  });
});
