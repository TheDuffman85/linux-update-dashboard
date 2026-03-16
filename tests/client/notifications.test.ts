import { describe, expect, test } from "bun:test";
import { readEmailAllowInsecureTls, readEmailTlsMode } from "../../client/lib/notifications";

describe("readEmailTlsMode", () => {
  test("prefers explicit smtpTlsMode", () => {
    expect(readEmailTlsMode({ smtpTlsMode: "tls", smtpSecure: "false" })).toBe("tls");
  });

  test("maps legacy smtpSecure false to plain", () => {
    expect(readEmailTlsMode({ smtpSecure: "false", smtpPort: "25" })).toBe("plain");
  });

  test("maps legacy smtpSecure true on port 465 to implicit tls", () => {
    expect(readEmailTlsMode({ smtpSecure: "true", smtpPort: "465" })).toBe("tls");
  });

  test("maps legacy smtpSecure true on port 587 to starttls", () => {
    expect(readEmailTlsMode({ smtpSecure: "true", smtpPort: "587" })).toBe("starttls");
  });
});

describe("readEmailAllowInsecureTls", () => {
  test("reads the stored string flag", () => {
    expect(readEmailAllowInsecureTls({ allowInsecureTls: "true" })).toBe(true);
    expect(readEmailAllowInsecureTls({ allowInsecureTls: "false" })).toBe(false);
  });
});
