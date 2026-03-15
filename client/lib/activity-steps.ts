import type { WsMessage } from "../hooks/useCommandOutput";
import type { ActivityStep } from "./systems";

const GLOBAL_PHASES = new Set(["reconnecting", "rechecking"]);
const TRAILING_ELLIPSIS_PATTERN = /\s*(?:…|\.{3})\s*$/;

function appendText(existing: string | null, next: string): string {
  return `${existing || ""}${next}`;
}

function finalizePendingStep(step: ActivityStep | undefined, status: "success" | "failed"): void {
  if (!step || step.status !== "started") return;
  step.status = status;
}

export function deriveLiveActivitySteps(messages: WsMessage[]): ActivityStep[] {
  const steps: ActivityStep[] = [];

  for (const message of messages) {
    const current = steps.at(-1);

    switch (message.type) {
      case "started":
        finalizePendingStep(current, "success");
        steps.push({
          label: null,
          pkgManager: message.pkgManager,
          command: message.command,
          output: null,
          error: null,
          status: "started",
        });
        break;
      case "output":
        if (!current) break;
        current.output = appendText(current.output, message.data);
        break;
      case "phase":
        if (!current || GLOBAL_PHASES.has(message.phase)) break;
        current.label = message.phase;
        break;
      case "error":
        if (!current) break;
        current.error = appendText(current.error, message.message);
        if (current.status === "started") {
          current.status = "failed";
        }
        break;
      case "done":
        finalizePendingStep(current, message.success ? "success" : "failed");
        break;
      default:
        break;
    }
  }

  return steps;
}

export function getActivityStepLabel(step: ActivityStep, index: number): string {
  const label = step.label?.trim().replace(TRAILING_ELLIPSIS_PATTERN, "");
  return label || `Step ${index + 1}`;
}
