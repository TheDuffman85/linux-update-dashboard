export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LOG_PRIORITIES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(value: string | undefined | null): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : "info";
}

type LogFields = Record<string, unknown>;

interface CreateLoggerOptions {
  level?: LogLevel;
  now?: () => string;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export interface Logger {
  level: LogLevel;
  isLevelEnabled: (level: LogLevel) => boolean;
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
}

function cleanFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.LUDASH_LOG_LEVEL);
  const now = options.now ?? (() => new Date().toISOString());
  const writeStdout =
    options.writeStdout ?? ((line: string) => process.stdout.write(line));
  const writeStderr =
    options.writeStderr ?? ((line: string) => process.stderr.write(line));

  function isLevelEnabled(candidate: LogLevel): boolean {
    return LOG_PRIORITIES[candidate] >= LOG_PRIORITIES[level];
  }

  function write(entryLevel: LogLevel, msg: string, fields?: LogFields): void {
    if (!isLevelEnabled(entryLevel)) return;

    const line = JSON.stringify({
      ts: now(),
      level: entryLevel,
      msg,
      ...cleanFields(fields),
    }) + "\n";

    if (entryLevel === "warn" || entryLevel === "error") {
      writeStderr(line);
      return;
    }

    writeStdout(line);
  }

  return {
    level,
    isLevelEnabled,
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

export const logger = createLogger();
