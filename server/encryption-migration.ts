import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { credentials, notifications, settings, systems } from "./db/schema";
import { logger } from "./logger";
import {
  CredentialEncryptor,
  CURRENT_AUTH_TAG_LENGTH,
  getEncryptor,
  isPassphraseKey,
  looksLikeEncryptedValue,
} from "./security";

const STORED_SENTINEL = "(stored)";

type RewriteEncryptedValue = (value: string) => string;

function rewriteValue(value: string | null | undefined, rewrite: RewriteEncryptedValue): [string | null | undefined, boolean] {
  if (!value || value === STORED_SENTINEL) return [value, false];
  const nextValue = rewrite(value);
  return [nextValue, nextValue !== value];
}

function rewriteFlatFields(
  config: Record<string, unknown>,
  fields: readonly string[],
  rewrite: RewriteEncryptedValue,
): boolean {
  let changed = false;

  for (const field of fields) {
    const current = typeof config[field] === "string" ? config[field] as string : null;
    const [nextValue, didChange] = rewriteValue(current, rewrite);
    if (didChange) {
      config[field] = nextValue;
      changed = true;
    }
  }

  return changed;
}

function rewriteWebhookSecrets(config: Record<string, unknown>, rewrite: RewriteEncryptedValue): boolean {
  let changed = false;

  if (Array.isArray(config.headers)) {
    for (const header of config.headers) {
      if (!header || typeof header !== "object") continue;
      const record = header as Record<string, unknown>;
      const [nextValue, didChange] = rewriteValue(
        record.sensitive === true && typeof record.value === "string" ? record.value : null,
        rewrite,
      );
      if (didChange) {
        record.value = nextValue;
        changed = true;
      }
    }
  }

  if (config.auth && typeof config.auth === "object") {
    const auth = config.auth as Record<string, unknown>;
    if (auth.mode === "bearer") {
      const [nextValue, didChange] = rewriteValue(
        typeof auth.token === "string" ? auth.token : null,
        rewrite,
      );
      if (didChange) {
        auth.token = nextValue;
        changed = true;
      }
    }

    if (auth.mode === "basic") {
      const [nextValue, didChange] = rewriteValue(
        typeof auth.password === "string" ? auth.password : null,
        rewrite,
      );
      if (didChange) {
        auth.password = nextValue;
        changed = true;
      }
    }
  }

  if (config.body && typeof config.body === "object") {
    const body = config.body as Record<string, unknown>;
    if (body.mode === "form" && Array.isArray(body.fields)) {
      for (const field of body.fields) {
        if (!field || typeof field !== "object") continue;
        const record = field as Record<string, unknown>;
        const [nextValue, didChange] = rewriteValue(
          record.sensitive === true && typeof record.value === "string" ? record.value : null,
          rewrite,
        );
        if (didChange) {
          record.value = nextValue;
          changed = true;
        }
      }
    }
  }

  return changed;
}

function rewriteNotificationConfig(
  type: string,
  rawConfig: string,
  rewrite: RewriteEncryptedValue,
): string | null {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    return null;
  }

  let changed = false;

  switch (type) {
    case "email":
      changed = rewriteFlatFields(config, ["smtpPassword"], rewrite);
      break;
    case "gotify":
      changed = rewriteFlatFields(config, ["gotifyToken"], rewrite);
      break;
    case "ntfy":
      changed = rewriteFlatFields(config, ["ntfyToken"], rewrite);
      break;
    case "telegram":
      changed = rewriteFlatFields(config, ["telegramBotToken", "commandApiTokenEncrypted"], rewrite);
      break;
    case "webhook":
      changed = rewriteWebhookSecrets(config, rewrite);
      break;
    default:
      break;
  }

  return changed ? JSON.stringify(config) : null;
}

