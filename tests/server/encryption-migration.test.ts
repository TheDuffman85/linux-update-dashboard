import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb, initDatabase, closeDatabase } from "../../server/db";
import { credentials, notifications, settings, systems } from "../../server/db/schema";
import { migrateEncryptionSalt, migrateLegacyAuthTags } from "../../server/encryption-migration";
import { CredentialEncryptor, CURRENT_AUTH_TAG_LENGTH, getEncryptor, initEncryptor } from "../../server/security";

function encryptWithAuthTagLength(plaintext: string, key: Buffer, authTagLength: number): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

describe("encryption migrations", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-encryption-migration-"));
    dbPath = join(tempDir, "dashboard.db");
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("migrates legacy AES-GCM auth tags across encrypted storage", () => {
    const rawKey = randomBytes(32).toString("base64");
    const key = Buffer.from(rawKey, "base64");

    initEncryptor(rawKey);
    initDatabase(dbPath);

    const db = getDb();
    const systemPassword = encryptWithAuthTagLength("system-secret", key, 12);
    const oidcSecret = encryptWithAuthTagLength("oidc-secret", key, 12);
    const credentialPassword = encryptWithAuthTagLength("credential-secret", key, 12);
    const webhookHeader = encryptWithAuthTagLength("header-secret", key, 12);
    const webhookPassword = encryptWithAuthTagLength("basic-secret", key, 12);
    const webhookField = encryptWithAuthTagLength("field-secret", key, 12);

    const systemRow = db.insert(systems).values({
      name: "web-1",
      hostname: "web-1.local",
      username: "root",
      encryptedPassword: systemPassword,
    }).returning({ id: systems.id }).get();

    db.update(settings)
      .set({ value: oidcSecret })
      .where(eq(settings.key, "oidc_client_secret"))
      .run();

    const credentialRow = db.insert(credentials).values({
      name: "DB login",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "app",
        password: credentialPassword,
      }),
    }).returning({ id: credentials.id }).get();

    const notificationRow = db.insert(notifications).values({
      name: "Webhook",
      type: "webhook",
      config: JSON.stringify({
        preset: "custom",
        method: "POST",
        url: "https://example.com/webhook",
        query: [],
        headers: [{ name: "X-Secret", value: webhookHeader, sensitive: true }],
        auth: { mode: "basic", username: "ops", password: webhookPassword },
        body: { mode: "form", fields: [{ name: "token", value: webhookField, sensitive: true }] },
        timeoutMs: 10000,
        retryAttempts: 0,
        retryDelayMs: 0,
        allowInsecureTls: false,
      }),
    }).returning({ id: notifications.id }).get();

    migrateLegacyAuthTags();

    const migratedSystem = db.select().from(systems).where(eq(systems.id, systemRow.id)).get();
    const migratedSetting = db.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();
    const migratedCredential = db.select().from(credentials).where(eq(credentials.id, credentialRow.id)).get();
    const migratedNotification = db.select().from(notifications).where(eq(notifications.id, notificationRow.id)).get();

    const decryptor = getEncryptor();
    const systemMeta = decryptor.decryptWithMetadata(migratedSystem?.encryptedPassword as string);
    const settingMeta = decryptor.decryptWithMetadata(migratedSetting?.value as string);
    const credentialMeta = decryptor.decryptWithMetadata(
      JSON.parse(migratedCredential?.payload as string).password,
    );
    const webhookConfig = JSON.parse(migratedNotification?.config as string);
    const headerMeta = decryptor.decryptWithMetadata(webhookConfig.headers[0].value);
    const passwordMeta = decryptor.decryptWithMetadata(webhookConfig.auth.password);
    const fieldMeta = decryptor.decryptWithMetadata(webhookConfig.body.fields[0].value);

    expect(systemMeta).toEqual({
      plaintext: "system-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
    expect(settingMeta).toEqual({
      plaintext: "oidc-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
    expect(credentialMeta).toEqual({
      plaintext: "credential-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
    expect(headerMeta).toEqual({
      plaintext: "header-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
    expect(passwordMeta).toEqual({
      plaintext: "basic-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
    expect(fieldMeta).toEqual({
      plaintext: "field-secret",
      authTagLength: CURRENT_AUTH_TAG_LENGTH,
    });
  });

  test("migrates webhook secrets from the legacy salt to the per-instance salt", () => {
    const passphrase = "migration-passphrase";
    const newSalt = randomBytes(16);

    initEncryptor(passphrase, newSalt);
    initDatabase(dbPath);

    const legacyEncryptor = new CredentialEncryptor(passphrase);
    const db = getDb();
    const legacyHeader = legacyEncryptor.encrypt("legacy-header");
    const legacyPassword = legacyEncryptor.encrypt("legacy-password");

    const inserted = db.insert(notifications).values({
      name: "Webhook",
      type: "webhook",
      config: JSON.stringify({
        preset: "custom",
        method: "POST",
        url: "https://example.com/webhook",
        query: [],
        headers: [{ name: "X-Secret", value: legacyHeader, sensitive: true }],
        auth: { mode: "basic", username: "ops", password: legacyPassword },
        body: { mode: "text", template: "{{event.body}}" },
        timeoutMs: 10000,
        retryAttempts: 0,
        retryDelayMs: 0,
        allowInsecureTls: false,
      }),
    }).returning({ id: notifications.id }).get();

    migrateEncryptionSalt(passphrase, newSalt);

    const migrated = db.select().from(notifications).where(eq(notifications.id, inserted.id)).get();
    const webhookConfig = JSON.parse(migrated?.config as string);
    const decryptor = getEncryptor();

    expect(decryptor.decrypt(webhookConfig.headers[0].value)).toBe("legacy-header");
    expect(decryptor.decrypt(webhookConfig.auth.password)).toBe("legacy-password");
    expect(webhookConfig.headers[0].value).not.toBe(legacyHeader);
    expect(webhookConfig.auth.password).not.toBe(legacyPassword);
  });
});
