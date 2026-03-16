import { describe, expect, test } from "bun:test";
import { validateSystemForm } from "../../client/lib/system-form-validation";

describe("validateSystemForm", () => {
  test("requires a valid hostname", () => {
    expect(
      validateSystemForm({
        name: "Web Server",
        hostname: " bad host ",
        port: 22,
        credentialId: 1,
      }),
    ).toBe("Hostname is required and must be a valid hostname or IP");
  });

  test("requires a valid port range", () => {
    expect(
      validateSystemForm({
        name: "Web Server",
        hostname: "server.local",
        port: 70000,
        credentialId: 1,
      }),
    ).toBe("SSH port must be between 1 and 65535");
  });

  test("requires an ssh credential", () => {
    expect(
      validateSystemForm({
        name: "Web Server",
        hostname: "server.local",
        port: 22,
        credentialId: 0,
      }),
    ).toBe("SSH credential is required");
  });

  test("accepts valid input", () => {
    expect(
      validateSystemForm({
        name: "Web Server",
        hostname: "server.local",
        port: 22,
        credentialId: 1,
        proxyJumpSystemId: 2,
      }),
    ).toBeNull();
  });
});
