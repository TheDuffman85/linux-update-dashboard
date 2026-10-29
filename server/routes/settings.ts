import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import {
  configureOidcFromSettings,
  DEFAULT_OIDC_GROUPS_CLAIM,
  OIDC_AUTO_LOGIN_SETTING_KEY,
  OIDC_BACKCHANNEL_LOGOUT_SETTING_KEY,
  OIDC_END_SESSION_SETTING_KEY,
  parseCsvList,
  parseOidcScope,
  parseOidcUnmatchedRole,
} from "../auth/oidc";
import {
  getAuthSettings,
  getManagedAuthSettings,
  getOidcAutoLoginState,
  getPasswordLoginState,
  hasAdminPasskey,
  hasOidcSettings,
  isAuthSettingKey,
  isAuthSettingManaged,
  MANAGED_BY_CONFIG_CODE,
  type AuthSettingKey,
} from "../auth/auth-config";
import { getEncryptor } from "../security";
import * as updateService from "../services/update-service";
import * as notificationRuntime from "../services/notification-runtime";
import {
  getNumericSettingRules,
  isNumericSettingKey,
  normalizeNumericSetting,
  syncSSHManagerWithSettings,
} from "../services/settings-service";
import type { SessionData } from "../auth/session";
import { getConfiguredTimeZone } from "../time-zone";
import { getUserPreferences } from "../services/user-service";
import {
  APP_LOGO_DARK_SETTING_KEY,
  APP_LOGO_JPEG_SETTING_KEY,
  APP_LOGO_SETTING_KEY,
  APP_NAME_SETTING_KEY,
  APP_THEME_SETTING_KEY,
  BrandingValidationError,
  clearAppDarkLogo,
  clearAppLogo,
  getAppLogo,
  getPublicBranding,
  normalizeAppName,
  parseAppLogoJpegUpload,
  parseAppLogoUpload,
  saveAppDarkLogo,
  saveAppLogo,
  saveAppTheme,
  type AppLogoVariant,
} from "../services/branding-service";
import {
  BrandingThemeValidationError,
  parseBrandingThemeInput,
} from "../../shared/branding-theme";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const SENSITIVE_KEYS = ["oidc_client_secret"];
const PUBLIC_SETTING_KEYS = ["language"] as const;
// Managed through dedicated branding endpoints; the logos are also too large to
// ship with every settings read.
const HIDDEN_KEYS = [
  APP_LOGO_SETTING_KEY,
  APP_LOGO_JPEG_SETTING_KEY,
  APP_LOGO_DARK_SETTING_KEY,
  APP_THEME_SETTING_KEY,
];

const settingsRouter = new Hono<AuthEnv>();

settingsRouter.get("/public", (c) => {
  const db = getDb();
  const publicSettings: Record<(typeof PUBLIC_SETTING_KEYS)[number], string> = {
    language: "browser",
  };

  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.key, "language"))
    .all();

  for (const row of rows) {
    if (PUBLIC_SETTING_KEYS.includes(row.key as (typeof PUBLIC_SETTING_KEYS)[number])) {
      publicSettings[row.key as (typeof PUBLIC_SETTING_KEYS)[number]] = row.value;
    }
  }

  return c.json({ settings: publicSettings, branding: getPublicBranding() });
});

function serveLogo(c: Context, variant: AppLogoVariant) {
  const logo = getAppLogo(variant);
  if (!logo) {
    return c.json({ error: "No custom logo configured" }, 404);
  }

  const versioned = c.req.query("v") === logo.version;
  c.header("Content-Type", logo.contentType);
  c.header(
    "Cache-Control",
    versioned ? "public, max-age=31536000, immutable" : "no-cache",
  );
  // SVG logos are rendered via <img>, but lock them down in case one is
  // opened directly so embedded scripts can never run on this origin.
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  );
  c.header("Content-Disposition", "inline");
  return c.body(new Uint8Array(logo.data));
}