function migrateStoredEncryptedValues(rewrite: RewriteEncryptedValue): number {
  const dbInstance = getDb();
  let changedRows = 0;

  const allSystems = dbInstance.select().from(systems).all();
  for (const sys of allSystems) {
    const updates: Record<string, string | null> = {};
    let changed = false;

    for (const col of [
      "encryptedPassword",
      "encryptedPrivateKey",
      "encryptedKeyPassphrase",
      "encryptedSudoPassword",
    ] as const) {
      const [nextValue, didChange] = rewriteValue(sys[col], rewrite);
      if (didChange) {
        updates[col] = nextValue ?? null;
        changed = true;
      }
    }

    if (changed) {
      dbInstance.update(systems).set(updates as never).where(eq(systems.id, sys.id)).run();
      changedRows += 1;
    }
  }

  const oidcClientSecret = dbInstance.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();
  if (oidcClientSecret?.value) {
    const [nextValue, changed] = rewriteValue(oidcClientSecret.value, rewrite);
    if (changed && nextValue) {
      dbInstance
        .update(settings)
        .set({ value: nextValue })
        .where(eq(settings.key, "oidc_client_secret"))
        .run();
      changedRows += 1;
    }
  }

  const credentialSecretFields: Record<string, string[]> = {
    usernamePassword: ["password"],
    sshKey: ["privateKey", "passphrase"],
    certificate: ["certificatePem", "privateKeyPem", "privateKeyPassword"],
  };

  const allCredentials = dbInstance.select().from(credentials).all();
  for (const credential of allCredentials) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(credential.payload);
    } catch {
      continue;
    }

    let changed = false;
    for (const field of credentialSecretFields[credential.kind] || []) {
      const [nextValue, didChange] = rewriteValue(
        typeof payload[field] === "string" ? payload[field] as string : null,
        rewrite,
      );
      if (didChange) {
        payload[field] = nextValue;
        changed = true;
      }
    }

    if (changed) {
      dbInstance
        .update(credentials)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(credentials.id, credential.id))
        .run();
      changedRows += 1;
    }
  }

  const allNotifications = dbInstance.select().from(notifications).all();
  for (const notification of allNotifications) {
    const nextConfig = rewriteNotificationConfig(notification.type, notification.config, rewrite);
    if (!nextConfig) continue;

    dbInstance
      .update(notifications)
      .set({ config: nextConfig })
      .where(eq(notifications.id, notification.id))
      .run();
    changedRows += 1;
  }

  return changedRows;
}

export function migrateEncryptionSalt(rawKey: string, newSalt: Buffer | null): void {
  if (!newSalt || !isPassphraseKey(rawKey)) return;

  const dbInstance = getDb();
  const anySystem = dbInstance.select({ id: systems.id }).from(systems).limit(1).get();
  const anyEncryptedSetting = dbInstance
    .select()
    .from(settings)
    .where(eq(settings.key, "oidc_client_secret"))
    .get();
  const anyCredential = dbInstance.select({ id: credentials.id }).from(credentials).limit(1).get();
  const anyNotification = dbInstance.select({ id: notifications.id }).from(notifications).limit(1).get();

  const hasEncryptedData =
    anySystem ||
    anyCredential ||
    anyNotification ||
    (anyEncryptedSetting?.value && anyEncryptedSetting.value.length > 0);

  if (!hasEncryptedData) return;

  const oldEncryptor = new CredentialEncryptor(rawKey);
  const newEncryptor = new CredentialEncryptor(rawKey, newSalt);

  logger.info("Migrating encrypted data to per-instance salt");

  const changedRows = migrateStoredEncryptedValues((value) => {
    try {
      return newEncryptor.encrypt(oldEncryptor.decrypt(value));
    } catch {
      return value;
    }
  });

  if (changedRows > 0) {
    logger.info("Encryption salt migration complete", { changedRows });
  }
}

export function migrateLegacyAuthTags(): void {
  const encryptor = getEncryptor();

  const changedRows = migrateStoredEncryptedValues((value) => {
    if (!looksLikeEncryptedValue(value)) return value;

    try {
      const { plaintext, authTagLength } = encryptor.decryptWithMetadata(value);
      return authTagLength === CURRENT_AUTH_TAG_LENGTH ? value : encryptor.encrypt(plaintext);
    } catch {
      return value;
    }
  });

  if (changedRows > 0) {
    logger.info("Migrated legacy AES-GCM auth tag lengths", { changedRows });
  }
}
