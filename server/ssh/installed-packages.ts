export interface InstalledPackage {
  pkgManager: string;
  packageName: string;
  currentVersion: string;
  architecture: string | null;
  repository: string | null;
}

type BuiltinInstalledPackageDefinition = {
  command: string;
  parse: (stdout: string) => InstalledPackage[];
};

function splitTabLine(line: string): string[] {
  return line.split("\t").map((part) => part.trim());
}

function parseTabularPackages(
  pkgManager: string,
  stdout: string,
  options: {
    repositoryIndex?: number;
  } = {},
): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const raw of stdout.split("\n")) {
    const parts = splitTabLine(raw.trim());
    const packageName = parts[0];
    const currentVersion = parts[1];
    if (!packageName || !currentVersion) continue;
    packages.push({
      pkgManager,
      packageName,
      currentVersion,
      architecture: parts[2] || null,
      repository: options.repositoryIndex === undefined
        ? null
        : parts[options.repositoryIndex] || null,
    });
  }
  return packages;
}

function splitApkNameVersion(value: string): { name: string; version: string } | null {
  for (let i = value.length - 2; i >= 0; i--) {
    if (value[i] === "-" && value[i + 1] >= "0" && value[i + 1] <= "9") {
      return {
        name: value.slice(0, i),
        version: value.slice(i + 1),
      };
    }
  }
  return null;
}

function parseSpaceSeparatedPackages(pkgManager: string, stdout: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const raw of stdout.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    packages.push({
      pkgManager,
      packageName: parts[0],
      currentVersion: parts[1],
      architecture: null,
      repository: null,
    });
  }
  return packages;
}

const BUILTIN_INSTALLED_PACKAGE_DEFINITIONS: Record<string, BuiltinInstalledPackageDefinition> = {
  apt: {
    command: "dpkg-query -W -f='${Package}\\t${Version}\\t${Architecture}\\n' 2>/dev/null",
    parse: (stdout) => parseTabularPackages("apt", stdout),
  },
  dnf: {
    command: "rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\n' 2>/dev/null",
    parse: (stdout) => parseTabularPackages("dnf", stdout),
  },
  yum: {
    command: "rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\n' 2>/dev/null",
    parse: (stdout) => parseTabularPackages("yum", stdout),
  },
  pacman: {
    command: "pacman -Q 2>/dev/null",
    parse: (stdout) => parseSpaceSeparatedPackages("pacman", stdout),
  },
  apk: {
    command: "apk info -v 2>/dev/null",
    parse: (stdout) => stdout
      .split("\n")
      .map((line) => splitApkNameVersion(line.trim()))
      .filter((entry): entry is { name: string; version: string } => !!entry?.name && !!entry.version)
      .map((entry) => ({
        pkgManager: "apk",
        packageName: entry.name,
        currentVersion: entry.version,
        architecture: null,
        repository: null,
      })),
  },
  flatpak: {
    command: "flatpak list --columns=application,version,arch,origin 2>/dev/null",
    parse: (stdout) => parseTabularPackages("flatpak", stdout, { repositoryIndex: 3 }),
  },
  snap: {
    command: "snap list --color=never 2>/dev/null",
    parse: (stdout) => {
      const packages = parseSpaceSeparatedPackages("snap", stdout);
      return packages
        .filter((pkg) => pkg.packageName !== "Name")
        .map((pkg) => ({ ...pkg, repository: "snap" }));
    },
  },
};

export function getBuiltinInstalledPackageCommand(pkgManager: string): string | null {
  return BUILTIN_INSTALLED_PACKAGE_DEFINITIONS[pkgManager]?.command ?? null;
}

export function parseBuiltinInstalledPackages(
  pkgManager: string,
  stdout: string,
): InstalledPackage[] | null {
  const definition = BUILTIN_INSTALLED_PACKAGE_DEFINITIONS[pkgManager];
  return definition ? definition.parse(stdout) : null;
}
