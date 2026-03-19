import { afterEach, describe, expect, test } from "bun:test";
import { __testing as requestSecurityTesting, rememberTrustedPublicOrigin } from "../../server/request-security";
import { ntfyProvider } from "../../server/services/notifications/ntfy";

describe("ntfy provider validation", () => {
  test("rejects invalid URL format", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "not-a-url",
      ntfyTopic: "updates",
    });
    expect(result).toContain("Invalid URL");
  });

  test("rejects non-http(s) URL", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "ftp://example.com",
      ntfyTopic: "updates",
    });
    expect(result).toContain("http or https");
  });

  test("rejects invalid topic characters", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "bad topic!",
    });
    expect(result).toContain("topic must only contain");
  });

  test("accepts valid config with private IP", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "http://192.168.1.100",
      ntfyTopic: "updates",
    });
    expect(result).toBeNull();
  });

  test("accepts valid config with public URL", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "my-topic",
    });
    expect(result).toBeNull();
  });

  test("accepts valid priority override", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "my-topic",
      ntfyPriorityOverride: "auto",
    });
    expect(result).toBeNull();
  });

  test("rejects unsupported config keys", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "my-topic",
      unsupportedKey: "value",
    });
    expect(result).toContain("Unsupported ntfy config key");
  });

  test("rejects invalid priority override", () => {
    const result = ntfyProvider.validateConfig({
      ntfyUrl: "https://ntfy.sh",
      ntfyTopic: "my-topic",
      ntfyPriorityOverride: "critical",
    });
    expect(result).toContain("ntfy priority override");
  });
});

describe("ntfy provider sending", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    requestSecurityTesting.resetKnownPublicOrigin();
  });

  test("uses payload priority when override is automatic", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestHeaders = init?.headers as Headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await ntfyProvider.send(
      {
        title: "Updates",
        body: "hello",
        priority: "high",
      },
      {
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "updates",
        ntfyPriorityOverride: "auto",
      }
    );

    expect(result.success).toBe(true);
    expect(new Headers(requestHeaders).get("Priority")).toBe("high");
  });

  test("applies priority override", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestHeaders = init?.headers as Headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await ntfyProvider.send(
      {
        title: "Updates",
        body: "hello",
        priority: "default",
        tags: ["package"],
      },
      {
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "updates",
        ntfyPriorityOverride: "urgent",
      }
    );

    expect(result.success).toBe(true);
    const headers = new Headers(requestHeaders);
    expect(headers.get("Priority")).toBe("urgent");
    expect(headers.get("Tags")).toBe("package");
  });

  test("sanitizes non-ascii title text for HTTP headers", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestHeaders = init?.headers as Headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await ntfyProvider.send(
      {
        title: "2 updates available (⏸️ 1 kept back)",
        body: "hello",
        priority: "default",
      },
      {
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "updates",
        ntfyPriorityOverride: "auto",
      }
    );

    expect(result.success).toBe(true);
    expect(new Headers(requestHeaders).get("Title")).toBe("2 updates available (1 kept back)");
  });

  test("adds a click header that opens the dashboard root", async () => {
    const previousBaseUrl = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;

    let requestHeaders: Headers | undefined;
    try {
      globalThis.fetch = (async (_input, init) => {
        requestHeaders = init?.headers as Headers;
        return new Response("", { status: 200 });
      }) as typeof fetch;

      rememberTrustedPublicOrigin("https://dashboard.example.com");

      const result = await ntfyProvider.send(
        {
          title: "Updates",
          body: "hello",
          priority: "default",
        },
        {
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "updates",
          ntfyPriorityOverride: "auto",
        }
      );

      expect(result.success).toBe(true);
      expect(new Headers(requestHeaders).get("Click")).toBe("https://dashboard.example.com/");
      expect(new Headers(requestHeaders).get("Actions")).toBe(
        "view, Open LUD, https://dashboard.example.com/"
      );
    } finally {
      if (previousBaseUrl === undefined) delete process.env.LUDASH_BASE_URL;
      else process.env.LUDASH_BASE_URL = previousBaseUrl;
    }
  });

  test("uses the application release URL as the click header for app updates", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestHeaders = init?.headers as Headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await ntfyProvider.send(
      {
        title: "Application update available",
        body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
        priority: "default",
        tags: ["arrow_up"],
        event: {
          title: "Application update available",
          body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
          priority: "default",
          tags: ["arrow_up"],
          sentAt: "2026-03-19T12:00:00.000Z",
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
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "updates",
        ntfyPriorityOverride: "auto",
      }
    );

    expect(result.success).toBe(true);
    expect(new Headers(requestHeaders).get("Click")).toBe(
      "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2"
    );
    expect(new Headers(requestHeaders).get("Actions")).toBe(
      "view, Open release, https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2"
    );
  });
});
