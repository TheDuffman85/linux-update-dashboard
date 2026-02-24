import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const LEGACY_SALT = Buffer.from("linux-update-dashboard-salt");
const PBKDF2_ITERATIONS = 480_000;

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
    const data = Buffer.from(ciphertext, "base64");
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final("utf8");
  }
}

/**
 * Returns true if the raw key is a passphrase (needs PBKDF2 derivation).
 */
export function isPassphraseKey(rawKey: string): boolean {
  return !(rawKey.length === 44 && rawKey.endsWith("="));
}

let _encryptor: CredentialEncryptor | null = null;

export function initEncryptor(key: string, salt?: Buffer | null): void {
  _encryptor = new CredentialEncryptor(key, salt);
}

export function getEncryptor(): CredentialEncryptor {
  if (!_encryptor) throw new Error("Encryptor not initialized");
  return _encryptor;
}
