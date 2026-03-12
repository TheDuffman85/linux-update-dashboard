import { execSync } from "child_process";
import { readFileSync } from "fs";

const UPDATE_CHECK_CACHE_MS = 60 * 60 * 1000;
const DEV_TAG_PATTERN = /^dev-\d{12}$/;
const USER_AGENT = "linux-update-dashboard-update-check";

export interface AppUpdateStatus {
  updateAvailable: boolean;
  currentVersion: string | null;
  currentBranch: string;
  remoteVersion: string | null;
  releaseUrl: string | null;
  repoUrl: string | null;
  reason?: string;
}

let cachedStatus: { checkedAt: number; data: AppUpdateStatus } | null = null;

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function normalizeRepository(input: string): { slug: string; repoUrl: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  if (!trimmed) return null;

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return {
      slug: trimmed,
      repoUrl: `https://github.com/${trimmed}`,
    };
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+\/.+)$/);
  if (sshMatch) {
    return {
      slug: sshMatch[1],
      repoUrl: `https://github.com/${sshMatch[1]}`,
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    const slug = url.pathname.replace(/^\/+/, "");
    if (!/^[^/]+\/[^/]+$/.test(slug)) return null;
    return {
      slug,
      repoUrl: `https://github.com/${slug}`,
    };
  } catch {
    return null;
  }
}

function getRepositoryMetadata(): { slug: string; repoUrl: string } | null {
  const candidates = [
    process.env.LUDASH_APP_REPOSITORY,
    process.env.VITE_APP_REPOSITORY,
    process.env.GITHUB_REPOSITORY,
    process.env.LUDASH_APP_REPO_URL,
    process.env.VITE_APP_REPO_URL,
    git("config --get remote.origin.url"),
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    const normalized = normalizeRepository(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function getCurrentBranch(): string {
  return (
    process.env.LUDASH_APP_BRANCH ||
    process.env.VITE_APP_BRANCH ||
    git("rev-parse --abbrev-ref HEAD") ||
    "main"
  );
}

function readPackageVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync("./package.json", "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function getCurrentVersion(): string | null {
  const version =
    process.env.LUDASH_APP_VERSION ||
    process.env.VITE_APP_VERSION ||
    git("describe --tags --exact-match") ||
    git("describe --tags --abbrev=0") ||
    readPackageVersion() ||
    null;
  return version && version.trim() ? version.trim() : null;
}

async function fetchJson(url: string, headers?: HeadersInit): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      ...headers,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

async function fetchLatestDevVersion(slug: string): Promise<string | null> {
  try {
    const tokenData = await fetchJson(
      `https://ghcr.io/token?scope=repository:${slug}:pull`,
      { Accept: "application/json" }
    );
    const token = typeof tokenData?.token === "string" ? tokenData.token : "";
    if (!token) return null;

    const tagsData = await fetchJson(`https://ghcr.io/v2/${slug}/tags/list`, {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });

    const tags = Array.isArray(tagsData?.tags) ? tagsData.tags : [];
    const devTags = tags
      .filter(
        (tag: unknown): tag is string =>
          typeof tag === "string" && DEV_TAG_PATTERN.test(tag)
      )
      .sort();

    return devTags.length > 0 ? devTags[devTags.length - 1].replace(/^dev-/, "") : null;
  } catch {
    const runsData = await fetchJson(
      `https://api.github.com/repos/${slug}/actions/workflows/dev-build.yml/runs?branch=dev&status=success&per_page=1`
    );
    const latestRun = Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs[0] : null;
    if (!latestRun) return null;

    const runDate = new Date(latestRun.run_started_at || latestRun.created_at);
    if (Number.isNaN(runDate.getTime())) return null;

    return `${runDate.getUTCFullYear()}${String(runDate.getUTCMonth() + 1).padStart(2, "0")}${String(runDate.getUTCDate()).padStart(2, "0")}${String(runDate.getUTCHours()).padStart(2, "0")}${String(runDate.getUTCMinutes()).padStart(2, "0")}`;
  }
}

export async function getAppUpdateStatus(force = false): Promise<AppUpdateStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - cachedStatus.checkedAt < UPDATE_CHECK_CACHE_MS) {
    return cachedStatus.data;
  }

  const repo = getRepositoryMetadata();
  const currentBranch = getCurrentBranch();
  const currentVersion = getCurrentVersion();

  const fallback = (reason: string): AppUpdateStatus => ({
    updateAvailable: false,
    currentVersion,
    currentBranch,
    remoteVersion: null,
    releaseUrl: null,
    repoUrl: repo?.repoUrl ?? null,
    reason,
  });

  if (!repo) {
    const data = fallback("missing_repository");
    cachedStatus = { checkedAt: now, data };
    return data;
  }

  try {
    let data: AppUpdateStatus;

    if (currentBranch === "dev") {
      const remoteVersion = await fetchLatestDevVersion(repo.slug);
      const normalizedCurrent = currentVersion || "";
      data = {
        updateAvailable:
          Boolean(remoteVersion) &&
          DEV_TAG_PATTERN.test(normalizedCurrent) &&
          remoteVersion! > normalizedCurrent.replace(/^dev-/, ""),
        currentVersion,
        currentBranch,
        remoteVersion,
        releaseUrl: null,
        repoUrl: repo.repoUrl,
      };
    } else {
      const release = await fetchJson(
        `https://api.github.com/repos/${repo.slug}/releases/latest`
      );
      const latestVersion =
        typeof release?.tag_name === "string"
          ? release.tag_name.replace(/^v/i, "").trim()
          : null;
      const normalizedCurrent = currentVersion?.replace(/^v/i, "").trim() || null;

      data = {
        updateAvailable:
          Boolean(latestVersion) && Boolean(normalizedCurrent) && latestVersion !== normalizedCurrent,
        currentVersion: normalizedCurrent,
        currentBranch,
        remoteVersion: latestVersion,
        releaseUrl:
          typeof release?.html_url === "string" ? release.html_url : null,
        repoUrl: repo.repoUrl,
      };
    }

    cachedStatus = { checkedAt: now, data };
    return data;
  } catch {
    const data = fallback("update_check_failed");
    cachedStatus = { checkedAt: now, data };
    return data;
  }
}

export function resetAppUpdateStatusCache(): void {
  cachedStatus = null;
}
