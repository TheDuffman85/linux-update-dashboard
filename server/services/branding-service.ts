import crypto from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import {
  BRANDING_THEME_STYLE_ID,
  buildBrandingThemeCss,
  DEFAULT_BRANDING_THEME,
  isDefaultBrandingTheme,
  normalizeBrandingTheme,
  type BrandingTheme,
} from "../../shared/branding-theme";

export const DEFAULT_APP_NAME = "Linux Update Dashboard";
export const APP_NAME_SETTING_KEY = "app_name";
export const APP_LOGO_SETTING_KEY = "app_logo";
export const APP_LOGO_DARK_SETTING_KEY = "app_logo_dark";
export const APP_THEME_SETTING_KEY = "app_theme";
// JPEG rendition of the logo (rendered by the browser on upload) for services
// such as Telegram bot profile photos that only accept JPEG.
export const APP_LOGO_JPEG_SETTING_KEY = "app_logo_jpeg";
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_LOGO_BYTES = 512 * 1024;
export const APP_LOGO_PATH = "/api/settings/public/logo";
export const APP_LOGO_DARK_PATH = "/api/settings/public/logo/dark";

/** The main logo is used everywhere; the optional dark variant only replaces it while the dark theme is active. */
export type AppLogoVariant = "default" | "dark";

export type AppLogoContentType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml";

export type AppLogo = {
  contentType: AppLogoContentType;
  data: Buffer;
  version: string;
};

export type PublicBranding = {
  appName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  theme: BrandingTheme;
};

export class BrandingValidationError extends Error {}

const DATA_URL_PATTERN = /^data:[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/;

function readSetting(key: string): string | undefined {
  return getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()?.value;
}

function writeSetting(key: string, value: string): void {
  const updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  getDb()
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run();
}

/**
 * Normalizes an admin-provided application name. Empty values reset to the
 * default name; control characters are stripped and whitespace collapsed.
 */
export function normalizeAppName(value: unknown): string {
  if (typeof value !== "string") {
    throw new BrandingValidationError("Application name must be a string");
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length > MAX_APP_NAME_LENGTH) {
    throw new BrandingValidationError(
      `Application name must be ${MAX_APP_NAME_LENGTH} characters or fewer`,
    );
  }
  return normalized;
}

export function getAppName(): string {
  try {
    return readSetting(APP_NAME_SETTING_KEY)?.trim() || DEFAULT_APP_NAME;
  } catch {
    // Branding is cosmetic; never let a missing database break notifications.
    return DEFAULT_APP_NAME;
  }
}

function startsWithBytes(data: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => data[offset + index] === byte);
}

/** Detects the image type from its content instead of trusting the client. */
export function detectAppLogoContentType(data: Buffer): AppLogoContentType | null {
  if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const header = data.subarray(0, 12).toString("latin1");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";

  if (data.includes(0)) return null;
  const text = data.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text)) {
    return "image/svg+xml";
  }
  return null;
}

function decodeImageDataUrl(dataUrl: unknown, label: string): Buffer {
  if (typeof dataUrl !== "string") {
    throw new BrandingValidationError(`${label} must be provided as a base64 data URL`);
  }
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!match) {
    throw new BrandingValidationError(`${label} must be provided as a base64 data URL`);
  }
  const data = Buffer.from(match[1], "base64");
  if (data.length === 0) {
    throw new BrandingValidationError(`${label} file is empty`);
  }
  if (data.length > MAX_APP_LOGO_BYTES) {
    throw new BrandingValidationError(
      `${label} must be ${MAX_APP_LOGO_BYTES / 1024} KB or smaller`,
    );
  }
  return data;
}

/** Validates an uploaded logo (base64 data URL) and returns its decoded form. */
export function parseAppLogoUpload(dataUrl: unknown): {
  contentType: AppLogoContentType;
  data: Buffer;
} {
  const data = decodeImageDataUrl(dataUrl, "Logo");
  const contentType = detectAppLogoContentType(data);
  if (!contentType) {
    throw new BrandingValidationError("Logo must be a PNG, JPEG, GIF, WebP, or SVG image");
  }
  return { contentType, data };
}

/** Validates the JPEG rendition of an uploaded logo. */
export function parseAppLogoJpegUpload(dataUrl: unknown): Buffer {
  const data = decodeImageDataUrl(dataUrl, "Logo JPEG rendition");
  if (detectAppLogoContentType(data) !== "image/jpeg") {
    throw new BrandingValidationError("Logo JPEG rendition must be a JPEG image");
  }
  return data;
}

