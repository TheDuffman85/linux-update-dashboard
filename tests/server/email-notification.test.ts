import { makeNotificationPayload } from "../helpers/notification-payload";
import { afterEach, describe, expect, test } from "vitest";
import nodemailer from "nodemailer";
import {
  buildEmailTransportOptions,
  emailProvider,
  resolveEmailImportance,
  resolveEmailTlsMode,
} from "../../server/services/notifications/email";

describe("email provider validation", () => {
  test("accepts supported importance override values", () => {
    const result = emailProvider.validateConfig({
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      smtpFrom: "dashboard@example.com",
      emailTo: "admin@example.com",
      emailImportanceOverride: "important",
    });
    expect(result).toBeNull();
  });

  test("accepts supported email formats and rejects others", () => {
    const base = {
      smtpHost: "smtp.example.com",
      smtpFrom: "dashboard@example.com",
      emailTo: "admin@example.com",
    };
    expect(emailProvider.validateConfig({ ...base, emailFormat: "html" })).toBeNull();
    expect(emailProvider.validateConfig({ ...base, emailFormat: "text" })).toBeNull();
    expect(emailProvider.validateConfig({ ...base, emailFormat: "markdown" })).toContain("email format");
  });

  test("rejects invalid importance override values", () => {
    const result = emailProvider.validateConfig({
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      smtpFrom: "dashboard@example.com",
      emailTo: "admin@example.com",
      emailImportanceOverride: "critical",
    });
    expect(result).toContain("email importance override");
  });
});

describe("resolveEmailImportance", () => {
  test("maps high payload priority to important in automatic mode", () => {
    expect(resolveEmailImportance("high", "auto")).toEqual({
      mailPriority: "high",
      importanceHeader: "high",
      xPriorityHeader: "1",
    });
  });

  test("maps default payload priority to normal in automatic mode", () => {
    expect(resolveEmailImportance("default", "auto")).toEqual({
      mailPriority: "normal",
      importanceHeader: "normal",
      xPriorityHeader: "3",
    });
  });

  test("forces important override", () => {
    expect(resolveEmailImportance("default", "important")).toEqual({
      mailPriority: "high",
      importanceHeader: "high",
      xPriorityHeader: "1",
    });
  });

  test("forces normal override", () => {
    expect(resolveEmailImportance("urgent", "normal")).toEqual({
      mailPriority: "normal",
      importanceHeader: "normal",
      xPriorityHeader: "3",
    });
  });
});

describe("resolveEmailTlsMode", () => {
  test("maps legacy smtpSecure false to plain", () => {
    expect(resolveEmailTlsMode({ smtpSecure: "false", smtpPort: "25" })).toBe("plain");
  });

  test("maps legacy smtpSecure true on port 465 to implicit tls", () => {
    expect(resolveEmailTlsMode({ smtpSecure: "true", smtpPort: "465" })).toBe("tls");
  });

  test("maps legacy smtpSecure true on non-465 ports to starttls", () => {
    expect(resolveEmailTlsMode({ smtpSecure: "true", smtpPort: "587" })).toBe("starttls");
  });
});

describe("buildEmailTransportOptions", () => {
  test("configures plain smtp without tls negotiation", () => {
    expect(buildEmailTransportOptions({
      smtpHost: "smtp.example.com",
      smtpPort: "25",
      smtpTlsMode: "plain",
    })).toMatchObject({
      host: "smtp.example.com",
      port: 25,
      secure: false,
      ignoreTLS: true,
      requireTLS: false,
      tls: undefined,
    });
  });

  test("configures starttls and honors insecure tls", () => {
    expect(buildEmailTransportOptions({
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      smtpTlsMode: "starttls",
      allowInsecureTls: "true",
    })).toMatchObject({
      secure: false,
      ignoreTLS: false,
      requireTLS: true,
      tls: { rejectUnauthorized: false },
    });
  });

  test("configures implicit tls and keeps certificate validation on by default", () => {
    expect(buildEmailTransportOptions({
      smtpHost: "smtp.example.com",
      smtpPort: "465",
      smtpTlsMode: "tls",
    })).toMatchObject({
      secure: true,
      ignoreTLS: false,
      requireTLS: false,
      tls: { rejectUnauthorized: true },
    });
  });
});

