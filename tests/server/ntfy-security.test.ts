import { describe, expect, test } from "bun:test";
import { ntfyProvider } from "../../server/services/notifications/ntfy";

describe("ntfy provider SSRF protection", () => {
  test("blocks loopback/private targets at send time", async () => {
    const result = await ntfyProvider.send(
      {
        title: "test",
        body: "body",
      },
      {
        ntfyUrl: "http://127.0.0.1",
        ntfyTopic: "updates",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not point");
  });
});