/** Stores the optional dark mode logo. It needs no JPEG rendition: only the main logo is used outside the UI. */
export function saveAppDarkLogo(logo: { contentType: AppLogoContentType; data: Buffer }): void {
  writeSetting(
    APP_LOGO_DARK_SETTING_KEY,
    `data:${logo.contentType};base64,${logo.data.toString("base64")}`,
  );
}

export function clearAppDarkLogo(): void {
  writeSetting(APP_LOGO_DARK_SETTING_KEY, "");
}

export function saveAppLogo(
  logo: { contentType: AppLogoContentType; data: Buffer },
  jpeg?: Buffer | null,
): void {
  writeSetting(
    APP_LOGO_SETTING_KEY,
    `data:${logo.contentType};base64,${logo.data.toString("base64")}`,
  );
  writeSetting(
    APP_LOGO_JPEG_SETTING_KEY,
    jpeg ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : "",
  );
}

export function clearAppLogo(): void {
  writeSetting(APP_LOGO_SETTING_KEY, "");
  writeSetting(APP_LOGO_JPEG_SETTING_KEY, "");
}

export function getAppLogo(variant: AppLogoVariant = "default"): AppLogo | null {
  const stored = readSetting(
    variant === "dark" ? APP_LOGO_DARK_SETTING_KEY : APP_LOGO_SETTING_KEY,
  );
  if (!stored) return null;
  const match = DATA_URL_PATTERN.exec(stored);
  if (!match) return null;
  const data = Buffer.from(match[1], "base64");
  const contentType = detectAppLogoContentType(data);
  if (!contentType) return null;
  return {
    contentType,
    data,
    version: crypto.createHash("sha256").update(stored).digest("hex").slice(0, 16),
  };
}

/**
 * JPEG rendition of the custom logo, or null when no custom logo (or no
 * rendition) is configured. The version changes whenever the image does.
 */
export function getAppLogoJpeg(): { data: Buffer; version: string } | null {
  if (!readSetting(APP_LOGO_SETTING_KEY)) return null;
  const stored = readSetting(APP_LOGO_JPEG_SETTING_KEY);
  const match = stored ? DATA_URL_PATTERN.exec(stored) : null;
  if (!match) return null;
  const data = Buffer.from(match[1], "base64");
  if (detectAppLogoContentType(data) !== "image/jpeg") return null;
  return {
    data,
    version: crypto.createHash("sha256").update(stored!).digest("hex").slice(0, 16),
  };
}

export function getAppTheme(): BrandingTheme {
  try {
    const stored = readSetting(APP_THEME_SETTING_KEY);
    return stored ? normalizeBrandingTheme(JSON.parse(stored)) : DEFAULT_BRANDING_THEME;
  } catch {
    return DEFAULT_BRANDING_THEME;
  }
}

export function saveAppTheme(theme: BrandingTheme): void {
  writeSetting(APP_THEME_SETTING_KEY, isDefaultBrandingTheme(theme) ? "" : JSON.stringify(theme));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Injects the configured name, logo, and colors into the SPA shell so the
 * browser tab, bookmarks, link previews, and palette are branded before any
 * JavaScript runs. The original favicon is kept in data attributes so the
 * client can restore it.
 */
export function applyBrandingToIndexHtml(html: string): string {
  const appName = getAppName();
  // Function replacers keep "$&"-style sequences in the name literal.
  let branded = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    () => `<title>${escapeHtmlAttribute(appName)}</title>`,
  );

  const logo = getAppLogo();
  if (logo) {
    branded = branded.replace(/<link\b[^>]*\brel="icon"[^>]*>/i, (tag) => {
      const defaultHref = /\bhref="([^"]*)"/i.exec(tag)?.[1] ?? "";
      const defaultType = /\btype="([^"]*)"/i.exec(tag)?.[1] ?? "";
      const href = escapeHtmlAttribute(`${APP_LOGO_PATH}?v=${logo.version}`);
      return `<link rel="icon" type="${logo.contentType}" href="${href}" data-default-href="${defaultHref}" data-default-type="${defaultType}" />`;
    });
  }

  // The theme CSS is built only from validated hex colors and preset names.
  const themeCss = buildBrandingThemeCss(getAppTheme());
  if (themeCss) {
    branded = branded.replace(
      "</head>",
      () => `<style id="${BRANDING_THEME_STYLE_ID}">${themeCss}</style>\n</head>`,
    );
  }

  return branded;
}

export function getPublicBranding(): PublicBranding {
  const logo = getAppLogo();
  const logoDark = getAppLogo("dark");
  return {
    appName: getAppName(),
    logoUrl: logo ? `${APP_LOGO_PATH}?v=${logo.version}` : null,
    logoDarkUrl: logoDark ? `${APP_LOGO_DARK_PATH}?v=${logoDark.version}` : null,
    theme: getAppTheme(),
  };
}
