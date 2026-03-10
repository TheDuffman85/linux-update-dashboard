import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const MAX_TAG_LENGTH = 16;
const MIN_TAG_LENGTH = 4;
const LEGACY_SALT = Buffer.from("linux-update-dashboard-salt");
const PBKDF2_ITERATIONS = 480_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
export const CURRENT_AUTH_TAG_LENGTH = MAX_TAG_LENGTH;

export class CredentialEncryptor {
  private key: Buffer;

  constructor(rawKey: string, salt?: Buffer | null) {
    if (!rawKey) {
      throw new Error(
        "Encryption key is required. " +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }

    // If it's a 32-byte base64 key (44 chars ending with =), decode it directly.
    // Otherwise derive a key from the passphrase via PBKDF2.
    if (rawKey.length === 44 && rawKey.endsWith("=")) {
      this.key = Buffer.from(rawKey, "base64");
    } else {
      const deriveSalt = salt ?? LEGACY_SALT;
      this.key = pbkdf2Sync(rawKey, deriveSalt, PBKDF2_ITERATIONS, 32, "sha256");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Format: base64(iv + tag + ciphertext)
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    return this.decryptWithMetadata(ciphertext).plaintext;
  }

  decryptWithMetadata(ciphertext: string): { plaintext: string; authTagLength: number } {
    if (!looksLikeEncryptedValue(ciphertext)) {
      throw new Error("Invalid encrypted value");
    }

    const data = Buffer.from(ciphertext, "base64");
    const iv = data.subarray(0, IV_LENGTH);
    const maxTagLength = Math.min(MAX_TAG_LENGTH, data.length - IV_LENGTH);
    let lastError: unknown = null;

    for (let tagLength = maxTagLength; tagLength >= MIN_TAG_LENGTH; tagLength--) {
      const tag = data.subarray(IV_LENGTH, IV_LENGTH + tagLength);
      const encrypted = data.subarray(IV_LENGTH + tagLength);

      try {
        const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: tagLength });
        decipher.setAuthTag(tag);
        return {
          plaintext: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
          authTagLength: tagLength,
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Invalid encrypted value");
  }
}

/**
 * Returns true if the raw key is a passphrase (needs PBKDF2 derivation).
 */
export function isPassphraseKey(rawKey: string): boolean {
  return !(rawKey.length === 44 && rawKey.endsWith("="));
}

export function looksLikeEncryptedValue(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false;

  const data = Buffer.from(value, "base64");
  if (data.length < IV_LENGTH + MIN_TAG_LENGTH) return false;

  return data.toString("base64") === value;
}

let _encryptor: CredentialEncryptor | null = null;

export function initEncryptor(key: string, salt?: Buffer | null): void {
  _encryptor = new CredentialEncryptor(key, salt);
}

export function getEncryptor(): CredentialEncryptor {
  if (!_encryptor) throw new Error("Encryptor not initialized");
  return _encryptor;
}
