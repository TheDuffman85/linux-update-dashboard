import distroLifecycleData from "./generated/distro-lifecycle-data.json";

export type OsLifecycleStatus =
  | "supported"
  | "support_ending"
  | "support_ended"
  | "approaching_eol"
  | "eol"
  | "unknown";

export interface OsLifecycleInput {
  osId?: string | null;
  osIdLike?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  osVersionCodename?: string | null;
  osLifecycleDismissedKey?: string | null;
}

export interface OsLifecycleInfo {
  osLifecycleStatus: OsLifecycleStatus;
  osLifecycleEolDate: string | null;
  osLifecycleDaysUntilEol: number | null;
  osLifecycleSupportEndDate: string | null;
  osLifecycleDaysUntilSupportEnd: number | null;
  osLifecycleLabel: string;
  osLifecycleDismissedKey: string | null;
  osLifecycleBannerDismissed: boolean;
}

interface LifecycleEntry {
  cycle: string;
  eol: string | false;
  supportEnd?: string;
}

interface ProductCatalog {
  label: string;
  entries: readonly LifecycleEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getMajorMinor(value: string): string {
  const match = value.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return "";
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function getMajor(value: string): string {
  return getMajorMinor(value).split(".")[0] ?? "";
}

function getProductKey(input: OsLifecycleInput): string | null {
  const osId = normalize(input.osId);
  const osIdLike = normalize(input.osIdLike);
  const osName = normalize(input.osName);

  if (osId === "proxmox" || osName.includes("proxmox")) return "proxmox";
  if (osId === "raspbian" || osName.includes("raspberry pi os") || osName.includes("raspbian")) return "debian";
  if (osId === "centos" && osName.includes("stream")) return "centos-stream";
  if (osId === "rhel" || osId === "redhat" || osName.includes("red hat enterprise linux")) return "rhel";
  if (osId === "rocky" || osName.includes("rocky linux")) return "rocky";
  if (osId === "almalinux" || osName.includes("almalinux")) return "almalinux";
  if (osId === "centos" || osName.includes("centos")) return "centos";
  if (osId === "ubuntu" || osName.includes("ubuntu")) return "ubuntu";
  if (osId === "debian" || osName.includes("debian") || osIdLike.split(/\s+/).includes("debian")) return "debian";
  if (osId === "fedora" || osName.includes("fedora")) return "fedora";
  if (osId === "alpine" || osName.includes("alpine")) return "alpine";
  return null;
}

function getCycle(productKey: string, input: OsLifecycleInput): string {
  const version = normalize(input.osVersion);
  if (!version) return "";

  if (productKey === "ubuntu" || productKey === "alpine") {
    return getMajorMinor(version);
  }

  return getMajor(version);
}

function parseDateUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function getTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function buildDismissedKey(productKey: string, cycle: string, eolDate: string | null, status: OsLifecycleStatus): string | null {
  if (
    status !== "eol" &&
    status !== "approaching_eol" &&
    status !== "support_ending" &&
    status !== "support_ended"
  ) return null;
  return `${productKey}:${cycle}:${eolDate ?? "none"}:${status}`;
}

function unknownResult(): OsLifecycleInfo {
  return {
    osLifecycleStatus: "unknown",
    osLifecycleEolDate: null,
    osLifecycleDaysUntilEol: null,
    osLifecycleSupportEndDate: null,
    osLifecycleDaysUntilSupportEnd: null,
    osLifecycleLabel: "Unknown",
    osLifecycleDismissedKey: null,
    osLifecycleBannerDismissed: false,
  };
}

export function resolveOsLifecycle(
  input: OsLifecycleInput,
  options: { warningDays?: number; now?: Date } = {},
): OsLifecycleInfo {
  const productKey = getProductKey(input);
  if (!productKey) return unknownResult();

  const product = (distroLifecycleData.catalog as Record<string, ProductCatalog>)[productKey];
  if (!product) return unknownResult();
  const cycle = getCycle(productKey, input);
  const entry = product.entries.find((candidate) => candidate.cycle === cycle);
  if (!entry) return unknownResult();

  if (entry.eol === false) {
    return {
      osLifecycleStatus: "supported",
      osLifecycleEolDate: null,
      osLifecycleDaysUntilEol: null,
      osLifecycleSupportEndDate: null,
      osLifecycleDaysUntilSupportEnd: null,
      osLifecycleLabel: `${product.label} ${cycle} supported`,
      osLifecycleDismissedKey: null,
      osLifecycleBannerDismissed: false,
    };
  }

  const now = options.now ?? new Date();
  const warningDays = Math.max(0, Math.trunc(options.warningDays ?? 180));
  const daysUntilEol = Math.ceil((parseDateUtc(entry.eol) - getTodayUtc(now)) / DAY_MS);
  const daysUntilSupportEnd = entry.supportEnd
    ? Math.ceil((parseDateUtc(entry.supportEnd) - getTodayUtc(now)) / DAY_MS)
    : null;
  const status: OsLifecycleStatus = daysUntilEol <= 0
    ? "eol"
    : daysUntilSupportEnd !== null && daysUntilSupportEnd <= 0
      ? "support_ended"
      : daysUntilEol <= warningDays
        ? "approaching_eol"
        : daysUntilSupportEnd !== null && daysUntilSupportEnd <= warningDays
          ? "support_ending"
          : "supported";
  const dismissedKey = buildDismissedKey(productKey, cycle, entry.eol, status);

  return {
    osLifecycleStatus: status,
    osLifecycleEolDate: entry.eol,
    osLifecycleDaysUntilEol: daysUntilEol,
    osLifecycleSupportEndDate: entry.supportEnd ?? null,
    osLifecycleDaysUntilSupportEnd: daysUntilSupportEnd,
    osLifecycleLabel:
      status === "eol"
        ? `${product.label} ${cycle} is EOL`
        : status === "support_ended"
          ? `${product.label} ${cycle} security support ended; LTS ends ${entry.eol}`
          : status === "support_ending"
            ? `${product.label} ${cycle} security support ends in ${daysUntilSupportEnd} day${daysUntilSupportEnd === 1 ? "" : "s"}`
        : status === "approaching_eol"
          ? `${product.label} ${cycle} reaches EOL in ${daysUntilEol} day${daysUntilEol === 1 ? "" : "s"}`
          : entry.supportEnd
            ? `${product.label} ${cycle} security support until ${entry.supportEnd}`
            : `${product.label} ${cycle} supported until ${entry.eol}`,
    osLifecycleDismissedKey: dismissedKey,
    osLifecycleBannerDismissed: !!dismissedKey && input.osLifecycleDismissedKey === dismissedKey,
  };
}
