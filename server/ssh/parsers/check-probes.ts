import type { CheckCommandResult } from "./types";

/**
 * Run an optional read-only lookup. Both streams are captured so that informational
 * stderr, such as "No snaps are installed yet", is not displayed as an error. A failed
 * lookup's output goes to stderr only, which keeps it visible but away from the parser.
 */
export function optionalCheckProbe(command: string, statusMarker: string): string {
  return [
    "ludash_probe_status=0",
    `ludash_probe_output="$(${command} 2>&1)" || ludash_probe_status=$?`,
    `printf '\\n${statusMarker}:%s\\n' "$ludash_probe_status"`,
    'if [ "$ludash_probe_status" -eq 0 ]; then printf "%s\\n" "$ludash_probe_output"; else printf "%s\\n" "$ludash_probe_output" >&2; fi',
  ].join("\n");
}

/** Missing markers are allowed for older custom check scripts. */
export function checkProbeFailed(stdout: string, statusMarker: string): boolean {
  return stdout.split("\n").some((line) => {
    const prefix = `${statusMarker}:`;
    if (!line.startsWith(prefix)) return false;
    const status = line.slice(prefix.length).trim();
    return /^\d+$/.test(status) && Number(status) !== 0;
  });
}

export function anyCheckProbeFailed(commandResults: CheckCommandResult[], statusMarker: string): boolean {
  return commandResults.some((result) => checkProbeFailed(result.stdout, statusMarker));
}
