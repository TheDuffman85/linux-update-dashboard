import { describe, test, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../../server/auth/password";

describe("Password hashing", () => {
  test("hash and verify matches", async () => {
    const hash = await hashPassword("mypassword");
    expect(hash).not.toBe("mypassword");
    expect(await verifyPassword("mypassword", hash)).toBe(true);
  });

  test("wrong password fails", async () => {
    const hash = await hashPassword("correct");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("same password produces different hashes", async () => {
    const a = await hashPassword("test");
    const b = await hashPassword("test");
    expect(a).not.toBe(b);
  });
});