settingsRouter.get("/public/logo", (c) => serveLogo(c, "default"));
settingsRouter.get("/public/logo/dark", (c) => serveLogo(c, "dark"));

settingsRouter.put("/branding/logo", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  try {
    const { dataUrl, jpegDataUrl } = body as { dataUrl?: unknown; jpegDataUrl?: unknown };
    const logo = parseAppLogoUpload(dataUrl);
    const jpeg = jpegDataUrl == null ? null : parseAppLogoJpegUpload(jpegDataUrl);
    saveAppLogo(logo, jpeg);
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  // Home Assistant entity pictures and Telegram bot photos follow the logo.
  void notificationRuntime.syncBranding();
  return c.json({ status: "ok", branding: getPublicBranding() });
});

settingsRouter.delete("/branding/logo", (c) => {
  clearAppLogo();
  void notificationRuntime.syncBranding();
  return c.json({ status: "ok", branding: getPublicBranding() });
});

// The dark mode logo only replaces the main logo in the UI, so notification
// integrations keep following the main logo.
settingsRouter.put("/branding/logo/dark", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  try {
    saveAppDarkLogo(parseAppLogoUpload((body as { dataUrl?: unknown }).dataUrl));
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  return c.json({ status: "ok", branding: getPublicBranding() });
});

settingsRouter.delete("/branding/logo/dark", (c) => {
  clearAppDarkLogo();
  return c.json({ status: "ok", branding: getPublicBranding() });
});

