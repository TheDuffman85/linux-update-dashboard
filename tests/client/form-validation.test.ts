import { describe, expect, test } from "bun:test";
import { validatePassword } from "../../client/lib/form-validation";

describe("validatePassword", () => {
  test("requires at least 8 characters", () => {
    expect(validatePassword("Abc123")).toBe("Password must be at least 8 characters");
  });

  test("requires a lowercase letter", () => {
    expect(validatePassword("ABCDEFG1")).toBe("Password must contain a lowercase letter");
  });

  test("requires an uppercase letter", () => {
    expect(validatePassword("abcdefg1")).toBe("Password must contain an uppercase letter");
  });

  test("requires a digit", () => {
    expect(validatePassword("Abcdefgh")).toBe("Password must contain a digit");
  });

  test("accepts a valid password", () => {
    expect(validatePassword("Abcdefg1")).toBeNull();
  });
});
