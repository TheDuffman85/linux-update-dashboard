import type { Client } from "ssh2";
import type { SSHConnectionManager } from "../ssh/connection";
import { SecretInput } from "../ssh/secret-input";
import {
  REPOSITORY_SOURCE_CONTENT_ENV,
  REPOSITORY_SOURCE_MAX_EDIT_BYTES,
  buildRepositorySourceWriteCommand,
  buildRepositorySourcesCommand,
  findRepositorySourceGroup,
  groupRepositorySourcePatterns,
  isSafeRepositorySourceEditPath,
  parseRepositorySourcesOutput,
  redactRepositorySourceContent,
  sha256Hex,
  supportsRepositorySources,
  validateRepositorySourceContent,
  type RepositorySourceFile,
  type RepositorySourcePatternGroup,
} from "../ssh/repository-sources";
import { buildUnifiedDiff } from "../utils/line-diff";
import { sanitizeOutput } from "../utils/sanitize";
import { getActivePkgManagers, getSudoPassword } from "./system-service";
import { recordRepositorySourceEdit } from "./update-service";

export interface RepositorySourcesResult {
  /** Active managers whose repository sources were read. */
  pkgManagers: string[];
  /** Active managers without known repository source files (e.g. snap, custom managers). */
  unsupportedPkgManagers: string[];
  /** Whether editing is turned on for this system. */
  editingEnabled: boolean;
  files: RepositorySourceFile[];
  fetchedAt: string;
}

type RepositorySourceSystem = Record<string, unknown> & {
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
  pkgManager: string | null;
  repositorySourceEditingEnabled?: number | null;
};

/** An error with the HTTP status the route should answer with. */
export class RepositorySourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function isEditingEnabled(system: RepositorySourceSystem): boolean {
  return system.repositorySourceEditingEnabled === 1;
}

function currentTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

async function readFiles(
  sshManager: SSHConnectionManager,
  conn: Client,
  groups: RepositorySourcePatternGroup[],
  editingEnabled: boolean,
): Promise<RepositorySourceFile[]> {
  const output = await sshManager.runCommand(conn, buildRepositorySourcesCommand(groups), 30);
  if (output.exitCode !== 0) {
    throw new Error(output.stderr.trim() || `Reading repository sources exited with code ${output.exitCode}`);
  }
  return parseRepositorySourcesOutput(output.stdout, groups, { editingEnabled });
}

export async function fetchRepositorySources(
  system: RepositorySourceSystem,
  sshManager: SSHConnectionManager,
  context: { systemId: number },
): Promise<RepositorySourcesResult> {
  const activeManagers = getActivePkgManagers(system);
  const pkgManagers = activeManagers.filter(supportsRepositorySources);
  const unsupportedPkgManagers = activeManagers.filter((manager) => !supportsRepositorySources(manager));
  const editingEnabled = isEditingEnabled(system);
  const result = (files: RepositorySourceFile[]): RepositorySourcesResult => ({
    pkgManagers,
    unsupportedPkgManagers,
    editingEnabled,
    files,
    fetchedAt: new Date().toISOString(),
  });
  if (pkgManagers.length === 0) return result([]);

  let conn: Client | null = null;
  try {
    conn = await sshManager.connect(system, context);
    return result(await readFiles(sshManager, conn, groupRepositorySourcePatterns(pkgManagers), editingEnabled));
  } finally {
    if (conn) sshManager.disconnect(conn);
  }
}

/** Paths of the editable files that exist on the host, for sudoedit rules. */
export async function listEditableRepositorySourcePaths(
  system: RepositorySourceSystem,
  sshManager: SSHConnectionManager,
  conn: Client,
): Promise<string[]> {
  const pkgManagers = getActivePkgManagers(system).filter(supportsRepositorySources);
  const groups = groupRepositorySourcePatterns(pkgManagers).filter((group) => group.editable);
  if (groups.length === 0) return [];
  const files = await readFiles(sshManager, conn, groups, true);
  return files
    .map((file) => file.path)
    .filter(isSafeRepositorySourceEditPath);
}

export interface SaveRepositorySourceInput {
  path: string;
  content: string;
  /** SHA-256 of the file as it was loaded for editing. */
  baseSha256: string;
  /** Validate and diff against the host without writing. */
  dryRun?: boolean;
}

export interface SaveRepositorySourceResult {
  file: RepositorySourceFile;
  changed: boolean;
  /** Unified diff from the current file to the new content (credentials masked). */
  diff: string;
}

