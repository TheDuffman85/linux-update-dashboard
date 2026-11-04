/**
 * Package managers whose kept-back flag means the package is pinned or held on
 * the host: apk world constraints, pacman IgnorePkg, flatpak masks, snap holds,
 * and apt-mark holds on deb-get apps.
 *
 * Upgrade All already skips these packages. Upgrading one by name either
 * overrides the pin (pacman, snap) or leaves the package unchanged (apk,
 * flatpak, deb-get), so by-name upgrades are refused. APT is not listed because
 * a by-name upgrade is a legitimate way to install a kept-back package there.
 */
export const PINNED_UPDATE_PACKAGE_MANAGERS: readonly string[] = [
  "apk",
  "pacman",
  "flatpak",
  "snap",
  "deb-get",
];

export function usesPinnedUpdates(pkgManager: string | null | undefined): boolean {
  return !!pkgManager && PINNED_UPDATE_PACKAGE_MANAGERS.includes(pkgManager);
}

export function isPinnedUpdate(update: {
  pkgManager?: string | null;
  isKeptBack?: boolean | number | null;
}): boolean {
  return !!update.isKeptBack && usesPinnedUpdates(update.pkgManager);
}
