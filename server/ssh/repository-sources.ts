import { createHash } from "crypto";

/**
 * Repository source files (APT sources, yum/dnf .repo files, pacman.conf, ...)
 * for each built-in package manager.
 *
 * Reading runs as the SSH user without sudo: these files are world-readable
 * on every supported distribution. Paths and file contents are base64-encoded
 * on the remote side so arbitrary bytes cannot break the line framing.
 *
 * Writing goes through sudoedit, which needs one exact-path sudoers rule per
 * file and copies the new content in as root without following symlinks.
 */

export type RepositorySourceFormat = "apt-list" | "deb822" | "ini" | "plain";

export interface RepositorySourcePattern {
  /** Absolute path, optionally with a shell glob in the file name. */
  glob: string;
  format: RepositorySourceFormat;
  /** Whether matching files may be edited from the dashboard. */
  editable: boolean;
}

export type RepositorySourceEditBlockedReason =
  | "disabled"
  | "unsupported"
  | "unreadable"
  | "truncated"
  | "redacted"
  | "encoding"
  | "too_large"
  | "path";

export interface RepositorySourceFile {
  path: string;
  format: RepositorySourceFormat;
  pkgManagers: string[];
  readable: boolean;
  content: string | null;
  truncated: boolean;
  /** Credentials were masked before the content left the server. */
  redacted: boolean;
  /** SHA-256 of the file bytes; sent back on save to detect concurrent changes. */
  sha256: string | null;
  editable: boolean;
  editBlockedReason: RepositorySourceEditBlockedReason | null;
}

/** Maximum bytes returned per file; larger files are truncated. */
export const REPOSITORY_SOURCE_MAX_FILE_BYTES = 128 * 1024;
/**
 * Maximum size of an edited file. The base64 content travels as one exported
 * shell variable, which must stay below Linux's 128 KiB per-string exec limit.
 */
export const REPOSITORY_SOURCE_MAX_EDIT_BYTES = 64 * 1024;
/** Maximum number of files read in one request. */
export const REPOSITORY_SOURCE_MAX_FILES = 64;
/** Environment variable that carries the new file content to the write script. */
export const REPOSITORY_SOURCE_CONTENT_ENV = "LUDASH_REPOSITORY_SOURCE";

const REPOSITORY_SOURCE_PATTERNS: Record<string, RepositorySourcePattern[]> = {
  apt: [
    { glob: "/etc/apt/sources.list", format: "apt-list", editable: true },
    { glob: "/etc/apt/sources.list.d/*.list", format: "apt-list", editable: true },
    { glob: "/etc/apt/sources.list.d/*.sources", format: "deb822", editable: true },
  ],
  dnf: [
    { glob: "/etc/yum.repos.d/*.repo", format: "ini", editable: true },
    // Additional default reposdir entries used by dnf5. The /usr/share
    // directory holds vendor files that package updates overwrite.
    { glob: "/etc/distro.repos.d/*.repo", format: "ini", editable: true },
    { glob: "/usr/share/dnf5/repos.d/*.repo", format: "ini", editable: false },
  ],
  yum: [
    { glob: "/etc/yum.repos.d/*.repo", format: "ini", editable: true },
  ],
  pacman: [
    { glob: "/etc/pacman.conf", format: "ini", editable: true },
    { glob: "/etc/pacman.d/*mirrorlist", format: "ini", editable: true },
  ],
  apk: [
    { glob: "/etc/apk/repositories", format: "plain", editable: true },
    { glob: "/etc/apk/repositories.d/*.list", format: "plain", editable: true },
  ],
  // Flatpak remotes are managed with `flatpak remote-*`, not by editing files.
  flatpak: [
    { glob: "/var/lib/flatpak/repo/config", format: "ini", editable: false },
    { glob: "/etc/flatpak/remotes.d/*.flatpakrepo", format: "ini", editable: false },
  ],
};

