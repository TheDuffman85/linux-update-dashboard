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

// Output from issue #314 on a self-compiled OpenWrt image. apk counts an installed
// package that is already marked broken as an error on every run, so the summary
// line reports "1 error" and the exit status is 1 although every upgrade worked.
export const APK_BROKEN_STATE_SIMULATION = [
  "(1/1) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)",
  "1 error; 293.6 MiB in 329 packages",
  "===LUDASH_APK_SIMULATION_STATUS:1===",
  "",
].join("\n");

export const APK_BROKEN_STATE_UPGRADE = [
  "(1/4) Upgrading openssh-client (10.6_p1-r2 -> 10.6_p2-r1)",
  "  Executing openssh-client-10.6_p2-r1.post-upgrade",
  "(2/4) Upgrading openssh-keygen (10.6_p1-r2 -> 10.6_p2-r1)",
  "(3/4) Upgrading openssh-server (10.6_p1-r2 -> 10.6_p2-r1)",
  "(4/4) Upgrading openssh-sftp-server (10.6_p1-r2 -> 10.6_p2-r1)",
  "1 error; 293.6 MiB in 329 packages",
  "",
].join("\n");
