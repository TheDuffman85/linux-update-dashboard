import { describe, test, expect } from "bun:test";
import { CredentialEncryptor } from "../../server/security";
import { randomBytes } from "crypto";

describe("CredentialEncryptor", () => {
  const testKey = randomBytes(32).toString("base64");

  test("encrypt and decrypt roundtrip", () => {
    const enc = new CredentialEncryptor(testKey);
    const plaintext = "my-secret-password";
    const ciphertext = enc.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(enc.decrypt(ciphertext)).toBe(plaintext);
  });

  test("same plaintext produces different ciphertexts", () => {
    const enc = new CredentialEncryptor(testKey);
    const a = enc.encrypt("test");
    const b = enc.encrypt("test");
    expect(a).not.toBe(b);
  });

  test("tampered ciphertext fails", () => {
    const enc = new CredentialEncryptor(testKey);
    const ciphertext = enc.encrypt("test");
    const tampered = "X" + ciphertext.slice(1);
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  test("missing key throws", () => {
    expect(() => new CredentialEncryptor("")).toThrow("Encryption key is required");
  });

  test("passphrase-derived key works", () => {
    const enc = new CredentialEncryptor("my-passphrase");
    const ciphertext = enc.encrypt("secret");
    expect(enc.decrypt(ciphertext)).toBe("secret");
  });

  test("base64 key format works", () => {
    const key = randomBytes(32).toString("base64");
    const enc = new CredentialEncryptor(key);
    const ciphertext = enc.encrypt("data");
    expect(enc.decrypt(ciphertext)).toBe("data");
  });
});
