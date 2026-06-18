import { Badge } from "../Badge";
import { CopyableCodeBlock } from "../CopyableCodeBlock";
import { highlightSudoers } from "../../lib/sudoers-highlight";
import type { SudoersPreview, SudoersPreviewWarning } from "../../lib/systems";
import { useI18n } from "../../lib/i18n";

function SudoersBlock({ content }: { content: string }) {
  return (
    <CopyableCodeBlock
      text={content}
      className="script-code mt-3 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100 whitespace-pre-wrap break-all"
      successMessage="components.sudoersSetupPanel.copiedSudoersFile"
    >
      <code>{highlightSudoers(content)}</code>
    </CopyableCodeBlock>
  );
}

function WarningList({ warnings }: { warnings: SudoersPreviewWarning[] }) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300 mb-3">
        {t("components.sudoersSetupPanel.commandsOmittedForManualReview")}
      </h3>
      <div className="space-y-3">
        {warnings.map((warning) => (
          <div
            key={`${warning.id}-${warning.message}`}
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {warning.label}
              </span>
              {warning.pkgManager ? <Badge variant="warning" small>{warning.pkgManager}</Badge> : null}
            </div>
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{warning.message}</p>
            {warning.command ? <SudoersBlock content={warning.command} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SudoersSetupPanel({
  preview,
  showRootUserGuidance = true,
}: {
  preview: SudoersPreview;
  showRootUserGuidance?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t("components.sudoersSetupPanel.generatedFileDescription")}
        </p>
      </div>

      {showRootUserGuidance && preview.username === "root" ? (
        <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
          <p className="font-semibold">{t("components.sudoersSetupPanel.leastPrivilegeUserRecommended")}</p>
          <p className="mt-1">
            {t("components.sudoersSetupPanel.rootUserGuidancePrefix")} <code className="font-mono">root</code>. {t("components.sudoersSetupPanel.rootUserGuidanceSuffix")}
          </p>
        </div>
      ) : null}

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {preview.filePath}
          </h3>
          {preview.resolution === "resolved" ? <Badge variant="success" small>{t("components.sudoersSetupPanel.pathsResolved")}</Badge> : null}
          {preview.resolution === "fallback" ? <Badge variant="warning" small>{t("components.sudoersSetupPanel.templateOnly")}</Badge> : null}
        </div>
        <SudoersBlock content={preview.content} />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("components.sudoersSetupPanel.installOnTargetHost")}</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>{t("components.sudoersSetupPanel.open")} <code className="font-mono">sudo visudo -f {preview.filePath}</code>.</li>
          <li>{t("components.sudoersSetupPanel.pasteGeneratedContent")}</li>
          <li>{t("components.sudoersSetupPanel.run")} <code className="font-mono">sudo chmod 440 {preview.filePath}</code>.</li>
          <li>{t("components.sudoersSetupPanel.run")} <code className="font-mono">sudo visudo -cf {preview.filePath}</code>.</li>
        </ol>
      </div>

      <WarningList warnings={preview.warnings} />
    </div>
  );
}
