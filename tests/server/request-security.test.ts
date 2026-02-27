import { describe, expect, test } from "bun:test";
import {
  isPrivateOrReservedIp,
  isSafeOutboundUrl,
  isTrustedReturnOrigin,
} from "../../server/request-security";

describe("request security helpers", () => {
  test("trusted return origin allows loopback dev origins", () => {
    expect(isTrustedReturnOrigin("http://localhost:5173")).toBe(true);
    expect(isTrustedReturnOrigin("http://127.0.0.1:4173")).toBe(true);
  });

  test("trusted return origin rejects unrelated origins", () => {
    expect(isTrustedReturnOrigin("https://evil.example.com")).toBe(false);
  });

  test("private/reserved IP detection", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.10")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });

  test("safe outbound URL rejects local/internal URLs", async () => {
    expect((await isSafeOutboundUrl("http://127.0.0.1/topic")).safe).toBe(false);
    expect((await isSafeOutboundUrl("http://10.0.0.5/topic")).safe).toBe(false);
    expect((await isSafeOutboundUrl("http://[::1]/topic")).safe).toBe(false);
  });
});
