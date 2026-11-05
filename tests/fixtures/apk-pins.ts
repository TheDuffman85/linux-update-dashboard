// Versions and package listing reproduced from issue #314 on OpenWrt 25.12.6.
export const APK_PINNED_WORLD = [
  "base-files=1~981c978eff",
  "kernel=6.12.112~9bc94e3a8c8d88d519791e4b3c6ced9b-r1",
  "libc=1.2.5-r5",
].join("\n");

export const APK_PINNED_LIST = [
  "base-files-1718~981c978eff x86_64 {feeds/base/base-files} (GPL-2.0) [upgradable from: base-files-1~981c978eff]",
  "kernel-6.12.112~b4125196ecec75391093e1e2edeba490-r1 x86_64 {feeds/base/kernel/linux} (GPL-2.0-only) [upgradable from: kernel-6.12.112~9bc94e3a8c8d88d519791e4b3c6ced9b-r1]",
  "zlib-1.3.2-r0 x86_64 {zlib} (Zlib) [upgradable from: zlib-1.3.1-r1]",
].join("\n");

export const APK_FAILED_SIMULATION =
  "ERROR: Not continuing due to stale/unavailable repositories. Use --force-missing-repositories to continue.\n" +
  "===LUDASH_APK_SIMULATION_STATUS:99===\n";
