import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockUseAuth,
  mockUsePublicSettingsResponse,
  mockUseSettingsResponse,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUsePublicSettingsResponse: vi.fn(),
  mockUseSettingsResponse: vi.fn(),
}));

vi.mock("../../client/context/AuthContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../../client/lib/settings", () => ({
  usePublicSettingsResponse: mockUsePublicSettingsResponse,
  useSettingsResponse: mockUseSettingsResponse,
}));

import { I18nProvider, useI18n } from "../../client/lib/i18n";

function CurrentLanguage() {
  const { language, preference } = useI18n();
  return <span>{`${language}:${preference}`}</span>;
}

describe("I18nProvider", () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockUsePublicSettingsResponse.mockReset();
    mockUseSettingsResponse.mockReset();
  });

  test("uses public settings for the saved language while logged out", () => {
    mockUseAuth.mockReturnValue({ loading: false, user: null });
    mockUseSettingsResponse.mockReturnValue({ data: undefined });
    mockUsePublicSettingsResponse.mockReturnValue({
      data: { settings: { language: "de" } },
    });

    const html = renderToStaticMarkup(
      <I18nProvider>
        <CurrentLanguage />
      </I18nProvider>,
    );

    expect(html).toContain("de:de");
    expect(mockUseSettingsResponse).toHaveBeenCalledWith(false);
    expect(mockUsePublicSettingsResponse).toHaveBeenCalledWith(true);
  });

  test("uses authenticated settings when a user is logged in", () => {
    mockUseAuth.mockReturnValue({ loading: false, user: { userId: 1, username: "admin" } });
    mockUseSettingsResponse.mockReturnValue({
      data: { settings: { language: "fr" } },
    });
    mockUsePublicSettingsResponse.mockReturnValue({
      data: { settings: { language: "de" } },
    });

    const html = renderToStaticMarkup(
      <I18nProvider>
        <CurrentLanguage />
      </I18nProvider>,
    );

    expect(html).toContain("fr:fr");
    expect(mockUseSettingsResponse).toHaveBeenCalledWith(true);
    expect(mockUsePublicSettingsResponse).toHaveBeenCalledWith(false);
  });
});
