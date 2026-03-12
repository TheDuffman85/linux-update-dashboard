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
  test("returns mqtt topic required when mqtt events are enabled without a topic", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        publishEvents: true,
        topic: "   ",
      }),
    ).toBe("MQTT topic is required");
  });

  test("returns null when mqtt event publishing is disabled", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        publishEvents: false,
        topic: "",
      }),
    ).toBeNull();
  });

  test("returns null when mqtt topic is present", () => {
    expect(
      validateNotificationFormAction("mqtt", {
        publishEvents: true,
        topic: "ludash/events",
      }),
    ).toBeNull();
  });

  test("returns null for non-mqtt notifications", () => {
    expect(
      validateNotificationFormAction("email", {
        publishEvents: true,
        topic: "",
      }),
    ).toBeNull();
  });
});
