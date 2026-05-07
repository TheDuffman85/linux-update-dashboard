export function getMinScheduleIntervalMinutes(): number {
  const parsed = Number.parseInt(
    import.meta.env.VITE_MIN_SCHEDULE_INTERVAL_MINUTES ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
}
