import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../client/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { ThemeToggle } from "../../client/components/ThemeToggle";
import { ThemeProvider } from "../../client/hooks/useTheme";

function pressedOption(stored: string | null): string | undefined {
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: vi.fn() });
  const html = renderToStaticMarkup(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  return html.match(/aria-label="components\.themeToggle\.(\w+)" aria-pressed="true"/)?.[1];
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("follows the system when nothing is stored", () => {
    expect(pressedOption(null)).toBe("system");
  });

  test.each(["light", "dark", "system"])("restores the stored %s preference", (stored) => {
    expect(pressedOption(stored)).toBe(stored);
  });

  test("falls back to the system for an unknown stored value", () => {
    expect(pressedOption("solarized")).toBe("system");
  });
});
