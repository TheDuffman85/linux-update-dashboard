import { describe, expect, test } from "vitest";
import {
  buildOutputRules,
  detachOutputRulesFromStep,
  missingOutputRuleStep,
  previewOutputRules,
  toEditorSteps,
  toOutputRuleDrafts,
  type EditorStep,
  type OutputRuleDraft,
} from "../../client/lib/output-rules";
import { evaluateOutputRules, type OutputRule } from "../../shared/output-rules";
import {
  OutputRulePreviewRunner,
  evaluatePreviewRequest,
  type OutputRulePreviewRequest,
  type OutputRulePreviewResponse,
  type PreviewWorker,
} from "../../client/lib/output-rules-preview";
import { afterEach, vi } from "vitest";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

function draft(patch: Partial<OutputRuleDraft>): OutputRuleDraft {
  return { step: "", exitCodes: "", match: "", notMatch: "", outcome: "warning", message: "", ...patch };
}

function rename(steps: EditorStep[], index: number, label: string): EditorStep[] {
  return steps.map((step, stepIndex) => stepIndex === index ? { ...step, label } : step);
}

describe("output rule drafts", () => {
  const steps = toEditorSteps([
    { label: "List", command: "apk list -u" },
    { label: "Simulate", command: "apk upgrade --simulate" },
    { label: "Inventory", command: "apk list --installed" },
  ]);

  test("round-trip saved rules", () => {
    const rules: OutputRule[] = [
      { step: "Simulate", match: "^\\d+ errors?;", notMatch: "^ERROR:", outcome: "success" },
      { step: 2, exitCodes: [1, 2], outcome: "failed", message: "Broken" },
      { exitCodes: [100], outcome: "warning" },
    ];
    expect(buildOutputRules(toOutputRuleDrafts(rules, steps), "step", steps, t)).toEqual(rules);
    expect(toOutputRuleDrafts(undefined, steps)).toEqual([]);
  });

  test("a rule follows its step when the step is renamed or moved", () => {
    const drafts = toOutputRuleDrafts([{ step: "Simulate", exitCodes: [1], outcome: "success" }], steps);
    const edited = [steps[1], steps[0], steps[2]].map((step) => step.label === "Simulate" ? { ...step, label: "Simulate upgrade" } : step);

    expect(buildOutputRules(drafts, "step", edited, t)).toEqual([{ step: "Simulate upgrade", exitCodes: [1], outcome: "success" }]);
  });

  test("renaming another step through the rule's label does not retarget the rule", () => {
    const drafts = toOutputRuleDrafts([{ step: "Simulate", exitCodes: [1], outcome: "success" }], steps);
    // Typing "Simulate extra" into the first step passes through "Simulate" on the way.
    let edited = rename(steps, 0, "Simulat");
    edited = rename(edited, 0, "Simulate");
    edited = rename(edited, 0, "Simulate extra");

    expect(buildOutputRules(drafts, "step", edited, t)).toEqual([{ step: "Simulate", exitCodes: [1], outcome: "success" }]);
  });

  test("two steps with the label of a rule are reported instead of saving an ambiguous rule", () => {
    const drafts = toOutputRuleDrafts([{ step: "Simulate", exitCodes: [1], outcome: "success" }], steps);
    expect(() => buildOutputRules(drafts, "step", rename(steps, 0, "Simulate"), t))
      .toThrow("pages.scripts.outputRules.error.stepAmbiguous");
  });

  test("a rule of a removed step keeps its label and is reported as missing", () => {
    const drafts = detachOutputRulesFromStep(
      toOutputRuleDrafts([{ step: "Simulate", exitCodes: [1], outcome: "success" }], steps),
      steps[1],
    );
    const remaining = [steps[0], steps[2]];

    expect(drafts[0].step).toBe("label:Simulate");
    expect(missingOutputRuleStep(drafts[0], remaining)).toBe("Simulate");
    expect(() => buildOutputRules(drafts, "step", remaining, t)).toThrow("pages.scripts.outputRules.error.stepMissing");
  });

  test("saved labels that match no step or several steps stay as labels", () => {
    const duplicated = toEditorSteps([{ label: "Same", command: "a" }, { label: "Same", command: "b" }]);
    expect(toOutputRuleDrafts([{ step: "Same", exitCodes: [1], outcome: "success" }], duplicated)[0].step).toBe("label:Same");
    expect(toOutputRuleDrafts([{ step: "Gone", exitCodes: [1], outcome: "success" }], steps)[0].step).toBe("label:Gone");
  });

  test("report rules whose step no longer exists", () => {
    expect(missingOutputRuleStep(draft({ step: `step:${steps[0].key}` }), steps)).toBeNull();
    expect(missingOutputRuleStep(draft({ step: "label:Gone" }), steps)).toBe("Gone");
    expect(missingOutputRuleStep(draft({ step: "index:1" }), steps)).toBeNull();
    expect(missingOutputRuleStep(draft({ step: "index:4" }), steps)).toBe("#5");
    expect(missingOutputRuleStep(draft({}), steps)).toBeNull();
  });

  test("trim fields and drop empty ones", () => {
    expect(buildOutputRules([draft({ exitCodes: " 1 , 2 ", match: "  x  ", message: "   " })], "command", steps, t))
      .toEqual([{ exitCodes: [1, 2], match: "x", outcome: "warning" }]);
  });

  test("operations without rule support save no rules", () => {
    expect(buildOutputRules([draft({ exitCodes: "1" })], null, steps, t)).toEqual([]);
  });

  test.each([
    [draft({}), "pages.scripts.outputRules.error.missingCondition"],
    [draft({ exitCodes: "1, x" }), "pages.scripts.outputRules.error.exitCodes"],
    [draft({ exitCodes: "256" }), "pages.scripts.outputRules.error.exitCodes"],
    [draft({ match: "(" }), "pages.scripts.outputRules.error.invalidPattern"],
    [draft({ notMatch: "[" }), "pages.scripts.outputRules.error.invalidPattern"],
    [draft({ match: "(a+)+$" }), "pages.scripts.outputRules.error.unsafePattern"],
    [draft({ notMatch: "x".repeat(501) }), "pages.scripts.outputRules.error.patternTooLong"],
  ])("reject invalid rules", (input, message) => {
    expect(() => buildOutputRules([draft({ exitCodes: "1" }), input], "step", steps, t)).toThrow(message);
    expect(() => buildOutputRules([draft({ exitCodes: "1" }), input], "step", steps, t)).toThrow('"number":2');
  });

  test("a step limit is rejected where steps run as one command", () => {
    expect(() => buildOutputRules([draft({ step: `step:${steps[0].key}`, exitCodes: "1" })], "command", steps, t))
      .toThrow("pages.scripts.outputRules.error.stepNotSupported");
  });

  test("previews never throw, follow the current steps, and skip incomplete rules", () => {
    const rules = previewOutputRules([
      draft({ exitCodes: "x", outcome: "failed" }),
      draft({ match: "(", outcome: "failed" }),
      draft({ outcome: "failed" }),
      draft({ step: "label:Gone", exitCodes: "1", outcome: "failed" }),
      draft({ step: `step:${steps[0].key}`, exitCodes: "1", outcome: "success" }),
      draft({ match: "^(?<count>\\d+) errors?;", outcome: "warning", message: "$<count> errors" }),
    ], rename(steps, 0, "Renamed"));
    const output = "1 error; 293.6 MiB in 329 packages";

    expect(evaluateOutputRules(rules, { exitCode: 1, output, step: { index: 1, label: "Simulate" } }))
      .toEqual({ outcome: "warning", message: "1 errors", ruleNumber: 6 });
    expect(evaluateOutputRules(rules, { exitCode: 1, output, step: { index: 0, label: "Renamed" } })?.ruleNumber)
      .toBe(5);
  });
});

