import { describe, expect, test } from "bun:test";
import { dnfParser, pacmanParser, snapParser, yumParser } from "../../server/ssh/parsers";

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
  });
});
