import { describe, expect, test } from "bun:test";
import { createLogger, parseLogLevel } from "../../server/logger";

describe("parseLogLevel", () => {
  test("accepts supported log levels", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("INFO")).toBe("info");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel("error")).toBe("error");
  });

  test("falls back to info for invalid values", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("verbose")).toBe("info");
  });
});

describe("createLogger", () => {
  test("writes info logs to stdout as single-line JSON", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "info",
      now: () => "2026-03-07T22:30:00.000Z",
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });

    logger.info("Server starting", { port: 3001, ignored: undefined });

    expect(stderr).toHaveLength(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout[0])).toEqual({
      ts: "2026-03-07T22:30:00.000Z",
      level: "info",
      msg: "Server starting",
      port: 3001,
    });
  });

  test("writes warnings and errors to stderr", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "debug",
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });

    logger.warn("Warn log");
    logger.error("Error log");

    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(2);
    expect(JSON.parse(stderr[0]).level).toBe("warn");
    expect(JSON.parse(stderr[1]).level).toBe("error");
  });

  test("suppresses debug logs when level is info", () => {
    const stdout: string[] = [];
    const logger = createLogger({
      level: "info",
      writeStdout: (line) => stdout.push(line),
    });

    logger.debug("Hidden");
    logger.info("Visible");

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]).msg).toBe("Visible");
  });
});
