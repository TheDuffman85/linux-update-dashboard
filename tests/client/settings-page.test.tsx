import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

const {
  mockUseSettingsResponse,
  mockUseUpdateSettings,
  mockUsePasskeys,
  mockUseDeletePasskey,
  mockUseRegisterPasskey,
  mockUseRenamePasskey,
  mockUseApiTokens,
  mockUseCreateApiToken,
  mockUseRenameApiToken,
  mockUseDeleteApiToken,
  mockUseToast,
  mockUseAuth,
  mockUseBranding,
} = vi.hoisted(() => ({
  mockUseSettingsResponse: vi.fn(),
  mockUseUpdateSettings: vi.fn(),
  mockUsePasskeys: vi.fn(),
  mockUseDeletePasskey: vi.fn(),
  mockUseRegisterPasskey: vi.fn(),
  mockUseRenamePasskey: vi.fn(),
  mockUseApiTokens: vi.fn(),
  mockUseCreateApiToken: vi.fn(),
  mockUseRenameApiToken: vi.fn(),
  mockUseDeleteApiToken: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseBranding: vi.fn(),
}));

vi.mock("../../client/lib/settings", () => ({
  useSettingsResponse: mockUseSettingsResponse,
  useUpdateSettings: mockUseUpdateSettings,
  useUpdatePreferences: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../client/components/UsersSettings", () => ({
  UsersSettings: () => <div data-testid="users-settings" />,
}));

vi.mock("../../client/lib/branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../client/lib/branding")>()),
  useBranding: mockUseBranding,
  useUploadAppLogo: () => ({ mutate: vi.fn(), isPending: false }),
  useResetAppLogo: () => ({ mutate: vi.fn(), isPending: false }),
  useUploadAppDarkLogo: () => ({ mutate: vi.fn(), isPending: false }),
  useResetAppDarkLogo: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateAppTheme: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../client/lib/passkeys", () => ({
  usePasskeys: mockUsePasskeys,
  useDeletePasskey: mockUseDeletePasskey,
  useRegisterPasskey: mockUseRegisterPasskey,
  useRenamePasskey: mockUseRenamePasskey,
}));

vi.mock("../../client/lib/api-tokens", () => ({
  useApiTokens: mockUseApiTokens,
  useCreateApiToken: mockUseCreateApiToken,
  useRenameApiToken: mockUseRenameApiToken,
  useDeleteApiToken: mockUseDeleteApiToken,
}));

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
}));

