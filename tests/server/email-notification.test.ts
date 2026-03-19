import { afterEach, describe, expect, test } from "bun:test";
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
      {
        title: "Updates",
        body: "hello",
        priority: "default",
        tags: ["warning"],
      },
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
      {
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
      },
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
});