describe("output rule preview runner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A worker that evaluates requests for real, except for patterns told to hang. */
  class FakeWorker implements PreviewWorker {
    requests: OutputRulePreviewRequest[] = [];
    terminated = false;
    private listener: ((event: MessageEvent<OutputRulePreviewResponse>) => void) | null = null;
    constructor(private readonly hangOn: Set<string> = new Set()) {}
    postMessage(request: OutputRulePreviewRequest) {
      this.requests.push(request);
      const responses: OutputRulePreviewResponse[] = [];
      let hung = false;
      evaluatePreviewRequest(request, (response) => {
        if (hung) return;
        responses.push(response);
        if (response.type === "pattern" && this.hangOn.has(response.key)) hung = true;
      });
      // Answers arrive asynchronously, as they do from a real worker.
      queueMicrotask(() => {
        for (const response of responses) this.listener?.({ data: response } as MessageEvent<OutputRulePreviewResponse>);
      });
    }
    addEventListener(_type: "message", listener: (event: MessageEvent<OutputRulePreviewResponse>) => void) {
      this.listener = listener;
    }
    terminate() {
      this.terminated = true;
    }
  }

  const input = { exitCode: 1, output: "1 error;", step: null };

  test("returns the worker's answer", async () => {
    const runner = new OutputRulePreviewRunner(() => new FakeWorker());
    expect(await runner.run([{ exitCodes: [1], outcome: "warning" }], input))
      .toEqual({ status: "done", match: { outcome: "warning", message: null, ruleNumber: 1 }, slowRules: [] });
  });

  test("a pattern that never finishes is skipped and the next rule decides, as on the server", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const runner = new OutputRulePreviewRunner(() => {
      workers.push(new FakeWorker(new Set(["1:match"])));
      return workers.at(-1)!;
    }, 250);

    const running = runner.run([
      { match: "^(a|aa)+$", outcome: "failed" },
      { exitCodes: [1], outcome: "warning" },
    ], input);
    await vi.advanceTimersByTimeAsync(250);

    expect(await running).toEqual({
      status: "done",
      match: { outcome: "warning", message: null, ruleNumber: 2 },
      slowRules: [1],
    });
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].requests[0].skipPatterns).toEqual(["1:match"]);
  });

  test("a pattern that finishes after the limit counts as timed out, like on the server", () => {
    let clock = 0;
    const responses: OutputRulePreviewResponse[] = [];
    evaluatePreviewRequest({
      id: 1,
      rules: [{ match: "slow", outcome: "failed" }, { match: "x", outcome: "success" }],
      input: { exitCode: 0, output: "slow x", step: null },
      skipPatterns: [],
    }, (response) => responses.push(response), () => {
      clock += responses.at(-1)?.type === "pattern" && (responses.at(-1) as { key: string }).key === "1:match" ? 120 : 1;
      return clock;
    });

    expect(responses.at(-1)).toEqual({
      id: 1,
      type: "result",
      match: { outcome: "success", message: null, ruleNumber: 2 },
      slowRules: [1],
    });
  });

  test("the reported pattern takes over 100 ms, so the preview skips it like the server", () => {
    const responses: OutputRulePreviewResponse[] = [];
    evaluatePreviewRequest({
      id: 1,
      rules: [{ match: "^(a|aa)+$|!$", outcome: "failed" }],
      input: { exitCode: 0, output: `${"a".repeat(36)}!`, step: null },
      skipPatterns: [],
    }, (response) => responses.push(response));

    expect(responses.at(-1)).toEqual({ id: 1, type: "result", match: null, slowRules: [1] });
  });

  test("a newer try replaces one that is still running and stops its worker", async () => {
    const workers: FakeWorker[] = [];
    const runner = new OutputRulePreviewRunner(() => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    });

    const first = runner.run([{ exitCodes: [1], outcome: "failed" }], input);
    const second = runner.run([{ exitCodes: [1], outcome: "success" }], input);

    expect(await first).toEqual({ status: "idle" });
    expect(await second).toMatchObject({ status: "done", match: { outcome: "success" } });
    expect(workers[0].terminated).toBe(true);
    runner.dispose();
    expect(workers[1].terminated).toBe(true);
  });

  test("gives up when the worker never answers", async () => {
    vi.useFakeTimers();
    const silent: PreviewWorker = { postMessage() {}, addEventListener() {}, terminate: vi.fn() };
    const runner = new OutputRulePreviewRunner(() => silent, 250, 1000);

    const running = runner.run([{ exitCodes: [1], outcome: "warning" }], input);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await running).toEqual({ status: "timeout" });
    expect(silent.terminate).toHaveBeenCalled();
  });
});
