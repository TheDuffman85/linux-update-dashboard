import { Cron } from "croner";
import cronstrue from "cronstrue/i18n";
import type { SupportedLanguage } from "./i18n";

export interface CronPreview {
  description: string;
  nextRuns: Date[];
}

export interface CronPreviewError {
  error: string;
}

export function getCronLocale(language: SupportedLanguage): string {
  if (language === "hi") return "en";
  if (language === "pt") return "pt_BR";
  return language === "zh" ? "zh_CN" : language;
}

export function getCronPreview(
  expression: string,
  startFrom: Date = new Date(),
  runCount = 3,
  language: SupportedLanguage = "en",
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
      locale: getCronLocale(language),
    });

    return { description, nextRuns };
  } catch {
    return { error: "Invalid cron expression" };
  }
}
