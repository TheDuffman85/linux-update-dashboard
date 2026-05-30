import { Badge } from "../Badge";
import { CopyableCodeBlock } from "../CopyableCodeBlock";
import { highlightShell } from "../../lib/shell-highlight";
import type { CommandReference, CommandReferenceWarning, PotentialCommandEntry } from "../../lib/systems";

function CommandBlock({ command }: { command: string }) {
  return (
    <CopyableCodeBlock
      text={command}
      className="script-code mt-3 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100 whitespace-pre-wrap break-all"
      successMessage="Copied command"
    >
      <code dangerouslySetInnerHTML={{ __html: highlightShell(command) }} />
    </CopyableCodeBlock>
  );
}

function PotentialCommandList({
  title,
  entries,
  sudoersUser,
  defaultExpanded = false,
}: {
  title: string;
  entries: PotentialCommandEntry[];
  sudoersUser?: string;
  defaultExpanded?: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <details open={defaultExpanded}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </summary>
      <div className="mt-3 space-y-4">
        {entries.map((entry) => {
          const command = sudoersUser
            ? `${sudoersUser} ALL=(root) NOPASSWD: ${entry.command}`
            : entry.command;
          return (
            <div key={`${title}-${entry.id}-${entry.command}`} className="rounded-lg border border-border bg-slate-50/70 dark:bg-slate-900/30 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.label}</span>
                {entry.pkgManager ? (
                  <Badge variant="muted" small>{entry.pkgManager}</Badge>
                ) : null}
                {entry.requiresWildcard ? (
                  <Badge variant="warning" small>package placeholder</Badge>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">Used for:</span>{" "}
                {entry.purpose}
              </p>
              <CommandBlock command={command} />
              {entry.warnings?.map((warning) => (
                <p key={warning} className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function PotentialCommandWarnings({ warnings }: { warnings: CommandReferenceWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300 mb-3">Review before allowing</h3>
      <div className="space-y-4">
        {warnings.map((warning) => (
          <div key={`${warning.id}-${warning.message}`} className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-amber-800 dark:text-amber-200">{warning.label}</span>
              {warning.pkgManager ? (
                <Badge variant="warning" small>{warning.pkgManager}</Badge>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{warning.message}</p>
            {warning.command ? <CommandBlock command={warning.command} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PotentialCommandsPanel({
  commandReference,
  sudoersUser,
}: {
  commandReference: CommandReference;
  sudoersUser: string;
}) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        This list is generated from the same backend command builders used at runtime.
      </p>
      <PotentialCommandList
        title="Sudoers-relevant commands"
        entries={commandReference.sudoers}
        sudoersUser={sudoersUser}
        defaultExpanded
      />
      <PotentialCommandWarnings warnings={commandReference.warnings ?? []} />
      <PotentialCommandList title="Exact remote commands" entries={commandReference.exact} />
    </div>
  );
}
