import { describe, expect, test } from "vitest";
import { aptParser, dnfParser, pacmanParser, snapParser, yumParser } from "../../server/ssh/parsers";

describe("parser check step labels", () => {
  test("provides human-readable labels for package managers with custom check flows", () => {
    expect(snapParser.getCheckCommandLabels?.()).toEqual([
      "Checking for updates",
    ]);
    expect(dnfParser.getCheckCommandLabels?.()).toEqual([
      "Checking for updates",
    ]);
    expect(yumParser.getCheckCommandLabels?.()).toEqual([
      "Checking for updates",
    ]);
    expect(pacmanParser.getCheckCommandLabels?.()).toEqual([
      "Refreshing package databases",
      "Listing available updates",
    ]);
    expect(aptParser.getCheckCommandLabels?.()).toEqual([
      "Auditing dpkg state",
      "Fetching package lists",
      "Listing available updates",
      "Detecting kept-back packages",
    ]);
  });
});