vi.mock("../../client/context/AuthContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../../client/components/Layout", () => ({
  Layout: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("../../client/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("../../client/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import Settings from "../../client/pages/Settings";
import { DEFAULT_BRANDING_THEME } from "../../shared/branding-theme";

function renderSettings(tab?: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[tab ? `/settings?tab=${tab}` : "/settings"]}>
      <Settings />
    </MemoryRouter>,
  );
}

function countSaveButtons(html: string) {
  return html.match(/>Save<\/button>/g)?.length ?? 0;
}

describe("Settings page", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { isSecureContext: false });
    mockUseSettingsResponse.mockReturnValue({
      data: {
        settings: {
          activity_history_limit: "20",
          ssh_timeout_seconds: "30",
          cmd_timeout_seconds: "120",
          concurrent_connections: "5",
          enable_root_user_check: "true",
          oidc_issuer: "",
          oidc_client_id: "",
          oidc_client_secret: "",
          disable_password_login: "false",
        },
        numericSettingRules: {
          activity_history_limit: { min: 5, max: 200, fallback: 20 },
          ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
          cmd_timeout_seconds: { min: 10, max: 900, fallback: 120 },
          concurrent_connections: { min: 1, max: 50, fallback: 5 },
        },
      },
      isLoading: false,
    });
    mockUseUpdateSettings.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUsePasskeys.mockReturnValue({ data: [], isLoading: false });
    mockUseDeletePasskey.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseRegisterPasskey.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseRenamePasskey.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseApiTokens.mockReturnValue({ data: [], isLoading: false });
    mockUseCreateApiToken.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseRenameApiToken.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseDeleteApiToken.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseToast.mockReturnValue({ addToast: vi.fn() });
    mockUseAuth.mockReturnValue({ hasPassword: true, refresh: vi.fn() });
    mockUseBranding.mockReturnValue({
      appName: "Linux Update Dashboard",
      logoUrl: null,
      logoDarkUrl: null,
      theme: DEFAULT_BRANDING_THEME,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("opens Profile by default and keeps the selected tab in the URL", () => {
    const html = renderSettings();

    expect(html).toContain('role="tablist"');
    expect(html.indexOf('id="settings-tab-account"')).toBeLessThan(
      html.indexOf('id="settings-tab-general"'),
    );
    expect(html).toMatch(/id="settings-tab-account"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="settings-tab-branding"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(html).toContain('id="settings-panel-account"');
    expect(html).not.toContain("Activity History");
    expect(html).not.toContain("Application Name");

    const branding = renderSettings("branding");
    expect(branding).toMatch(/id="settings-tab-branding"[^>]*aria-selected="true"/);
    expect(branding).toContain("Application Name");
    expect(branding).not.toContain("Activity History");
  });

  test("falls back to Profile for an unknown tab", () => {
    const html = renderSettings("nope");

    expect(html).toMatch(/id="settings-tab-account"[^>]*aria-selected="true"/);
    expect(html).toContain("Preferences");
  });

  test("shows one Save button per tab, and none for API tokens", () => {
    expect(countSaveButtons(renderSettings("general"))).toBe(1);
    expect(countSaveButtons(renderSettings("account"))).toBe(1);
    expect(countSaveButtons(renderSettings("authentication"))).toBe(1);
    expect(countSaveButtons(renderSettings("branding"))).toBe(1);
    expect(countSaveButtons(renderSettings("api-tokens"))).toBe(0);
  });

  test("does not render the embedded refresh schedule settings", () => {
    const html = renderSettings("general");

    expect(html).toContain("Activity History");
    expect(html).toContain("Connection Timeout");
    expect(html).toContain("Least-privilege root user check");
    expect(html).not.toContain("Min 5 seconds, max 120 seconds");
    expect(html).not.toContain("Min 10 seconds, max 900 seconds");
    expect(html).not.toContain("Update Schedule");
    expect(html).not.toContain("Scheduler Interval");
    expect(html).not.toContain("Cache Duration");
  });

  test("renders the branding section with the default logo controls", () => {
    const html = renderSettings("branding");

    expect(html).toContain("Branding");
    expect(html).toContain("Application Name");
    expect(html).toContain('placeholder="Linux Update Dashboard"');
    expect(html).toContain("Upload Logo");
    expect(html).toContain("Dark Mode Logo (Optional)");
    expect(html).not.toContain("Use Default Logo");
    expect(html).not.toContain("Remove Logo");
  });

  test("offers resetting the logo when a custom logo is configured", () => {
    mockUseBranding.mockReturnValue({
      appName: "Acme",
      logoUrl: "/api/settings/public/logo?v=abc",
      logoDarkUrl: null,
      theme: DEFAULT_BRANDING_THEME,
    });

    const html = renderSettings("branding");

    expect(html).toContain("Use Default Logo");
    expect(html).toContain('src="/api/settings/public/logo?v=abc"');
  });

  test("previews the dark mode logo and offers removing it", () => {
    mockUseBranding.mockReturnValue({
      appName: "Acme",
      logoUrl: "/api/settings/public/logo?v=abc",
      logoDarkUrl: "/api/settings/public/logo/dark?v=def",
      theme: DEFAULT_BRANDING_THEME,
    });

    const html = renderSettings("branding");
    const darkField = html.slice(html.indexOf('data-testid="settings-logo-dark"'));

    expect(html).toContain("Remove Logo");
    expect(darkField).toContain('src="/api/settings/public/logo/dark?v=def"');
  });

  test("renders the per-theme color settings with previews of the saved colors", () => {
    mockUseBranding.mockReturnValue({
      appName: "Acme",
      logoUrl: null,
      logoDarkUrl: null,
      theme: {
        light: { accent: "#e11d48", neutral: "zinc" },
        dark: { accent: null, neutral: null },
      },
    });

    const html = renderSettings("branding");

    expect(html).toContain("Accent Color");
    expect(html).toContain("Neutral Tone");
    expect(html).toContain('value="#e11d48"');
    expect(html).toContain('placeholder="Same as light mode"');
    expect(html).toContain('data-testid="settings-theme-preview-dark"');
    // The dark preview inherits the light mode accent.
    const darkPreviewStyle = /style="([^"]*)" data-testid="settings-theme-preview-dark"/.exec(
      html,
    )?.[1];
    expect(darkPreviewStyle).toContain("--color-blue-600:#e11d48");
    expect(html).toContain("Restore Default Colors");
  });

  function withSettingsResponse(extra: Record<string, unknown>) {
    const current = mockUseSettingsResponse();
    mockUseSettingsResponse.mockReturnValue({
      ...current,
      data: { ...current.data, ...extra },
    });
  }

  test("locks environment-managed auth settings and names their variables", () => {
    withSettingsResponse({
      managedSettings: {
        oidc_issuer: "LUDASH_OIDC_ISSUER",
        oidc_admin_groups: "LUDASH_OIDC_ADMIN_GROUPS",
        disable_password_login: "LUDASH_PASSWORD_LOGIN_ENABLED",
      },
    });

    const html = renderSettings("authentication");

    expect(html).toMatch(/<input id="oidc-issuer" disabled=""/);
    expect(html).not.toMatch(/<input id="oidc-client-id" disabled=""/);
    expect(html).toMatch(/<input id="oidc-admin-groups"[^>]*disabled=""/);
    expect(html).toContain("Set by the LUDASH_OIDC_ISSUER environment variable.");
    expect(html).toContain("Set by the LUDASH_OIDC_ADMIN_GROUPS environment variable.");
    expect(html).toContain("Set by the LUDASH_PASSWORD_LOGIN_ENABLED environment variable.");
    // Some OIDC fields stay editable, so the tab keeps its Save button.
    expect(countSaveButtons(html)).toBe(1);
  });

  test("warns when OIDC auto-login is enabled but inactive", () => {
    const current = mockUseSettingsResponse();
    withSettingsResponse({
      settings: { ...current.data.settings, oidc_auto_login: "true" },
      oidcAutoLoginActive: false,
    });
    expect(renderSettings("authentication")).toContain(
      "Auto-login is enabled but inactive",
    );

    withSettingsResponse({ oidcAutoLoginActive: true });
    expect(renderSettings("authentication")).not.toContain(
      "Auto-login is enabled but inactive",
    );
  });

  test("hides the Authentication Save button when every setting on the tab is managed", () => {
    withSettingsResponse({
      managedSettings: Object.fromEntries(
        [
          "disable_password_login",
          "oidc_issuer",
          "oidc_client_id",
          "oidc_client_secret",
          "oidc_scope",
          "oidc_groups_claim",
          "oidc_admin_groups",
          "oidc_read_only_groups",
          "oidc_unmatched_role",
          "oidc_end_session",
          "oidc_backchannel_logout",
          "oidc_auto_login",
        ].map((key) => [key, `LUDASH_${key.toUpperCase()}`]),
      ),
    });

    const html = renderSettings("authentication");

    expect(countSaveButtons(html)).toBe(0);
  });

  test("warns when password login stays enabled to avoid a lockout", () => {
    withSettingsResponse({ passwordLoginFallback: true });

    const html = renderSettings("authentication");

    expect(html).toContain(
      "Password login stays enabled because neither SSO nor a passkey is configured.",
    );
  });

  test("Profile holds the personal preferences, password and TOTP", () => {
    withSettingsResponse({
      settings: { ...mockUseSettingsResponse().data.settings, language: "de" },
    });

    const html = renderSettings("account");

    expect(html).toContain('id="settings-panel-account"');
    expect(html).toContain("Preferences");
    expect(html).toContain("Instance default (Deutsch)");
    expect(html).toContain("Change Password");
    expect(html).toContain("Two-factor authentication");
    // Authentication keeps only the sign-in configuration.
    const authentication = renderSettings("authentication");
    expect(authentication).toContain("Password login");
    expect(authentication).not.toContain("Change Password");
  });

  test("shows the Users tab to administrators", () => {
    const html = renderSettings("users");

    expect(html).toMatch(/id="settings-tab-users"[^>]*aria-selected="true"/);
    expect(html).toContain('data-testid="users-settings"');
  });

  test("read-only users only see Profile", () => {
    mockUseAuth.mockReturnValue({ hasPassword: true, isReadOnly: true, refresh: vi.fn() });

    for (const tab of [undefined, "general", "users", "authentication", "api-tokens"]) {
      const html = renderSettings(tab);
      expect(html).toMatch(/id="settings-tab-account"[^>]*aria-selected="true"/);
      expect(html).not.toContain('id="settings-tab-general"');
      expect(html).not.toContain('id="settings-tab-users"');
      expect(html).not.toContain("Activity History");
    }
    expect(mockUseApiTokens).toHaveBeenLastCalledWith(false);
  });
});