settingsRouter.put("/branding/theme", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  try {
    saveAppTheme(parseBrandingThemeInput((body as { theme?: unknown }).theme));
  } catch (error) {
    if (error instanceof BrandingThemeValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  return c.json({ status: "ok", branding: getPublicBranding() });
});

// Get all settings, plus the signed-in user's own preferences. Only administrators
// see how sign-in is configured.
settingsRouter.get("/", (c) => {
  const db = getDb();
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const allSettings = db.select().from(settings).orderBy(settings.key).all();
  const settingsMap: Record<string, string> = {};
  for (const s of allSettings) {
    if (HIDDEN_KEYS.includes(s.key)) continue;
    if (!isAdmin && isAuthSettingKey(s.key)) continue;
    if (SENSITIVE_KEYS.includes(s.key) && s.value) {
      settingsMap[s.key] = "(stored)";
    } else if (isNumericSettingKey(s.key)) {
      settingsMap[s.key] = normalizeNumericSetting(s.key, s.value);
    } else {
      settingsMap[s.key] = s.value;
    }
  }
  const preferences = getUserPreferences(user.userId);
  if (!isAdmin) {
    return c.json({
      settings: settingsMap,
      preferences,
      numericSettingRules: getNumericSettingRules(),
      timeZone: getConfiguredTimeZone(),
    });
  }
  // Environment-managed auth settings report their effective value.
  const managedSettings = getManagedAuthSettings();
  const managedKeys = Object.keys(managedSettings) as AuthSettingKey[];
  for (const [key, value] of getAuthSettings(managedKeys)) {
    settingsMap[key] = SENSITIVE_KEYS.includes(key) ? "(stored)" : value;
  }
  return c.json({
    settings: settingsMap,
    preferences,
    managedSettings,
    passwordLoginFallback: getPasswordLoginState().fallback,
    oidcAutoLoginActive: getOidcAutoLoginState().active,
    numericSettingRules: getNumericSettingRules(),
    timeZone: getConfiguredTimeZone(),
  });
});

// Update settings
settingsRouter.put("/", async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const db = getDb();
  const normalizedBody: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      isNumericSettingKey(key) ? normalizeNumericSetting(key, value) : value,
    ]),
  );

  const managedKeys = Object.keys(normalizedBody).filter(isAuthSettingManaged);
  if (managedKeys.length > 0) {
    return c.json(
      {
        error: `Managed by environment configuration: ${managedKeys.join(", ")}`,
        code: MANAGED_BY_CONFIG_CODE,
        keys: managedKeys,
      },
      409,
    );
  }
  if (HIDDEN_KEYS.some((key) => key in normalizedBody)) {
    return c.json(
      { error: "Use the branding endpoints to change the logos and colors" },
      400,
    );
  }
  if (APP_NAME_SETTING_KEY in normalizedBody) {
    try {
      normalizedBody[APP_NAME_SETTING_KEY] = normalizeAppName(
        normalizedBody[APP_NAME_SETTING_KEY],
      );
    } catch (error) {
      if (error instanceof BrandingValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  }
  if ("oidc_scope" in normalizedBody) {
    try {
      normalizedBody.oidc_scope = parseOidcScope(
        typeof normalizedBody.oidc_scope === "string" ? normalizedBody.oidc_scope : "",
      );
    } catch {
      return c.json({ error: "OIDC scopes must include openid" }, 400);
    }
  }
  if ("oidc_unmatched_role" in normalizedBody) {
    try {
      if (typeof normalizedBody.oidc_unmatched_role !== "string") {
        throw new Error("Invalid role");
      }
      normalizedBody.oidc_unmatched_role = parseOidcUnmatchedRole(
        normalizedBody.oidc_unmatched_role,
      );
    } catch {
      return c.json({ error: "Invalid OIDC unmatched role" }, 400);
    }
  }
  if ("oidc_groups_claim" in normalizedBody) {
    const claim = normalizedBody.oidc_groups_claim;
    normalizedBody.oidc_groups_claim =
      typeof claim === "string" && claim.trim()
        ? claim.trim()
        : DEFAULT_OIDC_GROUPS_CLAIM;
  }
  for (const key of ["oidc_admin_groups", "oidc_read_only_groups"]) {
    if (key in normalizedBody) {
      const value = normalizedBody[key];
      normalizedBody[key] = parseCsvList(typeof value === "string" ? value : "").join(",");
    }
  }

  for (const key of [
    OIDC_END_SESSION_SETTING_KEY,
    OIDC_BACKCHANNEL_LOGOUT_SETTING_KEY,
    OIDC_AUTO_LOGIN_SETTING_KEY,
  ]) {
    if (key in normalizedBody) {
      const value = normalizedBody[key];
      normalizedBody[key] = value === true || value === "true" ? "true" : "false";
    }
  }

  // Prevent disabling password login unless an administrator can still sign in. OIDC
  // settings saved in the same request count, so both can be changed together.
  if (
    normalizedBody.disable_password_login === "true" &&
    !hasAdminPasskey() &&
    !hasOidcSettings(normalizedBody)
  ) {
    return c.json({
      error: "Cannot disable password login without an administrator passkey or SSO configured",
    }, 400);
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

    db.insert(settings)
      .values({
        key,
        value: finalValue,
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: finalValue,
          updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      })
      .run();
  }

  if (APP_NAME_SETTING_KEY in normalizedBody) {
    // Republish Home Assistant discovery so device and entity names follow.
    void notificationRuntime.syncAppUpdateState();
  }

  if ("activity_history_limit" in normalizedBody) {
    updateService.pruneHistoryToConfiguredLimit();
  }

  if (
    "ssh_timeout_seconds" in normalizedBody ||
    "cmd_timeout_seconds" in normalizedBody ||
    "concurrent_connections" in normalizedBody
  ) {
    syncSSHManagerWithSettings();
  }

  // Log right away when this change leaves auto-login enabled but inactive.
  getOidcAutoLoginState();

  // Reconfigure OIDC if any OIDC settings were changed
  const oidcKeys = ["oidc_issuer", "oidc_client_id", "oidc_client_secret"];
  if (oidcKeys.some((k) => k in normalizedBody)) {
    const oidcError = await configureOidcFromSettings();
    if (oidcError) {
      return c.json({ status: "ok", oidcError });
    }
  }

  return c.json({ status: "ok" });
});

export default settingsRouter;
