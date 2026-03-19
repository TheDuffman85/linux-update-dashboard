import { afterEach, describe, expect, test } from "bun:test";
import { initEncryptor, getEncryptor } from "../../server/security";
import { gotifyProvider } from "../../server/services/notifications/gotify";
import { __testing as requestSecurityTesting, rememberTrustedPublicOrigin } from "../../server/request-security";

describe("gotify provider validation", () => {
  test("rejects invalid URL format", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "not-a-url",
      gotifyToken: "token",
    });
    expect(result).toContain("Invalid URL");
  });

  test("rejects non-http(s) URL", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "ftp://example.com",
      gotifyToken: "token",
    });
    expect(result).toContain("http or https");
  });

  test("requires an app token", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "https://gotify.example.com",
    });
    expect(result).toContain("app token");
  });

  test("accepts valid priority override", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "https://gotify.example.com",
      gotifyToken: "token",
      gotifyPriorityOverride: "8",
    });
    expect(result).toBeNull();
  });

  test("rejects unsupported config keys", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "https://gotify.example.com",
      gotifyToken: "token",
      unsupportedKey: "value",
    });
    expect(result).toContain("Unsupported gotify config key");
  });

  test("rejects invalid priority override", () => {
    const result = gotifyProvider.validateConfig({
      gotifyUrl: "https://gotify.example.com",
      gotifyToken: "token",
      gotifyPriorityOverride: "11",
    });
    expect(result).toContain("gotify priority override");
  });
});

describe("gotify provider sending", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    requestSecurityTesting.resetKnownPublicOrigin();
  });

  test("uses payload priority when override is automatic", async () => {
    const previousBaseUrl = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;

    let requestUrl: URL | undefined;
    let requestBody = "";
    try {
      globalThis.fetch = (async (input, init) => {
        requestUrl = new URL(String(input));
        requestBody = String(init?.body || "");
        return new Response("", { status: 200 });
      }) as typeof fetch;

      rememberTrustedPublicOrigin("https://dashboard.example.com");

      const result = await gotifyProvider.send(
        {
          title: "Updates",
          body: "hello",
          priority: "high",
          tags: ["package"],
        },
        {
          gotifyUrl: "https://gotify.example.com",
          gotifyToken: "token-123",
          gotifyPriorityOverride: "auto",
        }
      );

      expect(result.success).toBe(true);
      expect(requestUrl?.toString()).toBe("https://gotify.example.com/message?token=token-123");
      expect(JSON.parse(requestBody)).toEqual({
        title: "📦 Updates",
        message: "hello",
        priority: 8,
        extras: {
          "client::notification": {
            click: {
              url: "https://dashboard.example.com/",
            },
          },
        },
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.LUDASH_BASE_URL;
      else process.env.LUDASH_BASE_URL = previousBaseUrl;
    }
  });

  test("decrypts stored tokens and applies priority override", async () => {
    initEncryptor("gotify-test-key");

    let requestUrl: URL | undefined;
    let requestBody = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = new URL(String(input));
      requestBody = String(init?.body || "");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const encryptedToken = getEncryptor().encrypt("secret-token");
    const result = await gotifyProvider.send(
      {
        title: "Updates",
        body: "hello",
        priority: "default",
      },
      {
        gotifyUrl: "https://gotify.example.com",
        gotifyToken: encryptedToken,
        gotifyPriorityOverride: "10",
      }
    );

    expect(result.success).toBe(true);
    expect(requestUrl?.searchParams.get("token")).toBe("secret-token");
    expect(JSON.parse(requestBody).priority).toBe(10);
  });

  test("uses the release URL for app update click actions", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body || "");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await gotifyProvider.send(
      {
        title: "Application update available",
        body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
        event: {
          title: "Application update available",
          body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
          priority: "default",
          tags: ["arrow_up"],
          sentAt: new Date().toISOString(),
          eventTypes: ["appUpdates"],
          totals: {
            systemsWithUpdates: 0,
            totalUpdates: 0,
            totalSecurity: 0,
            totalKeptBack: 0,
            unreachableSystems: 0,
          },
          updates: [],
          unreachable: [],
          appUpdate: {
            currentVersion: "2026.3.1",
            currentBranch: "main",
            remoteVersion: "2026.3.2",
            releaseUrl: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
            repoUrl: "https://github.com/TheDuffman85/linux-update-dashboard",
          },
        },
      },
      {
        gotifyUrl: "https://gotify.example.com",
        gotifyToken: "token-123",
        gotifyPriorityOverride: "auto",
      }
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(requestBody).extras).toEqual({
      "client::notification": {
        click: {
          url: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
        },
      },
    });
  });
});
