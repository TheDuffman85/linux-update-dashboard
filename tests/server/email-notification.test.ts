import { afterEach, describe, expect, test } from "bun:test";
import nodemailer from "nodemailer";
import { emailProvider, resolveEmailImportance } from "../../server/services/notifications/email";

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

describe("email provider sending", () => {
  const originalCreateTransport = nodemailer.createTransport;

  afterEach(() => {
    (nodemailer as any).createTransport = originalCreateTransport;
  });

  test("sends important metadata when override is important", async () => {
    let sentMail: Record<string, unknown> | undefined;
    (nodemailer as any).createTransport = () => ({
      sendMail: async (options: Record<string, unknown>) => {
        sentMail = options;
      },
    });

    const result = await emailProvider.send(
      {
        title: "Updates",
        body: "hello",
        priority: "default",
      },
      {
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
        emailImportanceOverride: "important",
      }
    );

    expect(result.success).toBe(true);
    expect(sentMail?.priority).toBe("high");
    expect(sentMail?.headers).toEqual({
      Importance: "high",
      "X-Priority": "1",
    });
  });
});
