import { afterEach, describe, expect, test, vi } from "vitest";
import { createToastId } from "../../client/context/ToastContext";

describe("createToastId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("uses getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.fill(10);
      return array;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    let id = "";
    expect(() => {
      id = createToastId();
    }).not.toThrow();
    expect(id).toBe("0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");
    expect(getRandomValues).toHaveBeenCalled();
  });

  test("falls back to a timestamp id when browser crypto is unavailable", () => {
    const timestamp = 1_779_226_400_000;
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(timestamp);

    let id = "";
    expect(() => {
      id = createToastId();
    }).not.toThrow();
    expect(id).toMatch(new RegExp(`^${timestamp.toString(36)}-[a-z0-9]+$`));
  });
});
