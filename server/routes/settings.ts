import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { configureOidc } from "../auth/oidc";
import { getEncryptor } from "../security";
import * as scheduler from "../services/scheduler";

const SENSITIVE_KEYS = ["oidc_client_secret"];

const settingsRouter = new Hono();

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
