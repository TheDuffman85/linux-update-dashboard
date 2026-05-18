import { afterEach, describe, expect, test, vi } from "vitest";
import type { WSContext } from "hono/ws";
import * as outputStream from "../../server/services/output-stream";

describe("output stream subscriptions", () => {
  afterEach(() => {
    outputStream.removeStream(42);
  });

  test("sends reset when subscribing to an empty stream", () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WSContext;

    outputStream.subscribe(42, ws);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "reset" }));
  });
});
