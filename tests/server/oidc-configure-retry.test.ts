import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import { resetAuthConfig } from "../../server/auth/auth-config";
import { initEncryptor } from "../../server/security";

const { discovery } = vi.hoisted(() => ({ discovery: vi.fn() }));

vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openid-client")>()),
  discovery,
}));

const { configureOidcFromSettings, getConfiguredIssuer, isConfigured } = await import(
  "../../server/auth/oidc"
);

const ISSUER = "https://idp.example.com";
const MINUTE = 60_000;

function setSetting(key: string, value: string) {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

function provider(issuer = ISSUER) {
  return { serverMetadata: () => ({ issuer }) };
}

describe("OIDC setup while the provider is unreachable", () => {
  let tempDir: string;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-retry-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    setSetting("oidc_issuer", ISSUER);
    setSetting("oidc_client_id", "ludash");
    discovery.mockReset();
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Clearing the settings stops any retry that is still scheduled.
    setSetting("oidc_issuer", "");
    await configureOidcFromSettings();
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeDatabase();
    resetAuthConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("SSO comes back without a restart, and the retries then stop", async () => {
    discovery.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await configureOidcFromSettings()).toContain("ECONNREFUSED");
    expect(isConfigured()).toBe(false);
    expect(getConfiguredIssuer()).toBeNull();

    discovery.mockResolvedValue(provider());
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(isConfigured()).toBe(true);
    expect(getConfiguredIssuer()).toBe(ISSUER);
    expect(discovery).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(discovery).toHaveBeenCalledTimes(2);
  });

  test("keeps retrying and logs a repeated failure once", async () => {
    discovery.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await configureOidcFromSettings();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(discovery).toHaveBeenCalledTimes(4);
    expect(isConfigured()).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  test("removing the settings stops the retries", async () => {
    discovery.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await configureOidcFromSettings();

    setSetting("oidc_issuer", "");
    await configureOidcFromSettings();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(discovery).toHaveBeenCalledTimes(1);
    expect(isConfigured()).toBe(false);
  });

  test("a retry reads the current settings", async () => {
    discovery.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await configureOidcFromSettings();

    setSetting("oidc_issuer", "https://new-idp.example.com");
    discovery.mockResolvedValue(provider("https://new-idp.example.com"));
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(String(discovery.mock.calls[1][0])).toContain("new-idp.example.com");
    expect(getConfiguredIssuer()).toBe("https://new-idp.example.com");
  });

  test("a slow attempt cannot overwrite newer settings", async () => {
    let finishSlow: (value: unknown) => void = () => {};
    discovery.mockImplementationOnce(() => new Promise((resolve) => (finishSlow = resolve)));
    const slow = configureOidcFromSettings();

    setSetting("oidc_issuer", "https://new-idp.example.com");
    discovery.mockResolvedValueOnce(provider("https://new-idp.example.com"));
    await configureOidcFromSettings();

    finishSlow(provider());
    await slow;
    expect(getConfiguredIssuer()).toBe("https://new-idp.example.com");
  });
});
