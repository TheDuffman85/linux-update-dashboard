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

const settingsRouter = new Hono<AuthEnv>();

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
  const db = getDb();

  // Prevent disabling password login without an alternative auth method
  if (body.disable_password_login === "true") {
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
  for (const [key, value] of Object.entries(body)) {
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
  if ("check_interval_minutes" in body) {
    scheduler.restart();
  }

  // Reconfigure OIDC if any OIDC settings were changed
  const oidcKeys = ["oidc_issuer", "oidc_client_id", "oidc_client_secret"];
  if (oidcKeys.some((k) => k in body)) {
    const issuer = db.select().from(settings).where(eq(settings.key, "oidc_issuer")).get();
    const clientId = db.select().from(settings).where(eq(settings.key, "oidc_client_id")).get();
    const clientSecret = db.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();

    const decryptedSecret = clientSecret?.value
      ? encryptor.decrypt(clientSecret.value)
      : "";

    try {
      await configureOidc(
        issuer?.value || "",
        clientId?.value || "",
        decryptedSecret,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Failed to reconfigure OIDC:", e);
      return c.json({ status: "ok", oidcError: message });
    }
  }

  return c.json({ status: "ok" });
});

export default settingsRouter;