describe("email provider sending", () => {
  const originalCreateTransport = nodemailer.createTransport;

  afterEach(() => {
    (nodemailer as any).createTransport = originalCreateTransport;
  });

  test.each([
    [undefined, "⚠️ Updates"],
    ["", "⚠️ Updates"],
    ["   ", "⚠️ Updates"],
    ["[LINUX-UPDATE]", "[LINUX-UPDATE] ⚠️ Updates"],
    ["  Ops Team  ", "Ops Team ⚠️ Updates"],
    ["[更新]", "[更新] ⚠️ Updates"],
  ])("sends the expected subject for prefix %j", async (prefix, expectedSubject) => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mailOptions: Record<string, unknown>) => {
        sentMail = mailOptions;
      },
    });

    const result = await emailProvider.send(
      makeNotificationPayload({ title: "Updates", body: "hello", tags: ["warning"] }),
      {
        smtpHost: "smtp.example.com",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
        ...(prefix === undefined ? {} : { emailSubjectPrefix: prefix }),
      },
    );

    expect(result.success).toBe(true);
    expect(sentMail?.subject).toBe(expectedSubject);
    expect(sentMail?.text).toBe("hello");
    expect(String(sentMail?.html)).toContain("<strong>⚠️ Updates</strong>");
  });

  test("prepends the prefix to subjects without an icon", async () => {
    let subject: unknown;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mail: Record<string, unknown>) => { subject = mail.subject; },
    });

    await emailProvider.send(
      makeNotificationPayload({ title: "Updates", body: "hello", tags: [] }),
      { emailTo: "admin@example.com", emailSubjectPrefix: "[LINUX-UPDATE]" },
    );

    expect(subject).toBe("[LINUX-UPDATE] Updates");
  });

  test("sends important metadata when override is important", async () => {
    let sentMail: Record<string, unknown> | undefined;
    let transportOptions: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = (options: Record<string, unknown>) => {
      transportOptions = options;
      return {
        sendMail: async (mailOptions: Record<string, unknown>) => {
          sentMail = mailOptions;
        },
      };
    };

    const result = await emailProvider.send(
      makeNotificationPayload({
        title: "Updates",
        body: "hello",
        priority: "default",
        tags: ["warning"],
      }),
      {
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpTlsMode: "starttls",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
        emailImportanceOverride: "important",
      }
    );

    expect(result.success).toBe(true);
    expect(transportOptions).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });
    expect(sentMail?.subject).toBe("⚠️ Updates");
    expect(sentMail?.priority).toBe("high");
    expect(typeof sentMail?.html).toBe("string");
    expect(String(sentMail?.html)).toContain(">Open LUD<");
    expect(sentMail?.headers).toEqual({
      Importance: "high",
      "X-Priority": "1",
    });
  });

  test("adds an Open release link to HTML app update emails", async () => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mailOptions: Record<string, unknown>) => {
        sentMail = mailOptions;
      },
    });

    const result = await emailProvider.send(
      makeNotificationPayload({
        title: "Application update available",
        body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
        tags: ["arrow_up"],
        event: {
          title: "Application update available",
          body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
          priority: "default",
          tags: ["arrow_up"],
          sentAt: new Date().toISOString(),
          eventTypes: ["appUpdates"],
          totals: {
            systemsWithUpdates: 0,
            totalUpdates: 0,
            totalSecurity: 0,
            totalKeptBack: 0,
            unreachableSystems: 0,
          },
          updates: [],
          unreachable: [],
          appUpdate: {
            currentVersion: "2026.3.1",
            currentBranch: "main",
            remoteVersion: "2026.3.2",
            releaseUrl: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
            repoUrl: "https://github.com/TheDuffman85/linux-update-dashboard",
          },
        },
      }),
      {
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpTlsMode: "starttls",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
        emailImportanceOverride: "auto",
      }
    );

    expect(result.success).toBe(true);
    expect(String(sentMail?.text)).not.toContain("https://github.com/");
    expect(String(sentMail?.html)).toContain(">Open release<");
    expect(String(sentMail?.html)).toContain(
      "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2"
    );
  });
  test("renders event sections as bullet lists with readable HTML line breaks", async () => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mailOptions: Record<string, unknown>) => {
        sentMail = mailOptions;
      },
    });

    const body = "web-01: 3 updates\ndb-01: 5 updates (1 security)\n\nbackup-01: unreachable";
    const base = makeNotificationPayload({ title: "8 updates available", body });
    await emailProvider.send(
      { ...base, event: { ...base.event!, eventTypes: ["updates", "unreachable"] } },
      {
        smtpHost: "smtp.example.com",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
      },
    );

    const html = String(sentMail?.html);
    expect(sentMail?.text).toBe(body);
    expect(html).toContain("<li>web-01: 3 updates</li>\n<li>db-01: 5 updates (1 security)</li>\n</ul>");
    expect(html).toContain("<li>backup-01: unreachable</li>");
    expect(html.match(/<ul /g)).toHaveLength(2);
    expect(html.split("\n").length).toBeGreaterThan(5);
  });

  test("keeps non-event bodies as paragraphs and escapes HTML", async () => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mailOptions: Record<string, unknown>) => {
        sentMail = mailOptions;
      },
    });

    await emailProvider.send(
      makeNotificationPayload({ title: "Test", body: "line <one>\nline two" }),
      {
        smtpHost: "smtp.example.com",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
      },
    );

    const html = String(sentMail?.html);
    expect(html).not.toContain("<ul");
    expect(html).toContain("line &lt;one&gt;<br>\nline two</p>");
  });
  test("sends text-only mail with the link inline when the format is text", async () => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (mailOptions: Record<string, unknown>) => {
        sentMail = mailOptions;
      },
    });

    await emailProvider.send(
      makeNotificationPayload({ title: "Updates", body: "web-01: 3 updates" }),
      {
        smtpHost: "smtp.example.com",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
        emailFormat: "text",
      },
    );

    expect(sentMail?.html).toBeUndefined();
    expect(String(sentMail?.text)).toMatch(/^web-01: 3 updates\n\n.+: https?:\/\//);
  });
});
