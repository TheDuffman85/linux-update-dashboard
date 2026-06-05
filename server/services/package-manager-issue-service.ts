import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { packageManagerIssues, systems } from "../db/schema";
import { getDnfLikeRepoKeyPromptMessage, hasDnfLikeRepoKeyPrompt } from "../ssh/parsers/dnf";
import { sudo } from "../ssh/parsers/types";

export type PackageManagerIssueKey =
  | "apt_dpkg_interrupted"
  | "dnf_repo_key_prompt"
  | "yum_repo_key_prompt"
  | "custom_issue_detected";

export type PackageManagerIssueRow = typeof packageManagerIssues.$inferSelect;

export interface PackageManagerIssueInput {
  pkgManager: string;
  issueKey: PackageManagerIssueKey;
  title: string;
  message: string;
  repairCommand: string | null;
}

export class PackageIssueDismissalSnapshotRequiredError extends Error {
  constructor() {
    super("Run a system check before dismissing this package manager warning.");
    this.name = "PackageIssueDismissalSnapshotRequiredError";
  }
}

const APT_DPKG_INTERRUPTED_PATTERN =
  /(dpkg was interrupted|dpkg --configure -a|manually run ['"`]?(?:sudo\s+)?dpkg --configure -a)/i;

export function getAptDpkgInterruptedRepairCommand(): string {
  return `export DEBIAN_FRONTEND=noninteractive; ${sudo("dpkg --configure -a")} 2>&1`;
}

export function detectPackageManagerIssue(
  pkgManager: string,
  output: string,
): PackageManagerIssueInput | null {
  if (pkgManager === "apt" && APT_DPKG_INTERRUPTED_PATTERN.test(output)) {
    return {
      pkgManager,
      issueKey: "apt_dpkg_interrupted",
      title: "APT needs repair",
      message:
        "dpkg was interrupted. Run dpkg --configure -a to finish pending package configuration before checking for updates again.",
      repairCommand: getAptDpkgInterruptedRepairCommand(),
    };
  }

  if ((pkgManager === "dnf" || pkgManager === "yum") && hasDnfLikeRepoKeyPrompt(output)) {
    return {
      pkgManager,
      issueKey: pkgManager === "dnf" ? "dnf_repo_key_prompt" : "yum_repo_key_prompt",
      title: `${pkgManager.toUpperCase()} repository key needs trust`,
      message: getDnfLikeRepoKeyPromptMessage(pkgManager),
      repairCommand: `${pkgManager} -y check-update --quiet`,
    };
  }

  return null;
}

export function detectCustomPackageManagerIssue(
  pkgManager: string,
  label: string,
  config: {
    issueRegex?: string;
    issueTitle?: string;
    issueMessage?: string;
  } | null | undefined,
  output: string,
): PackageManagerIssueInput | null {
  const source = config?.issueRegex?.trim();
  if (!source) return null;
  const configuredTitle = config?.issueTitle?.trim();
  const configuredMessage = config?.issueMessage?.trim();

  let match: RegExpExecArray | null = null;
  try {
    match = new RegExp(source, "im").exec(output);
  } catch {
    return null;
  }
  if (!match) return null;

  const title = match.groups?.title?.trim() || configuredTitle || `${label} needs repair`;
  const message =
    match.groups?.message?.trim() ||
    configuredMessage ||
    `${label} reported a package manager issue. Run the configured repair action, then refresh updates.`;

  return {
    pkgManager,
    issueKey: "custom_issue_detected",
    title,
    message,
    repairCommand: null,
  };
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function dismissalExpired(
  issue: {
    dismissedAt?: string | null;
    dismissedBootId?: string | null;
    dismissedUptimeSeconds?: number | null;
  },
  system: {
    bootId?: string | null;
    uptimeSeconds?: number | null;
  },
): boolean {
  if (!issue.dismissedAt && !issue.dismissedBootId && issue.dismissedUptimeSeconds == null) {
    return false;
  }

  const dismissedBootId = issue.dismissedBootId?.trim() || "";
  const currentBootId = system.bootId?.trim() || "";
  if (dismissedBootId && currentBootId && dismissedBootId !== currentBootId) {
    return true;
  }

  return (
    issue.dismissedUptimeSeconds != null &&
    system.uptimeSeconds != null &&
    system.uptimeSeconds < issue.dismissedUptimeSeconds
  );
}

function clearExpiredDismissals(systemId: number): void {
  const db = getDb();
  const system = db
    .select({
      bootId: systems.bootId,
      uptimeSeconds: systems.uptimeSeconds,
    })
    .from(systems)
    .where(eq(systems.id, systemId))
    .get();
  if (!system) return;

  const rows = db
    .select()
    .from(packageManagerIssues)
    .where(eq(packageManagerIssues.systemId, systemId))
    .all();
  const now = nowSql();
  for (const issue of rows) {
    if (!dismissalExpired(issue, system)) continue;
    db.update(packageManagerIssues)
      .set({
        dismissedBootId: null,
        dismissedUptimeSeconds: null,
        dismissedAt: null,
        updatedAt: now,
      })
      .where(eq(packageManagerIssues.id, issue.id))
      .run();
  }
}

export function upsertPackageManagerIssue(
  systemId: number,
  issue: PackageManagerIssueInput,
): PackageManagerIssueRow {
  const db = getDb();
  const now = nowSql();

  db.insert(packageManagerIssues)
    .values({
      systemId,
      pkgManager: issue.pkgManager,
      issueKey: issue.issueKey,
      title: issue.title,
      message: issue.message,
      repairCommand: issue.repairCommand,
      active: 1,
      detectedAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        packageManagerIssues.systemId,
        packageManagerIssues.pkgManager,
        packageManagerIssues.issueKey,
      ],
      set: {
        title: issue.title,
        message: issue.message,
        repairCommand: issue.repairCommand,
        active: 1,
        lastSeenAt: now,
        resolvedAt: null,
        updatedAt: now,
      },
    })
    .run();

  return db
    .select()
    .from(packageManagerIssues)
    .where(
      and(
        eq(packageManagerIssues.systemId, systemId),
        eq(packageManagerIssues.pkgManager, issue.pkgManager),
        eq(packageManagerIssues.issueKey, issue.issueKey),
      ),
    )
    .get()!;
}

export function resolvePackageManagerIssuesForManager(
  systemId: number,
  pkgManager: string,
): void {
  const now = nowSql();
  getDb()
    .update(packageManagerIssues)
    .set({
      active: 0,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(packageManagerIssues.systemId, systemId),
        eq(packageManagerIssues.pkgManager, pkgManager),
        ne(packageManagerIssues.active, 0),
      ),
    )
    .run();
}

export function getPackageManagerIssue(
  systemId: number,
  issueId: number,
): PackageManagerIssueRow | null {
  return getDb()
    .select()
    .from(packageManagerIssues)
    .where(
      and(
        eq(packageManagerIssues.systemId, systemId),
        eq(packageManagerIssues.id, issueId),
      ),
    )
    .get() ?? null;
}

export function listVisiblePackageManagerIssues(systemId: number): PackageManagerIssueRow[] {
  clearExpiredDismissals(systemId);
  return getDb()
    .select()
    .from(packageManagerIssues)
    .where(
      and(
        eq(packageManagerIssues.systemId, systemId),
        eq(packageManagerIssues.active, 1),
        sql`${packageManagerIssues.dismissedAt} IS NULL`,
      ),
    )
    .all();
}

export function getVisiblePackageManagerIssueCounts(systemIds: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const systemId of systemIds) {
    counts.set(systemId, listVisiblePackageManagerIssues(systemId).length);
  }
  return counts;
}

export function dismissPackageManagerIssue(systemId: number, issueId: number): void {
  const db = getDb();
  const issue = getPackageManagerIssue(systemId, issueId);
  if (!issue || issue.active !== 1) {
    throw new Error("Package manager issue not found");
  }
  const system = db
    .select({
      bootId: systems.bootId,
      uptimeSeconds: systems.uptimeSeconds,
    })
    .from(systems)
    .where(eq(systems.id, systemId))
    .get();
  if (!system) throw new Error("System not found");

  const bootId = system.bootId?.trim() || "";
  const uptimeSeconds = system.uptimeSeconds ?? null;
  if (!bootId && uptimeSeconds == null) {
    throw new PackageIssueDismissalSnapshotRequiredError();
  }

  const now = nowSql();
  db.update(packageManagerIssues)
    .set({
      dismissedBootId: bootId || null,
      dismissedUptimeSeconds: uptimeSeconds,
      dismissedAt: now,
      updatedAt: now,
    })
    .where(eq(packageManagerIssues.id, issueId))
    .run();
}
