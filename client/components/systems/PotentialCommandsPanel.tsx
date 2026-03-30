import { Badge } from "../Badge";
import type { CommandReference, PotentialCommandEntry } from "../../lib/systems";

function PotentialCommandList({
  title,
  entries,
}: {
  title: string;
  entries: PotentialCommandEntry[];
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">{title}</h3>
      <div className="space-y-4">
        {entries.map((entry) => (
          <div key={`${title}-${entry.id}-${entry.command}`} className="rounded-lg border border-border bg-slate-50/70 dark:bg-slate-900/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.label}</span>
              {entry.pkgManager ? (
                <Badge variant="muted" small>{entry.pkgManager}</Badge>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              <span className="font-medium">Used for:</span>{" "}
              {entry.purpose}
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100 whitespace-pre-wrap break-all">
              {entry.command}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PotentialCommandsPanel({
  commandReference,
}: {
  commandReference: CommandReference;
}) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        This list is generated from the same backend command builders used at runtime.
      </p>
      <PotentialCommandList title="Sudoers-relevant commands" entries={commandReference.sudoers} />
      <PotentialCommandList title="Exact remote commands" entries={commandReference.exact} />
    </div>
  );
}
