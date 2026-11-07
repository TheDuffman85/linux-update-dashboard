import { describe, expect, test, vi } from "vitest";
import {
  OUTPUT_RULE_OUTPUT_LIMIT,
  evaluateOutputRules,
  getOutputRulePatternProblem,
  keepOutputTail,
  getOutputRuleScope,
  outputRuleAppliesToStep,
  type OutputRule,
} from "../../shared/output-rules";

const APK_SUMMARY = "(1/1) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)\n2 errors; 293.6 MiB in 329 packages\n";

describe("output rules", () => {
  test("returns null without rules or without a matching rule", () => {
    expect(evaluateOutputRules(undefined, { exitCode: 1, output: "" })).toBeNull();
    expect(evaluateOutputRules([], { exitCode: 1, output: "" })).toBeNull();
    expect(evaluateOutputRules([{ exitCodes: [2], outcome: "success" }], { exitCode: 1, output: "" })).toBeNull();
  });

  test("the first matching rule wins and reports its position", () => {
    const rules: OutputRule[] = [
      { exitCodes: [2], outcome: "failed" },
      { exitCodes: [1], outcome: "warning" },
      { exitCodes: [1], outcome: "success" },
    ];
    expect(evaluateOutputRules(rules, { exitCode: 1, output: "" })).toEqual({
      outcome: "warning",
      message: null,
      ruleNumber: 2,
    });
  });

  test("all conditions of a rule must hold", () => {
    const rule: OutputRule = { exitCodes: [1], match: "^\\d+ errors?;", notMatch: "^ERROR:", outcome: "warning" };
    expect(evaluateOutputRules([rule], { exitCode: 1, output: APK_SUMMARY })?.outcome).toBe("warning");
    expect(evaluateOutputRules([rule], { exitCode: 0, output: APK_SUMMARY })).toBeNull();
    expect(evaluateOutputRules([rule], { exitCode: 1, output: "nothing to see" })).toBeNull();
    expect(evaluateOutputRules([rule], { exitCode: 1, output: `ERROR: unable to select packages\n${APK_SUMMARY}` })).toBeNull();
  });

  test("^ and $ match at line boundaries", () => {
    expect(evaluateOutputRules([{ match: "^2 errors;", outcome: "success" }], { exitCode: 1, output: APK_SUMMARY }))
      .not.toBeNull();
    expect(evaluateOutputRules([{ match: "packages$", outcome: "success" }], { exitCode: 1, output: APK_SUMMARY }))
      .not.toBeNull();
  });

  test("a rule without conditions never matches", () => {
    expect(evaluateOutputRules([{ outcome: "success" }], { exitCode: 1, output: "x" })).toBeNull();
    expect(evaluateOutputRules([{ exitCodes: [], outcome: "success" }], { exitCode: 1, output: "x" })).toBeNull();
  });

  test("renders named groups from the match pattern into the message", () => {
    const match = evaluateOutputRules([{
      match: "^(?<count>\\d+) errors?;",
      outcome: "warning",
      message: " apk reported $<count> pre-existing error(s)$<missing> ",
    }], { exitCode: 2, output: APK_SUMMARY });
    expect(match?.message).toBe("apk reported 2 pre-existing error(s)");
  });

  test("skips rules whose pattern cannot be compiled", () => {
    expect(evaluateOutputRules([
      { match: "(", outcome: "failed" },
      { notMatch: "(", outcome: "failed" },
      { exitCodes: [1], outcome: "success" },
    ], { exitCode: 1, output: "" })?.ruleNumber).toBe(3);
  });

  test("classifies pattern problems", () => {
    expect(getOutputRulePatternProblem("^\\d+ errors?;")).toBeNull();
    expect(getOutputRulePatternProblem("(a+)+$")).toBe("unsafe");
    expect(getOutputRulePatternProblem("(\\w)\\1")).toBe("unsafe");
    expect(getOutputRulePatternProblem("(")).toBe("invalid");
    expect(getOutputRulePatternProblem("x".repeat(501))).toBe("tooLong");
  });

  test("never evaluates unsafe patterns, so a near match cannot hang", () => {
    const output = `${"a".repeat(40)}!`;
    const started = Date.now();
    expect(evaluateOutputRules([
      { match: "(a+)+$", outcome: "failed" },
      { notMatch: "(a+)+$", outcome: "failed" },
    ], { exitCode: 0, output })).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("keeps the end of long outputs", () => {
    const output = `${"x".repeat(OUTPUT_RULE_OUTPUT_LIMIT)}\n1 error;`;
    expect(keepOutputTail(output)).toHaveLength(OUTPUT_RULE_OUTPUT_LIMIT);
    expect(keepOutputTail(output).endsWith("\n1 error;")).toBe(true);
    expect(keepOutputTail("short")).toBe("short");
  });

  test("a pattern that runs out of time is reported and its rule skipped", () => {
    const onTimeout = vi.fn();
    const match = evaluateOutputRules([
      { match: "slow", outcome: "failed" },
      { exitCodes: [1], outcome: "success" },
    ], { exitCode: 1, output: "" }, {
      runRegex: (source) => source === "slow" ? { timedOut: true } : { matched: false },
      onTimeout,
    });
    expect(match?.ruleNumber).toBe(2);
    expect(onTimeout).toHaveBeenCalledWith(1, "slow");
  });

  test("reads only the end of very long outputs", () => {
    const output = `MARKER\n${"x".repeat(OUTPUT_RULE_OUTPUT_LIMIT)}`;
    expect(evaluateOutputRules([{ match: "MARKER", outcome: "failed" }], { exitCode: 0, output })).toBeNull();
    expect(evaluateOutputRules([{ match: "x$", outcome: "failed" }], { exitCode: 0, output })).not.toBeNull();
  });

  test("step rules apply to the step with that label or position only", () => {
    const step = { index: 3, label: "Detecting kept-back packages" };
    expect(outputRuleAppliesToStep({ outcome: "success", exitCodes: [1] }, step)).toBe(true);
    expect(outputRuleAppliesToStep({ outcome: "success", step: " Detecting kept-back packages " }, step)).toBe(true);
    expect(outputRuleAppliesToStep({ outcome: "success", step: "Listing available updates" }, step)).toBe(false);
    expect(outputRuleAppliesToStep({ outcome: "success", step: 3 }, step)).toBe(true);
    expect(outputRuleAppliesToStep({ outcome: "success", step: 2 }, step)).toBe(false);
    expect(outputRuleAppliesToStep({ outcome: "success", step: 3 }, null)).toBe(false);

    const rules: OutputRule[] = [
      { step: "Listing available updates", exitCodes: [1], outcome: "failed" },
      { exitCodes: [1], outcome: "warning" },
    ];
    expect(evaluateOutputRules(rules, { exitCode: 1, output: "", step })?.ruleNumber).toBe(2);
    expect(evaluateOutputRules(rules, { exitCode: 1, output: "", step: { index: 1, label: "Listing available updates" } })?.ruleNumber)
      .toBe(1);
  });

  test("knows which operations support rules and how their steps run", () => {
    expect(getOutputRuleScope("check_updates")).toBe("step");
    expect(getOutputRuleScope("list_installed_packages")).toBe("step");
    expect(getOutputRuleScope("repair_issue")).toBe("step");
    expect(getOutputRuleScope("pre_upgrade")).toBe("step");
    expect(getOutputRuleScope("post_upgrade")).toBe("step");
    expect(getOutputRuleScope("upgrade_all")).toBe("command");
    expect(getOutputRuleScope("full_upgrade_all")).toBe("command");
    expect(getOutputRuleScope("upgrade_selected")).toBe("command");
    expect(getOutputRuleScope("autoremove")).toBe("command");
    expect(getOutputRuleScope("detect")).toBeNull();
    expect(getOutputRuleScope("system_info")).toBeNull();
    expect(getOutputRuleScope("reboot")).toBeNull();
  });
});
