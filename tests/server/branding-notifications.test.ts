import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { renderTemplate } from "../../server/services/notifications/webhook-template";
import { makeNotificationPayload } from "../helpers/notification-payload";

describe("branding in notifications", () => {
  let tempDir: string;
  const event = makeNotificationPayload({ title: "Updates available", body: "1 update" }).event;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-branding-notifications-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("webhook templates expose the default application name", () => {
    expect(renderTemplate("{{event.appName}}", event)).toBe("Linux Update Dashboard");
  });

  test("webhook templates expose the configured application name", () => {
    getDb().insert(settings).values({ key: "app_name", value: 'Acme "Patch" Center' }).run();

    expect(renderTemplate("{{event.appName}}", event)).toBe('Acme "Patch" Center');
    expect(JSON.parse(`{"username": {{event.appNameJson}}}`.replace(
      "{{event.appNameJson}}",
      renderTemplate("{{event.appNameJson}}", event),
    ))).toEqual({ username: 'Acme "Patch" Center' });
  });
});
