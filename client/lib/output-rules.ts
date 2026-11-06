import {
  getOutputRulePatternProblem,
  type OutputRule,
  type OutputRuleOutcome,
  type OutputRuleScope,
} from "../../shared/output-rules";
import type { ScriptStep } from "./scripts";
import type { useI18n } from "./i18n";

/**
 * A step in the script editor. The key stays the same while the label is edited or
 * the step is moved, so rules keep pointing at the step they were made for.
 */
export interface EditorStep extends ScriptStep {
  key: string;
}

/** Editable form of an output rule. Every field is text so inputs can hold partial values. */
export interface OutputRuleDraft {
  /**
   * "" for any step, `step:<key>` for a step in the editor, `index:<n>` for a
   * zero-based position, or `label:<label>` for a saved label no step has any more.
   */
  step: string;
  exitCodes: string;
  match: string;
  notMatch: string;
  outcome: OutputRuleOutcome;
  message: string;
}

type Translate = ReturnType<typeof useI18n>["t"];

let nextStepKey = 0;

export function createStepKey(): string {
  nextStepKey += 1;
  return `step-${nextStepKey}`;
}

export function toEditorSteps(steps: ScriptStep[]): EditorStep[] {
  return steps.map((step) => ({ ...step, key: createStepKey() }));
}

export function emptyOutputRuleDraft(): OutputRuleDraft {
  return { step: "", exitCodes: "", match: "", notMatch: "", outcome: "warning", message: "" };
}

/** Points label rules at the step that has the label, so later label edits keep them attached. */
export function toOutputRuleDrafts(rules: OutputRule[] | null | undefined, steps: EditorStep[]): OutputRuleDraft[] {
  return (rules ?? []).map((rule) => {
    let step = "";
    if (typeof rule.step === "number") {
      step = `index:${rule.step}`;
    } else if (typeof rule.step === "string" && rule.step.trim()) {
      const label = rule.step.trim();
      const matches = steps.filter((candidate) => candidate.label.trim() === label);
      step = matches.length === 1 ? `step:${matches[0].key}` : `label:${label}`;
    }
    return {
      step,
      exitCodes: rule.exitCodes?.join(", ") ?? "",
      match: rule.match ?? "",
      notMatch: rule.notMatch ?? "",
      outcome: rule.outcome,
      message: rule.message ?? "",
    };
  });
}

type ResolvedStep =
  | { kind: "any" }
  | { kind: "index"; index: number }
  | { kind: "step"; index: number; label: string }
  | { kind: "missing"; display: string };

function resolveStep(value: string, steps: EditorStep[]): ResolvedStep {
  if (value.startsWith("step:")) {
    const index = steps.findIndex((step) => step.key === value.slice("step:".length));
    return index >= 0
      ? { kind: "step", index, label: steps[index].label.trim() }
      : { kind: "missing", display: "?" };
  }
  if (value.startsWith("index:")) {
    const index = Number.parseInt(value.slice("index:".length), 10);
    if (!Number.isInteger(index)) return { kind: "missing", display: "?" };
    return index < steps.length ? { kind: "index", index } : { kind: "missing", display: `#${index + 1}` };
  }
  if (value.startsWith("label:")) {
    const label = value.slice("label:".length);
    const index = steps.findIndex((step) => step.label.trim() === label.trim());
    return index >= 0 ? { kind: "step", index, label: label.trim() } : { kind: "missing", display: label };
  }
  return { kind: "any" };
}

function parseRuleExitCodes(value: string): number[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const codes = trimmed.split(",").map((part) => part.trim());
  if (codes.some((code) => !/^\d+$/.test(code) || Number(code) > 255)) return null;
  return codes.map(Number);
}

