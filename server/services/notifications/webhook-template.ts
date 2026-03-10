import Mustache from "mustache";
import type { NotificationEventData } from "./types";
import { decorateNotificationTitle, formatUpdateLine } from "./presentation";

const ALLOWED_TAG_RE = /^event(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/;

function validateTokens(tokens: any[]): string | null {
  for (const token of tokens) {
    const tokenType = token[0];
    if (tokenType === "text") continue;
    if (tokenType !== "name") {
      return "Templates only support simple variable tags";
    }

    const tagName = String(token[1] || "");
    if (!ALLOWED_TAG_RE.test(tagName)) {
      return "Templates may only reference dotted event paths";
    }
  }

  return null;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function buildTemplateView(event: NotificationEventData) {
  const decoratedTitle = decorateNotificationTitle({
    title: event.title,
    tags: event.tags,
  });
  const updatesText = event.updates
    .map((result) => formatUpdateLine(result))
    .join("\n");
  const unreachableText = event.unreachable
    .map((result) => `${result.systemName}: unreachable`)
    .join("\n");
  const appUpdateText = event.appUpdate
    ? [
        event.appUpdate.currentVersion,
        event.appUpdate.remoteVersion,
        event.appUpdate.releaseUrl || event.appUpdate.repoUrl || "",
      ].filter(Boolean).join("\n")
    : "";

  return {
    event: {
      ...event,
      tagsCsv: event.tags.join(","),
      updatesText,
      unreachableText,
      appUpdateText,
      decoratedTitle,
      titleJson: jsonStringify(event.title),
      decoratedTitleJson: jsonStringify(decoratedTitle),
      bodyJson: jsonStringify(event.body),
      sentAtJson: jsonStringify(event.sentAt),
      priorityJson: jsonStringify(event.priority),
      tagsCsvJson: jsonStringify(event.tags.join(",")),
      updatesTextJson: jsonStringify(updatesText),
      unreachableTextJson: jsonStringify(unreachableText),
      appUpdateTextJson: jsonStringify(appUpdateText),
      updatesJson: JSON.stringify(event.updates),
      unreachableJson: JSON.stringify(event.unreachable),
      appUpdateJson: JSON.stringify(event.appUpdate),
      json: JSON.stringify(event),
    },
  };
}

export function validateTemplate(template: string): string | null {
  try {
    return validateTokens(Mustache.parse(template));
  } catch {
    return "Invalid template syntax";
  }
}

export function renderTemplate(template: string, event: NotificationEventData): string {
  const templateError = validateTemplate(template);
  if (templateError) {
    throw new Error(templateError);
  }

  const originalEscape = Mustache.escape;
  Mustache.escape = stringify;
  try {
    return Mustache.render(template, buildTemplateView(event));
  } finally {
    Mustache.escape = originalEscape;
  }
}
