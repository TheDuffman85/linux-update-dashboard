import { describe, expect, test, vi } from "vitest";
import {
  OUTPUT_RULE_REGEX_TIMEOUT_MS,
  createBoundedRegexRunner,
  evaluateOutputRulesBounded,
} from "../../server/services/output-rule-regex";
import { getOutputRulePatternProblem } from "../../shared/output-rules";

// Passes the safety check, but backtracks exponentially on a near match.
const SLOW_PATTERN = "^(a|aa)+$";
const NEAR_MATCH = `${"a".repeat(45)}!`;

describe("time-limited output rule patterns", () => {
  test("the slow pattern is not caught by the safety check", () => {
    expect(getOutputRulePatternProblem(SLOW_PATTERN)).toBeNull();
  });

  test("stops a pattern that runs out of time", () => {
    const started = Date.now();
    expect(createBoundedRegexRunner(50)(SLOW_PATTERN, NEAR_MATCH)).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("returns matches and named groups of normal patterns", () => {
    const run = createBoundedRegexRunner();
    expect(run("^(?<count>\\d+) errors?;", "x\n1 error; 293.6 MiB")).toEqual({ matched: true, groups: { count: "1" } });
    expect(run("^ERROR:", "x\n1 error; 293.6 MiB")).toEqual({ matched: false });
    expect(run("(", "x")).toEqual({ matched: false });
    expect(run("(a+)+$", "aaa")).toEqual({ matched: false });
  });

  test("skips a slow rule, reports it, and goes on with the next rules", () => {
    const onSlowRule = vi.fn();
    const started = Date.now();
    const match = evaluateOutputRulesBounded([
      { match: SLOW_PATTERN, outcome: "failed" },
      { notMatch: SLOW_PATTERN, outcome: "failed" },
      { exitCodes: [1], outcome: "warning" },
    ], { exitCode: 1, output: NEAR_MATCH }, onSlowRule);

    expect(match).toEqual({ outcome: "warning", message: null, ruleNumber: 3 });
    expect(onSlowRule.mock.calls).toEqual([[1], [2]]);
    expect(Date.now() - started).toBeLessThan(OUTPUT_RULE_REGEX_TIMEOUT_MS * 2 + 1000);
  });
});
