import { describe, expect, test } from "vitest";
import { clipOutput } from "../../server/utils/clip-output";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1).padStart(4, "0")}\n`).join("");

describe("clipOutput", () => {
  test("keeps output that fits", () => {
    expect(clipOutput("short\n", 100)).toBe("short\n");
    expect(clipOutput("", 10)).toBe("");
  });

  test("keeps the start and the end of long output and says how much was left out", () => {
    const text = lines(500);
    const clipped = clipOutput(text, 2000);

    expect(clipped.length).toBeLessThanOrEqual(2000);
    expect(clipped.startsWith("line 0001\n")).toBe(true);
    expect(clipped.endsWith("line 0500\n")).toBe(true);
    const marker = /\[… (\d+) characters omitted …\]\n/.exec(clipped);
    expect(marker).not.toBeNull();
    expect(clipped.length - marker![0].length + Number(marker![1])).toBe(text.length);
  });

  test("gives most of the room to the end, where failures are reported", () => {
    const clipped = clipOutput(lines(500), 2000);
    const [head, tail] = clipped.split(/\[… \d+ characters omitted …\]\n/);

    expect(tail.length).toBeGreaterThan(head.length * 2);
    // Whole lines on both sides of the marker.
    expect(head.endsWith("\n")).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
  });

  test("never exceeds the limit when the output has no line breaks", () => {
    const text = "x".repeat(10_000);
    for (const limit of [60, 61, 200, 2000, 5000]) {
      const clipped = clipOutput(text, limit);
      expect(clipped.length).toBeLessThanOrEqual(limit);
      expect(clipped).toContain("characters omitted");
    }
  });

  test("keeps only the end when the limit has no room for the marker", () => {
    expect(clipOutput("abcdefghij".repeat(5), 10)).toBe("abcdefghij");
  });
});
