/**
 * Output rules let a custom script decide how a command result is classified,
 * instead of relying on the exit code alone. They are shared by the server, which
 * applies them, and the Scripts page, which can test them against sample output.
 */

export type OutputRuleOutcome = "success" | "warning" | "failed";

export const OUTPUT_RULE_OUTCOMES: readonly OutputRuleOutcome[] = ["success", "warning", "failed"];

export interface OutputRule {
  /**
   * Limits the rule to one step: a step label, or a zero-based step position.
   * Only operations whose steps run as separate commands support it.
   */
  step?: string | number;
  /** The rule matches only these exit codes. Omitted means any exit code. */
  exitCodes?: number[];
  /** A regular expression that must match the output. */
  match?: string;
  /** A regular expression that must not match the output. */
  notMatch?: string;
  outcome: OutputRuleOutcome;
  /** Shown for warnings and failures. `$<name>` inserts a named group from `match`. */
  message?: string;
}

/**
 * `step`: every step runs as its own command, so rules see one step's output and
 * exit code and can be limited to a step.
 * `command`: the steps run as one command that stops at the first failed step, so
 * rules see the combined output and the final exit code.
 */
export type OutputRuleScope = "step" | "command";

const OUTPUT_RULE_SCOPES: Record<string, OutputRuleScope> = {
  check_updates: "step",
  list_installed_packages: "step",
  repair_issue: "step",
  pre_upgrade: "step",
  post_upgrade: "step",
  autoremove: "command",
  upgrade_all: "command",
  full_upgrade_all: "command",
  upgrade_selected: "command",
};

/** Returns null for operations that do not support output rules. */
export function getOutputRuleScope(operation: string): OutputRuleScope | null {
  return OUTPUT_RULE_SCOPES[operation] ?? null;
}

export const MAX_OUTPUT_RULES = 20;
export const MAX_OUTPUT_RULE_PATTERN_LENGTH = 500;
/**
 * Time one pattern may take. A pattern that takes longer is skipped and the next
 * rule is checked. The server and the Scripts page preview both apply it.
 */
export const OUTPUT_RULE_PATTERN_TIMEOUT_MS = 100;
export const MAX_OUTPUT_RULE_MESSAGE_LENGTH = 500;
/** Rules read the end of long outputs, where package managers print their summary. */
export const OUTPUT_RULE_OUTPUT_LIMIT = 256 * 1024;

/** The part of an output that rules read: its end, where package managers print their summary. */
export function keepOutputTail(output: string): string {
  return output.length > OUTPUT_RULE_OUTPUT_LIMIT ? output.slice(-OUTPUT_RULE_OUTPUT_LIMIT) : output;
}

export interface OutputRuleStep {
  index: number;
  label: string;
}

export interface OutputRuleMatch {
  outcome: OutputRuleOutcome;
  /** The rendered rule message, or null when the rule has none. */
  message: string | null;
  /** One-based position of the matching rule in the script. */
  ruleNumber: number;
}

export function outputRuleAppliesToStep(rule: OutputRule, step: OutputRuleStep | null): boolean {
  if (rule.step === undefined || rule.step === null || rule.step === "") return true;
  if (!step) return false;
  return typeof rule.step === "number"
    ? rule.step === step.index
    : rule.step.trim() === step.label.trim();
}

/**
 * Nested quantifiers such as `(a+)+` and backreferences can take exponential time
 * on a near match. The same check guards every regex a script can store.
 */
export function hasUnsafeRegexConstruct(source: string): boolean {
  const nestedQuantifier = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/;
  return nestedQuantifier.test(source) || /\\[1-9]/.test(source);
}

export type OutputRulePatternProblem = "tooLong" | "unsafe" | "invalid";

/** Returns why a pattern cannot be used, or null when it is fine. */
export function getOutputRulePatternProblem(source: string): OutputRulePatternProblem | null {
  const trimmed = source.trim();
  if (trimmed.length > MAX_OUTPUT_RULE_PATTERN_LENGTH) return "tooLong";
  if (hasUnsafeRegexConstruct(trimmed)) return "unsafe";
  try {
    new RegExp(trimmed, "m");
  } catch {
    return "invalid";
  }
  return null;
}

export type OutputRuleRegexResult =
  | { matched: false }
  | { matched: true; groups?: Record<string, string | undefined> }
  | { timedOut: true };

/**
 * Runs one pattern against the output. The server swaps in a runner with a time
 * limit, because the safety check cannot recognize every slow pattern.
 */
export interface OutputRulePatternRef {
  ruleNumber: number;
  field: "match" | "notMatch";
}

export type OutputRuleRegexRunner = (
  source: string,
  output: string,
  ref?: OutputRulePatternRef,
) => OutputRuleRegexResult;

/** Patterns that fail validation never match, so evaluating them cannot hang on known traps. */
export const runOutputRuleRegex: OutputRuleRegexRunner = (source, output) => {
  if (getOutputRulePatternProblem(source)) return { matched: false };
  const match = new RegExp(source.trim(), "m").exec(output);
  return match ? { matched: true, groups: match.groups } : { matched: false };
};

export interface OutputRuleEvaluationOptions {
  runRegex?: OutputRuleRegexRunner;
  /** Called for a pattern that ran out of time. The rule is then skipped. */
  onTimeout?: (ruleNumber: number, pattern: string) => void;
}

function renderMessage(message: string, groups: Record<string, string | undefined> | undefined): string {
  return message.replace(/\$<([A-Za-z_][A-Za-z0-9_]*)>/g, (_token, name: string) => groups?.[name] ?? "");
}

/**
 * Returns the first rule that matches, or null when none does. Rules without any
 * condition never match, so a rule cannot silently accept every result.
 */
export function evaluateOutputRules(
  rules: readonly OutputRule[] | null | undefined,
  input: { exitCode: number; output: string; step?: OutputRuleStep | null },
  options: OutputRuleEvaluationOptions = {},
): OutputRuleMatch | null {
  const runRegex = options.runRegex ?? runOutputRuleRegex;
  if (!rules?.length) return null;
  const output = keepOutputTail(input.output);
  for (const [index, rule] of rules.entries()) {
    if (!outputRuleAppliesToStep(rule, input.step ?? null)) continue;
    const exitCodes = rule.exitCodes ?? [];
    if (!exitCodes.length && !rule.match && !rule.notMatch) continue;
    if (exitCodes.length && !exitCodes.includes(input.exitCode)) continue;
    let groups: Record<string, string | undefined> | undefined;
    if (rule.match) {
      const result = runRegex(rule.match, output, { ruleNumber: index + 1, field: "match" });
      if ("timedOut" in result) {
        options.onTimeout?.(index + 1, rule.match);
        continue;
      }
      if (!result.matched) continue;
      groups = result.groups;
    }
    if (rule.notMatch) {
      // An unusable not-match pattern cannot prove its absence, so the rule does not apply.
      if (getOutputRulePatternProblem(rule.notMatch)) continue;
      const result = runRegex(rule.notMatch, output, { ruleNumber: index + 1, field: "notMatch" });
      if ("timedOut" in result) {
        options.onTimeout?.(index + 1, rule.notMatch);
        continue;
      }
      if (result.matched) continue;
    }
    return {
      outcome: rule.outcome,
      message: rule.message?.trim() ? renderMessage(rule.message.trim(), groups) : null,
      ruleNumber: index + 1,
    };
  }
  return null;
}