function patternError(source: string, number: number, t: Translate): string | null {
  if (!source.trim()) return null;
  switch (getOutputRulePatternProblem(source)) {
    case "tooLong":
      return t("pages.scripts.outputRules.error.patternTooLong", { number });
    case "unsafe":
      return t("pages.scripts.outputRules.error.unsafePattern", { number });
    case "invalid":
      try {
        new RegExp(source.trim(), "m");
      } catch (error) {
        return t("pages.scripts.outputRules.error.invalidPattern", {
          number,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    default:
      return null;
  }
}

/** The first pattern problem of a draft, as a translated message, or null. */
export function outputRuleDraftPatternError(draft: OutputRuleDraft, number: number, t: Translate): string | null {
  return patternError(draft.match, number, t) ?? patternError(draft.notMatch, number, t);
}

/** Builds the rules to save. Throws a translated error for the first invalid rule. */
export function buildOutputRules(
  drafts: OutputRuleDraft[],
  scope: OutputRuleScope | null,
  steps: EditorStep[],
  t: Translate,
): OutputRule[] {
  if (!scope) return [];
  return drafts.map((draft, index) => {
    const number = index + 1;
    const exitCodes = parseRuleExitCodes(draft.exitCodes);
    if (!exitCodes) throw new Error(t("pages.scripts.outputRules.error.exitCodes", { number }));
    const patternMessage = outputRuleDraftPatternError(draft, number, t);
    if (patternMessage) throw new Error(patternMessage);
    if (!exitCodes.length && !draft.match.trim() && !draft.notMatch.trim()) {
      throw new Error(t("pages.scripts.outputRules.error.missingCondition", { number }));
    }
    const step = resolveStep(draft.step, steps);
    if (step.kind !== "any" && scope !== "step") {
      throw new Error(t("pages.scripts.outputRules.error.stepNotSupported", { number }));
    }
    if (step.kind === "missing") {
      throw new Error(t("pages.scripts.outputRules.error.stepMissing", { number }));
    }
    if (step.kind === "step") {
      if (!step.label) throw new Error(t("pages.scripts.outputRules.error.stepMissing", { number }));
      const sameLabel = steps.filter((candidate) => candidate.label.trim() === step.label).length;
      if (sameLabel > 1) {
        throw new Error(t("pages.scripts.outputRules.error.stepAmbiguous", { number, step: step.label }));
      }
    }
    const rule: OutputRule = { outcome: draft.outcome };
    if (step.kind === "step") rule.step = step.label;
    if (step.kind === "index") rule.step = step.index;
    if (exitCodes.length) rule.exitCodes = exitCodes;
    if (draft.match.trim()) rule.match = draft.match.trim();
    if (draft.notMatch.trim()) rule.notMatch = draft.notMatch.trim();
    if (draft.message.trim()) rule.message = draft.message.trim();
    return rule;
  });
}

/**
 * Converts drafts for trying them out. Unlike `buildOutputRules` it never throws:
 * incomplete rules are kept as they are and simply do not match, and the evaluator
 * skips patterns that are unsafe or invalid. Step limits become positions, so the
 * preview follows the steps as they are in the editor right now.
 */
export function previewOutputRules(drafts: OutputRuleDraft[], steps: EditorStep[]): OutputRule[] {
  return drafts.map((draft) => {
    const rule: OutputRule = { outcome: draft.outcome };
    const step = resolveStep(draft.step, steps);
    if (step.kind === "step" || step.kind === "index") rule.step = step.index;
    if (step.kind === "missing") rule.step = -1;
    const exitCodes = parseRuleExitCodes(draft.exitCodes);
    if (exitCodes === null) rule.exitCodes = [-1];
    else if (exitCodes.length) rule.exitCodes = exitCodes;
    if (draft.match.trim()) rule.match = draft.match.trim();
    if (draft.notMatch.trim()) rule.notMatch = draft.notMatch.trim();
    if (draft.message.trim()) rule.message = draft.message.trim();
    return rule;
  });
}

/**
 * Keeps a rule pointing at a removed step as its last label, so it shows up as a
 * missing step instead of quietly applying to every step.
 */
export function detachOutputRulesFromStep(drafts: OutputRuleDraft[], removed: EditorStep): OutputRuleDraft[] {
  return drafts.map((draft) => draft.step === `step:${removed.key}`
    ? { ...draft, step: `label:${removed.label.trim() || "?"}` }
    : draft);
}

/** Describes a rule's step when it no longer matches any step, or returns null. */
export function missingOutputRuleStep(draft: OutputRuleDraft, steps: EditorStep[]): string | null {
  const step = resolveStep(draft.step, steps);
  return step.kind === "missing" ? step.display : null;
}
