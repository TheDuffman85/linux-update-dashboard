import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  applyBrandingToIndexHtml,
  getAppLogo,
  getPublicBranding,
  saveAppDarkLogo,
  saveAppLogo,
  saveAppTheme,
} from "../../server/services/branding-service";

const INDEX_HTML = [
  "<!DOCTYPE html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <title>Linux Update Dashboard</title>",
  "    <link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg%3E%3C/svg%3E\" />",
  "  </head>",
  "  <body><div id=\"root\"></div></body>",
  "</html>",
].join("\n");

describe("index.html branding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-branding-service-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("leaves the default shell unchanged without custom branding", () => {
    expect(applyBrandingToIndexHtml(INDEX_HTML)).toBe(INDEX_HTML);
  });

  test("injects an escaped application name into the title", () => {
    getDb().insert(settings).values({ key: "app_name", value: "Acme <Ops> & $& \"Patch\"" }).run();

    const html = applyBrandingToIndexHtml(INDEX_HTML);

    expect(html).toContain("<title>Acme &lt;Ops&gt; &amp; $&amp; &quot;Patch&quot;</title>");
    expect(html).not.toContain("Linux Update Dashboard");
  });

  test("swaps the favicon for the custom logo and keeps the default for restoring", () => {
    saveAppLogo({
      contentType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    });

    const html = applyBrandingToIndexHtml(INDEX_HTML);

    expect(html).toContain(
      `<link rel="icon" type="image/png" href="/api/settings/public/logo?v=${getAppLogo()!.version}" ` +
        'data-default-href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-default-type="image/svg+xml" />',
    );
  });

  test("keeps the main logo as the favicon when a dark mode logo is set", () => {
    saveAppDarkLogo({
      contentType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    });

    expect(applyBrandingToIndexHtml(INDEX_HTML)).toBe(INDEX_HTML);
    expect(getPublicBranding().logoDarkUrl).toBe(
      `/api/settings/public/logo/dark?v=${getAppLogo("dark")!.version}`,
    );
  });

  test("injects the theme colors into the head", () => {
    saveAppTheme({
      light: { accent: "#e11d48", neutral: null },
      dark: { accent: null, neutral: "zinc" },
    });

    const html = applyBrandingToIndexHtml(INDEX_HTML);

    expect(html).toMatch(
      /<style id="branding-theme">:root\{--color-blue-50:#[0-9a-f]{6};[^<]*<\/style>\n<\/head>/,
    );
    expect(html).toContain(':root[data-theme="dark"]{--color-slate-50:');
  });

  test("ignores a corrupt stored theme", () => {
    getDb().insert(settings).values({ key: "app_theme", value: "{not json" }).run();

    expect(applyBrandingToIndexHtml(INDEX_HTML)).toBe(INDEX_HTML);
    expect(getPublicBranding().theme.light.accent).toBeNull();
  });
});
