import { describe, test, expect } from "bun:test";
import { CredentialEncryptor, isPassphraseKey } from "../../server/security";
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

  test("per-instance salt produces different keys than legacy salt", () => {
    const passphrase = "my-test-passphrase";
    const customSalt = randomBytes(16);
    const legacyEnc = new CredentialEncryptor(passphrase); // uses legacy salt
    const saltedEnc = new CredentialEncryptor(passphrase, customSalt);

    const plaintext = "sensitive-data";
    const legacyCipher = legacyEnc.encrypt(plaintext);
    const saltedCipher = saltedEnc.encrypt(plaintext);

    // Both should decrypt with their respective encryptors
    expect(legacyEnc.decrypt(legacyCipher)).toBe(plaintext);
    expect(saltedEnc.decrypt(saltedCipher)).toBe(plaintext);

    // Cross-decryption should fail (different derived keys)
    expect(() => saltedEnc.decrypt(legacyCipher)).toThrow();
    expect(() => legacyEnc.decrypt(saltedCipher)).toThrow();
  });

  test("base64 key ignores salt parameter", () => {
    const key = randomBytes(32).toString("base64");
    const salt = randomBytes(16);
    const enc1 = new CredentialEncryptor(key);
    const enc2 = new CredentialEncryptor(key, salt);

    const plaintext = "test-data";
    const cipher = enc1.encrypt(plaintext);
    // Both should decrypt because base64 keys bypass PBKDF2
    expect(enc2.decrypt(cipher)).toBe(plaintext);
  });
});

describe("isPassphraseKey", () => {
  test("detects base64 keys", () => {
    const key = randomBytes(32).toString("base64");
    expect(isPassphraseKey(key)).toBe(false);
  });

  test("detects passphrases", () => {
    expect(isPassphraseKey("my-passphrase")).toBe(true);
    expect(isPassphraseKey("short")).toBe(true);
    expect(isPassphraseKey("a-longer-passphrase-that-is-not-base64")).toBe(true);
  });
});
