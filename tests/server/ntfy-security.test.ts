import { describe, expect, test } from "bun:test";
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
});
