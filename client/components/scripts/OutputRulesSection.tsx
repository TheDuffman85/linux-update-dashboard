import { useId, useMemo, useState } from "react";
import { Badge } from "../Badge";
import { useI18n } from "../../lib/i18n";
import {
  emptyOutputRuleDraft,
  missingOutputRuleStep,
  outputRuleDraftPatternError,
  previewOutputRules,
  type EditorStep,
  type OutputRuleDraft,
} from "../../lib/output-rules";
import { useOutputRulePreview } from "../../lib/output-rules-preview";
import {
  OUTPUT_RULE_OUTCOMES,
  keepOutputTail,
  type OutputRuleOutcome,
  type OutputRuleScope,
} from "../../../shared/output-rules";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass = "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const iconButtonClass =
  "inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

const OUTCOME_BADGES: Record<OutputRuleOutcome, "success" | "warning" | "danger"> = {
  success: "success",
  warning: "warning",
  failed: "danger",
};

export function OutputRulesSection({
  scope,
  steps,
  rules,
  onChange,
  parserNote,
}: {
  scope: OutputRuleScope;
  steps: EditorStep[];
  rules: OutputRuleDraft[];
  onChange: (rules: OutputRuleDraft[]) => void;
  /** Shown when a built-in parser keeps reading the output whatever the rules decide. */
  parserNote?: boolean;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const [sampleOutput, setSampleOutput] = useState("");
  const [sampleTrimmed, setSampleTrimmed] = useState(false);
  const [sampleExitCode, setSampleExitCode] = useState("1");
  const [sampleStepKey, setSampleStepKey] = useState("");

  const update = (index: number, patch: Partial<OutputRuleDraft>) => {
    onChange(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
  };
  const move = (index: number, offset: number) => {
    const next = [...rules];
    const [moved] = next.splice(index, 1);
    next.splice(index + offset, 0, moved);
    onChange(next);
  };

  const outcomeLabel = (outcome: OutputRuleOutcome) => t(`pages.scripts.outputRules.outcome.${outcome}`);
  const stepName = (index: number) => steps[index]?.label.trim() || t("pages.scripts.stepNumber", { step: index + 1 });
  const stepOption = (index: number) =>
    t("pages.scripts.stepNumberWithLabel", { step: index + 1, label: stepName(index) });
  const fieldId = (ruleIndex: number, field: string) => `${idPrefix}-rule-${ruleIndex}-${field}`;

  const sampleStepIndex = Math.max(0, steps.findIndex((step) => step.key === sampleStepKey));
  const previewRules = useMemo(() => previewOutputRules(rules, steps), [rules, steps]);
  const previewInput = useMemo(() => {
    const exitCode = Number.parseInt(sampleExitCode.trim(), 10);
    if (!Number.isInteger(exitCode)) return null;
    const step = scope === "step" && steps[sampleStepIndex]
      ? { index: sampleStepIndex, label: steps[sampleStepIndex].label }
      : null;
    return { exitCode, output: sampleOutput, step };
  }, [sampleExitCode, sampleOutput, sampleStepIndex, scope, steps]);
  // Patterns run in a worker with a time limit, so a slow pattern cannot freeze the page.
  const previewState = useOutputRulePreview(previewRules, previewInput);
  let preview: string | null = null;
  if (previewState.status === "timeout") {
    preview = t("pages.scripts.outputRules.testTimeout");
  } else if (previewState.status === "done") {
    const match = previewState.match;
    const result = match ? t(`pages.scripts.outputRules.outcome.${match.outcome}`) : "";
    // Slow rules are skipped as at runtime, and the result shows which ones.
    preview = [
      ...previewState.slowRules.map((number) => t("pages.scripts.outputRules.testSlowRule", { number })),
      !match
        ? t("pages.scripts.outputRules.testNoMatch")
        : match.message
          ? t("pages.scripts.outputRules.testMatchWithMessage", { number: match.ruleNumber, result, message: match.message })
          : t("pages.scripts.outputRules.testMatch", { number: match.ruleNumber, result }),
    ].join(" ");
  }

  return (
    <details
      className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3"
      open={rules.length > 0 || undefined}
    >
      <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
        <span className="inline-flex items-center gap-2">
          {t("pages.scripts.outputRules.title")}
          {rules.length > 0 && <Badge variant="info" small>{rules.length}</Badge>}
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t(scope === "step" ? "pages.scripts.outputRules.descriptionStep" : "pages.scripts.outputRules.descriptionCommand")}
          {parserNote ? ` ${t("pages.scripts.outputRules.parserNote")}` : ""}
        </p>

        {rules.map((rule, index) => {
          const number = index + 1;
          const missingStep = missingOutputRuleStep(rule, steps);
          const showStep = scope === "step" || rule.step !== "";
          const savedStep = !missingStep && (rule.step.startsWith("index:") || rule.step.startsWith("label:"));
          const patternMessage = outputRuleDraftPatternError(rule, number, t);
          return (
            <div
              key={index}
              role="group"
              aria-labelledby={fieldId(index, "title")}
              className="rounded-lg border border-border bg-white/70 dark:bg-slate-900/40 p-3 space-y-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <span id={fieldId(index, "title")}>{t("pages.scripts.outputRules.rule", { number })}</span>
                  <Badge variant={OUTCOME_BADGES[rule.outcome]} small>{outcomeLabel(rule.outcome)}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={iconButtonClass}
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    title={t("pages.scripts.outputRules.moveUp", { number })}
                    aria-label={t("pages.scripts.outputRules.moveUp", { number })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={iconButtonClass}
                    onClick={() => move(index, 1)}
                    disabled={index === rules.length - 1}
                    title={t("pages.scripts.outputRules.moveDown", { number })}
                    aria-label={t("pages.scripts.outputRules.moveDown", { number })}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={`${iconButtonClass} text-lg leading-none`}
                    onClick={() => onChange(rules.filter((_rule, ruleIndex) => ruleIndex !== index))}
                    title={t("pages.scripts.outputRules.remove", { number })}
                    aria-label={t("pages.scripts.outputRules.remove", { number })}
                  >
                    -
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {showStep && (
                  <div>
                    <label htmlFor={fieldId(index, "step")} className={labelClass}>
                      {t("pages.scripts.outputRules.step")}
                    </label>
                    <select
                      id={fieldId(index, "step")}
                      value={rule.step}
                      onChange={(e) => update(index, { step: e.target.value })}
                      className={inputClass}
                      aria-describedby={missingStep || scope !== "step" ? fieldId(index, "step-hint") : undefined}
                    >
                      <option value="">{t("pages.scripts.outputRules.anyStep")}</option>
                      {steps.map((step, stepIndex) => (
                        <option key={step.key} value={`step:${step.key}`}>{stepOption(stepIndex)}</option>
                      ))}
                      {savedStep && rule.step.startsWith("index:") && (
                        <option value={rule.step}>
                          {t("pages.scripts.outputRules.stepPosition", { step: Number(rule.step.slice(6)) + 1 })}
                        </option>
                      )}
                      {savedStep && rule.step.startsWith("label:") && (
                        <option value={rule.step}>{rule.step.slice(6)}</option>
                      )}
                      {missingStep && (
                        <option value={rule.step}>{t("pages.scripts.outputRules.missingStep", { step: missingStep })}</option>
                      )}
                    </select>
                    {missingStep && (
                      <p id={fieldId(index, "step-hint")} className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        {t("pages.scripts.outputRules.missingStepHint")}
                      </p>
                    )}
                    {!missingStep && scope !== "step" && (
                      <p id={fieldId(index, "step-hint")} className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        {t("pages.scripts.outputRules.error.stepNotSupported", { number })}
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <label htmlFor={fieldId(index, "exit-codes")} className={labelClass}>
                    {t("pages.scripts.outputRules.exitCodes")}
                  </label>
                  <input
                    id={fieldId(index, "exit-codes")}
                    value={rule.exitCodes}
                    onChange={(e) => update(index, { exitCodes: e.target.value })}
                    className={inputClass}
                    placeholder={t("pages.scripts.outputRules.anyExitCode")}
                  />
                </div>
                <div>
                  <label htmlFor={fieldId(index, "match")} className={labelClass}>
                    {t("pages.scripts.outputRules.match")}
                  </label>
                  <input
                    id={fieldId(index, "match")}
                    value={rule.match}
                    onChange={(e) => update(index, { match: e.target.value })}
                    className={`${inputClass} font-mono text-xs`}
                    placeholder="^\d+ errors?;"
                    aria-invalid={patternMessage ? true : undefined}
                    aria-describedby={patternMessage ? fieldId(index, "pattern-hint") : undefined}
                  />
                </div>
                <div>
                  <label htmlFor={fieldId(index, "not-match")} className={labelClass}>
                    {t("pages.scripts.outputRules.notMatch")}
                  </label>
                  <input
                    id={fieldId(index, "not-match")}
                    value={rule.notMatch}
                    onChange={(e) => update(index, { notMatch: e.target.value })}
                    className={`${inputClass} font-mono text-xs`}
                    placeholder="^ERROR:"
                    aria-invalid={patternMessage ? true : undefined}
                    aria-describedby={patternMessage ? fieldId(index, "pattern-hint") : undefined}
                  />
                </div>
                {patternMessage && (
                  <p id={fieldId(index, "pattern-hint")} className="md:col-span-2 text-xs text-red-700 dark:text-red-300" role="alert">
                    {patternMessage}
                  </p>
                )}
                <div>
                  <label htmlFor={fieldId(index, "outcome")} className={labelClass}>
                    {t("pages.scripts.outputRules.outcomeLabel")}
                  </label>
                  <select
                    id={fieldId(index, "outcome")}
                    value={rule.outcome}
                    onChange={(e) => update(index, { outcome: e.target.value as OutputRuleOutcome })}
                    className={inputClass}
                  >
                    {OUTPUT_RULE_OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>
                    ))}
                  </select>
                </div>
                <div className={showStep ? "" : "md:col-span-2"}>
                  <label htmlFor={fieldId(index, "message")} className={labelClass}>
                    {t("pages.scripts.outputRules.message")}
                  </label>
                  <input
                    id={fieldId(index, "message")}
                    value={rule.message}
                    onChange={(e) => update(index, { message: e.target.value })}
                    className={inputClass}
                    placeholder={t("pages.scripts.outputRules.messagePlaceholder")}
                  />
                </div>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => onChange([...rules, emptyOutputRuleDraft()])}
          className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700"
        >
          {t("pages.scripts.outputRules.add")}
        </button>

        {rules.length > 0 && (
          <div
            role="group"
            aria-labelledby={`${idPrefix}-test-title`}
            className="rounded-lg border border-dashed border-border p-3 space-y-3"
          >
            <div id={`${idPrefix}-test-title`} className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {t("pages.scripts.outputRules.testTitle")}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {scope === "step" && (
                <div>
                  <label htmlFor={`${idPrefix}-test-step`} className={labelClass}>
                    {t("pages.scripts.outputRules.step")}
                  </label>
                  <select
                    id={`${idPrefix}-test-step`}
                    value={steps[sampleStepIndex]?.key ?? ""}
                    onChange={(e) => setSampleStepKey(e.target.value)}
                    className={inputClass}
                  >
                    {steps.map((step, stepIndex) => (
                      <option key={step.key} value={step.key}>{stepOption(stepIndex)}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor={`${idPrefix}-test-exit-code`} className={labelClass}>
                  {t("pages.scripts.outputRules.testExitCode")}
                </label>
                <input
                  id={`${idPrefix}-test-exit-code`}
                  value={sampleExitCode}
                  onChange={(e) => setSampleExitCode(e.target.value)}
                  className={inputClass}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-test-output`} className={labelClass}>
                {t("pages.scripts.outputRules.testOutput")}
              </label>
              <textarea
                id={`${idPrefix}-test-output`}
                value={sampleOutput}
                onChange={(e) => {
                  // Keep the end of long logs, which is what rules read at runtime.
                  const next = keepOutputTail(e.target.value);
                  setSampleTrimmed(next.length < e.target.value.length);
                  setSampleOutput(next);
                }}
                className={`${inputClass} min-h-24 font-mono text-xs`}
                aria-describedby={sampleTrimmed ? `${idPrefix}-test-output-trimmed` : undefined}
              />
              {sampleTrimmed && (
                <p id={`${idPrefix}-test-output-trimmed`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.scripts.outputRules.testOutputTrimmed")}
                </p>
              )}
            </div>
            {preview && (
              <p className="text-sm text-slate-600 dark:text-slate-300" role="status" aria-live="polite">{preview}</p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
