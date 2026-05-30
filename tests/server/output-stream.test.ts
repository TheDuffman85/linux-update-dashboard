import { afterEach, describe, expect, test, vi } from "vitest";
import type { WSContext } from "hono/ws";
import * as outputStream from "../../server/services/output-stream";
import { sudo } from "../../server/ssh/parsers/types";

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

  test("preserves runtime script commands in live activity", () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WSContext;
    const command = `${sudo("apk upgrade")} 2>&1`;

    outputStream.subscribe(42, ws);
    outputStream.publish(42, {
      type: "started",
      command,
      pkgManager: "apk",
      startedAt: "2026-05-30 12:00:00",
    });

    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({
      type: "started",
      command,
      pkgManager: "apk",
      startedAt: "2026-05-30 12:00:00",
    }));
  });
});
