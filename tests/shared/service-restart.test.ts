import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVICE_RESTART_SKIP_PATTERNS,
  isServiceSkipped,
  isValidServiceName,
  listRestartableServices,
  matchesGlob,
  normalizeServiceSkipPatterns,
  parseServiceRestartInfo,
  resolveServiceSkipPatterns,
  type ServiceRestartInfo,
} from "../../shared/service-restart";

function info(units: string[]): ServiceRestartInfo {
  return {
    status: "ok",
    init: "systemd",
    services: units.map((unit) => ({ unit, processes: [{ pid: 1000, comm: "x" }], files: [] })),
    managerNeedsReexec: false,
    sessionProcessCount: 0,
    otherProcesses: [],
  };
}

describe("service restart helpers", () => {
  test("matches skip patterns with or without the .service suffix", () => {
    expect(isServiceSkipped("dbus.service", ["dbus"])).toBe(true);
    expect(isServiceSkipped("dbus", ["dbus.service"])).toBe(false);
    expect(isServiceSkipped("getty@tty1.service", ["getty@*"])).toBe(true);
    expect(isServiceSkipped("serial-getty@ttyS0.service", ["getty@*"])).toBe(false);
    expect(isServiceSkipped("pve-ha-lrm.service", ["pve-ha-?rm"])).toBe(true);
    expect(isServiceSkipped("nginx.service", DEFAULT_SERVICE_RESTART_SKIP_PATTERNS)).toBe(false);
    expect(isServiceSkipped("NetworkManager.service", DEFAULT_SERVICE_RESTART_SKIP_PATTERNS)).toBe(true);
    expect(isServiceSkipped("docker.service", DEFAULT_SERVICE_RESTART_SKIP_PATTERNS)).toBe(true);
  });

  test("matches many-wildcard patterns in bounded time", () => {
    const value = `${"a".repeat(5000)}.service`;
    const pattern = `${"a*".repeat(60)}b`;
    const started = performance.now();
    expect(isServiceSkipped(value, [pattern])).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(matchesGlob("*a*b*", "xxaxxbxx")).toBe(true);
    expect(matchesGlob("a*", "")).toBe(false);
    expect(matchesGlob("*", "")).toBe(true);
    expect(matchesGlob("DBUS", "dbus")).toBe(true);
  });

  test("treats regex characters in patterns literally", () => {
    expect(isServiceSkipped("aXb.service", ["a.b"])).toBe(false);
    expect(isServiceSkipped("a.b.service", ["a.b"])).toBe(true);
  });

  test("uses the defaults only when a system has no list of its own", () => {
    expect(resolveServiceSkipPatterns(null)).toBe(DEFAULT_SERVICE_RESTART_SKIP_PATTERNS);
    expect(resolveServiceSkipPatterns([])).toEqual([]);
    expect(listRestartableServices(info(["dbus.service", "nginx.service"]), resolveServiceSkipPatterns(null))
      .map((service) => service.unit)).toEqual(["nginx.service"]);
    expect(listRestartableServices(info(["dbus.service", "nginx.service"]), [])).toHaveLength(2);
  });

  test("normalizes and validates skip patterns", () => {
    expect(normalizeServiceSkipPatterns([" dbus ", "", "dbus", "user@*"])).toEqual({ patterns: ["dbus", "user@*"] });
    expect(normalizeServiceSkipPatterns(["bad pattern"])).toHaveProperty("error");
    expect(normalizeServiceSkipPatterns(["x;rm"])).toHaveProperty("error");
    expect(normalizeServiceSkipPatterns("dbus")).toHaveProperty("error");
    expect(normalizeServiceSkipPatterns(Array.from({ length: 101 }, (_, index) => `s${index}`))).toHaveProperty("error");
  });

  test("accepts only service names that are safe without shell quoting", () => {
    expect(isValidServiceName("nginx.service")).toBe(true);
    expect(isValidServiceName("getty@tty1.service")).toBe(true);
    expect(isValidServiceName("sshd")).toBe(true);
    expect(isValidServiceName("-nginx")).toBe(false);
    expect(isValidServiceName("a b")).toBe(false);
    expect(isValidServiceName("a;b")).toBe(false);
    expect(isValidServiceName("dev-disk-by\\x2duuid.service")).toBe(false);
    expect(isValidServiceName("")).toBe(false);
  });

  test("reads stored scans defensively", () => {
    expect(parseServiceRestartInfo(null)).toBeNull();
    expect(parseServiceRestartInfo("not json")).toBeNull();
    expect(parseServiceRestartInfo("{}")).toBeNull();
    expect(parseServiceRestartInfo(JSON.stringify(info(["a.service"])))?.services).toHaveLength(1);
  });
});
