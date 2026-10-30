import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockUseAuth, mockUseI18n, mockUseBranding } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseI18n: vi.fn(),
  mockUseBranding: vi.fn<() => { appName: string; logoUrl: string | null }>(() => ({
    appName: "Linux Update Dashboard",
    logoUrl: null,
  })),
}));

vi.mock("../../client/context/AuthContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../../client/lib/i18n", () => ({
  useI18n: mockUseI18n,
}));

vi.mock("../../client/lib/branding", () => ({
  useBranding: mockUseBranding,
}));

import Login from "../../client/pages/Login";

describe("Login page", () => {
  test("disables native validation bubbles on the password login form", () => {
    mockUseAuth.mockReturnValue({
      login: vi.fn(),
      refresh: vi.fn(),
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
    });
    mockUseI18n.mockReturnValue({ t: (key: string) => key });

    const html = renderToStaticMarkup(<Login />);

    expect(html).toContain("<form");
    expect(html).toContain("noValidate");
    expect(html).toContain("required");
  });

  test("offers passkey sign-in only when the server reports passkeys", () => {
    mockUseI18n.mockReturnValue({ t: (key: string) => key });
    const auth = {
      login: vi.fn(),
      refresh: vi.fn(),
      oidcEnabled: true,
      passwordLoginDisabled: false,
    };

    mockUseAuth.mockReturnValue({ ...auth, passkeysEnabled: false });
    const withoutPasskeys = renderToStaticMarkup(<Login />);
    expect(withoutPasskeys).not.toContain("pages.login.signInWithPasskey");
    expect(withoutPasskeys).toContain("pages.login.continueWithSso");

    mockUseAuth.mockReturnValue({ ...auth, passkeysEnabled: true });
    expect(renderToStaticMarkup(<Login />)).toContain("pages.login.signInWithPasskey");
  });

  test("shows the configured application name and logo", () => {
    mockUseAuth.mockReturnValue({
      login: vi.fn(),
      refresh: vi.fn(),
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
    });
    mockUseI18n.mockReturnValue({ t: (key: string) => key });
    mockUseBranding.mockReturnValue({
      appName: "Acme Patch Center",
      logoUrl: "/api/settings/public/logo?v=abc",
    });

    const html = renderToStaticMarkup(<Login />);

    expect(html).toContain("Acme Patch Center");
    expect(html).toContain('src="/api/settings/public/logo?v=abc"');
  });

  describe("OIDC auto-login", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function renderWith(search: string, options: { suppressed?: boolean; oidcAutoLogin?: boolean } = {}) {
      vi.stubGlobal("window", { location: { search } });
      vi.stubGlobal("sessionStorage", {
        getItem: () => (options.suppressed ? "true" : null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });
      mockUseAuth.mockReturnValue({
        login: vi.fn(),
        refresh: vi.fn(),
        oidcEnabled: true,
        oidcAutoLogin: options.oidcAutoLogin ?? true,
        passwordLoginDisabled: true,
        passkeysEnabled: false,
      });
      mockUseI18n.mockReturnValue({ t: (key: string) => key });
      return renderToStaticMarkup(<Login />);
    }

    test("announces the redirect to the identity provider", () => {
      expect(renderWith("")).toContain("pages.login.redirectingToSso");
    });

    test("stays on the login page when the server reports auto-login as inactive", () => {
      expect(renderWith("", { oidcAutoLogin: false })).not.toContain("pages.login.redirectingToSso");
    });

    test("?local=1 keeps the login page reachable", () => {
      expect(renderWith("?local=1")).not.toContain("pages.login.redirectingToSso");
    });

    test("does not redirect right after a logout", () => {
      expect(renderWith("", { suppressed: true })).not.toContain("pages.login.redirectingToSso");
    });

    test("shows a failed SSO sign-in instead of redirecting again", () => {
      const html = renderWith("?error=oidc_unauthorized");
      expect(html).not.toContain("pages.login.redirectingToSso");
      expect(html).toContain("pages.login.oidcUnauthorized");
    });
  });
});
