import vm from "node:vm";
import {
  OUTPUT_RULE_PATTERN_TIMEOUT_MS,
  evaluateOutputRules,
  getOutputRulePatternProblem,
  type OutputRule,
  type OutputRuleMatch,
  type OutputRuleRegexRunner,
  type OutputRuleStep,
} from "../../shared/output-rules";

/**
 * Time one pattern may take, shared with the Scripts page preview. Normal patterns
 * finish in well under a millisecond, even on the largest output rules read.
 */
export const OUTPUT_RULE_REGEX_TIMEOUT_MS = OUTPUT_RULE_PATTERN_TIMEOUT_MS;

// A vm timeout interrupts V8 while it is still backtracking inside a regular
// expression, so a slow pattern costs at most the timeout instead of blocking the
// server. The context is reused because creating one is comparatively expensive.
const context = vm.createContext({ source: "", output: "" });
const script = new vm.Script(`(() => {
  const match = new RegExp(source, "m").exec(output);
  return match ? { groups: match.groups ? Object.assign({}, match.groups) : undefined } : null;
})()`);

export function createBoundedRegexRunner(timeoutMs = OUTPUT_RULE_REGEX_TIMEOUT_MS): OutputRuleRegexRunner {
  return (source, output) => {
    if (getOutputRulePatternProblem(source)) return { matched: false };
    context.source = source.trim();
    context.output = output;
    try {
      const match = script.runInContext(context, { timeout: timeoutMs }) as
        | { groups?: Record<string, string | undefined> }
        | null;
      return match ? { matched: true, groups: match.groups ? { ...match.groups } : undefined } : { matched: false };
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { timedOut: true };
      return { matched: false };
    } finally {
      context.output = "";
    }
  };
}

const boundedRegexRunner = createBoundedRegexRunner();

/** Evaluates rules on the server, where every pattern runs with a time limit. */
export function evaluateOutputRulesBounded(
  rules: readonly OutputRule[] | null | undefined,
  input: { exitCode: number; output: string; step?: OutputRuleStep | null },
  onSlowRule: (ruleNumber: number) => void,
): OutputRuleMatch | null {
  return evaluateOutputRules(rules, input, {
    runRegex: boundedRegexRunner,
    onTimeout: (ruleNumber) => onSlowRule(ruleNumber),
  });
}
