import type { System } from "./systems";
import { getHostKeyStatusBadgeLabel } from "./host-key-status";

type SearchableSystem = Pick<System, "name" | "hostname" | "port" | "osName" | "isReachable"> &
  Partial<Pick<System, "hidden" | "osLifecycleStatus" | "osLifecycleLabel" | "hostKeyStatus" | "proxyJumpChain" | "needsReboot" | "packageIssueCount">>;

function hasLtsLifecycleLabel(system: Partial<Pick<System, "osLifecycleLabel">>): boolean {
  return /\bLTS\b/.test(system.osLifecycleLabel ?? "");
}

export function getLifecycleBadge(
  system: Partial<Pick<System, "osLifecycleStatus" | "osLifecycleLabel">>,
  t: (key: string) => string,
): { label: string; variant: "warning" | "danger" } | null {
  if (system.osLifecycleStatus === "eol") return { label: t("pages.systemDetail.lifecycle.eol"), variant: "danger" };
  if (system.osLifecycleStatus === "support_ended") {
    return {
      label: hasLtsLifecycleLabel(system)
        ? t("pages.systemDetail.lifecycle.lts")
        : t("pages.systemDetail.lifecycle.regularSupportEndedLower"),
      variant: "warning",
    };
  }
  if (system.osLifecycleStatus === "support_ending") {
    return {
      label: t("pages.systemDetail.lifecycle.securitySupportEndingSoonLower"),
      variant: "warning",
    };
  }
  if (system.osLifecycleStatus === "approaching_eol") {
    return {
      label: t("pages.systemDetail.lifecycle.eolSoon"),
      variant: "warning",
    };
  }
  return null;
}

export function filterSystems<T extends SearchableSystem>(
  systems: T[],
  search: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): T[] {
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLowerCase();
  const query = normalize(search);
  if (!query) return systems;
  return systems.filter((system) => {
    const lifecycleBadge = getLifecycleBadge(system, t);
    const proxyJump = system.proxyJumpChain?.[0];
    const values = [
      system.name,
      `${system.hostname}${system.port !== 22 ? `:${system.port}` : ""}`,
      system.osName,
      t(
        system.isReachable === 1
          ? "pages.systemsList.online"
          : system.isReachable === -1
            ? "pages.systemsList.offline"
            : "pages.systemsList.unknown",
      ),
      system.hidden === 1 ? t("pages.systemsList.hidden") : null,
      lifecycleBadge?.label,
      system.hostKeyStatus ? getHostKeyStatusBadgeLabel(system.hostKeyStatus, t) : null,
      proxyJump
        ? t("pages.systemsList.viaName", {
            name: proxyJump.name,
          })
        : null,
      system.needsReboot === 1 ? t("pages.systemsList.rebootRequired") : null,
      (system.packageIssueCount ?? 0) > 0
        ? t("pages.systemsList.pkgIssue")
        : null,
    ];
    return values.some((value) => value && normalize(value).includes(query));
  });
}
