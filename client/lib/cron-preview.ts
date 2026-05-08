import { Cron } from "croner";
import cronstrue from "cronstrue";

export interface CronPreview {
  description: string;
  nextRuns: Date[];
}

export interface CronPreviewError {
  error: string;
}

export function getCronPreview(
  expression: string,
  startFrom: Date = new Date(),
  runCount = 3,
): CronPreview | CronPreviewError {
  const cronExpression = expression.trim();
  if (!cronExpression) {
    return { error: "Cron expression is required" };
  }

  try {
    const cron = new Cron(cronExpression);
    const nextRuns = cron.nextRuns(runCount, startFrom);
    const description = cronstrue.toString(cronExpression, {
      verbose: true,
      use24HourTimeFormat: true,
    });

    return { description, nextRuns };
  } catch {
    return { error: "Invalid cron expression" };
  }
}
