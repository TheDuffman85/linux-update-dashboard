import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  __testing as requestSecurityTesting,
  getKnownPublicOrigin,
  getTrustedPublicOrigin,
  isPrivateOrReservedIp,
  isSafeOutboundUrl,
  isTrustedReturnOrigin,
  rememberTrustedPublicOrigin,
} from "../../server/request-security";

describe("request security helpers", () => {
  afterEach(() => {
    requestSecurityTesting.resetKnownPublicOrigin();
  });

  test("trusted return origin allows loopback dev origins", () => {
    expect(isTrustedReturnOrigin("http://localhost:5173")).toBe(true);
    expect(isTrustedReturnOrigin("http://127.0.0.1:4173")).toBe(true);
  });

  test("trusted return origin rejects unrelated origins when base URL is set", () => {
    const prev = process.env.LUDASH_BASE_URL;
    process.env.LUDASH_BASE_URL = "https://my-app.example.com";
    try {
      expect(isTrustedReturnOrigin("https://evil.example.com")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LUDASH_BASE_URL;
      else process.env.LUDASH_BASE_URL = prev;
    }
  });

  test("trusted return origin accepts any valid origin without explicit base URL", () => {
    const prev = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;
    try {
      expect(isTrustedReturnOrigin("https://any-app.example.com")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.LUDASH_BASE_URL = prev;
    }
  });

  test("trusted public origin prefers request host when base URL is unset", async () => {
    const prev = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;
    try {
      const app = new Hono();
      app.get("/origin", (c) => c.text(getTrustedPublicOrigin(c)));

      const res = await app.request("https://dashboard.example.com/origin", {
        headers: {
          host: "dashboard.example.com",
          referer: "https://idp.example.com/auth",
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("https://dashboard.example.com");
    } finally {
      if (prev !== undefined) process.env.LUDASH_BASE_URL = prev;
    }
  });

  test("trusted public origin keeps same-host referer scheme when base URL is unset", async () => {
    const prev = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;
    try {
      const app = new Hono();
      app.get("/origin", (c) => c.text(getTrustedPublicOrigin(c)));

      const res = await app.request("http://dashboard.example.com/origin", {
        headers: {
          host: "dashboard.example.com",
          referer: "https://dashboard.example.com/login",
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("https://dashboard.example.com");
    } finally {
      if (prev !== undefined) process.env.LUDASH_BASE_URL = prev;
    }
  });

  test("known public origin prefers remembered external origin over later loopback requests", () => {
    const prev = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;
    try {
      expect(rememberTrustedPublicOrigin("https://dashboard.example.com")).toBe(true);
      expect(getKnownPublicOrigin()).toBe("https://dashboard.example.com");

      expect(rememberTrustedPublicOrigin("http://localhost:3001")).toBe(false);
      expect(getKnownPublicOrigin()).toBe("https://dashboard.example.com");
    } finally {
      if (prev !== undefined) process.env.LUDASH_BASE_URL = prev;
    }
  });

  test("known public origin uses explicit base URL when configured", () => {
    const prev = process.env.LUDASH_BASE_URL;
    process.env.LUDASH_BASE_URL = "https://linux-update-dashboard.i.tausend.me";
    try {
      rememberTrustedPublicOrigin("https://dashboard.example.com");
      expect(getKnownPublicOrigin()).toBe("https://linux-update-dashboard.i.tausend.me");
    } finally {
      if (prev === undefined) delete process.env.LUDASH_BASE_URL;
      else process.env.LUDASH_BASE_URL = prev;
    }
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
