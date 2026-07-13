import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { mockUseAuth, mockUseI18n } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseI18n: vi.fn(),
}));

vi.mock("../../client/context/AuthContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../../client/lib/i18n", () => ({
  useI18n: mockUseI18n,
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

  test("offers passkey sign-in when SSO is enabled so OIDC-only passkeys get a clear response", () => {
    mockUseAuth.mockReturnValue({
      login: vi.fn(),
      refresh: vi.fn(),
      oidcEnabled: true,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
    });
    mockUseI18n.mockReturnValue({ t: (key: string) => key });

    const html = renderToStaticMarkup(<Login />);

    expect(html).toContain("pages.login.signInWithPasskey");
  });
});
