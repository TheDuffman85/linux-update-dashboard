import { Hono } from "hono";
import { eq, count } from "drizzle-orm";
import { getDb } from "../db";
import { settings, webauthnCredentials } from "../db/schema";
import { configureOidc } from "../auth/oidc";
import { getEncryptor } from "../security";
import * as scheduler from "../services/scheduler";
import type { SessionData } from "../auth/session";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const SENSITIVE_KEYS = ["oidc_client_secret"];
const NUMERIC_SETTING_RULES = {
  check_interval_minutes: { min: 5, max: 1440, fallback: 15 },
  cache_duration_hours: { min: 0, max: 168, fallback: 12 },
  ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
  cmd_timeout_seconds: { min: 10, max: 600, fallback: 120 },
  concurrent_connections: { min: 1, max: 50, fallback: 5 },
} as const;

const settingsRouter = new Hono<AuthEnv>();

type NumericSettingKey = keyof typeof NUMERIC_SETTING_RULES;

function isNumericSettingKey(key: string): key is NumericSettingKey {
  return key in NUMERIC_SETTING_RULES;
}

function normalizeNumericSetting(key: NumericSettingKey, value: unknown): string {
  const { min, max, fallback } = NUMERIC_SETTING_RULES[key];
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return String(fallback);
  }

  return String(Math.min(max, Math.max(min, parsed)));
}

// Get all settings
settingsRouter.get("/", (c) => {
  const db = getDb();
  const allSettings = db.select().from(settings).orderBy(settings.key).all();
  const settingsMap: Record<string, string> = {};
  for (const s of allSettings) {
    if (SENSITIVE_KEYS.includes(s.key) && s.value) {
      settingsMap[s.key] = "(stored)";
    } else {
      settingsMap[s.key] = s.value;
    }
  }
  return c.json({ settings: settingsMap });
});

// Update settings
settingsRouter.put("/", async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const db = getDb();
  const normalizedBody = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      isNumericSettingKey(key) ? normalizeNumericSetting(key, value) : value,
    ]),
  );

  // Prevent disabling password login without an alternative auth method
  if (normalizedBody.disable_password_login === "true") {
    const user = c.get("user");

    // Check if user has at least one passkey
    const passkeyCnt = db
      .select({ count: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.userId))
      .get();
    const hasPasskeys = (passkeyCnt?.count ?? 0) > 0;

    // Check if OIDC is configured
    const oidcIssuer = db.select({ value: settings.value }).from(settings).where(eq(settings.key, "oidc_issuer")).get();
    const oidcClientId = db.select({ value: settings.value }).from(settings).where(eq(settings.key, "oidc_client_id")).get();
    const hasOidc = !!(oidcIssuer?.value && oidcClientId?.value);

    if (!hasPasskeys && !hasOidc) {
      return c.json({
        error: "Cannot disable password login without a passkey or SSO configured",
      }, 400);
    }
  }

  const encryptor = getEncryptor();
  for (const [key, value] of Object.entries(normalizedBody)) {
    const strValue = String(value);

    // Skip sensitive fields that haven't been changed
    if (SENSITIVE_KEYS.includes(key) && strValue === "(stored)") continue;

    // Encrypt sensitive fields before storing
    const finalValue =
      SENSITIVE_KEYS.includes(key) && strValue
        ? encryptor.encrypt(strValue)
        : strValue;

    db.update(settings)
      .set({
        value: finalValue,
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      })
      .where(eq(settings.key, key))
      .run();
  }

  // Restart scheduler if check interval was changed
  if ("check_interval_minutes" in normalizedBody) {
    scheduler.restart();
  }

  // Reconfigure OIDC if any OIDC settings were changed
  const oidcKeys = ["oidc_issuer", "oidc_client_id", "oidc_client_secret"];
  if (oidcKeys.some((k) => k in normalizedBody)) {
    const issuer = db.select().from(settings).where(eq(settings.key, "oidc_issuer")).get();
    const clientId = db.select().from(settings).where(eq(settings.key, "oidc_client_id")).get();
    const clientSecret = db.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();

    const decryptedSecret = clientSecret?.value
      ? encryptor.decrypt(clientSecret.value)
      : "";

    const oidcError = await configureOidc(
      issuer?.value || "",
      clientId?.value || "",
      decryptedSecret,
    );
    if (oidcError) {
      return c.json({ status: "ok", oidcError });
    }
  }

  return c.json({ status: "ok" });
});

export default settingsRouter;