function normalizeContent(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  return normalized && !normalized.endsWith("\n") ? `${normalized}\n` : normalized;
}

export async function saveRepositorySource(
  system: RepositorySourceSystem,
  input: SaveRepositorySourceInput,
  sshManager: SSHConnectionManager,
  context: { systemId: number },
): Promise<SaveRepositorySourceResult> {
  if (!isEditingEnabled(system)) {
    throw new RepositorySourceError("Repository source editing is disabled for this system", 403);
  }
  const pkgManagers = getActivePkgManagers(system).filter(supportsRepositorySources);
  const group = isSafeRepositorySourceEditPath(input.path)
    ? findRepositorySourceGroup(input.path, pkgManagers)
    : null;
  if (!group || !group.editable) {
    throw new RepositorySourceError("This path is not an editable repository source for this system", 400);
  }

  const content = normalizeContent(input.content);
  const newBytes = Buffer.from(content, "utf8");
  if (newBytes.length > REPOSITORY_SOURCE_MAX_EDIT_BYTES) {
    throw new RepositorySourceError(
      `Repository source files can be at most ${REPOSITORY_SOURCE_MAX_EDIT_BYTES / 1024} KiB`,
      400,
    );
  }
  const validationError = validateRepositorySourceContent(content, group.format);
  if (validationError) {
    throw new RepositorySourceError(
      `Line ${validationError.line}: ${validationError.message}`,
      400,
      { line: validationError.line },
    );
  }

  const singleFile: RepositorySourcePatternGroup[] = [{ ...group, glob: input.path }];
  const pkgManager = group.pkgManagers[0];
  const startedAt = currentTimestamp();
  const writeCommand = buildRepositorySourceWriteCommand(input.path);
  let conn: Client | null = null;
  try {
    try {
      conn = await sshManager.connect(system, context);
    } catch (error) {
      throw new RepositorySourceError(errorMessage(error), 502);
    }

    const [current] = await readFiles(sshManager, conn, singleFile, true);
    if (!current) {
      throw new RepositorySourceError("The file no longer exists on the host", 404);
    }
    if (!current.editable || current.content === null) {
      throw new RepositorySourceError("This file cannot be edited from the dashboard", 409, {
        reason: current.editBlockedReason,
      });
    }
    if (current.sha256 !== input.baseSha256) {
      throw new RepositorySourceError(
        "The file changed on the host since it was loaded. Reload it and apply your changes again.",
        409,
        { reason: "conflict" },
      );
    }
    if (current.content === content) {
      return { file: current, changed: false, diff: "" };
    }

    const diff = redactRepositorySourceContent(buildUnifiedDiff(input.path, current.content, content)).content;
    if (input.dryRun) {
      return { file: current, changed: true, diff };
    }
    const failure = (message: string): RepositorySourceError => {
      recordRepositorySourceEdit(context.systemId, pkgManager, "failed", {
        path: input.path,
        command: writeCommand,
        diff,
        error: message,
        startedAt,
      });
      return new RepositorySourceError(message, 502);
    };

    const write = await sshManager.runCommand(
      conn,
      writeCommand,
      60,
      getSudoPassword(system),
      undefined,
      null,
      {
        secretInput: new SecretInput([{
          envVar: REPOSITORY_SOURCE_CONTENT_ENV,
          value: newBytes.toString("base64"),
        }]),
      },
    );
    if (write.exitCode !== 0) {
      throw failure(sanitizeOutput(write.stderr.trim() || write.stdout.trim() || `Writing the file exited with code ${write.exitCode}`));
    }

    // sudoedit can exit 0 without writing, e.g. when sudoers overrides the editor.
    const [updated] = await readFiles(sshManager, conn, singleFile, true);
    if (!updated || updated.sha256 !== sha256Hex(newBytes)) {
      throw failure("The file content did not change on the host. Check that sudo allows sudoedit for this path.");
    }

    recordRepositorySourceEdit(context.systemId, pkgManager, "success", {
      path: input.path,
      command: writeCommand,
      diff,
      startedAt,
    });
    return { file: updated, changed: true, diff };
  } catch (error) {
    if (error instanceof RepositorySourceError) throw error;
    throw new RepositorySourceError(errorMessage(error), 502);
  } finally {
    if (conn) sshManager.disconnect(conn);
  }
}

function errorMessage(error: unknown): string {
  return sanitizeOutput(error instanceof Error ? error.message : String(error));
}