const SAFE_GLOB = /^\/[A-Za-z0-9_.*+/-]+$/;
// Editable paths also end up verbatim in sudoers rules, so they stay plain.
const SAFE_EDIT_PATH = /^\/[A-Za-z0-9_.+/-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function getRepositorySourcePatterns(pkgManager: string): RepositorySourcePattern[] {
  return REPOSITORY_SOURCE_PATTERNS[pkgManager] ?? [];
}

export function supportsRepositorySources(pkgManager: string): boolean {
  return getRepositorySourcePatterns(pkgManager).length > 0;
}

export interface RepositorySourcePatternGroup {
  glob: string;
  format: RepositorySourceFormat;
  editable: boolean;
  pkgManagers: string[];
}

/** One entry per distinct glob, so managers sharing a directory read it once. */
export function groupRepositorySourcePatterns(pkgManagers: string[]): RepositorySourcePatternGroup[] {
  const groups = new Map<string, RepositorySourcePatternGroup>();
  for (const pkgManager of pkgManagers) {
    for (const pattern of getRepositorySourcePatterns(pkgManager)) {
      const existing = groups.get(pattern.glob);
      if (existing) {
        if (!existing.pkgManagers.includes(pkgManager)) existing.pkgManagers.push(pkgManager);
      } else {
        groups.set(pattern.glob, { ...pattern, pkgManagers: [pkgManager] });
      }
    }
  }
  return [...groups.values()];
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

export function isSafeRepositorySourceEditPath(path: string): boolean {
  return SAFE_EDIT_PATH.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..");
}

/** The pattern group an absolute path belongs to, for the given managers. */
export function findRepositorySourceGroup(
  path: string,
  pkgManagers: string[],
): RepositorySourcePatternGroup | null {
  return groupRepositorySourcePatterns(pkgManagers)
    .find((group) => globToRegExp(group.glob).test(path)) ?? null;
}

function assertSafeGlob(glob: string): void {
  if (!SAFE_GLOB.test(glob) || glob.split("/").includes("..")) {
    throw new Error(`Unsafe repository source path: ${glob}`);
  }
}

/**
 * Build the read-only listing command. Each matched regular file produces one
 * line: `F <group index> <base64 path> ok|unreadable <base64 content>`.
 */
export function buildRepositorySourcesCommand(groups: RepositorySourcePatternGroup[]): string {
  const lines = [
    "# Read repository source files as the SSH user (read-only).",
    "command -v base64 >/dev/null 2>&1 || { echo 'base64 is required to read repository sources' >&2; exit 127; }",
    "n=0",
  ];
  groups.forEach((group, index) => {
    assertSafeGlob(group.glob);
    lines.push(
      `for f in ${group.glob}; do`,
      '  [ -f "$f" ] || continue',
      `  [ "$n" -lt ${REPOSITORY_SOURCE_MAX_FILES} ] || break`,
      "  n=$((n + 1))",
      `  printf 'F\\t${index}\\t'`,
      "  printf '%s' \"$f\" | base64 | tr -d '\\n'",
      '  if [ -r "$f" ]; then',
      "    printf '\\tok\\t'",
      `    head -c ${REPOSITORY_SOURCE_MAX_FILE_BYTES + 1} "$f" | base64 | tr -d '\\n'`,
      "  else",
      "    printf '\\tunreadable\\t'",
      "  fi",
      "  printf '\\n'",
      "done",
    );
  });
  lines.push("exit 0");
  return lines.join("\n");
}

/**
 * Replace one existing repository source file with the content delivered in
 * $LUDASH_REPOSITORY_SOURCE (base64, read from stdin by the secret preamble).
 *
 * Root writes the file directly. Everyone else goes through sudoedit: it copies
 * the file to a temporary file owned by the SSH user, runs the "editor" (here a
 * throwaway script that overwrites that copy), and installs the result as root
 * while keeping the file's owner and mode.
 */
export function buildRepositorySourceWriteCommand(path: string): string {
  if (!isSafeRepositorySourceEditPath(path)) {
    throw new Error(`Unsafe repository source path: ${path}`);
  }
  const contentVar = `$${REPOSITORY_SOURCE_CONTENT_ENV}`;
  return [
    "# Replace one repository source file.",
    `target='${path}'`,
    'if [ ! -f "$target" ] || [ -L "$target" ]; then',
    '  echo "$target is not a regular file" >&2',
    "  exit 2",
    "fi",
    "dir=$(mktemp -d /tmp/ludash_XXXXXX) || exit 1",
    "trap 'rm -rf \"$dir\"' EXIT",
    `printf '%s' "${contentVar}" | base64 -d > "$dir/content" || { echo "Could not decode the new file content" >&2; exit 1; }`,
    `unset ${REPOSITORY_SOURCE_CONTENT_ENV}`,
    'if [ "$(id -u)" = "0" ]; then',
    '  cat "$dir/content" > "$target"',
    "elif command -v sudo >/dev/null 2>&1; then",
    "  # The editor replaces sudoedit's temporary copy (its last argument).",
    "  printf '%s\\n' '#!/bin/sh' 'for last; do :; done' 'cat \"${0%/*}/content\" > \"$last\"' > \"$dir/editor\"",
    "  # Sudoers-relevant command: sudoedit <path>",
    '  SUDO_EDITOR="/bin/sh $dir/editor" sudo -S -p \'\' -e "$target"',
    "else",
    '  echo "sudo is required to edit repository sources" >&2',
    "  exit 1",
    "fi",
    "rc=$?",
    'exit "$rc"',
  ].join("\n");
}

function decodeBase64(value: string): Buffer | null {
  if (!BASE64.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, "base64");
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const SECRET_ASSIGNMENT = /^(\s*[A-Za-z0-9_.-]*(?:password|passwd|token|secret)[A-Za-z0-9_.-]*\s*[=:][ \t]*)\S.*$/gim;

/** Mask URL credentials and password/token assignments. */
export function redactRepositorySourceContent(content: string): { content: string; redacted: boolean } {
  const redactedContent = content
    .replace(URL_USERINFO, "$1***@")
    .replace(SECRET_ASSIGNMENT, "$1***");
  return { content: redactedContent, redacted: redactedContent !== content };
}

function getEditBlockedReason(
  file: Omit<RepositorySourceFile, "editable" | "editBlockedReason">,
  group: RepositorySourcePatternGroup,
  rawBytes: Buffer | null,
  editingEnabled: boolean,
): RepositorySourceEditBlockedReason | null {
  if (!group.editable) return "unsupported";
  if (!editingEnabled) return "disabled";
  if (!isSafeRepositorySourceEditPath(file.path)) return "path";
  if (!file.readable || !rawBytes) return "unreadable";
  if (file.truncated) return "truncated";
  if (rawBytes.length > REPOSITORY_SOURCE_MAX_EDIT_BYTES) return "too_large";
  if (file.redacted) return "redacted";
  // Saving re-encodes the text as UTF-8, which must reproduce the file exactly.
  if (!Buffer.from(rawBytes.toString("utf8"), "utf8").equals(rawBytes)) return "encoding";
  return null;
}

export function parseRepositorySourcesOutput(
  stdout: string,
  groups: RepositorySourcePatternGroup[],
  options: { editingEnabled?: boolean } = {},
): RepositorySourceFile[] {
  const files = new Map<string, RepositorySourceFile>();
  for (const line of stdout.split("\n")) {
    const parts = line.replace(/\r$/, "").split("\t");
    if (parts[0] !== "F" || parts.length !== 5) continue;
    const group = groups[Number(parts[1])];
    const pathBytes = decodeBase64(parts[2]);
    if (!group || !pathBytes) continue;
    const path = pathBytes.toString("utf8");
    if (!path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) continue;

    const existing = files.get(path);
    if (existing) {
      for (const pkgManager of group.pkgManagers) {
        if (!existing.pkgManagers.includes(pkgManager)) existing.pkgManagers.push(pkgManager);
      }
      continue;
    }

    const readable = parts[3] === "ok";
    let rawBytes: Buffer | null = null;
    let content: string | null = null;
    let truncated = false;
    let redacted = false;
    if (readable) {
      const bytes = decodeBase64(parts[4]);
      if (!bytes) continue;
      truncated = bytes.length > REPOSITORY_SOURCE_MAX_FILE_BYTES;
      rawBytes = bytes.subarray(0, REPOSITORY_SOURCE_MAX_FILE_BYTES);
      const masked = redactRepositorySourceContent(rawBytes.toString("utf8"));
      content = masked.content;
      redacted = masked.redacted;
    }

    const file = {
      path,
      format: group.format,
      pkgManagers: [...group.pkgManagers],
      readable,
      content,
      truncated,
      redacted,
      sha256: rawBytes && !truncated ? sha256Hex(rawBytes) : null,
    };
    const editBlockedReason = getEditBlockedReason(file, group, rawBytes, options.editingEnabled ?? false);
    files.set(path, { ...file, editable: editBlockedReason === null, editBlockedReason });
  }
  return [...files.values()];
}

export interface RepositorySourceValidationError {
  line: number;
  message: string;
}

const APT_LIST_ENTRY = /^deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?\S+\s+\S+(?:\s+\S+)*$/;
const DEB822_FIELD = /^([A-Za-z0-9][A-Za-z0-9-]*):/;
const DEB822_REQUIRED_FIELDS = ["types", "uris", "suites"];

function validateAptList(lines: string[]): RepositorySourceValidationError | null {
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!APT_LIST_ENTRY.test(line)) {
      return {
        line: index + 1,
        message: "Expected \"deb [options] URI suite [component...]\" or \"deb-src ...\"",
      };
    }
  }
  return null;
}

function validateDeb822(lines: string[]): RepositorySourceValidationError | null {
  let stanzaStart = 0;
  let fields = new Set<string>();
  let hasField = false;
  const finishStanza = (): RepositorySourceValidationError | null => {
    if (!hasField) return null;
    const missing = DEB822_REQUIRED_FIELDS.filter((field) => !fields.has(field));
    return missing.length > 0
      ? { line: stanzaStart, message: `Entry is missing required field(s): ${missing.map((f) => f[0].toUpperCase() + f.slice(1)).join(", ")}` }
      : null;
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (!line.trim()) {
      const error = finishStanza();
      if (error) return error;
      fields = new Set();
      hasField = false;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (!hasField) return { line: lineNumber, message: "Continuation line without a field" };
      continue;
    }
    const match = DEB822_FIELD.exec(line);
    if (!match) return { line: lineNumber, message: "Expected \"Field: value\"" };
    if (!hasField) stanzaStart = lineNumber;
    hasField = true;
    fields.add(match[1].toLowerCase());
  }
  return finishStanza();
}

function validateIni(lines: string[]): RepositorySourceValidationError | null {
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith("[") && !/^\[[^\]]+\]$/.test(line)) {
      return { line: index + 1, message: "Expected a section header like \"[name]\"" };
    }
  }
  return null;
}

/** Light syntax check that catches obviously broken files before they are written. */
export function validateRepositorySourceContent(
  content: string,
  format: RepositorySourceFormat,
): RepositorySourceValidationError | null {
  if (content.includes("\0")) return { line: 1, message: "Content must not contain NUL bytes" };
  const lines = content.split("\n");
  if (format === "apt-list") return validateAptList(lines);
  if (format === "deb822") return validateDeb822(lines);
  if (format === "ini") return validateIni(lines);
  return null;
}
