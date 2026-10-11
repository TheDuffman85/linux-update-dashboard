import type { Client } from "ssh2";
import type { SSHConnectionManager } from "../ssh/connection";
import { sanitizeOutput } from "../utils/sanitize";
import type {
  CommandReference,
  CommandReferenceWarning,
  PotentialCommandEntry,
} from "./command-reference";
import { getAppName } from "./branding-service";
import { listEditableRepositorySourcePaths } from "./repository-source-service";

export interface SudoersPreviewWarning extends CommandReferenceWarning {}

export interface SudoersPreview {
  username: string;
  filePath: string;
  required: boolean;
  resolution: "resolved" | "fallback";
  resolutionError: string | null;
  content: string;
  warnings: SudoersPreviewWarning[];
}

interface CommandParts {
  executable: string;
  args: string;
}

interface SudoersPreviewInput {
  username: string;
  commandReference: CommandReference;
  executablePaths?: Map<string, string>;
  resolution?: SudoersPreview["resolution"];
  resolutionError?: string | null;
  /**
   * Repository source files that may be edited with sudoedit. `null` means
   * editing is enabled but the files could not be listed; omit when disabled.
   */
  repositorySourcePaths?: string[] | null;
}

const SAFE_EXECUTABLE = /^[a-zA-Z0-9_+./-]+$/;
const PACKAGE_PLACEHOLDER_GROUP = /<package\d?>(?:\s+<package\d?>)*/g;

