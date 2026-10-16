import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BRANDING_THEME,
  MIN_ACCENT_CONTRAST,
  THEME_SHADES,
  buildBrandingThemeCss,
  generateAccentScale,
  getAccentContrast,
  getContrastRatio,
  getResolvedThemeModeVariables,
  normalizeBrandingTheme,
  normalizeHexColor,
  parseBrandingThemeInput,
  resolveThemeMode,
} from "../../shared/branding-theme";

describe("branding theme", () => {
  test("normalizes hex colors and rejects anything else", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor(" e11d48 ")).toBe("#e11d48");
    expect(normalizeHexColor("red")).toBeNull();
    expect(normalizeHexColor("#e11d48;}body{")).toBeNull();
    expect(normalizeHexColor(42)).toBeNull();
  });

  test("falls back to the defaults for invalid stored values", () => {
    expect(normalizeBrandingTheme(null)).toEqual(DEFAULT_BRANDING_THEME);
    expect(
      normalizeBrandingTheme({ light: { accent: "nope", neutral: "zinc" }, dark: "x" }),
    ).toEqual({
      light: { accent: null, neutral: "zinc" },
      dark: { accent: null, neutral: null },
    });
  });

  test("rejects invalid admin input", () => {
    expect(() => parseBrandingThemeInput([])).toThrow();
    expect(() => parseBrandingThemeInput({ light: { accent: "blue" } })).toThrow();
    expect(() => parseBrandingThemeInput({ dark: { neutral: "pink" } })).toThrow();
    expect(parseBrandingThemeInput({ light: { accent: "", neutral: "" } })).toEqual(
      DEFAULT_BRANDING_THEME,
    );
  });

  test("dark mode inherits the light mode colors unless overridden", () => {
    const theme = {
      light: { accent: "#e11d48", neutral: "stone" as const },
      dark: { accent: null, neutral: "zinc" as const },
    };
    expect(resolveThemeMode(theme, "dark")).toEqual({ accent: "#e11d48", neutral: "zinc" });
    expect(resolveThemeMode(DEFAULT_BRANDING_THEME, "light")).toEqual({
      accent: null,
      neutral: "slate",
    });
  });

  test("generates a full accent scale that keeps the chosen color", () => {
    const scale = generateAccentScale("#e11d48");
    expect(Object.keys(scale).map(Number)).toEqual([...THEME_SHADES]);
    expect(Object.values(scale)).toContain("#e11d48");
    for (const value of Object.values(scale)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    // Lighter shades come first.
    expect(getContrastRatio(scale[50], "#000000")).toBeGreaterThan(
      getContrastRatio(scale[950], "#000000"),
    );
  });

  test("darkens a generated button shade until white text is readable", () => {
    const scale = generateAccentScale("#7dd3fc");
    expect(getContrastRatio("#ffffff", scale[600])).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
  });

  test("builds CSS only for explicit settings", () => {
    expect(buildBrandingThemeCss(DEFAULT_BRANDING_THEME)).toBe("");

    const css = buildBrandingThemeCss({
      light: { accent: "#e11d48", neutral: null },
      dark: { accent: null, neutral: "zinc" },
    });
    expect(css).toMatch(/^:root\{--color-blue-50:#[0-9a-f]{6};/);
    expect(css).toContain("--color-blue-600:");
    expect(css).not.toMatch(/:root\{[^}]*--color-slate-/);
    expect(css).toContain(':root[data-theme="dark"]{--color-slate-50:oklch(98.5% 0 0);');
    expect(css).not.toMatch(/data-theme="dark"\]\{[^}]*--color-blue-/);
  });

  test("previews resolve every color, including the defaults", () => {
    const variables = getResolvedThemeModeVariables(DEFAULT_BRANDING_THEME, "dark");
    expect(variables["--color-blue-600"]).toBe("oklch(54.6% 0.245 262.881)");
    expect(variables["--color-slate-900"]).toBe("oklch(20.8% 0.042 265.755)");
    expect(DEFAULT_ACCENT_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("reports the contrast of custom accents only", () => {
    expect(getAccentContrast(DEFAULT_BRANDING_THEME, "light")).toBeNull();
    const contrast = getAccentContrast(
      // Kept as shade 600, so it is not darkened for the button text.
      { light: { accent: "#8b5cf6", neutral: null }, dark: { accent: null, neutral: null } },
      "light",
    );
    expect(contrast!.accentText).toBeLessThan(MIN_ACCENT_CONTRAST);
  });
});
