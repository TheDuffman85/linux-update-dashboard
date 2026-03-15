import { afterEach, describe, expect, test } from "bun:test";
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
});