function sanitizeComment(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeSudoersFileSegment(username: string): string {
  const segment = username
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment && segment !== "." && segment !== ".." ? segment : "user";
}

function escapeSudoersUser(username: string): string {
  return username
    .replace(/\\/g, "\\\\")
    .replace(/([,:=()!#@\s])/g, "\\$1");
}

export function escapeSudoersArgs(args: string): string {
  return args
    .replace(/\\/g, "\\\\")
    .replace(/([,:=])/g, "\\$1");
}

function splitCommand(command: string): CommandParts | null {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim());
  if (!match) return null;
  const executable = match[1];
  if (!SAFE_EXECUTABLE.test(executable) || executable.startsWith("-")) {
    return null;
  }
  return {
    executable,
    args: match[2]?.trim() ?? "",
  };
}

function isSafeAbsoluteExecutable(value: string): boolean {
  return value.startsWith("/") && SAFE_EXECUTABLE.test(value);
}

function fallbackExecutable(executable: string): string {
  const basename = executable.split("/").filter(Boolean).at(-1) || "command";
  return `REPLACE_WITH_ABSOLUTE_PATH/${basename}`;
}

function resolveExecutable(
  executable: string,
  executablePaths: Map<string, string> | undefined,
): string {
  if (executable.startsWith("/")) return executable;
  return executablePaths?.get(executable) || fallbackExecutable(executable);
}

function selectedPackageCommand(command: string): string {
  return command.replace(PACKAGE_PLACEHOLDER_GROUP, "*");
}

function isOptionalHostCommand(entry: PotentialCommandEntry): boolean {
  return entry.category === "reboot" &&
    entry.command === "pvesh get /cluster/tasks --output-format json";
}

function formatRule(
  username: string,
  entry: PotentialCommandEntry,
  executablePaths: Map<string, string> | undefined,
): string | null {
  const command = entry.requiresWildcard
    ? selectedPackageCommand(entry.command)
    : entry.command;
  const parts = splitCommand(command);
  if (!parts) return null;
  if (
    isOptionalHostCommand(entry) &&
    executablePaths &&
    !parts.executable.startsWith("/") &&
    !executablePaths.has(parts.executable)
  ) {
    return null;
  }

  const executable = resolveExecutable(parts.executable, executablePaths);
  const args = parts.args ? escapeSudoersArgs(parts.args) : '""';
  return `${escapeSudoersUser(username)} ALL=(root) NOPASSWD: ${executable} ${args}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function buildRepositorySourceSection(
  username: string,
  paths: string[] | null | undefined,
): string[] {
  if (paths === undefined) return [];
  const header = [
    "",
    "# WARNING: Repository source editing is disabled until you uncomment rules below.",
    "# Writing repository sources is root-equivalent: a changed repository can ship",
    "# packages that run code as root during the next upgrade. Uncomment only the",
    "# files you want to edit from the dashboard.",
  ];
  if (paths === null) {
    return [
      ...header,
      "# Could not list the repository source files on this host. Add one rule per file:",
      `# ${escapeSudoersUser(username)} ALL=(root) NOPASSWD: sudoedit /absolute/path/to/file`,
    ];
  }
  if (paths.length === 0) {
    return [...header, "# No editable repository source files were found on this host."];
  }
  return [
    ...header,
    ...paths.map((path) => `# ${escapeSudoersUser(username)} ALL=(root) NOPASSWD: sudoedit ${escapeSudoersArgs(path)}`),
  ];
}

function buildContent(
  username: string,
  commandReference: CommandReference,
  executablePaths: Map<string, string> | undefined,
  resolution: SudoersPreview["resolution"],
  resolutionError: string | null,
  repositorySourcePaths: string[] | null | undefined,
): string {
  const header = [
    `# Generated by ${getAppName()}.`,
    "# Review this least-privilege allowlist before installing it.",
  ];
  if (resolution === "fallback") {
    header.push(
      "# WARNING: NOT PASTE-READY. Replace every REPLACE_WITH_ABSOLUTE_PATH entry first.",
    );
    if (resolutionError) {
      header.push(`# Path resolution failed: ${sanitizeComment(resolutionError)}`);
    }
  }

  const isReadOnlyWildcard = (entry: PotentialCommandEntry) =>
    entry.sudoersSafety === "read_only_wildcard";
  const rules = dedupe(commandReference.sudoers
    .filter((entry) => !entry.requiresWildcard && !isReadOnlyWildcard(entry))
    .map((entry) => formatRule(
      username,
      entry,
      executablePaths,
    ))
    .filter((rule): rule is string => !!rule));
  const readOnlyRules = dedupe(commandReference.sudoers
    .filter(isReadOnlyWildcard)
    .map((entry) => formatRule(
      username,
      entry,
      executablePaths,
    ))
    .filter((rule): rule is string => !!rule));
  const selectedPackageRules = dedupe(commandReference.sudoers
    .filter((entry) => entry.requiresWildcard)
    .map((entry) => formatRule(
      username,
      entry,
      executablePaths,
    ))
    .filter((rule): rule is string => !!rule));
  const readOnlySection = readOnlyRules.length > 0
    ? [
        "",
        "# Read-only lookups. The argument wildcard only selects which items are shown;",
        "# these commands do not change the system.",
        ...readOnlyRules,
      ]
    : [];
  const selectedPackageSection = selectedPackageRules.length > 0
    ? [
        "",
        "# WARNING: Selected-package upgrades are disabled by default.",
        "# Uncomment only the rules you need. Each wildcard broadens the allowed command arguments.",
        ...selectedPackageRules.map((rule) => `# ${rule}`),
      ]
    : [];

  const envKeep = commandReference.envKeep ?? [];
  const envKeepSection = envKeep.length > 0
    ? [
        "# Secret environment variables are passed through sudo by name only;",
        "# their values never appear in a command line.",
        ...envKeep.map((entry) =>
          `# ${entry.envVar}: ${sanitizeComment(entry.pkgManager)} config entry ${sanitizeComment(entry.key)}`),
        `Defaults:${escapeSudoersUser(username)} env_keep += "${envKeep.map((entry) => entry.envVar).join(" ")}"`,
      ]
    : [];

  return [
    ...header,
    "",
    `Defaults:${escapeSudoersUser(username)} !requiretty`,
    ...envKeepSection,
    "",
    ...rules,
    ...readOnlySection,
    ...selectedPackageSection,
    ...buildRepositorySourceSection(username, repositorySourcePaths),
  ].join("\n") + "\n";
}

function invalidCommandWarnings(commandReference: CommandReference): SudoersPreviewWarning[] {
  return commandReference.sudoers.flatMap((entry) => {
    if (splitCommand(entry.command)) return [];
    return [{
      id: `${entry.id}:invalid-executable`,
      category: entry.category,
      label: entry.label,
      pkgManager: entry.pkgManager,
      message: "Could not derive a safe executable name for this command, so it was omitted from the generated sudoers file.",
      command: entry.command,
    }];
  });
}

export function listSudoersExecutables(commandReference: CommandReference): string[] {
  return dedupe(commandReference.sudoers.flatMap((entry) => {
    const parts = splitCommand(entry.command);
    if (!parts || parts.executable.startsWith("/")) return [];
    return [parts.executable];
  }));
}

function listRequiredSudoersExecutables(commandReference: CommandReference): string[] {
  return dedupe(commandReference.sudoers.flatMap((entry) => {
    const parts = splitCommand(entry.command);
    if (!parts || parts.executable.startsWith("/") || isOptionalHostCommand(entry)) return [];
    return [parts.executable];
  }));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildExecutablePathLookupCommand(executables: string[]): string {
  return executables
    .map((executable) => [
      `resolved=$(command -v ${shellSingleQuote(executable)} 2>/dev/null || true)`,
      `printf '%s\\t%s\\n' ${shellSingleQuote(executable)} "$resolved"`,
    ].join("; "))
    .join("; ");
}

export function parseExecutablePathLookupOutput(output: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const executable = line.slice(0, separator);
    const path = line.slice(separator + 1).trim();
    if (isSafeAbsoluteExecutable(path)) paths.set(executable, path);
  }
  return paths;
}

export function buildSudoersPreview({
  username,
  commandReference,
  executablePaths,
  resolution = "resolved",
  resolutionError = null,
  repositorySourcePaths,
}: SudoersPreviewInput): SudoersPreview {
  const filePath = `/etc/sudoers.d/linux-update-dashboard-${sanitizeSudoersFileSegment(username)}`;
  const warnings = [
    ...commandReference.warnings,
    ...invalidCommandWarnings(commandReference),
  ];

  return {
    username,
    filePath,
    required: true,
    resolution,
    resolutionError,
    content: buildContent(
      username,
      commandReference,
      executablePaths,
      resolution,
      resolutionError,
      repositorySourcePaths,
    ),
    warnings,
  };
}

export async function resolveSudoersPreview(
  username: string,
  commandReference: CommandReference,
  sshManager: SSHConnectionManager,
  system: Record<string, unknown>,
  context: { systemId: number },
): Promise<SudoersPreview> {
  const repositorySourceEditing = system.repositorySourceEditingEnabled === 1;
  let conn: Client | null = null;
  try {
    conn = await sshManager.connect(system, context);
    const executables = listSudoersExecutables(commandReference);
    const lookupCommand = buildExecutablePathLookupCommand(executables);
    const result = lookupCommand
      ? await sshManager.runCommand(conn, lookupCommand, 10)
      : { stdout: "", stderr: "", exitCode: 0 };
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Executable path lookup exited with code ${result.exitCode}`);
    }

    let repositorySourcePaths: string[] | null | undefined;
    if (repositorySourceEditing) {
      repositorySourcePaths = await listEditableRepositorySourcePaths(
        system as Parameters<typeof listEditableRepositorySourcePaths>[0],
        sshManager,
        conn,
      ).catch(() => null);
    }

    const executablePaths = parseExecutablePathLookupOutput(result.stdout);
    const unresolved = listRequiredSudoersExecutables(commandReference)
      .filter((executable) => !executablePaths.has(executable));
    if (unresolved.length > 0) {
      return buildSudoersPreview({
        username,
        commandReference,
        executablePaths,
        resolution: "fallback",
        resolutionError: `Could not resolve: ${unresolved.join(", ")}`,
        repositorySourcePaths,
      });
    }

    return buildSudoersPreview({
      username,
      commandReference,
      executablePaths,
      repositorySourcePaths,
    });
  } catch (error) {
    return buildSudoersPreview({
      username,
      commandReference,
      resolution: "fallback",
      resolutionError: sanitizeOutput(error instanceof Error ? error.message : String(error)),
      repositorySourcePaths: repositorySourceEditing ? null : undefined,
    });
  } finally {
    if (conn) sshManager.disconnect(conn);
  }
}
