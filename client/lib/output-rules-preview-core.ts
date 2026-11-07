import {
  OUTPUT_RULE_PATTERN_TIMEOUT_MS,
  evaluateOutputRules,
  runOutputRuleRegex,
  type OutputRule,
  type OutputRuleMatch,
  type OutputRulePatternRef,
  type OutputRuleStep,
} from "../../shared/output-rules";

// Shared by the preview worker and the page. Kept free of React so the worker stays small.

export interface OutputRulePreviewInput {
  exitCode: number;
  output: string;
  step: OutputRuleStep | null;
}

export interface OutputRulePreviewRequest {
  id: number;
  rules: OutputRule[];
  input: OutputRulePreviewInput;
  /** Patterns that already ran out of time in an earlier attempt, as `ruleNumber:field`. */
  skipPatterns: string[];
}

export type OutputRulePreviewResponse =
  /** Sent before each pattern runs, so a pattern that never finishes can be identified. */
  | { id: number; type: "pattern"; key: string }
  | { id: number; type: "result"; match: OutputRuleMatch | null; slowRules: number[] };

export type OutputRulePreviewState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; match: OutputRuleMatch | null; slowRules: number[] }
  | { status: "timeout" };

export function patternKey(ref: OutputRulePatternRef): string {
  return `${ref.ruleNumber}:${ref.field}`;
}

/**
 * Evaluates a preview request the way the server evaluates rules: a pattern that
 * takes longer than the shared limit is skipped and the next rule is checked. A
 * worker cannot stop a running pattern, so one that finishes late counts as timed
 * out, and one that never finishes is stopped by the runner and skipped on the retry.
 */
export function evaluatePreviewRequest(
  request: OutputRulePreviewRequest,
  post: (response: OutputRulePreviewResponse) => void,
  now: () => number = () => performance.now(),
): void {
  const skip = new Set(request.skipPatterns);
  const slowRules = new Set<number>();
  const match = evaluateOutputRules(request.rules, request.input, {
    runRegex: (source, output, ref) => {
      if (!ref) return runOutputRuleRegex(source, output);
      const key = patternKey(ref);
      if (skip.has(key)) return { timedOut: true };
      post({ id: request.id, type: "pattern", key });
      const started = now();
      const result = runOutputRuleRegex(source, output);
      return now() - started > OUTPUT_RULE_PATTERN_TIMEOUT_MS ? { timedOut: true } : result;
    },
    onTimeout: (ruleNumber) => slowRules.add(ruleNumber),
  });
  post({ id: request.id, type: "result", match, slowRules: [...slowRules] });
}
