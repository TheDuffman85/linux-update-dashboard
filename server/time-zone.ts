export function parseTimeZone(value: string | undefined): string | null {
  const timeZone = value?.trim();
  if (!timeZone) return null;

  try {
    return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    throw new Error(
      `Invalid TZ value "${timeZone}". Use an IANA time zone such as Europe/Berlin or UTC.`,
    );
  }
}

export function getConfiguredTimeZone(): string | null {
  return parseTimeZone(process.env.TZ);
}
