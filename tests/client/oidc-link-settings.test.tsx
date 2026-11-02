import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import type { OidcLinkStatus } from "../../client/lib/oidc-link";

const { status } = vi.hoisted(() => ({ status: { current: null as unknown } }));

vi.mock("../../client/lib/oidc-link", () => ({
  useOidcLinkStatus: () => ({ data: status.current }),
  useStartOidcLink: () => ({ isPending: false, mutate: vi.fn() }),
  useConfirmOidcLink: () => ({ isPending: false, mutate: vi.fn() }),
  useUnlinkOidc: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../client/context/ToastContext", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("../../client/lib/date-time", () => ({
  useDateTime: () => ({ formatDate: () => "2 Nov 2026" }),
}));

vi.mock("../../client/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

vi.mock("../../client/components/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

import { OidcLinkSettings } from "../../client/components/OidcLinkSettings";

const UNLINKED: OidcLinkStatus = {
  available: true,
  canManage: true,
  username: "admin",
  totpEnabled: true,
  passwordLoginDisabled: false,
  ssoTokenCount: 0,
  link: null,
  pending: null,
};

const LINKED: OidcLinkStatus = {
  ...UNLINKED,
  link: {
    issuer: "https://auth.example.com/oidc",
    username: "alice",
    role: "read-only",
    method: "verified",
    linkedAt: "2026-11-02 10:00:00",
    provider: "current",
  },
};

function render(value: OidcLinkStatus | null) {
  status.current = value;
  return renderToStaticMarkup(
    <MemoryRouter>
      <OidcLinkSettings />
    </MemoryRouter>,
  );
}

describe("OidcLinkSettings", () => {
  beforeEach(() => {
    status.current = null;
    vi.stubGlobal("window", { location: { origin: "https://ludash.example.com" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stays hidden while linking is unavailable and nothing is linked", () => {
    expect(render(null)).toBe("");
    expect(render({ ...UNLINKED, available: false })).toBe("");
  });

  test("offers linking from a local session", () => {
    const html = render(UNLINKED);
    expect(html).toContain("pages.settings.oidcLink.description<");
    expect(html).toContain("pages.settings.oidcLink.link<");
    expect(html).not.toContain("pages.settings.oidcLink.unlink<");
  });

  test("shows the identity, its access and the recovery path once linked", () => {
    const html = render(LINKED);
    expect(html).toContain("auth.example.com");
    expect(html).toContain("alice");
    expect(html).toContain("pages.settings.users.roleReadOnly");
    expect(html).toContain("pages.settings.oidcLink.statusLinked");
    expect(html).toContain("pages.settings.oidcLink.recovery<");
    expect(html).toContain(">admin<");
    expect(html).toContain('href="https://ludash.example.com/login?local=1"');
    expect(html).toContain("pages.settings.oidcLink.unlink<");
    expect(html).not.toContain("pages.settings.oidcLink.stale");
    expect(html).not.toContain("pages.settings.oidcLink.statusStale");
  });

  test("warns about weak or unavailable local recovery", () => {
    const html = render({ ...LINKED, totpEnabled: false, passwordLoginDisabled: true });
    expect(html).toContain("pages.settings.oidcLink.totpWarning");
    expect(html).toContain("pages.settings.oidcLink.passwordLoginWarning");
  });

  test("marks stale and unverified links", () => {
    const html = render({
      ...LINKED,
      link: { ...LINKED.link!, provider: "changed", method: "username" },
    });
    expect(html).toContain("pages.settings.oidcLink.statusStale");
    expect(html).toContain("pages.settings.oidcLink.stale<");
    expect(html).toContain("pages.settings.oidcLink.unverified");
  });

  test("an unreachable provider is not shown as a changed one", () => {
    const html = render({
      ...LINKED,
      available: false,
      link: { ...LINKED.link!, provider: "unavailable" },
    });
    expect(html).toContain("pages.settings.oidcLink.statusUnavailable");
    expect(html).toContain("pages.settings.oidcLink.unavailable<");
    expect(html).toContain("pages.settings.oidcLink.recovery<");
    expect(html).not.toContain("pages.settings.oidcLink.statusStale");
    expect(html).not.toContain("pages.settings.oidcLink.stale<");
  });

  test("an SSO session sees the link but no controls or local warnings", () => {
    const html = render({ ...LINKED, canManage: false, totpEnabled: false });
    expect(html).toContain("pages.settings.oidcLink.ssoSessionHint");
    expect(html).not.toContain("pages.settings.oidcLink.unlink<");
    expect(html).not.toContain("pages.settings.oidcLink.totpWarning");
  });
});
