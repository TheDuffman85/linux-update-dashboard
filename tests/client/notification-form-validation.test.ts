import { describe, expect, test } from "bun:test";
import {
  canSendNotificationFormTest,
  validateNotificationFormAction,
} from "../../client/lib/notification-form-validation";

describe("canSendNotificationFormTest", () => {
  test("returns false for mqtt when event publishing is disabled", () => {
    expect(
      canSendNotificationFormTest("mqtt", {
        publishEvents: false,
      }),
    ).toBe(false);
  });

  test("returns true for mqtt when event publishing is enabled", () => {
    expect(
      canSendNotificationFormTest("mqtt", {
        publishEvents: true,
      }),
    ).toBe(true);
  });

  test("returns true for non-mqtt notifications", () => {
    expect(
      canSendNotificationFormTest("email", {
        publishEvents: false,
      }),
    ).toBe(true);
  });
});

describe("validateNotificationFormAction", () => {
  test("requires notification names to be non-empty", () => {
    expect(
      validateNotificationFormAction(
        "email",
        {
          smtpHost: "smtp.example.com",
          smtpFrom: "bot@example.com",
          emailTo: "ops@example.com",
        },
        { name: "   " },
      ),
    ).toBe("Name is required");
  });

  test("returns mqtt topic required when mqtt events are enabled without a topic", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        brokerUrl: "mqtt://broker.example.com",
        keepaliveSeconds: 60,
        connectTimeoutMs: 10000,
        publishEvents: true,
        topic: "   ",
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        payloadInstall: "install",
      }),
    ).toBe("MQTT topic is required");
  });

  test("returns null when mqtt event publishing is disabled", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        brokerUrl: "mqtt://broker.example.com",
        keepaliveSeconds: 60,
        connectTimeoutMs: 10000,
        publishEvents: false,
        topic: "",
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        payloadInstall: "install",
      }),
    ).toBeNull();
  });

  test("returns null when mqtt topic is present", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        brokerUrl: "mqtt://broker.example.com",
        keepaliveSeconds: 60,
        connectTimeoutMs: 10000,
        publishEvents: true,
        topic: "ludash/events",
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        payloadInstall: "install",
      }),
    ).toBeNull();
  });

  test("validates email inputs", () => {
    expect(
      validateNotificationFormAction("email", {
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpFrom: "bad-address",
        emailTo: "ops@example.com",
      }),
    ).toBe("Invalid sender email address");
  });

  test("validates gotify urls", () => {
    expect(
      validateNotificationFormAction("gotify", {
        gotifyUrl: "ftp://example.com",
        gotifyToken: "secret",
      }),
    ).toBe("Gotify URL must use http or https");
  });

  test("validates webhook timeout bounds", () => {
    expect(
      validateNotificationFormAction("webhook", {
        url: "https://hooks.example.com/notify",
        timeoutMs: 500,
        retryAttempts: 1,
        retryDelayMs: 1000,
      }),
    ).toBe("Timeout must be between 1000 and 30000");
  });

  test("allows stored telegram bot tokens when editing", () => {
    expect(
      validateNotificationFormAction("telegram", {
        telegramBotToken: "(stored)",
      }),
    ).toBeNull();
  });

  test("allows stored gotify tokens when editing", () => {
    expect(
      validateNotificationFormAction("gotify", {
        gotifyUrl: "https://gotify.example.com",
        gotifyToken: "(stored)",
      }),
    ).toBeNull();
  });

  test("allows stored webhook bearer tokens when editing", () => {
    expect(
      validateNotificationFormAction("webhook", {
        url: "https://hooks.example.com/notify",
        timeoutMs: 10000,
        retryAttempts: 1,
        retryDelayMs: 1000,
        auth: { mode: "bearer", token: "(stored)" },
      }),
    ).toBeNull();
  });

  test("returns null for valid webhook settings", () => {
    expect(
      validateNotificationFormAction("webhook", {
        url: "https://hooks.example.com/notify",
        timeoutMs: 10000,
        retryAttempts: 1,
        retryDelayMs: 1000,
        auth: { mode: "none" },
      }),
    ).toBeNull();
  });
});
