import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const {
  mockUseSettings,
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
} = vi.hoisted(() => ({
  mockUseSettings: vi.fn(),
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
}));

vi.mock("../../client/lib/settings", () => ({
  useSettings: mockUseSettings,
  useUpdateSettings: mockUseUpdateSettings,
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

describe("Settings page", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { isSecureContext: false });
    mockUseSettings.mockReturnValue({
      data: {
        activity_history_limit: "20",
        ssh_timeout_seconds: "30",
        cmd_timeout_seconds: "120",
        concurrent_connections: "5",
        oidc_issuer: "",
        oidc_client_id: "",
        oidc_client_secret: "",
        disable_password_login: "false",
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not render the embedded refresh schedule settings", () => {
    const html = renderToStaticMarkup(<Settings />);

    expect(html).toContain("Activity History");
    expect(html).not.toContain("Update Schedule");
    expect(html).not.toContain("Scheduler Interval");
    expect(html).not.toContain("Cache Duration");
  });
});
